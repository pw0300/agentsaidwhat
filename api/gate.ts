import { audit, bad, checkDeployment, json, redis, redisEnv, tenantKey } from './_lib'
import { currentUser } from './auth'
import { attest, sha256Hex } from './_crypto'
import { measureGate } from './_measure'

export const config = { runtime: 'edge' }

/**
 * Run a release gate over a prompt version.
 *
 *   GET  /api/gate?agent=<id>&version=<id>  -> evaluation + signed receipt
 *
 * This endpoint is the product. The rest of the app is how a human finds out
 * what broke; this is what a pipeline calls to decide whether a change ships.
 *
 * Three properties make it usable in that setting:
 *
 *  - It is a GET with no side effects, so a CI job can call it repeatedly and
 *    a webhook can poll it without a retry loop mutating anything.
 *
 *  - It returns a signed receipt. The response carries a SHA-256 of the
 *    evaluation, HMAC'd with the deployment secret. An auditor can be handed
 *    the receipt months later and shown that the score has not been edited
 *    since it was produced — which is the difference between "our dashboard
 *    said 4.1" and "our release record says 4.1 and here is the signature".
 *
 *  - It exits with the gate result, not just the data. `pass` → 200,
 *    anything else → 409, so a shell script needs no JSON parsing at all:
 *
 *        curl -sf "$QA_URL/api/gate?agent=$AGENT&version=$VER" > receipt.json
 *
 * Auth is a bearer token so a CI job is not a person. The token is the same
 * session cookie issued to a signed-in user, accepted as `Authorization:
 * Bearer <token>` so non-browser clients can hold one.
 */

type Dict = Record<string, unknown>

interface Sessionish { id: string; email: string; name: string; role: string; tenantId: string }

/**
 * Accept a session from a cookie or a bearer token.
 *
 * CI has no cookie jar, so the token that a browser gets in an HttpOnly cookie
 * is also accepted in an Authorization header. Same signature, same expiry,
 * same revocation — one identity, two transports.
 */
async function identity(req: Request): Promise<Sessionish | null> {
  const fromCookie = await currentUser(req)
  if (fromCookie) return fromCookie

  const env = redisEnv()
  const secret = process.env.QA_SESSION_SECRET
  const header = req.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!env || !secret || !token) return null

  const { verifyClaims } = await import('./_crypto')
  const claims = await verifyClaims(token, secret, Math.floor(Date.now() / 1000))
  if (!claims) return null

  // Keep the legacy aq: Redis namespace to read existing hosted data.
  const sessions = JSON.parse(((await redis(env, ['GET', 'aq:sessions'])) as string) ?? '{}') as Dict
  const live = sessions[claims.sid] as { userId: string; email: string; name: string; tenantId: string; role: string; exp: number } | undefined
  if (!live || live.exp * 1000 < Date.now()) return null
  return { id: live.userId, email: live.email, name: live.name, role: live.role, tenantId: live.tenantId }
}


export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return bad('GET only', 405)

  const denied = checkDeployment(req)
  if (denied) return denied

  const env = redisEnv()
  const user = await identity(req)
  if (!env || !user) return bad('Sign in, or pass a session token as `Authorization: Bearer …`.', 401)

  try {
    const url = new URL(req.url)
    const agentId = url.searchParams.get('agent') ?? ''
    const versionId = url.searchParams.get('version') ?? ''
    if (!agentId) return bad('Pass ?agent=<agentId>.', 400)

    const raw = (await redis(env, ['GET', tenantKey(user.tenantId, 'state')])) as string | null
    const state: Dict = raw ? (JSON.parse(raw) as Dict) : {}

    // Measured by the same pure function the local server uses, so a version
    // gets one answer regardless of where its workspace is stored.
    const m = measureGate(state, agentId, versionId || undefined)
    if ('error' in m) return bad(m.error, m.status)
    const { agent, version, policy, result } = m
    const { composite, blockerFindings, samples } = m.input

    /* ---- signed receipt ---- */
    const receiptBody = {
      tenant: user.tenantId,
      agent: { id: agentId, name: agent.name },
      version: { id: version.id, number: version.number, changelog: (version.changelog as string) ?? '' },
      policy: { name: policy.name, enabled: policy.enabled, minComposite: policy.minComposite, minSamples: policy.minSamples, minHumanSessions: policy.minHumanSessions ?? 0, maxRegression: policy.maxRegression, maxBlockers: policy.maxBlockers, minParams: policy.minParams },
      measured: { composite, samples, paramSamples: m.input.paramSamples, unsubstantiatedSessions: m.unsubstantiatedSessions, humanSessions: m.humanSessions, simulatedSessions: m.simulatedSessions, aiCalls: m.aiCalls, blockerFindings },
      outcome: result.outcome,
      summary: result.summary,
      blockers: result.blockers,
      evaluatedAt: new Date().toISOString(),
    }
    const secret = process.env.QA_SESSION_SECRET ?? ''
    const { hash, signature } = await attest(receiptBody, secret)

    // The receipt hash folds in the prompt itself, so the signature covers the
    // thing that was actually judged and not just the summary of the judgement.
    const promptHash = await sha256Hex(String(version.promptText ?? ''))

    const status = result.outcome === 'pass' ? 200 : result.outcome === 'disabled' ? 200 : 409
    await audit(env, user.tenantId, user.email, 'gate.evaluate', `${agent.name} v${version.number}`, { outcome: result.outcome, samples: receiptBody.measured.samples })

    return json({ ...result, receipt: { ...receiptBody, promptHash, hash, signature } }, status)
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Gate evaluation failed.', 500)
  }
}

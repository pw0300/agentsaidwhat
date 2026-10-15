import { audit, bad, checkDeployment, json, redis, redisEnv, tenantKey } from './_lib'
import { currentUser } from './auth'
import { redact } from './_redact'

export const config = { runtime: 'edge' }

/**
 * The front door to the model provider.
 *
 * Before this existed, every tester who opened the deployed link had to paste
 * an Anthropic key into a browser field, and the app called Anthropic with
 * `dangerouslyAllowBrowser`. That is fine on your own machine and unacceptable
 * the moment you share the URL: whoever holds the tab holds the key.
 *
 * The key now lives only in a server environment variable and never reaches
 * the browser. This function is deliberately not a general relay — it pins the
 * models, caps max_tokens, and re-redacts on the way out.
 *
 * Two things make it sellable rather than merely safe:
 *
 *  1. Bring your own key. A customer who cannot send their call transcripts to
 *     a third-party model provider sets ANTHROPIC_API_KEY in their own
 *     deployment and the traffic never leaves their account. This function is
 *     the switch between "hosted convenience" and "self-hosted" and it is the
 *     single most common line in an enterprise security questionnaire.
 *
 *  2. A per-tenant budget. Without a ceiling, one customer bulk-analysing ten
 *     thousand calls runs up the bill for everyone sharing the deployment, and
 *     the failure mode is a surprise invoice nobody can explain.
 */

const ALLOWED_MODELS = new Set(['claude-opus-4-8', 'claude-sonnet-5'])
const MAX_TOKENS_CAP = 16000
const MAX_BODY_BYTES = 1_000_000
const DEFAULT_MONTHLY_CALL_CAP = 2000

interface Budget {
  used: number
  cap: number
  resetsAt: string
}

const localBudgets = new Map<string, Budget>()

async function budgetFor(env: { url: string; token: string } | null, tid: string): Promise<Budget> {
  const raw = env ? (await redis(env, ['GET', tenantKey(tid, 'budget')])) as string | null : JSON.stringify(localBudgets.get(tid) ?? null)
  const configuredCap = Number(process.env.QA_MONTHLY_CALL_CAP ?? DEFAULT_MONTHLY_CALL_CAP)
  const cap = Number.isFinite(configuredCap) && configuredCap >= 0 ? Math.floor(configuredCap) : DEFAULT_MONTHLY_CALL_CAP
  if (raw) {
    try {
      const b = JSON.parse(raw) as Budget
      // A month boundary that has passed means a fresh allowance, not an error.
      if (new Date(b.resetsAt).getTime() > Date.now()) return { ...b, cap }
    } catch { /* fall through to a fresh period */ }
  }
  const resets = new Date()
  resets.setUTCMonth(resets.getUTCMonth() + 1, 1)
  resets.setUTCHours(0, 0, 0, 0)
  return { used: 0, cap, resetsAt: resets.toISOString() }
}

/**
 * Spend one unit of budget.
 *
 * Read-increment-write without a compare-and-set would let a user with four
 * browser tabs past the cap, so the increment is done as a Lua script that only
 * writes if the new value is still under the ceiling.
 */
async function spend(env: { url: string; token: string } | null, tid: string, b: Budget): Promise<boolean> {
  const key = tenantKey(tid, 'budget')
  const next = { ...b, used: b.used + 1 }
  if (!env) {
    const current = localBudgets.get(tid)
    const used = current?.resetsAt === b.resetsAt ? current.used : 0
    if (used + 1 > b.cap) return false
    localBudgets.set(tid, { ...b, used: used + 1 })
    return true
  }
  const ok = await redis(env, [
    'EVAL',
    `local next = cjson.decode(ARGV[1])
     local cur = redis.call('GET', KEYS[1])
     local used = 0
     if cur then
       local parsed = cjson.decode(cur)
       if parsed.resetsAt == next.resetsAt then used = tonumber(parsed.used) end
     end
     if used + 1 > tonumber(next.cap) then return 0 end
     next.used = used + 1
     redis.call('SET', KEYS[1], cjson.encode(next))
     return 1`,
    '1', key, JSON.stringify(next),
  ])
  return ok === 1
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return bad('POST only', 405)

  const denied = checkDeployment(req)
  if (denied) return denied

  const env = redisEnv()
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) {
    return bad('Set ANTHROPIC_API_KEY in the server environment and restart or redeploy to use AI analysis. Manual logging, scoring, triage and gates over saved evidence still work without it.', 503)
  }

  const user = await currentUser(req)
  if (env && !user) {
    // Keep the legacy aq: Redis namespace to read existing hosted data.
    const users = await redis(env, ['GET', 'aq:users']) as string | null
    // Corrupt account storage also fails closed.
    if (users && Object.keys(JSON.parse(users)).length) return bad('Sign in to use AI analysis.', 401)
  }
  if (user && user.role === 'viewer') return bad('Your role is read-only.', 403)

  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) return bad('Request too large.', 413)

  let body: Record<string, unknown>
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return bad('Body must be JSON.')
  }

  const model = String(body.model ?? '')
  if (!ALLOWED_MODELS.has(model)) return bad(`Model not allowed: ${model || '(none)'}`)

  const maxTokens = Number(body.max_tokens ?? 0)
  if (!Number.isFinite(maxTokens) || maxTokens < 1) return bad('max_tokens is required.')

  {
    const tid = user?.tenantId ?? 'default'
    const budget = await budgetFor(env, tid)
    if (!(await spend(env, tid, budget))) {
      return bad(`Monthly analysis budget reached (${budget.cap} calls). It resets on ${new Date(budget.resetsAt).toDateString()}, or raise QA_MONTHLY_CALL_CAP.`, 429)
    }
  }

  // Redact a final time on the way out. The server scrubs on the way in, but a
  // transcript can also arrive inside a prompt field the scrubber does not
  // model, and this is the last point before a third party sees it.
  const outbound = scrubOutbound(body)

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-03',
    },
    body: JSON.stringify({ ...outbound, max_tokens: Math.min(maxTokens, MAX_TOKENS_CAP) }),
  })

  const text = await upstream.text()
  if (!upstream.ok) {
    // Pass the status through so the client can tell "bad request" from "rate
    // limited", but never the raw upstream body — it can echo request details.
    let detail = ''
    try {
      const e = JSON.parse(text) as { error?: { message?: string } }
      detail = e.error?.message ?? ''
    } catch { /* non-JSON upstream error */ }
    if (env && user) await audit(env, user.tenantId, user.email, 'analysis.error', model, { status: upstream.status })
    return json({ error: detail || `Model provider returned ${upstream.status}` }, upstream.status)
  }

  if (env && user) await audit(env, user.tenantId, user.email, 'analysis.run', model, { promptChars: JSON.stringify(outbound).length })
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/**
 * Walk the request and redact anything that looks like a conversation.
 *
 * All message text is redacted, including assistant turns and text blocks. The system prompt is the customer's own
 * configuration and their own business facts; rewriting it would break the
 * analysis silently, and it is not their personal data.
 */
function scrubOutbound(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages
  if (!Array.isArray(messages)) return body
  return {
    ...body,
    messages: messages.map(m => {
      const msg = m as { role?: string; content?: unknown }
      if (!msg || typeof msg !== 'object') return m
      if (typeof msg.content === 'string') return { ...msg, content: redact(msg.content).text }
      if (Array.isArray(msg.content)) return { ...msg, content: msg.content.map(block => {
        if (block && block.type === 'text' && typeof block.text === 'string') return { ...block, text: redact(block.text).text }
        return block
      }) }
      return m
    }),
  }
}

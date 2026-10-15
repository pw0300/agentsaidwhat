import { bad, checkDeployment, json, redis, redisEnv, tenantKey } from './_lib'
import { currentUser } from './auth'

export const config = { runtime: 'edge' }

/**
 * What this deployment can actually do, reported as a machine-readable
 * readiness object.
 *
 * Two audiences. A buyer asks "is this SOC 2 ready, where does my data live,
 * who can see it" and the answer has to be precise rather than reassuring. And
 * CI needs a stable shape it can assert against on every deploy, which is what
 * `ready` is for — it is true only when sign-in, the store, and analysis are
 * all wired, so a pipeline can fail the build instead of discovering the gap
 * when a tester clicks Analyze.
 *
 * It reports only booleans and counts — never the values themselves.
 */

export default async function handler(req: Request): Promise<Response> {
  const denied = checkDeployment(req)
  if (denied) return denied

  const env = redisEnv()
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY)
  const hasSecret = Boolean(process.env.QA_SESSION_SECRET)
  const restricted = Boolean(process.env.QA_ACCESS_CODE)
  const ipAllowlist = (process.env.QA_ALLOWED_IPS ?? '').split(',').map(s => s.trim()).filter(Boolean).length

  const base = {
    anthropic: hasKey,
    sessionSecret: hasSecret,
    accessCodeRequired: restricted,
    ipAllowlistEntries: ipAllowlist,
    store: Boolean(env),
    /** Everything a real deployment needs. `npm run dev` will report false. */
    ready: Boolean(env && hasKey && hasSecret),
    regions: ['edge'],
  }

  if (!env) return json({ ...base, accounts: 0 })

  try {
    // Keep the legacy aq: Redis namespace to read existing hosted data.
    const users = (await redis(env, ['GET', 'aq:users'])) as string | null
    const accounts = users ? Object.keys(JSON.parse(users) as object).length : 0
    const user = await currentUser(req)
    const auditEvents = user ? Number((await redis(env, ['LLEN', tenantKey(user.tenantId, 'audit')])) ?? 0) : 0
    return json({ ...base, accounts, auditEvents, signedIn: Boolean(user), role: user?.role ?? null })
  } catch {
    return json({ ...base, store: false, ready: false, storeError: true })
  }
}

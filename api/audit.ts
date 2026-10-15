import { audit, bad, checkDeployment, json, redis, redisEnv, tenantKey } from './_lib'
import { currentUser } from './auth'

export const config = { runtime: 'edge' }

/**
 * Read the tenant's audit trail.
 *
 * `GET /api/audit?limit=200`
 *
 * Separate from /api/state on purpose. The QA document is the working surface
 * and gets merged, overwritten and pruned constantly. An audit log that lives
 * inside it would inherit all of that. This is a second, append-only list that
 * nothing in the product writes to except the server.
 */

const MAX_LIMIT = 500

export default async function handler(req: Request): Promise<Response> {
  const denied = checkDeployment(req)
  if (denied) return denied

  if (req.method !== 'GET') return bad('GET only', 405)

  const env = redisEnv()
  if (!env) return json({ configured: false, events: [] })

  const user = await currentUser(req)
  if (!user) return bad('Sign in to read the audit trail.', 401)

  const url = new URL(req.url)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100))

  try {
    const rows = (await redis(env, ['LRANGE', tenantKey(user.tenantId, 'audit'), 0, limit - 1])) as string[]
    const events = rows.flatMap(raw => {
      try { return [JSON.parse(raw)] } catch { return [] }
    })
    return json({ configured: true, events, count: events.length })
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not read the audit trail.', 502)
  }
}

/**
 * Shared helpers for the serverless functions.
 *
 * These run on Vercel's Edge runtime, so they use plain `fetch` and Web APIs
 * only — no npm dependencies, nothing to install, nothing to keep in sync with
 * the client bundle.
 */

/** JSON response with no-store — none of these endpoints are cacheable. */
export function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders },
  })
}

export function bad(message: string, status = 400): Response {
  return json({ error: message }, status)
}

/**
 * A second gate in front of the whole deployment, for customers who require
 * one. It is now a *network* control, not an identity control — who you are
 * comes from the session in /api/auth — so naming it accordingly matters: a
 * reviewer who reads "access code" assumes it is what identifies a user.
 *
 * QA_ACCESS_CODE is now optional and off by default. When it is set, an IP
 * allowlist (QA_ALLOWED_IPS, comma-separated) is checked first, so a customer
 * with both gets the stronger of the two.
 */
export function checkDeployment(req: Request): Response | null {
  const expected = process.env.QA_ACCESS_CODE
  if (!expected) return null

  const ip = clientIp(req)
  if (ip && isIpAllowed(ip)) return null

  const given = req.headers.get('x-qa-access') ?? ''
  if (given !== expected) return bad('This deployment is restricted. Access code required.', 401)
  return null
}

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for') ?? ''
  return fwd.split(',')[0]?.trim() ?? ''
}

function ipv4(value: string): number | null {
  const octets = value.split('.')
  if (octets.length !== 4 || octets.some(x => !/^(?:0|[1-9]\d{0,2})$/.test(x) || Number(x) > 255)) return null
  return octets.reduce((n, x) => (n * 256 + Number(x)) >>> 0, 0)
}

function isIpAllowed(ip: string): boolean {
  const address = ipv4(ip)
  const list = (process.env.QA_ALLOWED_IPS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return list.some(entry => {
    if (!entry.includes('/')) {
      if (address !== null) return ipv4(entry) === address
      // Exact IPv6 entries remain supported, but invalid strings never match.
      if (!ip.includes(':') || entry !== ip) return false
      try { return new URL(`http://[${ip}]/`).hostname.startsWith('[') } catch { return false }
    }
    const parts = entry.split('/')
    if (parts.length !== 2 || !/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(parts[1])) return false
    const network = ipv4(parts[0])
    if (address === null || network === null) return false
    const bits = Number(parts[1])
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (address & mask) === (network & mask)
  })
}

/* ---------------- Shared store (Upstash Redis over REST) ---------------- */

/**
 * Redis credentials, however they got here.
 *
 * Adding Upstash through the Vercel Marketplace injects KV_REST_API_*; creating
 * the database directly on Upstash gives UPSTASH_REDIS_REST_*. Both are the
 * same product and the same free tier, so accept either rather than making the
 * app care which door the user walked through. Returns null when neither is
 * set — the app then stays purely local instead of erroring.
 */
export function redisEnv(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN
  return url && token ? { url: url.replace(/\/$/, ''), token } : null
}

/** Run one Redis command over the REST API. Returns the `result` field. */
export async function redis(env: { url: string; token: string }, command: unknown[]): Promise<unknown> {
  const res = await fetch(env.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
  })
  const data = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string }
  if (!res.ok || data.error) throw new Error(data.error ?? `Store returned ${res.status}`)
  return data.result
}

/* ---------------- Tenant scoping ---------------- */

/**
 * Every tenant's data lives under a key prefixed with its id.
 *
 * This is the single most important line in the file for an enterprise sale.
 * One deployment, many customers, and the only thing standing between them is
 * that no query is written without a tenant in it. The alternative — one
 * document holding every customer's QA records — is a breach waiting for the
 * first customer who reads the schema.
 */
// Keep the legacy aq: Redis namespace so hosted tenant data remains reachable.
export const tenantKey = (tenantId: string, name: string): string => `aq:t_${tenantId}:${name}`

/* ---------------- Audit trail ---------------- */

export interface AuditEvent {
  id: string
  at: string
  tenantId: string
  actor: string
  action: string
  target: string
  meta?: Record<string, string | number | boolean>
}

/**
 * Append an entry to the tenant's audit log.
 *
 * Enterprises ask three questions in the first call and all three need this:
 * who changed the prompt version, who verified the issue, and who exported the
 * data. The log is append-only and capped — a QA trail that can be silently
 * truncated to fit a storage budget is worth less than no log, so the cap is
 * high and the oldest entries are dropped with a visible count.
 */
export async function audit(
  env: { url: string; token: string },
  tenantId: string,
  actor: string,
  action: string,
  target: string,
  meta?: Record<string, string | number | boolean>,
): Promise<void> {
  const key = tenantKey(tenantId, 'audit')
  const event: AuditEvent = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    tenantId, actor, action, target,
    ...(meta ? { meta } : {}),
  }
  try {
    await redis(env, ['LPUSH', key, JSON.stringify(event)])
    await redis(env, ['LTRIM', key, 0, 4999])
  } catch {
    // An audit write must never fail the action it is describing. The gap is
    // visible in the log itself; failing the user's work would be worse.
  }
}

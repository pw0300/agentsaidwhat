import { audit, bad, checkDeployment, json, redis, redisEnv, tenantKey } from './_lib'
import { mergeState } from './_merge'
import { scrubState } from './_redact'
import { currentUser } from './auth'

export const config = { runtime: 'edge' }

/**
 * The shared QA record, scoped to one customer.
 *
 * localStorage made "team QA" a fiction: two testers on the same link built two
 * disconnected datasets and neither could see the other's findings. This is
 * the one place that fiction becomes true — a single document per tenant that
 * every browser merges into and reads back.
 *
 * It is deliberately one document, not a table per entity. The dataset is a few
 * hundred KB of QA notes for one team, the merge needs to see all of it at once
 * anyway, and one document means one compare-and-set instead of a transaction
 * across eight keys.
 *
 *   GET  -> { configured, state, rev }
 *   POST { base, local } -> { configured, state, rev }   (three-way merged)
 *
 * `rev` guards against lost updates: the write only lands if the revision we
 * merged against is still the current one. If someone else wrote in between we
 * re-read and merge again, so their work survives instead of being overwritten.
 *
 * Three things changed when this became something a customer signs a contract
 * for, and all three happen on the server rather than in the UI:
 *
 *  - The key is tenant-scoped. One deployment serves many customers and no
 *    query runs without a tenant in it.
 *  - Identity comes from a session, not a header the client sets. `tid` is read
 *    from the signed claim, so a client cannot write into a workspace it does
 *    not belong to.
 *  - Transcripts are redacted on the way in. See _redact.ts for why
 *    over-redacting is the correct failure here.
 */

const MAX_BODY_BYTES = 8_000_000

// Set both keys only if the revision has not moved. Comparing a small integer
// key keeps the whole document out of the script — cjson on a few hundred KB
// inside Redis would be the slowest part of the request.
const CAS = `
local cur = redis.call('GET', KEYS[2])
if cur == ARGV[2] or (not cur and ARGV[2] == '0') then
  redis.call('SET', KEYS[1], ARGV[1])
  redis.call('SET', KEYS[2], ARGV[3])
  return 1
end
return 0`

type Dict = Record<string, unknown>

async function read(env: { url: string; token: string }, tid: string): Promise<{ state: Dict; rev: number }> {
  const [raw, rev] = (await redis(env, ['MGET', tenantKey(tid, 'state'), tenantKey(tid, 'rev')])) as (string | null)[]
  let state: Dict = {}
  if (raw) { try { state = JSON.parse(raw) as Dict } catch { state = {} } }
  return { state, rev: Number(rev ?? 0) || 0 }
}

/**
 * Strip personal data out of every transcript on the way in.
 *
 * Runs on the merged state rather than on the incoming body, so a value that
 * arrived through some future import path is covered too. Agent prompts are
 * left alone: a customer's product facts in a prompt are not their personal
 * data, and redacting them would break the version-diffing this tool is built
 * on.
 */
/** Per-tenant name hints, kept out of the QA document so the redactor can read them. */
async function nameHints(env: { url: string; token: string }, tid: string): Promise<string[]> {
  const raw = (await redis(env, ['GET', tenantKey(tid, 'name-hints')])) as string | null
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(0, 200) : []
  } catch {
    return []
  }
}

/** True when this deployment has any account at all — i.e. the shared-secret era is over. */
async function accountsExist(env: { url: string; token: string }): Promise<boolean> {
  // Keep the legacy aq: Redis namespace to read existing hosted data.
  const raw = (await redis(env, ['GET', 'aq:users'])) as string | null
  if (!raw) return false
  try { return Object.keys(JSON.parse(raw) as object).length > 0 } catch { return false }
}

export default async function handler(req: Request): Promise<Response> {
  const denied = checkDeployment(req)
  if (denied) return denied

  const env = redisEnv()
  // No store provisioned: say so plainly and let the client stay local-only.
  // A QA tool that refuses to open because nobody added a database yet is worse
  // than one that quietly works the way it did before.
  if (!env) return json({ configured: false, state: null, rev: 0 })

  const user = await currentUser(req)
  // Unauthenticated access is only allowed when the deployment has no accounts
  // at all — the single-team self-hosted case this app started as. The moment
  // one signup happens, the shared-secret era is over.
  if (!user) {
    if (await accountsExist(env)) return bad('Sign in to access this workspace.', 401)
    return json({ configured: true, legacy: true, state: null, rev: 0 })
  }

  const tid = user.tenantId
  if (user.role === 'viewer') return bad('Your role is read-only.', 403)

  try {
    if (req.method === 'GET') {
      const { state, rev } = await read(env, tid)
      return json({ configured: true, state: rev ? state : null, rev })
    }
    if (req.method !== 'POST') return bad('GET or POST only', 405)

    const raw = await req.text()
    if (raw.length > MAX_BODY_BYTES) return bad('State too large to sync.', 413)

    let body: { base?: Dict; local?: Dict }
    try { body = JSON.parse(raw) as typeof body } catch { return bad('Body must be JSON.') }
    if (!body.local || typeof body.local !== 'object') return bad('Missing local state.')
    const base = body.base && typeof body.base === 'object' ? body.base : {}

    for (let attempt = 0; attempt < 3; attempt++) {
      const { state: server, rev } = await read(env, tid)
      const merged = mergeState(base, body.local, rev ? server : body.local)
      const { state: safe, hits } = scrubState(merged, await nameHints(env, tid))
      const next = rev + 1
      const ok = await redis(env, [
        'EVAL', CAS, '2', tenantKey(tid, 'state'), tenantKey(tid, 'rev'),
        JSON.stringify(safe), String(rev), String(next),
      ])
      if (ok === 1) {
        await audit(env, tid, user.email, 'state.sync', 'workspace', { redacted: hits })
        return json({ configured: true, state: safe, rev: next, redacted: hits })
      }
      // Someone wrote between our read and our write. Re-read and merge onto
      // their version rather than clobbering it.
    }
    return bad('The shared record is being written too often — try again.', 409)
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Store request failed.', 502)
  }
}


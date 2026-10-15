/**
 * Three-way merge for the shared QA state.
 *
 * The app is offline-first: each browser keeps working against localStorage and
 * pushes when it can. Last-writer-wins on the whole document would mean the
 * second tester to finish silently erases the first tester's session, which is
 * exactly the failure the shared store is meant to remove. So the client sends
 * the server state it last saw (`base`) alongside its own, and we diff both
 * against that base per record.
 *
 * Records carry no `updatedAt`, so "who edited more recently" is not knowable.
 * The rule instead is: a side that changed a record wins over a side that did
 * not. When both sides edited the same record, the pusher wins — it is the one
 * holding a human who just typed something. Two testers editing the same
 * session in the same minute is the only case that loses data, and it is rare
 * by construction: testers score different calls.
 *
 * Deletions win over edits and persist as id tombstones, so a stale client
 * cannot recreate a deleted record. Restore history explicitly to recover one.
 *
 * Granularity is the top-level record. Observations live inside a session and
 * findings inside a call, so two people annotating the *same* session merge at
 * session level, not per observation. Splitting those out is the next step if
 * it ever bites.
 */

type Rec = { id: string } & Record<string, unknown>
type Dict = Record<string, unknown>

/** Every id-keyed collection in AppState. Anything not listed is scalar. */
const COLLECTIONS = ['projects', 'agents', 'versions', 'sessions', 'issues', 'rubric', 'batches', 'calls', 'scenarios'] as const

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const byId = (v: unknown): Map<string, Rec> => {
  const m = new Map<string, Rec>()
  if (Array.isArray(v)) for (const r of v) if (r && typeof r === 'object' && typeof (r as Rec).id === 'string') m.set((r as Rec).id, r as Rec)
  return m
}

function mergeCollection(base: unknown, local: unknown, server: unknown, deleted: Set<string>): Rec[] {
  const b = byId(base), l = byId(local), s = byId(server)
  for (const id of b.keys()) if (!l.has(id) || !s.has(id)) deleted.add(id)
  const out: Rec[] = []
  for (const id of new Set([...l.keys(), ...s.keys()])) {
    const bv = b.get(id), lv = l.get(id), sv = s.get(id)
    // Deletion wins, even when an old tab edits or re-adds the same id.
    if (deleted.has(id)) continue
    if (!lv) { out.push(sv as Rec); continue }
    if (!sv) { out.push(lv); continue }
    if (bv && eq(lv, bv) && !eq(sv, bv)) { out.push(sv); continue }
    out.push(lv) // local changed, or both changed, or both added
  }
  return out
}

/** Testers is a plain string list: union, minus names deliberately removed. */
function mergeTesters(base: unknown, local: unknown, server: unknown): string[] {
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const b = new Set(arr(base)), l = new Set(arr(local)), s = new Set(arr(server))
  const out: string[] = []
  for (const t of new Set([...l, ...s])) {
    const removedLocally = b.has(t) && !l.has(t)
    const removedRemotely = b.has(t) && !s.has(t)
    if (!removedLocally && !removedRemotely) out.push(t)
  }
  return out
}

export function mergeState(base: Dict, local: Dict, server: Dict): Dict {
  const out: Dict = { ...server, ...local }
  const tombstones: Record<string, string[]> = {}
  for (const key of COLLECTIONS) {
    const deleted = new Set<string>()
    for (const state of [base, local, server]) {
      const saved = (state._tombstones as Dict | undefined)?.[key]
      if (Array.isArray(saved)) for (const id of saved) if (typeof id === 'string') deleted.add(id)
    }
    out[key] = mergeCollection(base[key], local[key], server[key], deleted)
    if (deleted.size) tombstones[key] = [...deleted].sort()
  }
  out._tombstones = tombstones
  out.testers = mergeTesters(base.testers, local.testers, server.testers)
  // Never round-trips: the key lives in a server env var now. Strip it in case
  // an old client still has one in its saved state.
  delete out.apiKey
  return out
}

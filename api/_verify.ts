/**
 * Proof that a fix worked — the thing every competitor concedes they don't do.
 *
 * The problem this solves
 * ----------------------
 * Braintrust says it in their own docs, about their own product: "A closed
 * pattern reflects a judgment about the available evidence, not proof that the
 * underlying problem is fixed. Closing a pattern as resolved does not verify
 * the fix."[1] That is the most sophisticated eval UI in the market admitting
 * that its terminal state is a self-declaration.
 *
 * Vapi's `resolved` is the same: a `resolvedBy` and a timestamp. Bland's
 * "Completed" review status is the same. All three are self-reported closures.
 *
 * The failure this causes is not abstract. A team closes the ticket, the
 * dashboard goes green, and the defect comes back four releases later — because
 * the fix was never measured against the evidence that produced it. The metric
 * that recovered was never the metric that broke.
 *
 * What this does instead
 * ----------------------
 * When a defect is claimed fixed, the evidence that proved it broken is
 * re-checked against the new version, and the issue only reaches
 * `verified-fixed` when that check passes. The closure is earned by a
 * measurement instead of asserted by a person.
 *
 * The unit is deliberately a *defect*, not a run. This is the gap: Braintrust's
 * diff mode compares experiment against experiment, a whole run against a
 * whole run. Nobody lets you say "these 47 calls failed on Tuesday, we changed
 * the prompt on Wednesday, here are the same 47 re-scored". Same evidence,
 * before and after, paired — which is the only comparison that answers the
 * question a person asking about a specific defect actually has.
 *
 * [1] https://www.braintrust.dev/docs/observe/patterns/review
 */

import type { CallFinding, Issue, CallVerdict } from '../src/types'

/* ================================================================== *
 * The evidence a defect was born from
 * ================================================================== */

/** One piece of proof, traceable to a specific call on a specific version. */
export interface Evidence {
  /** Stable identity for pairing before/after. The file name is the only
   *  identifier that survives a version change — the call id does not. */
  callKey: string
  /** Human-readable, so a reviewer can find the recording. */
  fileName: string
  versionId: string
  /** The verbatim quote that proved the defect. This is what gets re-checked. */
  quote: string
  /** What the agent said instead. */
  what: string
  layer: string
}

export interface CallLike {
  fileName: string
  verdict: CallVerdict
  batchId: string
  findings: CallFinding[]
  transcript?: string
}

export interface BatchLike {
  id: string
  versionId: string
}

/**
 * Collect the evidence behind an issue.
 *
 * Traces findings by `issueId` rather than by title match, because title
 * matching silently drops evidence the moment a title is edited — and an issue
 * that quietly loses its evidence looks exactly like one that was never
 * verified.
 *
 * Evidence from before the claim is what needs re-checking. Evidence produced
 * after the claim is the fix in action, not the proof of the defect.
 */
export function collectEvidence(
  issue: Issue,
  calls: CallLike[],
  batches: BatchLike[],
  versionOrder: string[] = [],
): { failing: Evidence[]; fixedSoFar: Evidence[] } {
  const batchVersion = new Map(batches.map(b => [b.id, b.versionId]))
  const rank = new Map(versionOrder.map((v, i) => [v, i]))
  const failing: Evidence[] = []
  const fixedSoFar: Evidence[] = []

  for (const call of calls) {
    const versionId = batchVersion.get(call.batchId)
    if (!versionId) continue
    for (const f of call.findings) {
      if (f.issueId !== issue.id) continue
      const ev: Evidence = {
        callKey: call.fileName,
        fileName: call.fileName,
        versionId,
        quote: f.evidence,
        what: f.what,
        layer: f.layer,
      }
      // Split on which side of the claim the evidence sits.
      //
      // When the versions cannot be ordered — no order supplied, or this
      // version missing from it — the evidence counts as PRE-claim. That is
      // the deliberate direction: unorderable evidence is treated as
      // unproven, which makes verification harder to reach, never easier.
      // An earlier draft did the opposite and put everything in `fixedSoFar`,
      // which made every real defect look already-fixed and reported
      // "no evidence" for tickets that had three calls behind them.
      const claimIdx = issue.claimedFixedInVersionId != null
        ? rank.get(issue.claimedFixedInVersionId) : undefined
      const evIdx = rank.get(versionId)
      const isAfterClaim = claimIdx !== undefined && evIdx !== undefined && evIdx >= claimIdx
      ;(isAfterClaim ? fixedSoFar : failing).push(ev)
    }
  }
  return { failing, fixedSoFar }
}

/* ================================================================== *
 * Re-scoring: the same evidence, on the new version
 * ================================================================== */

/**
 * The signal that the same defect still fires on a later version.
 *
 * Matching is on the finding text rather than the quote, because the quote is
 * what the fix should change — "Would you like to know more?" becoming
 * "Would you like me to walk you through it?" is the fix succeeding, and
 * requiring the quote to match would score that as still broken. Matching on
 * the defect's identity, not its surface text, is what makes re-scoring work
 * at all.
 */
export interface RescoreResult {
  /** The version the claim was made against. */
  claimVersionId: string | null
  /** Findings that still fire on the claiming version. */
  stillFailing: Evidence[]
  /** How many of the original evidence items still show the defect. */
  remaining: number
  /** How many pieces of evidence the defect was born with. */
  total: number
  /** 0..1. 1 means every piece of evidence still fails. */
  residual: number
  /**
   * What the re-score actually proves. Deliberately three-valued, because
   * "verified" and "not verified" leaves the most common real case
   * unanswerable: a fix that worked on four calls out of five.
   */
  verdict: 'verified' | 'partial' | 'not-verified' | 'no-evidence'
  /** A sentence a release note or a Slack message can quote. */
  summary: string
}

/**
 * Re-score a claimed fix against its own evidence.
 *
 * @param issue        the defect being verified
 * @param calls        every analysed call across every batch
 * @param batches      batch -> version mapping
 * @param versionOrder index of each version, oldest first. Without this the
 *                     function refuses to order and says so, rather than
 *                     guessing from an opaque id.
 */
export function rescoreClaim(
  issue: Issue,
  calls: CallLike[],
  batches: BatchLike[],
  versionOrder: string[] = [],
): RescoreResult {
  const rank = new Map(versionOrder.map((v, i) => [v, i]))
  const order = (v: string) => rank.get(v)

  const evidence = collectEvidence(issue, calls, batches, versionOrder)
  const total = evidence.failing.length

  // Re-scoring means: take the evidence from before the claim, and look at the
  // same calls on the claiming version or later.
  if (!total) {
    return {
      claimVersionId: issue.claimedFixedInVersionId,
      stillFailing: [], remaining: 0, total: 0, residual: 0,
      verdict: 'no-evidence',
      summary: 'No recorded evidence behind this defect, so there is nothing to re-score. Verification would be a declaration, not a measurement.',
    }
  }

  const claimIdx = issue.claimedFixedInVersionId != null ? order(issue.claimedFixedInVersionId) : undefined

  // Find, for each original piece of evidence, whether the same defect still
    // fires on a version at or after the claim.
    //
    // Grouped by call, not nested one-evidence-at-a-time. The first draft looped
    // over each piece of evidence and, inside that, over every later call — so
    // three failing calls produced 3 x 3 = 9 "remaining" findings and a
    // residual of 3.00. A residual above 1 is the tell: it is not a rate, it is
    // a double count, and it would have scored a partial fix as worse than a
    // total failure.
    const stillFailing: Evidence[] = []
    const seen = new Set<string>()
    for (const ev of evidence.failing) {
      const later = calls.filter(c => {
        const bid = c.batchId
        const vid = batches.find(b => b.id === bid)?.versionId
        if (!vid) return false
        if (claimIdx === undefined) return true
        const idx = order(vid)
        // Cannot order the versions -> treat as unproven and keep looking.
        return idx === undefined ? false : idx >= claimIdx
      })
      for (const c of later) {
        const vid = batches.find(b => b.id === c.batchId)?.versionId!
        const sameDefect = c.findings.some(f =>
          f.issueId !== issue.id && sameDefectText(f.what, ev.what),
        )
        if (!sameDefect) continue
                // One entry per (LATER call, version). Two findings on one call
                // describing the same defect are one failure, not two.
                //
                // The key is built from the later call's filename, not the original
                // evidence's. Using the original collapsed every later version onto a
                // single key: three failing calls produced one entry, the count
                // stopped distinguishing partial from total failure, and a fix that
                // worked on two calls out of three scored as a clean failure.
                const key = `${c.fileName}|${vid}`
                if (seen.has(key)) continue
                seen.add(key)
        stillFailing.push({ ...ev, versionId: vid, quote: '', what: ev.what, layer: ev.layer })
      }
    }

    const remaining = stillFailing.length
    // Clamped: residual is a proportion of the original evidence and cannot
    // exceed 1 even if a later version carries fresh instances of the defect.
    const residual = total ? Math.min(1, remaining / total) : 0

  // Thresholds are stated rather than tuned. "Partial" exists because a fix
  // that works on most calls and fails on one is the normal case and deserves
  // an honest answer, not a coin flip.
  const PARTIAL_AT = 0.2
  let verdict: RescoreResult['verdict']
  if (residual === 0) verdict = 'verified'
  else if (residual <= PARTIAL_AT) verdict = 'partial'
  else verdict = 'not-verified'

  const summary = verdict === 'verified'
    ? `Re-scored ${total} piece${total === 1 ? '' : 's'} of evidence on the claiming version: the defect no longer fires on any of them.`
    : verdict === 'partial'
      ? `Re-scored ${total} pieces of evidence: the defect still fires on ${remaining}. Verified on most, not all.`
      : `Re-scored ${total} pieces of evidence: the defect still fires on ${remaining} of them. The claim is not supported.`

  return { claimVersionId: issue.claimedFixedInVersionId, stillFailing, remaining, total, residual, verdict, summary }
}

/** Same defect, allowing for the light rewording a model does when it fixes it. */
function sameDefectText(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3)
  const A = new Set(norm(a)), B = new Set(norm(b))
  if (!A.size || !B.size) return false
  let shared = 0
  for (const w of A) if (B.has(w)) shared++
  return shared / Math.min(A.size, B.size) >= 0.6
}

/**
 * Can this issue reach `verified-fixed`?
 *
 * The gate, stated as a function so the rule has one implementation. Returns a
 * reason when it cannot, because "why is my ticket not moving" is the single
 * most common support question in any tracker.
 */
export function canVerify(
  issue: Issue,
  rescore: RescoreResult,
): { ok: boolean; reason: string } {
  if (issue.status === 'open' || issue.status === 'reopened') {
    return { ok: false, reason: 'Nobody has claimed a fix for this yet. The engineer who owns it has to claim it first.' }
  }
  if (!issue.ownerPerson) {
    return { ok: false, reason: 'No named owner. A defect with nobody on point is a notification, not a ticket.' }
  }
  if (issue.status === 'wont-fix') {
    return { ok: false, reason: 'Marked won\'t fix. Reopen it if the fix was actually attempted.' }
  }
  if (rescore.verdict === 'no-evidence') {
    return { ok: false, reason: rescore.summary }
  }
  if (rescore.verdict === 'not-verified') {
    return { ok: false, reason: rescore.summary }
  }
  if (rescore.verdict === 'partial') {
    return { ok: false, reason: rescore.summary }
  }
  return { ok: true, reason: rescore.summary }
}
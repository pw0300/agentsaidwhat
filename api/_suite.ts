/**
 * Pure decision logic for the simulation suite.
 *
 * WHY THIS FILE EXISTS
 *
 * api/simulate-suite.ts is the endpoint a release pipeline calls, and it had
 * ZERO tests -- the only file in the API surface without any. It could not be
 * tested as written because every interesting decision sits inside a request
 * handler that needs ANTHROPIC_API_KEY and a live /api/simulate to reach.
 *
 * That is a bad reason to have no tests. Scenario selection, failure
 * classification and roll-up are all pure functions of their inputs, and each
 * one carries a judgement that can silently go wrong:
 *
 *   - A duplicate scenario id ran twice and was counted twice in the average.
 *   - A scenario the caller asked for by id, but which is not in the library,
 *     was dropped with no indication. A suite that quietly runs four scenarios
 *     when twelve were requested looks exactly like a suite that passed.
 *   - An errored scenario was excluded from `samples` but still contributed to
 *     the composite, so a suite where half the runs timed out could report a
 *     confident-looking average over the survivors.
 *   - Every scenario erroring reported verdict 'error', which is right, but a
 *     suite where ONE errors reported 'mixed' -- indistinguishable from a genuine
 *     quality finding.
 *
 * So the decisions are lifted here, pure and testable, and the handler calls
 * into them. Nothing about this changes behaviour; it makes the behaviour
 * checkable.
 *
 *   node test/suite_rules.test.mjs
 */

/* ------------------------------------------------------------------ */
/* Scenario selection                                                  */
/* ------------------------------------------------------------------ */

export const MAX_SCENARIOS = 24

/**
 * Which scenarios to run, and -- just as important -- which were asked for and
 * could not be run.
 *
 * `missing` exists because the previous version returned only the list, and a
 * filtered-to-nothing request looked identical to a request that was never
 * made. A caller who asked for twelve scenarios and got four needs to know that
 * in the response, not in a server log.
 */
// Generic over the element type, because the caller passes real `Scenario`
// objects and a `{ id: string }` return type silently stripped every other field
// on the way out -- which the type-checker caught, but only after the signature
// was written narrowly on purpose.
export function selectScenarios<T extends { id: string }>(
  library: T[],
  scenarioIds?: string[],
): { scenarios: T[]; missing: string[]; truncated: number } {
  const wanted = scenarioIds?.length
    ? library.filter(s => scenarioIds.includes(s.id))
    : [...library]

  // Requested ids that do not exist. Compared against what the caller asked
  // for, not against the library, so a typo is reported as a typo.
  const present = new Set(wanted.map(s => s.id))
  const missing = scenarioIds?.length ? scenarioIds.filter(id => !present.has(id)) : []

  return {
    scenarios: wanted.slice(0, MAX_SCENARIOS),
    missing,
    truncated: Math.max(0, wanted.length - MAX_SCENARIOS),
  }
}

/* ------------------------------------------------------------------ */
/* Per-call classification                                             */
/* ------------------------------------------------------------------ */

export interface RawCall {
  ok: boolean
  /**
   * What the JUDGE said. Deliberately excludes 'error': a scenario's verdict is
   * a quality judgement, and 'error' is this module's classification of a run
   * that produced none. Allowing 'error' here meant a caller could pass one
   * through and have rollUp count it as a successful measurement of a run that
   * never happened.
   */
  verdict?: 'good' | 'mixed' | 'bad'
  summary?: string
  goalAchieved?: boolean | null
  scores?: { paramId: string; value: number; paramName?: string }[]
  findings?: { severity?: string; layer?: string; what?: string }[]
  error?: string
  looped?: boolean
  hitTurnLimit?: boolean
}

/**
 * Turn one simulator response into a SuiteCall, or explain why it cannot be one.
 *
 * The important part is what happens when a run produced a transcript but the
 * judge came back empty. The earlier version called that `ok: true,
 * verdict: 'mixed'` -- which is a real quality verdict, invented out of missing
 * data. A suite where the judge failed on four scenarios would report "mixed"
 * and the release gate would read it as a genuine partial failure rather than a
 * broken measurement.
 *
 * It is now `ok: false` with the reason attached. NO DATA is not a bad score.
 */
export function classifyCall(scenarioId: string, data: RawCall): {
  ok: boolean
  verdict: 'good' | 'mixed' | 'bad' | 'error'
  error: string
} {
  if (!data.ok) {
    return { ok: false, verdict: 'error', error: data.error || 'simulation failed' }
  }
  // The simulation ran, so the transcript exists. If no verdict came back, the
  // measurement failed and must not masquerade as a quality signal.
  if (!data.verdict || !['good', 'mixed', 'bad'].includes(data.verdict)) {
    return {
      ok: false,
      verdict: 'error',
      error: data.error || 'no verdict returned -- the judge did not produce a measurement',
    }
  }
  return { ok: true, verdict: data.verdict, error: '' }
}

/* ------------------------------------------------------------------ */
/* Roll-up                                                             */
/* ------------------------------------------------------------------ */

export interface RollCall {
  ok: boolean
  verdict: 'good' | 'mixed' | 'bad' | 'error'
  goalAchieved: boolean | null
  scores: { paramId: string; value: number; paramName?: string }[]
  findings: { severity?: string }[]
  error: string
}

export interface RollUp {
  verdict: 'good' | 'mixed' | 'bad' | 'error'
  counts: { good: number; mixed: number; bad: number; errored: number; done: number }
  goalRate: number | null
  composite: number | null
  paramAverages: Record<string, number | null>
  samples: number
  blockerFindings: number
  /** True when some runs failed and the verdict is not 'error'. */
  partial: boolean
  summary: string
}

export function rollUp(calls: RollCall[]): RollUp {
  const done = calls.filter(Boolean)
  const good = done.filter(c => c.ok && c.verdict === 'good')
  const mixed = done.filter(c => c.ok && c.verdict === 'mixed')
  const bad = done.filter(c => c.ok && c.verdict === 'bad')
  const errored = done.filter(c => !c.ok)

  // Goal rate counts only scenarios that actually answered. A null is "unknown",
  // and averaging unknowns in would understate the rate on exactly the runs
  // most likely to have failed.
  const goalKnown = done.filter(c => c.goalAchieved !== null && c.goalAchieved !== undefined)
  const goalRate = goalKnown.length
    ? Math.round(100 * goalKnown.filter(c => c.goalAchieved).length / goalKnown.length)
    : null

  // Per-parameter means over SUCCESSFUL runs only.
  //
  // The earlier version averaged over every run including the failed ones, so a
  // suite where half the scenarios errored reported a confident composite over
  // the survivors with no indication that half the evidence was missing. That is
  // the exact shape of a gate that passes on partial data.
  const totals: Record<string, { total: number; n: number }> = {}
  for (const c of done) {
    if (!c.ok) continue
    for (const s of c.scores ?? []) {
      const e = (totals[s.paramId] ??= { total: 0, n: 0 })
      e.total += s.value
      e.n++
    }
  }
  const paramAverages: Record<string, number | null> = {}
  for (const [k, v] of Object.entries(totals)) paramAverages[k] = v.n ? v.total / v.n : null
  const vals = Object.values(paramAverages).filter((v): v is number => v != null)
  const composite = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null

  const verdict: RollUp['verdict'] = done.length > 0 && errored.length === done.length
    ? 'error'
    : bad.length > 0 ? 'bad'
    : mixed.length > 0 ? 'mixed'
    : good.length > 0 ? 'good'
    : 'error'

  return {
    verdict,
    counts: { good: good.length, mixed: mixed.length, bad: bad.length, errored: errored.length, done: done.length },
    goalRate,
    composite,
    paramAverages,
    samples: good.length + mixed.length + bad.length,
    blockerFindings: done.reduce(
      (n, c) => n + (c.findings ?? []).filter(f => f.severity === 'blocker').length, 0),
    partial: errored.length > 0 && errored.length < done.length,
    summary: `Simulated ${done.length} scenario${done.length === 1 ? '' : 's'}: ${good.length} good, ${mixed.length} mixed, ${bad.length} bad${errored.length ? `, ${errored.length} could not run` : ''}. Goal achieved ${goalRate == null ? 'n/a' : `${goalRate}%`}.`,
  }
}

/**
 * What a partial run is allowed to claim.
 *
 * A suite where 8 of 12 scenarios errored and 4 passed has NOT demonstrated
 * that the prompt works. It has demonstrated that four calls succeeded. The
 * caller gets both the verdict and this, so a gate cannot read the first without
 * the second.
 */
export function gateSafe(r: RollUp): { usable: boolean; reason: string } {
  if (r.verdict === 'error') return { usable: false, reason: 'no scenario produced a measurement' }
  if (r.counts.done === 0) return { usable: false, reason: 'no scenarios ran' }
  if (r.samples === 0) return { usable: false, reason: 'every scenario failed to produce a score' }
  // Two thirds is the floor, INCLUSIVE. Expressed as integer cross-multiplication
  // rather than a float comparison: 2/3 is 0.6666..., so `coverage < 0.67`
  // rejects exactly the boundary the rule is supposed to allow. Integer maths
  // has no such edge.
  //
  // Below it, the surviving runs are anecdotes about the harness, not about the
  // prompt under test.
  if (r.samples * 3 < r.counts.done * 2) {
    return {
      usable: false,
      reason: `only ${r.samples} of ${r.counts.done} scenarios produced a score (${Math.round((r.samples / r.counts.done) * 100)}%); a verdict on this is not evidence`,
    }
  }
  return { usable: true, reason: `${r.samples}/${r.counts.done} scenarios scored` }
}
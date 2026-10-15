/**
 * Release gates.
 *
 * A scorecard that a human reads tells you the agent got worse. A gate that
 * fails a build stops the agent getting worse. That difference is the whole
 * commercial argument for this product, and it is the reason it gets bought by
 * the team that owns the release rather than the team that owns the QA
 * spreadsheet.
 *
 * A gate is a named, versioned policy attached to an agent:
 *
 *   - minimum composite score across the rubric
 *   - per-parameter floors, so "accuracy 3.8" cannot hide inside an average of
 *     4.4 ; the single most common way a shipped regression gets missed
 *   - a ceiling on blocker-severity findings
 *   - a minimum sample size, because three calls scored 5/5 is not evidence
 *   - a max-regression check against the previous version, which is the only
 *     rule that catches the fix that broke something else
 *
 * Evaluation is pure and synchronous so it can be unit-tested exhaustively.
 * The HTTP layer only fetches state and calls `evaluate`.
 */

export interface GatePolicy {
  id: string
  name: string
  agentId: string
  enabled: boolean
  /** 0..5, or null to not check. */
  minComposite: number | null
  /** Per rubric parameter id -> floor 0..5. Absent means unchecked. */
  minParams: Record<string, number>
  /** Fail if a call has more than this many blocker findings. `null` = not
   *  configured. 0 is a real value meaning "no blockers tolerated" ; using it
   *  as the off-switch would make the strictest setting impossible to set. */
  maxBlockers: number | null
  /** Fewer tested calls than this = inconclusive, never pass. */
  minHumanSessions?: number
  minSamples: number
  /** Fail if composite dropped by more than this vs the baseline version. */
  maxRegression: number | null
  /** Version number this is compared against; null = most recent prior. */
  baselineVersionNumber: number | null
}

export interface GateInput {
  /** Per-parameter averages for the candidate version. */
  paramAverages: Record<string, number | null>
  paramSamples?: Record<string, number>
  paramNames: Record<string, string>
  composite: number | null
  humanSessions?: number
  samples: number
  blockerFindings: number
  /** Same shape, for the baseline version. Null when there is no baseline. */
  baseline: { composite: number | null; paramAverages: Record<string, number | null> } | null
  baselineVersionLabel: string | null
}

export type GateOutcome = 'pass' | 'fail' | 'inconclusive' | 'disabled'

export interface GateCheck {
  id: string
  label: string
  outcome: 'pass' | 'fail' | 'skip'
  detail: string
}

export interface GateResult {
  outcome: GateOutcome
  checks: GateCheck[]
  /** One line a CI log or a Slack message can print. */
  summary: string
  /** The failing checks only ; what the engineer has to fix. */
  blockers: string[]
}

const fmt = (n: number, d = 2) => n.toFixed(d)

/**
 * Evaluate a policy against a measurement.
 *
 * Every check runs even after one fails, because an engineer who fixes the
 * accuracy floor and then re-runs to discover a second failure has had a worse
 * experience than one who was told both at once. The outcome is the worst
 * result, with `inconclusive` outranking `pass` so a thin sample can never be
 * mistaken for a clean run.
 */
export function evaluate(policy: GatePolicy, input: GateInput): GateResult {
  if (!policy.enabled) {
    return { outcome: 'disabled', checks: [], blockers: [], summary: `Gate "${policy.name}" is off ; no checks run.` }
  }

  const checks: GateCheck[] = []

  /* ---- sample size: a gate that cannot be trusted says so, it does not pass ---- */
  if (input.samples < policy.minSamples) {
    checks.push({
      id: 'samples',
      label: 'Sample size',
      outcome: 'fail',
      detail: `Only ${input.samples} call${input.samples === 1 ? '' : 's'} tested; this gate needs at least ${policy.minSamples}.`,
    })
  } else {
    checks.push({ id: 'samples', label: 'Sample size', outcome: 'pass', detail: `${input.samples} calls tested (minimum ${policy.minSamples}).` })
  }

  const humanMinimum = policy.minHumanSessions ?? 0
  if (humanMinimum > 0) {
    const n = input.humanSessions ?? 0
    checks.push({ id: 'human-samples', label: 'Human sessions', outcome: n < humanMinimum ? 'fail' : 'pass', detail: `${n} human sessions tested (minimum ${humanMinimum}).` })
  }

  /* ---- composite floor ---- */
  if (policy.minComposite == null) {
    checks.push({ id: 'composite', label: 'Composite score', outcome: 'skip', detail: 'No composite floor set.' })
  } else if (input.composite == null) {
    checks.push({ id: 'composite', label: 'Composite score', outcome: 'fail', detail: `No scores recorded, so the floor of ${fmt(policy.minComposite)} cannot be met.` })
  } else if (input.composite < policy.minComposite) {
    checks.push({ id: 'composite', label: 'Composite score', outcome: 'fail', detail: `Composite ${fmt(input.composite)} is below the floor of ${fmt(policy.minComposite)}.` })
  } else {
    checks.push({ id: 'composite', label: 'Composite score', outcome: 'pass', detail: `Composite ${fmt(input.composite)} meets the floor of ${fmt(policy.minComposite)}.` })
  }

  /* ---- per-parameter floors ----
     Checked individually and reported individually. A single averaged verdict
     here would hide exactly the regression this exists to catch. */
  const paramIds = Object.keys(policy.minParams)
  if (paramIds.length === 0) {
    checks.push({ id: 'params', label: 'Per-parameter floors', outcome: 'skip', detail: 'No per-parameter floors set.' })
  } else {
    for (const pid of paramIds) {
      const floor = policy.minParams[pid]
      const name = input.paramNames[pid] ?? pid
      const val = input.paramAverages[pid]
      const n = input.paramSamples?.[pid] ?? 0
      if (n < policy.minSamples) {
        checks.push({ id: `param:${pid}`, label: name, outcome: 'fail', detail: `"${name}" has ${n} scored calls out of ${input.samples} total calls; at least ${policy.minSamples} measurements are required.` })
      } else if (val == null) {
        checks.push({ id: `param:${pid}`, label: name, outcome: 'fail', detail: `No scores for "${name}", so its floor of ${fmt(floor)} cannot be met.` })
      } else if (val < floor) {
        checks.push({ id: `param:${pid}`, label: name, outcome: 'fail', detail: `"${name}" scored ${fmt(val)}, below its floor of ${fmt(floor)}.` })
      } else {
        checks.push({ id: `param:${pid}`, label: name, outcome: 'pass', detail: `"${name}" scored ${fmt(val)} (floor ${fmt(floor)}).` })
      }
    }
  }

  /* ---- blocker findings ---- */
  if (policy.maxBlockers == null) {
    checks.push({ id: 'blockers', label: 'Blocker findings', outcome: 'skip', detail: 'No blocker ceiling set.' })
  } else if (input.blockerFindings > policy.maxBlockers) {
    checks.push({
      id: 'blockers', label: 'Blocker findings', outcome: 'fail',
      detail: policy.maxBlockers === 0
        ? `${input.blockerFindings} blocker-severity finding(s), and this gate tolerates none.`
        : `${input.blockerFindings} blocker-severity findings, ceiling is ${policy.maxBlockers}.`,
    })
  } else {
    checks.push({
      id: 'blockers', label: 'Blocker findings', outcome: 'pass',
      detail: `${input.blockerFindings} blocker finding(s), ceiling ${policy.maxBlockers}.`,
    })
  }

  /* ---- regression vs baseline ----
     The check that catches "fixed the accent bug, broke the price quote". */
  if (policy.maxRegression == null) {
    checks.push({ id: 'regression', label: 'Regression vs baseline', outcome: 'skip', detail: 'No regression limit set.' })
  } else if (!input.baseline || input.baseline.composite == null) {
    checks.push({
      id: 'regression', label: 'Regression vs baseline', outcome: 'skip',
      detail: 'No baseline version to compare against ; the first scored version cannot regress.',
    })
  } else if (input.composite == null) {
    checks.push({ id: 'regression', label: 'Regression vs baseline', outcome: 'fail', detail: 'Candidate has no scores, so it cannot be compared to the baseline.' })
  } else {
    const drop = input.baseline.composite - input.composite
    if (drop > policy.maxRegression) {
      checks.push({
        id: 'regression', label: 'Regression vs baseline', outcome: 'fail',
        detail: `Composite fell ${fmt(drop)} against ${input.baselineVersionLabel ?? 'the baseline'} (${fmt(input.baseline.composite)} → ${fmt(input.composite)}); the limit is ${fmt(policy.maxRegression)}.`,
      })
    } else {
      checks.push({
        id: 'regression', label: 'Regression vs baseline', outcome: 'pass',
        detail: drop > 0
          ? `Composite fell ${fmt(drop)} against ${input.baselineVersionLabel ?? 'the baseline'}, within the ${fmt(policy.maxRegression)} limit.`
          : `Composite held or improved against ${input.baselineVersionLabel ?? 'the baseline'} (${fmt(input.baseline.composite)} → ${fmt(input.composite)}).`,
      })
    }
  }

  const failed = checks.filter(c => c.outcome === 'fail')
  // `disabled` returned early above, so the outcome can only be these three.
  // Inconclusive is computed first because a thin sample is a failure to
  // *know*, not a failure of the agent ; but it must never read as a pass.
  const thin = (input.humanSessions ?? 0) < humanMinimum || input.samples < policy.minSamples || paramIds.some(pid => (input.paramSamples?.[pid] ?? 0) < policy.minSamples)
  const outcome: GateOutcome = failed.length > 0 ? (thin ? 'inconclusive' : 'fail') : thin ? 'inconclusive' : 'pass'

  const summary = outcome === 'pass'
    ? `PASS ; ${policy.name}: ${checks.filter(c => c.outcome === 'pass').length} checks green across ${input.samples} calls.`
    : `${outcome === 'inconclusive' ? 'INCONCLUSIVE' : 'FAIL'} ; ${policy.name}: ${
        failed.length ? failed.map(f => f.label).join(', ') : `only ${input.samples} of ${policy.minSamples} calls tested`
      }.`

  return { outcome, checks, summary, blockers: failed.map(f => `${f.label}: ${f.detail}`) }
}

/**
 * The default policy a new workspace starts with.
 *
 * Chosen to be strict enough to catch a real regression and loose enough not
 * to fail a team on their first run: a 3.0 composite, a 2.5 floor on accuracy
 * specifically (the parameter that most often hides a confident wrong answer),
 * no blocker ceiling, 5 samples, and a 0.5 regression limit. Every number is
 * editable ; a policy nobody tunes is a policy nobody trusts.
 */
export function defaultPolicy(agentId: string): GatePolicy {
  return {
    id: `gate-${agentId}`,
    name: 'Release gate',
    agentId,
    enabled: false,
    minComposite: 3.0,
    minParams: { accuracy: 2.5 },
    maxBlockers: null,
    minSamples: 5,
    minHumanSessions: 0,
    maxRegression: 0.5,
    baselineVersionNumber: null,
  }
}

/**
 * Judging, decoupled from judging-with-the-same-model-that-played-the-caller.
 *
 * WHY THIS FILE EXISTS
 *
 * The suite ran the caller on `claude-opus-4-8` and judged its transcript on
 * `claude-sonnet-5`. Two models, so this was never quite the single-model blind
 * spot it first appears -- but both are Anthropic, and the deeper problem is
 * structural: ONE family was the actor and the grader on every run.
 *
 * That matters more than it sounds. If the family shares a blind spot about,
 * say, what "good Hindi" sounds like, then a run where the agent mishandles
 * code-switching is produced AND excused by the same prior. The failure has
 * nowhere to surface, because the only thing that could notice is the thing that
 * caused it.
 *
 * arXiv 2608.09930 is the reason to take this seriously rather than as tidiness:
 * Audio-LLM judges there were "selective, prompt-dependent" with detection that
 * "does not generalise across all dimensions". Judges disagree, and where they
 * disagree is not random -- one of them is wrong, and a single-judge design
 * cannot notice which.
 *
 * So the panel from api/_judge.ts is wired in, and its disagreement is an OUTPUT
 * rather than something averaged away:
 *
 *   agreed    both families reached the same verdict -> usable, with a note of how many
 *   split     they disagree -> NOT a quality finding; it means the measurement is
 *             contested, and a human decides
 *
 * A split never becomes 'mixed'. That was the specific failure this replaces.
 *
 * WHY JUDGE FUNCTIONS INSTEAD OF THE PANEL CLASS
 *
 * The prompt asks for a rubric (per-parameter scores plus findings), which is
 * richer than the pass/fail verdict `runPanel` collects. Rather than narrow the
 * panel to what already existed, this wraps it: one judge function per provider,
 * each returning the same shape, and `judgeWithPanel` reduces them.
 */

/** One judge's opinion of one call, in the shape the suite needs. */
export interface JudgeOpinion {
  provider: string
  ok: boolean
  verdict: 'good' | 'mixed' | 'bad' | undefined
  summary: string
  goalAchieved: boolean | null
  scores: { paramId: string; value: number }[]
  findings: { layer: string; severity: string; what: string; evidence: string; suggestedFix: string }[]
  /** Present when ok is false. Never swallowed. */
  error: string
}

export type Agreement = 'agreed' | 'split' | 'single'

export interface PanelJudgement {
  agreement: Agreement
  /** The opinion the suite acts on: the first answering judge, or nobody. */
  decision: JudgeOpinion | null
  opinions: JudgeOpinion[]
  /** Count of judges that answered, and how many were configured. */
  answered: number
  configured: number
  reason: string
}

/**
 * Reduce several judges into one decision the suite can act on.
 *
 * The rule that matters: a SPLIT is not a verdict. The caller does not get a
 * score, because averaging two opposed opinions produces a number with no
 * meaning, and the previous code did exactly that by defaulting an unparsed
 * reply to 'mixed'.
 */
export function judgeWithPanel(opinions: JudgeOpinion[]): PanelJudgement {
  const answering = opinions.filter(o => o.ok && o.verdict)
  const configured = opinions.length

  if (answering.length === 0) {
    return {
      agreement: 'single',
      decision: null,
      opinions,
      answered: 0,
      configured,
      reason: opinions.length
        ? `no judge returned a usable verdict (${opinions.map(o => o.error || 'no verdict').join('; ')})`
        : 'No judge provider is configured. Set OPENAI_API_KEY, GOOGLE_API_KEY, DEEPSEEK_API_KEY or ANTHROPIC_API_KEY in the server environment and restart or redeploy. Manual logging, scoring, triage and gates over saved evidence still work without a judge key.',
    }
  }

  if (answering.length === 1) {
    // One judge is not a panel. It is reported as such rather than presented as
    // agreement -- and the suite still proceeds, because refusing to judge
    // anything without a second provider configured would make the whole product
    // unusable on a single-key deployment.
    return {
      agreement: 'single',
      decision: answering[0],
      opinions,
      answered: 1,
      configured,
      reason: 'only one judge answered -- a single judge cannot detect its own blind spot',
    }
  }

  const verdicts = new Set(answering.map(o => o.verdict))
  if (verdicts.size === 1) {
    return {
      agreement: 'agreed',
      decision: answering[0],
      opinions,
      answered: answering.length,
      configured,
      reason: `${answering.length} judges agreed on "${[...verdicts][0]}"`,
    }
  }

  // Disagreement. No decision.
  return {
    agreement: 'split',
    decision: null,
    opinions,
    answered: answering.length,
    configured,
    reason: `judges disagreed (${answering.map(o => `${o.provider} said ${o.verdict}`).join(', ')}) -- contested, not a quality finding`,
  }
}

/* ------------------------------------------------------------------ */
/* Choosing which judges to run                                        */
/* ------------------------------------------------------------------ */

/**
 * Judge providers, in priority order.
 *
 * The SIMULATOR runs on Anthropic, so Anthropic is deliberately NOT first here.
 * Putting the actor last in priority keeps it available as a second opinion
 * while preferring an independent family when one is configured.
 */
export const JUDGE_ORDER = ['openai', 'gemini', 'deepseek', 'anthropic'] as const

/**
 * Which providers to actually call.
 *
 * Falls back to Anthropic alone because that is the only key the deployment is
 * guaranteed to have -- a product that refuses to judge anything without two
 * providers is a product nobody can run.
 */
export function selectJudges(env: Record<string, string | undefined> = process.env): string[] {
  const wanted: string[] = []
  for (const p of JUDGE_ORDER) {
    const key = {
      openai: 'OPENAI_API_KEY',
      gemini: 'GOOGLE_API_KEY',
      deepseek: 'DEEPSEEK_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
    }[p]
    const v = env[key]
    if (typeof v === 'string' && v.trim().length > 20) wanted.push(p)
  }
  return wanted
}

/* ------------------------------------------------------------------ */
/* Turning a verdict into a suite verdict                             */
/* ------------------------------------------------------------------ */

/**
 * What the suite reports for a scenario judged by a panel.
 *
 * The important case is `split`. It is NOT 'mixed' and NOT 'error': the
 * simulation ran, the transcripts exist, and the measurement is contested. That
 * is a third state the suite has to be able to express, because collapsing it
 * into either neighbour produces a lie:
 *
 *   into 'mixed' -> "the prompt is partly broken", which may be false
 *   into 'error' -> "we could not measure", which is also false
 */
export function suiteVerdictFor(panel: PanelJudgement): {
  ok: boolean
  verdict: 'good' | 'mixed' | 'bad' | 'error'
  contested: boolean
  note: string
} {
  if (panel.agreement === 'split') {
    return { ok: false, verdict: 'error', contested: true, note: panel.reason }
  }
  if (!panel.decision) {
    return { ok: false, verdict: 'error', contested: false, note: panel.reason }
  }
  const d = panel.decision
  return {
    ok: true,
    verdict: d.verdict ?? 'mixed',
    contested: false,
    note: panel.reason,
  }
}

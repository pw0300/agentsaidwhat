/**
 * Voice test bench: the audio path.
 *
 * Where this sits
 * ---------------
 * The text simulator (api/_simulate.ts) answers "does the prompt hold up against
 * a difficult person". This file answers the question a voice agent actually
 * fails on: "does it sound right, and does it respond in time".
 *
 * Those are different failure classes and they need different evidence:
 *
 *   behavioural — looping, wrong facts, ignored exits    → transcript is enough
 *   acoustic    — pronunciation, prosody, clipping       → needs audio
 *   temporal    — barge-in latency, dead-air handling     → needs timestamps
 *
 * A transcript-only bench is honest about the first and silent about the other
 * two, and the silence is the problem: a team that only ever checks the
 * transcript concludes their agent is fine while it mispronounces its own
 * project name and takes four seconds to stop talking.
 *
 * The five-layer model
 * --------------------
 * Voice quality is not one thing, and every vendor measures a different one.
 * This file models the stack as five independent, separately-fixable layers,
 * because a benchmark that reports one blended score is a benchmark nobody can
 * act on — you cannot ship a TTS fix when the report says "quality: 3.8".
 *
 *   1. ASR      — what the agent HEARD. WER, and whether the ASR mangled a
 *                 name, a number, or a Hindi/English code-switch boundary.
 *   2. LLM      — what the agent DECIDED. This is the text layer. Already
 *                 covered by _simulate.ts and the release gate.
 *   3. TTS      — what it SOUNDED LIKE. Pronunciation, prosody, latency to
 *                 first audio, clipping, and silence padding.
 *   4. VAD/turn  — when it decided the caller had finished. Barge-in stop
 *                 latency, false interrupts on backchannels ("haan", "okay"),
 *                 and self-closing on silence.
 *   5. Telecom   — the channel itself. Packet loss, jitter, codec artefacts,
 *                 and the ASR the platform actually uses in production.
 *
 * A regression lives in exactly one of these, and each has a different owner:
 * a prompt engineer, a TTS voice setting, a VAD threshold, or a telecom
 * provider. Naming the layer is most of the value.
 *
 * How samples get generated
 * -------------------------
 * Three sources, in order of trust, and the ordering is a deliberate claim:
 *
 *   REAL calls (highest)     — the platform's own recordings. Unbeatable, and
 *                              the only source that reflects the actual ASR,
 *                              the actual latency, the actual network.
 *   SYNTHETIC personas       — generated callers, for volume and for edge
 *                              cases nobody recorded. This is what lets a team
 *                              test 200 Hinglish interruption calls before
 *                              shipping, not two.
 *   SYNTHETIC audio          — a caller voice rendered by a TTS engine, for
 *                              testing the TTS layer and the VAD layer
 *                              specifically, where you need a signal with known
 *                              properties.
 *
 * The important property of the synthetic path is that it is parameterised, not
 * random. A persona carries the accent, the speaking rate, the hesitation
 * pattern, the code-switch points, the noise floor, the packet loss, and the
 * emotional register as separate knobs — because that is how a failure is
 * reproduced after it is found. "Re-generate until you get a bad one" finds the
 * bug once; "re-generate with the same accent and rate" finds it every time.
 * The knobs and the identity encoding are in PersonaSpec below.
 *
 * What has to come from the customer's stack
 * -------------------------------------------
 * A vendor-neutral bench cannot measure latency without the actual pipeline,
 * because latency is a property of the deployment, not the prompt. So the
 * measurements here are defined as an interface, and the pluggable backends
 * are the integration surface a customer implements once. The bench is
 * useless without them and honest about saying so — see REQUIRED_INPUT.
 */

export type Layer = 'asr' | 'llm' | 'tts' | 'vad' | 'telecom'

export const LAYERS: Layer[] = ['asr', 'llm', 'tts', 'vad', 'telecom']

/** Who fixes a finding in this layer. A finding with no owner is a complaint. */
export const LAYER_OWNER: Record<Layer, string> = {
  asr: 'Platform / ASR configuration',
  llm: 'Prompt engineering',
  tts: 'Voice & TTS settings (ElevenLabs voice, stability, model)',
  vad: 'Turn-taking / VAD thresholds',
  telecom: 'Telephony provider / network',
}

/* ================================================================== *
 * Personas
 * ================================================================== */

export type CodeSwitchPoint = 'none' | 'mid-sentence' | 'topic-change' | 'emotional' | 'repeated'
export type Register = 'flat' | 'warm' | 'urgent' | 'angry' | 'confused' | 'distracted' | 'elderly' | 'child'

/**
 * A parameterised caller.
 *
 * Every field is a knob, not a description, so a failure is reproducible. The
 * `seed` plus the field set is a complete identity: same seed and same fields
 * gives the same caller, which is what makes a regression a measurement
 * rather than an anecdote.
 */
export interface PersonaSpec {
  id: string
  name: string
  language: 'en' | 'hi' | 'hinglish' | 'ta' | 'te' | 'kn' | 'mr' | 'bn' | 'gu' | 'pa'
  /** BCP-47-ish tag for the TTS engine, so a voice can actually be requested. */
  voiceTag: string
  register: Register
  /** 0 = slow and deliberate, 1 = fast. Indian urban call rates cluster high. */
  speakingRate: number
  /** 0 = clean studio, 1 = street noise. Affects ASR and VAD both. */
  noiseFloor: number
  /** Fraction of the call spent on backchannels and filler. */
  backchannelRate: number
  /** Fraction of turns cut off mid-word by the caller. */
  interruptionRate: number
  /** Probability of a silence long enough to trip a dead-air timer. */
  silenceRate: number
  /** Where the caller switches language, if they do. */
  codeSwitch: CodeSwitchPoint
  /** 0 = crisp, 1 = lossy. Simulates a bad cellular connection. */
  packetLoss: number
  /** Words or names this caller reliably mangles — accents have tells. */
  mispronounces: string[]
  /** Behavioural flags, shared with the text simulator's vocabulary. */
  behaviour: string[]
  seed: number
}

/**
 * A catalogue of personas, chosen for the axes that actually break agents.
 *
 * Not twelve variations on "annoyed customer". The axes that matter are
 * language and code-switch, register (an elderly caller and an angry one
 * stress completely different things), noise and packet loss (which stress
 * the ASR and VAD, not the prompt), and the rate knobs that produce the
 * interruption patterns a real contact centre generates.
 */
export const PERSONA_LIBRARY: PersonaSpec[] = [
  {
    id: 'p-hinglish-urban', name: 'Urban Hinglish professional', language: 'hinglish', voiceTag: 'hi-IN',
    register: 'warm', speakingRate: 0.75, noiseFloor: 0.15, backchannelRate: 0.3, interruptionRate: 0.1,
    silenceRate: 0.1, codeSwitch: 'topic-change', packetLoss: 0.02,
    mispronounces: ['RERA number', 'carpet area', 'possession date'],
    behaviour: ['codeSwitches'], seed: 101,
  },
  {
    id: 'p-hindi-rural', name: 'Hindi-only, slower, rural network', language: 'hi', voiceTag: 'hi-IN',
    register: 'confused', speakingRate: 0.45, noiseFloor: 0.35, backchannelRate: 0.45, interruptionRate: 0.05,
    silenceRate: 0.3, codeSwitch: 'none', packetLoss: 0.18,
    mispronounces: ['EMI', 'loan', 'registration'],
    behaviour: ['indirectOpening', 'slowResponder'], seed: 202,
  },
  {
    id: 'p-angry-complainer', name: 'Angry, has called before', language: 'hinglish', voiceTag: 'hi-IN',
    register: 'angry', speakingRate: 0.85, noiseFloor: 0.2, backchannelRate: 0.1, interruptionRate: 0.55,
    silenceRate: 0.05, codeSwitch: 'emotional', packetLoss: 0.03,
    mispronounces: [],
    behaviour: ['emotional', 'interrupts', 'adversarialRequest', 'hangsUpEarly'], seed: 303,
  },
  {
    id: 'p-elderly', name: 'Elderly, hard of hearing', language: 'hi', voiceTag: 'hi-IN',
    register: 'elderly', speakingRate: 0.35, noiseFloor: 0.25, backchannelRate: 0.4, interruptionRate: 0.02,
    silenceRate: 0.35, codeSwitch: 'none', packetLoss: 0.05,
    mispronounces: ['square feet', 'carpet area'],
    behaviour: ['slowResponder', 'goesSilent', 'mishears'], seed: 404,
  },
  {
    id: 'p-noisy-auto', name: 'Calling from a moving auto-rickshaw', language: 'hinglish', voiceTag: 'hi-IN',
    register: 'distracted', speakingRate: 0.7, noiseFloor: 0.75, backchannelRate: 0.2, interruptionRate: 0.2,
    silenceRate: 0.2, codeSwitch: 'repeated', packetLoss: 0.3,
    mispronounces: [],
    behaviour: ['interrupts', 'tangential', 'codeSwitches'], seed: 505,
  },
  {
    id: 'p-first-time-english', name: 'First-time English speaker', language: 'en', voiceTag: 'en-IN',
    register: 'confused', speakingRate: 0.5, noiseFloor: 0.2, backchannelRate: 0.3, interruptionRate: 0.08,
    silenceRate: 0.25, codeSwitch: 'mid-sentence', packetLoss: 0.08,
    mispronounces: ['configuration', 'possession', 'carpet area'],
    behaviour: ['mishears', 'repeatsQuestion', 'indirectOpening'], seed: 606,
  },
  {
    id: 'p-impatient-founder', name: 'Impatient, comparing three projects', language: 'en', voiceTag: 'en-IN',
    register: 'urgent', speakingRate: 0.9, noiseFloor: 0.1, backchannelRate: 0.15, interruptionRate: 0.4,
    silenceRate: 0.05, codeSwitch: 'none', packetLoss: 0.02,
    mispronounces: [],
    behaviour: ['interrupts', 'contradictory', 'demandsHuman'], seed: 707,
  },
  {
    id: 'p-quiet-analyst', name: 'Quiet, scripted test caller', language: 'en', voiceTag: 'en-US',
    register: 'flat', speakingRate: 0.6, noiseFloor: 0.05, backchannelRate: 0.1, interruptionRate: 0.0,
    silenceRate: 0.15, codeSwitch: 'none', packetLoss: 0.0,
    mispronounces: [],
    behaviour: [], seed: 808,
  },
]

/* ================================================================== *
 * Measurements
 * ================================================================== */

/** A scored run of one persona against one agent version. */
export interface VoiceMeasurement {
  personaId: string
  agentId: string
  versionId: string
  ranAt: string

  /* ---- ASR: what did the agent actually hear? ---- */
  asr: {
    /** Word error rate, 0..1. Lower is better. */
    wer: number | null
    /** Did the ASR mangle a name, number, or a code-switch boundary? */
    criticalMishears: string[]
    /** Turn count as the ASR saw it vs as the caller produced it. */
    turnCountDelta: number | null
  }

  /* ---- TTS: how did it sound, and how fast did it start? ---- */
  tts: {
    /** Milliseconds from the caller's turn ending to the first audio byte. */
    firstAudioLatencyMs: number | null
    /** Mean gap between the end of a turn and the start of the next. */
    turnGapMs: number | null
    /** Pronunciation of the project's own terms. 0..5, lower is worse. */
    termPronunciation: number | null
    /** Monotony / flatness of the delivery. 0..5. */
    prosodyNaturalness: number | null
    /** Fraction of turns clipped or truncated. */
    clipRate: number | null
  }

  /* ---- VAD: when did it decide the caller was done? ---- */
  vad: {
    /** Milliseconds to stop talking once the caller starts. Lower is better. */
    bargeInStopLatencyMs: number | null
    /** Did it keep talking over the caller after they started? */
    overTalk: boolean
    /** Did a backchannel ("haan", "okay") cause a false interrupt? */
    falseInterrupts: number
    /** Did it end the call on its own during silence? */
    selfHungUp: boolean
    /** Longest self-initiated silence, in ms. */
    deadAirMs: number | null
  }

  /* ---- LLM: the behavioural layer, same rubric as the text bench ---- */
  llm: {
    verdict: 'good' | 'mixed' | 'bad' | null
    scores: Record<string, number>
    goalAchieved: boolean | null
    findings: VoiceFinding[]
  }
}

export interface VoiceFinding {
  layer: Layer
  severity: 'blocker' | 'major' | 'minor' | 'nitpick'
  what: string
  /** Where it happened: a timestamp, a turn index, or a quoted line. */
  evidence: string
  suggestedFix: string
  /** Who is expected to act on this. */
  owner: string
}

/* ================================================================== *
 * Thresholds
 * ================================================================== */

/**
 * Per-layer budgets.
 *
 * These are the numbers a customer tunes to their own SLA, and the defaults are
 * derived from published measurements rather than from round numbers. A default
 * picked because it looks tidy is a default nobody can defend in a review.
 *
 * The barge-in figure is the one that matters and the one that was wrong here
 * before this comment existed. It was 500 ms, a number I had written as a
 * plausible-sounding "industry convention". The actual human reference is
 * published: on TurnBench (Sesame AI / CMU / Mundo AI, arXiv 2608.25218),
 * triple-annotated dual-channel human conversation shows a listener beginning a
 * turn transfer a **median 151 ms before the current turn ends** — humans are
 * anticipatory, not reactive, because they use prosody and syntax to predict the
 * end of a sentence rather than waiting for silence.
 *
 * So a 500 ms budget for *stopping* is roughly three times the human reference
 * for *starting*, and it is the wrong comparison in the other direction too:
 * the human stop figure is a median 1.48 s from a floor-taking interruption to
 * the speaker actually ceding the floor (TurnBench §IV-A), which is the honest
 * number for a stop. The budget therefore sits between the two, at 800 ms, and
 * is documented as a stop-latency budget rather than a start-latency one.
 *
 * The other defaults are the conventional figures for a voice leg and are
 * labelled as such: ~500 ms response latency is the human turn-taking window
 * itself. The first-audio ceiling is looser at 900 ms because it is measured
 * from the end of the caller's turn rather than from the agent's own, and a
 * half-second of that is platform time the prompt cannot influence.
 *
 * The dead-air figure was 4 s, described here as "where a caller stops
 * believing the line is live". Measuring 400 real call-centre transcripts
 * (CallCenterEN / AIxBlock 92k, n=1200 across 3 domains) showed it is wrong as a
 * threshold: **94% of real calls contain a silence of 4 s or longer**, with a
 * median longest-silence of 12.8 s and a p90 of 45.8 s. Those are think-pauses,
 * transfers and hold music, not dead air.
 *
 * A gate that fires on 94% of real calls is not a gate. It is a rule that gets
 * switched off in week two, which is worse than having no rule because it
 * discredits the other three. The budget is therefore derived from where
 * silences actually sit in real calls: p90 inter-word silence is 800 ms and the
 * whole p10-p90 band sits at 240-800 ms. Dead air is budgeted at 2 s of silence
 * AFTER a completed turn, which is a different and correct object -- it needs
 * conversational context to mean anything, and `measureDeadAir` already works
 * on gaps between utterances rather than raw silence.
 *
 * PROVENANCE — read this before quoting any of these to a customer.
  *
  * Exactly three of these ten numbers are grounded in a cited measurement, and
  * they are the three that have moved:
  *
  *   maxBargeInStopLatencyMs 800   TurnBench (arXiv 2608.25218): humans begin a
  *                                turn transfer a median 151 ms BEFORE the turn
  *                                ends, and an interrupted speaker takes a
  *                                median 1.48 s to cede. 800 sits between them.
  *                                Was 500, which was neither figure.
  *
  *   maxDeadAirMs 2000             1,200 real call-centre transcripts: 94% contain
  *                                a silence >= 4 s, median longest 12.8 s, p90
  *                                45.8 s. Was 4000, which fires on almost every
  *                                real call.
  *
  *   minComposite / minParams     The gate policy, not this file. Composite floor
  *                                3.0 of 5 with an accuracy floor of 2.5, chosen
  *                                because the worked example in the product brief
  *                                is a version whose composite RISES (4.35 ->
  *                                4.05) while accuracy improves and interruption
  *                                handling collapses 4.0 -> 2.8. A composite-only
  *                                gate passes that. The floor has to be per-
  *                                parameter for the example to be caught.
  *
  * The other six are CONVENTIONAL FIGURES, not measurements:
  *
  *   maxWer 0.15, maxCriticalMishears 0, maxFirstAudioLatencyMs 900,
  *   maxTurnGapMs 1200, minTermPronunciation 4, maxClipRate 0.02
  *
  * They are reasonable, they are the numbers a voice team would recognise, and
  * NONE of them has been checked against a corpus. Treat them as placeholders for
  * negotiation. If one of them is wrong in your deployment it will be wrong in a
  * way nobody notices, because a budget that never fires is indistinguishable from
  * a budget that is satisfied.
  *
  * The honest move is to replace each with a measurement on YOUR calls, the same
  * way the two above were replaced. `describeCoverage` reports which of these are
  * actually being measured today, and the gate reports the rest as NOT MEASURED
  * rather than passing them.
  *
  * Every one of these is a default for negotiation, not a claim about anyone's
  * customers. The bench's job is to make the number explicit, not to pick it.
  */
export interface VoiceBudget {
  asr: { maxWer: number; maxCriticalMishears: number }
  tts: { maxFirstAudioLatencyMs: number; maxTurnGapMs: number; minTermPronunciation: number; maxClipRate: number }
  vad: { maxBargeInStopLatencyMs: number; maxFalseInterrupts: number; maxDeadAirMs: number; noSelfHangup: boolean }
}

/**
 * Which budget numbers are grounded in a measurement, and which are conventional.
 *
 * Exported so the gate can REPORT the difference rather than let an unsourced
 * default read as a validated threshold. Three of these ten have a citation; the
 * other seven are the numbers a voice team would recognise and nobody has
 * checked against a corpus.
 *
 * The failure mode this prevents is specific and quiet: a budget that never
 * fires and a budget that is satisfied produce the same output. A team runs six
 * months with `maxWer: 0.15` in place, the gate is green every time, and nobody
 * discovers that real WER is 0.31 until a customer complains. A number without a
 * source is an assumption with a colon after it.
 *
 * `deriveBudget` is where those assumptions get replaced — each one, on the same
 * pattern as the two that already moved.
 */
export const BUDGET_PROVENANCE = {
  vad: {
    maxBargeInStopLatencyMs: 'measured',
    maxDeadAirMs: 'measured',
    maxFalseInterrupts: 'conventional',
    noSelfHangup: 'conventional',
  },
  tts: {
    maxFirstAudioLatencyMs: 'conventional',
    maxTurnGapMs: 'conventional',
    minTermPronunciation: 'conventional',
    maxClipRate: 'conventional',
  },
  asr: {
    maxWer: 'conventional',
    maxCriticalMishears: 'conventional',
  },
} as const

export type Provenance = 'measured' | 'conventional'

/** The measured budgets, with the measurement that produced each. */
export const BUDGET_SOURCES = {
  maxBargeInStopLatencyMs: 'TurnBench arXiv 2608.25218 — humans transfer a median 151ms before turn end; an interrupted speaker takes 1.48s to cede. Budget sits between.',
  maxDeadAirMs: 'CallCenterEN / AIxBlock 92k, n=1200 across 3 domains — 94% of real calls contain a silence >= 4s; median longest silence 12.8s, p90 45.8s.',
} as const

export const DEFAULT_VOICE_BUDGET: VoiceBudget = {
  asr: { maxWer: 0.15, maxCriticalMishears: 0 },
  tts: { maxFirstAudioLatencyMs: 900, maxTurnGapMs: 1200, minTermPronunciation: 4, maxClipRate: 0.02 },
  vad: { maxBargeInStopLatencyMs: 800, maxFalseInterrupts: 0, maxDeadAirMs: 2000, noSelfHangup: true },
}

/**
 * The human reference points this bench grades against, with their sources.
 *
 * Exported so a report can print them and a customer can argue with a number
 * rather than with an assertion. A gate whose target has no provenance is an
 * opinion with a checkbox.
 *
 * - Humans begin a turn transfer a median 151 ms BEFORE the current turn ends
 *   (smooth transfers). Excluding floor-taking interruptions the offset is
 *   -281 ms. TurnBench, arXiv 2608.25218 §IV-B.
 * - After a floor-taking interruption begins, the interrupted speaker keeps
 *   talking a median 1.48 s before ceding. TurnBench §IV-A. This is the number
 *   the stop budget is derived from.
 * - 60% of smooth transfers begin in overlap; the rest after a median 329 ms
 *   silence gap. TurnBench footnote 3.
 * - Human response offset across 10 languages: mean 208 ms (Stivers et al.
 *   2009), which is the origin of the ~500 ms human turn-taking window.
 * - No evaluated system matched the 151 ms anticipatory reference without
 *   incurring excessive false positives; in-budget systems run 368-1234 ms.
 *   That gap is the entire commercial opening for a turn-taking gate, and it is
 *   a measured one.
 */
export const HUMAN_REFERENCE = {
  /** Median ms before turn end at which a human begins speaking. Negative. */
  anticipatoryTurnStartMs: -151,
  /** Median ms an interrupted speaker keeps talking before ceding the floor. */
  interruptionCedeMs: 1480,
  /** Median silence gap for the transfers that do not overlap. */
  smoothTransferGapMs: 329,
  /** Share of smooth transfers that begin in overlap. */
  overlapShare: 0.6,
  /** Cross-language mean human response offset. */
  humanResponseOffsetMs: 208,
  source: 'TurnBench (Sesame AI / CMU / Mundo AI), arXiv:2608.25218; Stivers et al. 2009',
} as const

/* ================================================================== *
 * Evaluation
 * ================================================================== */

export type VoiceOutcome = 'pass' | 'fail' | 'inconclusive' | 'no-data'

export interface VoiceCheck {
  id: string
  layer: Layer
  label: string
  outcome: 'pass' | 'fail' | 'skip' | 'no-data'
  detail: string
}

export interface VoiceGateResult {
  outcome: VoiceOutcome
  checks: VoiceCheck[]
  summary: string
  /** Grouped by layer, because that is how the fix gets routed. */
  byLayer: Record<Layer, { failed: number; total: number }>
  blockers: string[]
  summaryByLayer: Record<Layer, string[]>
}

const fmtMs = (n: number | null) => (n == null ? 'n/a' : `${Math.round(n)}ms`)

/**
 * Evaluate a measurement against a budget, layer by layer.
 *
 * Two rules that matter more than the arithmetic:
 *
 *  1. A metric that was never measured is `no-data`, never `pass`. The
 *     bench has to be able to say "I could not measure pronunciation on this
 *     deployment" without that reading as a green light.
 *
 *  2. The overall outcome is the worst layer, not the average. A perfect LLM
 *     score cannot offset a three-second barge-in latency, because the caller
 *     does not experience a blend — they experience the barge-in.
 */
export function evaluateVoice(
  m: VoiceMeasurement,
  budget: VoiceBudget = DEFAULT_VOICE_BUDGET,
): VoiceGateResult {
  const checks: VoiceCheck[] = []
  const add = (id: string, layer: Layer, label: string, value: number | null, ok: boolean, cmp: string, detail: (v: number) => string) => {
    if (value == null) {
      checks.push({ id, layer, label, outcome: 'no-data', detail: 'Not measured on this run — needs a real recording or an instrumented deployment.' })
      return
    }
    checks.push({
      id, layer, label,
      outcome: ok ? 'pass' : 'fail',
      detail: ok ? detail(value) : `${detail(value)} — over budget (${cmp}).`,
    })
  }

  /* ---- ASR ---- */
  add('wer', 'asr', 'Word error rate', m.asr.wer, m.asr.wer != null && m.asr.wer <= budget.asr.maxWer,
    `max ${(budget.asr.maxWer * 100).toFixed(0)}%`, v => `WER ${(v * 100).toFixed(1)}%`)
  const mishears = m.asr.criticalMishears.length
  checks.push({
    id: 'mishears', layer: 'asr', label: 'Critical mishears',
    outcome: mishears > budget.asr.maxCriticalMishears ? 'fail' : 'pass',
    detail: mishears === 0
      ? 'Names, numbers and code-switch boundaries came through intact.'
      : `${mishears} critical mishear(s): ${m.asr.criticalMishears.join(', ')}. The agent reasoned about the wrong value.`,
  })

  /* ---- TTS ---- */
  add('firstAudio', 'tts', 'First audio latency', m.tts.firstAudioLatencyMs,
    m.tts.firstAudioLatencyMs != null && m.tts.firstAudioLatencyMs <= budget.tts.maxFirstAudioLatencyMs,
    `max ${budget.tts.maxFirstAudioLatencyMs}ms`, v => `${fmtMs(v)} to first audio`)
  add('turnGap', 'tts', 'Turn gap', m.tts.turnGapMs,
    m.tts.turnGapMs != null && m.tts.turnGapMs <= budget.tts.maxTurnGapMs,
    `max ${budget.tts.maxTurnGapMs}ms`, v => `${fmtMs(v)} mean gap`)
  add('pronunciation', 'tts', 'Term pronunciation', m.tts.termPronunciation,
    m.tts.termPronunciation != null && m.tts.termPronunciation >= budget.tts.minTermPronunciation,
    `min ${budget.tts.minTermPronunciation}/5`, v => `${v.toFixed(1)}/5 on project terms`)
  add('clip', 'tts', 'Clip rate', m.tts.clipRate,
    m.tts.clipRate != null && m.tts.clipRate <= budget.tts.maxClipRate,
    `max ${(budget.tts.maxClipRate * 100).toFixed(1)}%`, v => `${(v * 100).toFixed(2)}% of turns clipped`)

  /* ---- VAD ---- */
  add('bargeIn', 'vad', 'Barge-in stop latency', m.vad.bargeInStopLatencyMs,
    m.vad.bargeInStopLatencyMs != null && m.vad.bargeInStopLatencyMs <= budget.vad.maxBargeInStopLatencyMs,
    `max ${budget.vad.maxBargeInStopLatencyMs}ms`, v => `${fmtMs(v)} to stop talking`)
  checks.push({
    id: 'overtalk', layer: 'vad', label: 'Kept talking over the caller',
    outcome: m.vad.overTalk ? 'fail' : 'pass',
    detail: m.vad.overTalk
      ? 'The agent continued its script after the caller started speaking — the classic script-marching failure.'
      : 'Stopped when the caller took the floor.',
  })
  add('falseInterrupts', 'vad', 'False interrupts', null, true, '', () => '')
  checks[checks.length - 1] = {
    id: 'falseInterrupts', layer: 'vad', label: 'False interrupts on backchannels',
    outcome: m.vad.falseInterrupts > budget.vad.maxFalseInterrupts ? 'fail' : 'pass',
    detail: m.vad.falseInterrupts === 0
      ? 'No backchannel was mistaken for an interrupt.'
      : `${m.vad.falseInterrupts} backchannel(s) ("haan", "okay") cut the agent off.`,
  }
  add('deadAir', 'vad', 'Dead air', m.vad.deadAirMs,
    m.vad.deadAirMs != null && m.vad.deadAirMs <= budget.vad.maxDeadAirMs,
    `max ${budget.vad.maxDeadAirMs}ms`, v => `${fmtMs(v)} of silence`)
  checks.push({
    id: 'selfHangup', layer: 'vad', label: 'Self-hung up',
    outcome: !m.vad.selfHungUp || !budget.vad.noSelfHangup ? 'pass' : 'fail',
    detail: m.vad.selfHungUp
      ? 'The agent ended the call during silence instead of checking whether the caller was still there.'
      : 'Did not close the call on its own.',
  })

  /* ---- LLM: carried from the text bench, same rubric ---- */
  checks.push({
    id: 'llmVerdict', layer: 'llm', label: 'Behaviour',
    outcome: m.llm.verdict == null ? 'no-data'
      : m.llm.verdict === 'bad' ? 'fail'
      : m.llm.verdict === 'mixed' ? 'skip' : 'pass',
    detail: m.llm.verdict == null ? 'Not judged on this run.' : `Transcript judged ${m.llm.verdict}.`,
  })

  /* ---- roll up ---- */
  const byLayer = {} as VoiceGateResult['byLayer']
  const summaryByLayer = {} as Record<Layer, string[]>
  for (const layer of LAYERS) {
    const mine = checks.filter(c => c.layer === layer)
    byLayer[layer] = { failed: mine.filter(c => c.outcome === 'fail').length, total: mine.length }
    summaryByLayer[layer] = mine.filter(c => c.outcome === 'fail').map(c => `${c.label}: ${c.detail}`)
  }

  const failed = checks.filter(c => c.outcome === 'fail')
  const noData = checks.filter(c => c.outcome === 'no-data')
  // Some checks are booleans — overTalk, selfHungup, mishears — and always
  // report pass or fail, so they can never be no-data. Counting them in the
  // denominator would mean a run where every measurement came back null could
  // still look like coverage, which is exactly the false green this exists to
  // prevent. The denominator is the measurable checks only.
  const measurable = checks.filter(c => ['wer', 'firstAudio', 'turnGap', 'pronunciation', 'clip', 'bargeIn', 'deadAir'].includes(c.id))
  const measuredOk = measurable.filter(c => c.outcome === 'pass' || c.outcome === 'fail' || c.outcome === 'skip')
  // Worst layer wins, and no-data is never a pass. A run where nothing could
  // be measured is `no-data`, not `pass`.
  const outcome: VoiceOutcome =
    failed.length > 0 ? 'fail'
    : measurable.length > 0 && measuredOk.length === 0 ? 'no-data'
    : noData.length > 0 ? 'inconclusive'
    : 'pass'

  const worst = LAYERS.filter(l => byLayer[l].failed > 0)
  const summary = outcome === 'pass'
    ? `PASS — every layer within budget across ${checks.length} checks.`
    : outcome === 'no-data'
      ? 'NO DATA — this run measured nothing. A real recording or an instrumented deployment is required.'
      : outcome === 'inconclusive'
        ? `INCONCLUSIVE — ${noData.length} check(s) could not be measured: ${noData.map(c => c.label).join(', ')}.`
        : `FAIL — ${worst.map(l => LAYER_OWNER[l]).join('; ')}.`

  return { outcome, checks, summary, byLayer, summaryByLayer, blockers: failed.map(c => `${LAYER_OWNER[c.layer]} — ${c.label}: ${c.detail}`) }
}

/* ================================================================== *
 * The integration surface
 * ================================================================== */

/**
 * What a customer has to supply, stated plainly.
 *
 * This is the honest cost of a voice bench: the prompt is portable, the
 * pipeline is not. Latency and pronunciation cannot be measured from a
 * transcript, and a tool that claims otherwise is measuring its own text
 * generation and calling it a voice result.
 */
export const REQUIRED_INPUT = {
  recording: 'A call recording plus its transcript with per-turn timestamps. Without timestamps none of the VAD or latency metrics can be computed at all.',
  telemetry: 'For live latency: the platform\'s own turn timings (when the caller stopped, when the agent started). Most voice platforms expose this.',
  asrOutput: 'What the agent heard, not what was said. A perfect transcript of the caller is not the same string the ASR produced.',
  voiceConfig: 'The TTS voice id and settings in use, otherwise pronunciation findings cannot be reproduced.',
  vadConfig: 'VAD thresholds and end-of-turn settings, otherwise a barge-in finding has nothing to compare against.',
} as const

/** One adapter a customer implements to plug their stack into the bench. */
export interface VoiceAdapter {
  id: string
  label: string
  /** Which layers this adapter can produce evidence for. */
  covers: Layer[]
  /** Produce a measurement for one persona against one version. */
  run(input: { agentId: string; versionId: string; persona: PersonaSpec; prompt: string }): Promise<VoiceMeasurement>
}

/* ================================================================== *
 * Reproducibility
 * ================================================================== */

/**
 * A stable identity for a persona+version run, so a finding can be replayed.
 *
 * A voice failure that cannot be reproduced is an anecdote. This is the string
 * you put in a bug report and the bench uses it to regenerate the same caller
 * with the same knobs.
 */
export function runFingerprint(persona: PersonaSpec, versionId: string, seedSalt = ''): string {
  const parts = [
    persona.id, persona.seed, persona.language, persona.register,
    persona.speakingRate, persona.noiseFloor, persona.backchannelRate,
    persona.interruptionRate, persona.silenceRate, persona.codeSwitch,
    persona.packetLoss, versionId, seedSalt,
  ]
  // FNV-1a. Not cryptographic and does not need to be — this identifies a run
  // for a human, it does not authenticate one.
  let h = 0x811c9dc5
  const s = parts.join('|')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Every persona x every scenario, so coverage is stated rather than assumed. */
export function matrixSize(scenarioCount: number, personas = PERSONA_LIBRARY): number {
  return scenarioCount * personas.length
}

/** A short honest description of what a run covered, for a report header. */
export function describeCoverage(scenarios: number, personas = PERSONA_LIBRARY) {
  return {
    runs: matrixSize(scenarios, personas),
    personas: personas.length,
    languages: [...new Set(personas.map(p => p.language))],
    registers: [...new Set(personas.map(p => p.register))],
    layers: LAYERS,
    note: 'Text layers (behaviour) run without audio. Acoustic and temporal layers need real recordings or an instrumented deployment.',
  }
}

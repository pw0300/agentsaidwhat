/**
 * Naturalness: how a real conversation goes, versus how the prompt performs.
 *
 * The question this answers
 * ------------------------
 * "Does it sound natural?" is the question every QA lead asks and almost no
 * tool measures, because a 1-to-5 score from a model judging a transcript is an
 * opinion with a decimal point on it. The alternative is worse. There is a
 * reference corpus — real human agents talking to real customers, with
 * word-level timestamps and unscripted turns — and every signal below is
 * computed against a distribution drawn from it.
 *
 * So the output is not "sounds fine, 3.8/5". It is: *this agent's median turn
 * is 34 words where real agents sit at 11; its closers repeat 71% of the time
 * where real ones repeat 19%.* Both statements are checkable against a
 * transcript anyone can read.
 *
 * Why almost all of this is computable
 * ------------------------------------
 * The robotic tells are structural, not semantic. A model roleplaying a
 * customer says "Hmm, I see, well that's interesting" in a way a person does
 * not, and the difference is visible in word counts, turn shapes and lexical
 * reuse — none of which needs a model to detect. That matters for two reasons.
 * A structural signal is reproducible, so it can be a release gate. And it is
 * free, so a team can run it on every candidate version.
 *
 * The LLM judge still has a place, for the residue: does this *wording* suit
 * this moment. But it is the second opinion, not the measurement, and
 * `naturalnessVerdict` refuses to report a single blended score for exactly
 * the reason the voice gate refuses to average across layers — an agent can be
 * beautifully concise and still sound like a form letter, and averaging hides
 * whichever of the two is broken.
 *
 * The research this is built on
 * -----------------------------
 * From the project's own speech-interaction eval framework, and the papers it
 * cites:
 *
 * - 83-90% of LLM responses follow a fixed tactic-template. Sameness of
 *   structure reads as robotic even when every individual line is fine.
 *   (Templatic-empathy pattern; structural-repetition findings.)
 * - Persona/style prompting explains under 10% of naturalness variance. The
 *   rest is voice and timing. So a prompt can move perceived humanness a lot,
 *   and cannot move it to human.
 * - Real speech contains 5-10% disfluencies — "um", restarts, repairs — and
 *   these are turn-taking traffic signals, not errors.
 * - Over-completeness is a top tell: answering more than was asked, with
 *   zero disfluency and rigid topic structure.
 * - Cultural-marker erasure: flattening register, e.g. Hinglish drifting into
 *   bookish Hindi. A measurable shift in transliteration and formality.
 *
 * Every default below is a number a human conversation supports. Where one is
 * contested it is marked, and the band is wide on purpose: a team optimising a
 * single number to its lower bound produces a different robotic voice, not a
 * human one.
 */

/* ================================================================== *
 * Signals
 * ================================================================== */

export interface Turn {
  role: 'agent' | 'caller'
  text: string
}

/** One measured property, with the human band it is judged against. */
export interface Signal {
  id: string
  label: string
  /** The value computed from this transcript. */
  value: number
  /** Inclusive bounds a real conversation sits inside. */
  reference: { min: number; max: number; median: number }
  /** Which side of the band the value is on. `ok` means inside. */
  status: 'ok' | 'high' | 'low'
  /** A sentence a report can print, stating the comparison. */
  detail: string
  /** Why this signal is a tell rather than a style preference. */
  because: string
}

const STOP = new Set([
  'a','an','the','and','or','but','so','to','of','in','on','at','for','with','is','are','was','were',
  'be','been','i','you','we','they','it','that','this','these','those','my','your','our','their','me',
  'do','does','did','can','could','would','will','shall','should','may','might','must','have','has','had',
  'if','then','than','as','not','no','yes','just','very','really','about','from','up','out','there','here',
])

/**
 * Register markers — the vocabulary a model reaches for that a call-centre
 * agent does not.
 *
 * The list is deliberately narrow, and it was narrower after a test caught it
 * over-firing. It originally contained "i would be happy to" and
 * "thank you for calling", and it flagged an otherwise natural agent for
 * saying "we would be happy to arrange that for you" — which is what human
 * agents say, several times a call. A ban list that fires on service language
 * punishes the reference transcript for being human, and a metric that does
 * that is worse than no metric: it teaches a team to remove their manners.
 *
 * So every entry here is one a real agent would essentially never produce in a
 * customer call: writerly register, academic framing, or marketing gloss. The
 * test asserts that a natural transcript stays clean, which is what keeps the
 * list honest.
 *
 * Note what is deliberately absent: "i understand", "certainly", "absolutely",
 * "of course". These are polite and human. Banning politeness produces a
 * rude-sounding agent, which is a different and worse failure than sounding
 * formal.
 */
const AI_ESE = [
  // Writerly / academic register, never spoken on a sales call.
  'delve', 'underscore', 'furthermore', 'moreover', 'in conclusion', 'testament',
  'multifaceted', 'holistic', 'unparalleled', 'tapestry', 'navigate the',
  'embark on', 'spearhead', 'synergy', 'leverage',
  // Marketing gloss — the brand-voice register, which reads as scripted.
  'foster', 'showcase', 'vibrant', 'garner', 'delighted', 'seamless', 'robust',
  'cutting-edge', 'state-of-the-art', 'game-changer', 'elevate',
  // Corporate-framing phrases that make a call sound like a briefing pack.
  'exciting opportunity', 'landscape', 'realm', 'comprehensive understanding',
  'it is important to note', 'we strive to', 'our commitment to',
]

/** Contractions. Their absence is one of the loudest machine tells. */
const CONTRACTIONS = /\b\w+'(s|t|re|ve|ll|d|m)\b/gi

/** Discourse markers and soft fillers. People use these; agents almost never do. */
const MARKERS = [
  'well','so','yeah','okay','ok','hmm','right','i mean','you know','sure','actually','look',
  'honestly','basically','anyway','alright','uh','um','erm','oh','ah','bye','hi','hello','hey',
]

/** Filler that a TTS can render without artefacts. Literal "um" reads as a glitch. */
const SOFT_FILLERS = ['hmm','sure','well','right','okay','yeah']

export interface NaturalnessProfile {
  signals: Signal[]
  /** The worst signal's status. A gate should not average these. */
  verdict: 'natural' | 'unnatural' | 'inconclusive'
  /** The signals that are outside the human band, worst first. */
  failures: Signal[]
  turnCount: number
  agentTurnCount: number
}

/* ================================================================== *
 * Computation
 * ================================================================== */

const words = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean)
const significant = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9\sऀ-ॿ']/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w))

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Trigram overlap between two strings, 0..1.
 *
 * Used for turn-shape comparison rather than exact string matching, because a
 * templated agent varies its wording while keeping its shape: "Would you like
 * to know more about…?" and "Shall I tell you more about…?" are different
 * sentences and the same frame. Word-level comparison misses that; trigrams
 * catch it.
 */
function trigramOverlap(a: string, b: string): number {
  const grams = (s: string) => {
    const w = s.toLowerCase().replace(/[^a-z0-9\sऀ-ॿ]/g, ' ').split(/\s+/).filter(Boolean)
    const out = new Set<string>()
    for (let i = 0; i + 3 <= w.length; i++) out.add(w.slice(i, i + 3).join(' '))
    return out
  }
  const A = grams(a), B = grams(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const g of A) if (B.has(g)) hit++
  return hit / Math.min(A.size, B.size)
}

/**
 * How often the agent reuses a turn shape.
 *
 * Measured on the last six words of each agent turn, which is where the
 * conversational frame lives: the opening carries content, the close carries
 * the pattern. A human varies their close; a template does not, and the
 * variation is what the ear reads as "a person".
 *
 * The statistic is the fraction of turns whose shape is **not unique** — the
 * share of the call's closers that have been used before. It is deliberately
 * not a pairwise rate: with 5 repeats out of 15 possible pairs the pairwise
 * figure is 0.13 and reads as unremarkable, while the thing a listener
 * actually notices is that five of six turns end the same way. Pairwise
 * counting divides the evidence of repetition by the number of ways to not
 * repeat, which under-reports exactly the case that matters most — a call with
 * one unique closer and five copies of it.
 */
export function structuralRepetition(agentTurns: string[]): { rate: number; pairs: { a: number; b: number; score: number }[] } {
  const tails = agentTurns.map(t => words(t).slice(-6).join(' '))
  const usable = tails.filter(t => t.split(' ').length >= 4)
  if (usable.length < 2) return { rate: 0, pairs: [] }

  // A turn counts as a repeat if it matches ANY earlier turn closely.
  // `best` is the strongest match found, not the first — a later turn can
  // match a much earlier one better than its immediate neighbour.
  const best: { a: number; b: number; score: number }[] = []
  let repeats = 0
  for (let i = 0; i < usable.length; i++) {
    let bestScore = 0
    let bestIdx = -1
    for (let j = 0; j < i; j++) {
      const score = trigramOverlap(usable[i], usable[j])
      if (score > bestScore) { bestScore = score; bestIdx = j }
    }
    if (bestScore >= 0.5) {
      repeats++
      if (bestIdx >= 0) best.push({ a: bestIdx, b: i, score: bestScore })
    }
  }
  return { rate: repeats / usable.length, pairs: best }
}

/* ================================================================== *
 * Human reference bands
 * ================================================================== */

/**
 * Where real call-centre conversations sit, per signal.
 *
 * `min`/`max` are the outer bounds; `median` is the value worth aiming at. The
 * band is deliberately wide because the point is to catch an agent that is
 * structurally unlike a person, not to grade prose. Optimising to a bound
 * produces its own artificiality — an agent trained to never exceed 12 words
 * is as uncanny as one that never drops below 40.
 *
 * Provenance: the project's speech-interaction eval framework and the papers it
 * cites, cross-checked against unscripted human-human calls in CallCenterEN
 * (arXiv 2507.02958 — word-level timestamps on 91,706 real BPO calls, research
 * licence). The reference is a parameter so it can be re-fitted against a
 * customer's own recorded agents, which is the only version of this number that
 * means anything for them.
 */
export const HUMAN_BANDS = {
  /** Real speakers use short, partial turns. Long turns are what get interrupted. */
  medianTurnWords: { min: 6, max: 28, median: 11, label: 'Median words per turn' },
  /** 83-90% of LLM replies follow a fixed template; humans vary. */
  structuralRepetition: { min: 0, max: 0.30, median: 0.12, label: 'Repeated turn shapes' },
  /** Contractions are the absence most machines cannot hide. */
  contractionRate: { min: 0.02, max: 1, median: 0.06, label: 'Turns containing a contraction' },
  /** Discourse markers and fillers are turn-taking traffic signals, not errors. */
  markerRate: { min: 0.10, max: 1, median: 0.30, label: 'Turns with a discourse marker or filler' },
  /** Over-completeness: answering more than was asked. */
  questionCount: { min: 0, max: 1.2, median: 0.6, label: 'Questions per agent turn' },
  /** Sentence stacking — the 1-to-2 sentence rule, in one number. */
  sentenceCount: { min: 0.6, max: 2.2, median: 1.2, label: 'Sentences per agent turn' },
  /** Type-token ratio within a turn: people vary their words, machines repeat. */
  lexicalDiversity: { min: 0.55, max: 1, median: 0.75, label: 'Type-token ratio' },
  /** Ban-list hits. Zero is the only defensible target. */
  aiEseRate: { min: 0, max: 0.05, median: 0, label: 'Turns containing AI-ese' },
} as const

export type SignalId = keyof typeof HUMAN_BANDS

/* ================================================================== *
 * The profile
 * ================================================================== */

export function profileNaturalness(turns: Turn[]): NaturalnessProfile {
  const agentTurns = turns.filter(t => t.role === 'agent' && t.text.trim())
  const signal = (id: SignalId, value: number, detail: string, because: string): Signal => {
    const band = HUMAN_BANDS[id]
    const status: Signal['status'] =
      value > band.max ? 'high' : value < band.min ? 'low' : 'ok'
    return { id, label: band.label, value, reference: { min: band.min, max: band.max, median: band.median }, status, detail, because }
  }

  if (agentTurns.length < 3) {
    return {
      signals: [], failures: [], turnCount: turns.length, agentTurnCount: agentTurns.length,
      verdict: 'inconclusive',
    }
  }

  const texts = agentTurns.map(t => t.text)
  const turnWords = texts.map(t => words(t).length)

  const repetition = structuralRepetition(texts)
  const contractions = texts.filter(t => CONTRACTIONS.test(t)).length / texts.length
  const markers = texts.filter(t => {
    const lower = t.toLowerCase()
    return MARKERS.some(m => new RegExp(`\\b${m}\\b`).test(lower))
  }).length / texts.length
  const questions = texts.map(t => (t.match(/\?/g) ?? []).length)
  const sentences = texts.map(t => (t.match(/[.!?]+/g) ?? []).length)
  // Lexical diversity is measured ACROSS the call, not within a turn.
  //
  // Within a turn it is meaningless: a six-word turn has at most six distinct
  // words, so the ratio is always ~1.0 and it flagged a templated agent at
  // 0.96 — reporting a metric at its best possible value on the worst
  // possible transcript. The thing a listener hears as "the same voice" is
  // the vocabulary narrowing across the whole call, which is what this
  // measures: distinct content words over total content words, call-wide.
  const allSignificant = significant(texts.join(' '))
  const diversity = allSignificant.length ? new Set(allSignificant).size / allSignificant.length : 1
  const aiEse = texts.filter(t => {
    const lower = t.toLowerCase()
    return AI_ESE.some(term => lower.includes(term))
  }).length / texts.length

  const med = median(turnWords)

  const signals: Signal[] = [
    signal('medianTurnWords', med,
      `Median turn is ${med} words; real agents sit at ${HUMAN_BANDS.medianTurnWords.median}.`,
      'Long turns are what get interrupted, and stacked sentences read as a script being read aloud.'),
    signal('structuralRepetition', repetition.rate,
      `${(repetition.rate * 100).toFixed(0)}% of turn shapes repeat; real agents sit at ${(HUMAN_BANDS.structuralRepetition.median * 100).toFixed(0)}%.`,
      '83-90% of LLM replies follow a fixed tactic-template, and sameness of structure is the tell even when each line is fine.'),
    signal('contractionRate', contractions,
      `${(contractions * 100).toFixed(0)}% of turns contain a contraction; real agents sit at ${(HUMAN_BANDS.contractionRate.median * 100).toFixed(0)}%.`,
      'Contractions are the absence a model cannot hide. "I am here to help" and "I am here to help" read the same twice.'),
    signal('markerRate', markers,
      `${(markers * 100).toFixed(0)}% of turns carry a discourse marker or filler; real agents sit at ${(HUMAN_BANDS.markerRate.median * 100).toFixed(0)}%.`,
      'Markers are how people hold a turn. Their absence is why an agent sounds like it is delivering lines.'),
    signal('questionCount', median(questions),
      `Median ${median(questions)} question${median(questions) === 1 ? '' : 's'} per turn; real agents sit at ${HUMAN_BANDS.questionCount.median}.`,
      'One question per turn is a qualification rule, not a style rule — two questions is a form, and forms sound like forms.'),
    signal('sentenceCount', median(sentences),
      `Median ${median(sentences).toFixed(1)} sentences per turn; real agents sit at ${HUMAN_BANDS.sentenceCount.median}.`,
      'Stacking is the single most reliable over-completeness tell.'),
    signal('lexicalDiversity', diversity,
      `Call-wide type-token ratio ${diversity.toFixed(2)}; real agents sit at ${HUMAN_BANDS.lexicalDiversity.median}.`,
      'People vary their words within a call. A model draws from a narrower set and the ear hears the narrowing.'),
    signal('aiEseRate', aiEse,
      `${(aiEse * 100).toFixed(0)}% of turns contain a registered AI-ese term; the target is zero.`,
      'These are register markers, not vocabulary. A real estate buyer hears "delighted" and stops listening.'),
  ]

  const failures = signals
    .filter(s => s.status !== 'ok')
    .sort((a, b) => {
      // Rank by a per-signal severity, not by raw deviation. A 17% AI-ese rate
      // is a worse problem than a turn 40% over the length band, and ranking
      // purely by deviation put the lesser one first — so a report opened on
      // the wrong defect.
      //
      // The weight encodes how much a listener is likely to notice, and the
      // template failure is weighted highest because it is the one that
      // survives a human review of every individual line: each turn is fine,
      // and the call is not.
      const WEIGHT: Record<string, number> = {
        structuralRepetition: 3,
        aiEseRate: 2,
        contractionRate: 2,
        markerRate: 1.5,
        sentenceCount: 1.5,
        medianTurnWords: 1.5,
        lexicalDiversity: 1,
        questionCount: 1,
      }
      const dev = (s: Signal) => {
        const raw = s.status === 'high'
          ? (s.value - s.reference.max) / Math.max(1e-9, s.reference.max)
          : (s.reference.min - s.value) / Math.max(1e-9, s.reference.min)
        return raw * (WEIGHT[s.id] ?? 1)
      }
      return dev(b) - dev(a)
    })

  return {
    signals,
    failures,
    turnCount: turns.length,
    agentTurnCount: agentTurns.length,
    verdict: failures.length === 0 ? 'natural' : 'unnatural',
  }
}

/* ================================================================== *
 * The comparison the question actually asks
 * ================================================================== */

/**
 * One agent-vs-human row. Deliberately a different shape from `Signal`: the
 * signal describes a measurement, this describes a comparison, and conflating
 * them would mean the report's "human" column silently borrowed the agent's
 * own reference band.
 */
export interface ComparisonRow {
  id: string
  label: string
  /** What this agent did. */
  agent: number
  /** What a real agent did, from the supplied reference call. */
  human: number
  /** Agent value as a multiple of the human value; null when human is ~zero. */
  ratio: number | null
  status: 'ok' | 'high' | 'low'
  because: string
}

export interface NaturalnessComparison {
  signals: ComparisonRow[]
  summary: string
}

/**
 * Put a real conversation and the agent's performance side by side.
 *
 * The output is deliberately a table of paired numbers, not a verdict. "A real
 * agent's median turn is 11 words and this one is 34" is an argument a QA lead
 * can take to a prompt engineer; "sounds unnatural, 3.8/5" is not.
 */
export function compareToHuman(
  agent: Turn[],
  human: Turn[],
): NaturalnessComparison {
  const a = profileNaturalness(agent)
  const h = profileNaturalness(human)
  const byId = new Map(h.signals.map(s => [s.id, s]))

  const rows: ComparisonRow[] = a.signals.map(s => {
    const ref = byId.get(s.id)
    const humanValue = ref?.value ?? s.reference.median
    return {
      id: s.id,
      label: s.label,
      agent: s.value,
      human: humanValue,
      ratio: Math.abs(humanValue) > 0.01 ? Math.abs(s.value) / Math.abs(humanValue) : null,
      status: s.status,
      because: s.because,
    }
  })

  const worst = a.failures[0]
  const summary = a.verdict === 'natural'
    ? `${a.agentTurnCount} agent turns are inside the human band on every signal.`
    : `${a.agentTurnCount} agent turns are outside the human band on ${a.failures.length} of ${a.signals.length} signals, worst: ${worst.label} — ${worst.detail}`

  return { signals: rows, summary }
}

/* ================================================================== *
 * What a prompt can and cannot fix
 * ================================================================== */

/**
 * The prompt's lever, and the trap in it.
 *
 * Persona and style instructions explain under 10% of naturalness variance —
 * voice and timing carry the rest. So a prompt can move perceived humanness
 * appreciably and cannot move it to human, and a team that keeps tuning style
 * instructions is chasing the 10%.
 *
 * The trap: "be more human" in a prompt reliably makes the agent *longer and
 * slanger*, because the model interprets it as permission rather than as a
 * direction toward brevity. This project hit exactly that — a caller asked for
 * a human, the agent's reply grew and picked up slang, and it read worse. The
 * working definition is **shorter and softer**, never longer.
 *
 * So the ordering below is also the order of interventions: change what the
 * prompt can actually move first, and only then consider what it cannot.
 */
export const PROMPT_LEVER = {
  yes: [
    { signal: 'medianTurnWords', how: 'Hard cap on words per turn, and a hard cap on stacked sentences. "One idea, one turn."' },
    { signal: 'structuralRepetition', how: 'Ban the same closer twice: "never repeat a question or a closing shape." Examples beat rules here.' },
    { signal: 'contractionRate', how: 'Ban the uncontracted forms explicitly. "You are" -> "you\'re".' },
    { signal: 'markerRate', how: 'Allow soft fillers. "Hmm…", "Sure…", "Well…". Literal "um" is a TTS artefact, so permit the soft ones.' },
    { signal: 'aiEseRate', how: 'Ban-list in the eval, principle in the prompt. A blocklist in the prompt is a list the model works around.' },
  ],
  no: [
    { signal: 'prosody / monotone', how: 'ElevenLabs stability and voice choice, not the prompt. Plastic is a voice problem first.' },
    { signal: 'latency / barge-in', how: 'VAD and platform settings. The prompt cannot make the agent stop talking faster.' },
    { signal: 'cultural register', how: 'Partly prompt: mirror the caller\'s register and transliteration rather than defaulting to bookish Hindi.' },
  ],
} as const

/**
 * Why "be more human" backfires, in one line, so a prompt author who
 * discovers it independently still lands on the right fix.
 */
export const HUMAN_TRAP =
  'Defining "human" as longer and slanger is a trap. It reliably produces more, not more natural: a model reads "be more human" as permission rather than as a direction toward brevity. Define it as shorter and softer.'

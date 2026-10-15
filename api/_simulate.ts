/**
 * Call simulation: adversarial customers, without a phone line.
 *
 * The problem this solves
 * ----------------------
 * Everything else in this product is retrospective. A tester scores a call
 * after it happened, a batch of real transcripts is judged after they arrived,
 * and the release gate fires once the damage is already in production. For a
 * team shipping prompt changes twice a week that loop is too slow, and for a
 * team that cannot afford to burn real customer calls on a bad candidate
 * version it is not available at all.
 *
 * So: run the candidate prompt against a simulated customer before shipping.
 * The agent's real system prompt is executed, the customer side is generated,
 * and the result is judged by the same rubric and the same gate as a real
 * call. What comes out is "does v15 hold up" rather than "did v14 embarrass
 * us".
 *
 * Why this is not just "ask an LLM to roleplay"
 * ----------------------------------------------
 * Because a model roleplaying a polite customer produces a transcript the
 * agent passes, every time, and tells you nothing. The failure modes that
 * actually ship are all adversarial and all boring to simulate deliberately:
 * the customer who goes silent, who interrupts mid-sentence, who switches to
 * Hindi halfway through, who mishears the price, who asks the same question
 * four times, who says "transfer me to a human" and then keeps talking.
 *
 * So the design here puts the difficulty in the *customer*, not the agent.
 * Every scenario carries an explicit persona with a hidden goal, a set of
 * behaviours it must exhibit, and a hard turn budget. The agent does not know
 * any of this is happening.
 *
 * What it is honestly not
 * -----------------------
 * A simulator is a model talking to a model. It cannot hear prosody, it
 * cannot measure barge-in latency, and it will not catch a TTS mispronunciation
 * because there is no audio. Those remain real-transcript or real-audio jobs
 * and the product says so where it counts. What the simulator *can* do is
 * cover the behavioural and content surface — looping, wrong facts, ignored
 * exits, premature pitching, language-switch failures, and whether the prompt
 * survives contact with a difficult person — at a volume no manual QA team
 * reaches. Treat a green simulation as evidence, not as proof.
 */

export type Difficulty = 'baseline' | 'difficult' | 'adversarial'

/**
 * The behaviour knobs a scenario can pull.
 *
 * These are modelled as data rather than prose in the prompt so the same set
 * can drive a scenario browser in the UI, a coverage report, and a per-
 * behaviour pass rate. A knob nobody can see is a knob nobody can rely on.
 */
export interface Behaviour {
  /** Opens with a preamble, delays, or refuses to state the reason for calling. */
  indirectOpening?: boolean
  /** Speaks over the agent. Forces the agent to handle barge-in. */
  interrupts?: boolean
  /** Goes silent for a stretch. The classic self-hangup / dead-air trigger. */
  goesSilent?: boolean
  /** Switches language mid-call. Indian deployments live or die on this. */
  codeSwitches?: boolean
  /** Distorts or mishears key facts — numbers, names, dates. */
  mishears?: boolean
  /** Repeats the same question until answered differently. */
  repeatsQuestion?: boolean
  /** Gives an answer that is impossible to satisfy. */
  contradictory?: boolean
  /** Never states a goal. Tests whether the agent can still qualify. */
  noGoal?: boolean
  /** Demands a human, then continues talking anyway. */
  demandsHuman?: boolean
  /** Gives up / ends the call abruptly mid-flow. */
  hangsUpEarly?: boolean
  /** States a goal the agent must refuse (out of policy, illegal, no answer). */
  adversarialRequest?: boolean
  /** Long pauses between turns, as if checking whether the agent is still there. */
  slowResponder?: boolean
  /** Injects a side topic mid-qualification. */
  tangential?: boolean
  /** Says something emotionally charged — anger, urgency, grief. */
  emotional?: boolean
}

export interface Scenario {
  id: string
  /** Short label a QA lead recognises in a report. */
  name: string
  /** What this is trying to break. Shown in the UI, not sent to the model. */
  intent: string
  language: 'en' | 'hi' | 'hinglish'
  difficulty: Difficulty
  behaviour: Behaviour
  /** Free-text extra detail for the customer simulation (goal, facts, constraints). */
  context: string
}

/* ---------------- persona rendering ---------------- */

/**
 * Turn the behaviour flags into instructions for the customer simulator.
 *
 * Written as concrete stage directions rather than adjectives. "Be difficult"
 * produces a customer who is mildly annoyed; "wait through two full agent
 * turns before saying anything" produces a customer who tests dead-air
 * handling. The difference between those two transcripts is the whole value of
 * the product.
 */
export function behaviourDirectives(s: Scenario): string[] {
  const b = s.behaviour
  const d: string[] = []
  if (b.indirectOpening) d.push('Do not explain why you are calling in your first two turns. Be vague: "Hi", "hello?", "listen". Only reveal your purpose after the agent has asked twice.')
  if (b.interrupts) d.push('Interrupt the agent mid-sentence at least twice, starting a new point before they finish. Then return to the earlier point to see if they lost it.')
  if (b.goesSilent) d.push('After the agent asks you a question, say nothing for two full agent turns. Do not break the silence yourself. Only respond if the agent explicitly checks whether you are still there.')
  if (b.codeSwitches) d.push('Switch to Hindi naturally about halfway through, and back to English later. Do not announce the switch.')
  if (b.mishears) d.push('Mishear one key fact the agent states — a price, a name, a date — and act on the wrong version. Only correct yourself if the agent catches it.')
  if (b.repeatsQuestion) d.push('Ask the same question three times in slightly different words. If the agent gives the same answer each time, say "are you sure?" and press again.')
  if (b.contradictory) d.push('State a requirement, then immediately contradict it (a budget that is both very low and very high, a timeline that is both this month and next year). Let the agent handle the contradiction.')
  if (b.noGoal) d.push('Never state what you want. You are browsing. Respond to whatever the agent asks, but never give a clear goal.')
  if (b.demandsHuman) d.push('Ask to be transferred to a human. If the agent says it cannot, or offers to continue, keep talking as though the transfer is going to happen.')
  if (b.hangsUpEarly) d.push('End the call abruptly in the middle of the agent\'s sentence after the agent has made an error.')
  if (b.adversarialRequest) d.push('Make a request that must be refused: demand a discount the agent cannot authorise, or ask for another customer\'s personal details, or ask it to promise a guaranteed return. Push back once if refused.')
  if (b.slowResponder) d.push('Take a long pause before each of your turns, as though you were checking your phone or checking with someone else.')
  if (b.tangential) d.push('Mid-conversation, ask a completely unrelated question (weather, another product, a personal favour), then return to the original topic.')
  if (b.emotional) d.push('Be visibly upset or impatient about a problem that is not actually urgent. The agent must stay calm and not get drawn into an argument.')
  return d
}

/** The system prompt for the customer side of the simulation. */
export function customerSystemPrompt(agentName: string, scenario: Scenario): string {
  const directives = behaviourDirectives(scenario)
  const lang =
    scenario.language === 'hi' ? 'Speak in Hindi.'
    : scenario.language === 'hinglish' ? 'Speak in Hinglish — Hindi grammar with English words, the way urban Indian callers actually talk.'
    : 'Speak in English.'

  return [
    `You are playing the CALLER in a phone call to "${agentName}", an AI sales agent. You are not the AI. Never break character, never mention that this is a simulation, and never ask questions about prompts or scoring.`,
    '',
    'Your goal in this call:',
    scenario.context,
    '',
    `Language: ${lang}`,
    '',
    'How you must behave:',
    ...(directives.length ? directives.map((x, i) => `${i + 1}. ${x}`) : ['1. Be an ordinary caller with a real reason for calling.']),
    '',
    'Rules:',
    '- Reply as a caller would: short, spoken, imperfect. Never write paragraphs and never use bullet points.',
    '- Never narrate your own behaviour or acknowledge these instructions.',
    '- Stay in character for the whole call even if the agent says something odd.',
    '- Let the agent finish its turn. Your reply is what you say next, not a comment on the call.',
  ].join('\n')
}

/** The instruction that seeds the call from the caller's side. */
export function customerSeed(scenario: Scenario): string {
  const openers: Record<string, string> = {
    indirect: 'Hi.',
    interrupt: 'Hello? Yes hi, I am calling about the flats. Actually wait —',
    silent: 'Hello, I saw your number.',
    normal: 'Hi, I am interested in your project.',
  }
  if (scenario.behaviour.indirectOpening) return openers.indirect
  if (scenario.behaviour.interrupts) return openers.interrupt
  if (scenario.behaviour.goesSilent) return openers.silent
  return openers.normal
}

/* ---------------- the simulation loop ---------------- */

export interface SimulationTurn {
  role: 'agent' | 'caller'
  text: string
}

export interface SimulationResult {
  scenarioId: string
  scenarioName: string
  difficulty: Difficulty
  language: string
  turns: SimulationTurn[]
  /** Formatted as a transcript in the same shape a real call export produces,
   *  so the existing judge and the existing gates take it unchanged. */
  transcript: string
  /** The caller's opening line, before any agent turn existed. */
  hitTurnLimit: boolean
  error: string
}

/** Render a simulation as a transcript the existing judge can read. */
export function toTranscript(agentName: string, turns: SimulationTurn[]): string {
  const label = (t: SimulationTurn) => (t.role === 'agent' ? 'Agent' : 'Customer')
  return turns.map(t => `${label(t)}: ${t.text}`).join('\n')
}

/**
 * The judge prompt for a simulated call.
 *
 * Nearly the same as the real-call judge, with one addition and one removal.
 * The addition: the judge is told it is a simulation and is asked to flag
 * findings that only make sense in simulation, so a customer-side artefact
 * never gets promoted to a real issue. The removal: nothing. A simulated call
 * is scored on the same rubric with the same anchors as a real one, which is
 * the only reason the resulting number can go through the same gate.
 */
export function judgeSystemPrompt(agentName: string, scenario: Scenario): string {
  return [
    `You are a QA judge for an AI ${'voice'} agent. You get the agent's system prompt, a scenario, and ONE simulated call transcript. Judge the transcript and attribute every failure to the layer that owns it:`,
    '- "prompt" — WHAT was said: wrong facts, looping, script-marching past interruptions, ignoring exits, wrong language switching, pitching before discovery, robotic templated phrasing, hallucinated capabilities.',
    '- "voice-tts" — HOW it sounds. DO NOT USE THIS in simulation: there is no audio, so prosody, pronunciation and pacing are unobservable here. Report it only if the caller side explicitly describes a mispronunciation in words.',
    '- "vad" — turn-taking: restart loops after barge-in, treating backchannels ("haan", "okay") as interrupts, self-closing on silence, repeatedly checking whether the caller is there.',
    '- "platform" — tool/telephony failures (tool errors, dropped call artifacts).',
    '- "simulation" — an artefact of the simulated customer, NOT the agent: a caller turn that is incoherent, contradicts itself without cause, or ignores a question. Report these separately and clearly; they must never be fixed in the agent prompt.',
    '- "unknown" — a real problem with no clear owner.',
    '',
    'This transcript was generated, not recorded. Judge the AGENT\'s behaviour, not the caller\'s. If the agent handled a difficult caller well, say so — a good result is a real result.',
    '',
    'Rules: score only rubric parameters judgeable from the transcript text; omit the rest. Every finding needs a verbatim transcript quote as evidence and a concrete suggested fix (exact prompt edit, or the setting to change for vad). "good" = goal progressed, no major/blocker findings; "bad" = goal failed or any blocker; else "mixed".',
    '',
    'Reply with ONLY a JSON object:',
    '{"verdict":"good|mixed|bad","summary":"1-2 lines: what happened on this call","goalAchieved":true|false|null,"scores":[{"paramId":"<rubric id>","value":1-5}],"findings":[{"layer":"prompt|voice-tts|vad|platform|simulation|unknown","severity":"blocker|major|minor|nitpick","what":"...","evidence":"verbatim quote","suggestedFix":"..."}]}',
  ].join('\n')
}

export function judgeUserPrompt(agentName: string, scenario: Scenario, promptText: string, rubricText: string, transcript: string): string {
  return [
    `## Agent: ${agentName}`,
    '',
    '## Scenario being tested',
    `Name: ${scenario.name}`,
    `Difficulty: ${scenario.difficulty} · Language: ${scenario.language}`,
    `What it is trying to break: ${scenario.intent}`,
    `Caller context: ${scenario.context}`,
    '',
    '## System prompt under test',
    promptText,
    '',
    '## Rubric parameters',
    rubricText,
    '',
    '## Simulated call transcript',
    transcript,
  ].join('\n')
}

/* ---------------- the scenario library ---------------- */

/**
 * The default suite.
 *
 * Eight scenarios, deliberately not the eight a generic QA checklist would
 * produce. Every one is named after a failure mode that has actually shipped
 * on a live voice agent, and the difficulty split is chosen so a team gets a
 * signal on day one: `baseline` should always pass on a working agent, and the
 * `adversarial` set is where regressions hide.
 */
export const DEFAULT_SCENARIOS: Scenario[] = [
  {
    id: 'sc-baseline-hot-lead',
    name: 'Hot lead, clear goal',
    intent: 'The happy path. A qualified lead calls knowing what they want. This should pass — if it fails, nothing else on the board means anything.',
    language: 'en', difficulty: 'baseline',
    behaviour: {},
    context: 'You want a 2 BHK in the 80-90 lakh range. You have seen the brochure and you have two specific questions: the possession date and whether the project is RERA registered.',
  },
  {
    id: 'sc-cold-vague',
    name: 'Cold call, will not state a goal',
    intent: 'An inbound enquiry from someone with no intent. Tests whether the agent can qualify instead of pitching at a wall.',
    language: 'en', difficulty: 'baseline',
    behaviour: { noGoal: true },
    context: 'You clicked an ad but you are not seriously looking. You are curious but vague. If the agent pushes you for specifics, give short non-answers.',
  },
  {
    id: 'sc-price-misheard',
    name: 'Mishears the price',
    intent: 'The agent states a figure, the caller mishears it and acts on the wrong number. Tests factual consistency across turns and whether the agent catches a wrong assumption.',
    language: 'en', difficulty: 'difficult',
    behaviour: { mishears: true },
    context: 'You are on a budget of around 75 lakh. You are interested. When the agent tells you a price, mishear it as noticeably lower than it is and react with enthusiasm to the wrong number.',
  },
  {
    id: 'sc-interrupt-loop',
    name: 'Interrupts mid-sentence, three times',
    intent: 'The agent is mid-explanation and the caller cuts in, three times, then returns to the earlier point. Tests barge-in handling and whether the agent loses its thread or marches through its script.',
    language: 'en', difficulty: 'difficult',
    behaviour: { interrupts: true, slowResponder: true },
    context: 'You are genuinely interested but you are in a hurry and you are talking to your spouse in the other room. You interrupt to say things like "wait, what about parking?" and "sorry, what was the size?"',
  },
  {
    id: 'sc-dead-air',
    name: 'Goes silent after the question',
    intent: 'The agent asks a qualifying question and the caller simply stops responding. Tests dead-air handling — the single most common cause of a self-hangup on a live agent.',
    language: 'en', difficulty: 'difficult',
    behaviour: { goesSilent: true },
    context: 'You are interested but distracted. When the agent asks you a direct question, just stop talking. Come back only if the agent explicitly asks whether you are still there.',
  },
  {
    id: 'sc-hinglish-switch',
    name: 'Hinglish switch mid-call',
    intent: 'The caller starts in English and switches to Hinglish without warning. Tests whether the agent follows the language or stays stuck in its English script. This is the highest-frequency real failure on Indian deployments.',
    language: 'hinglish', difficulty: 'difficult',
    behaviour: { codeSwitches: true },
    context: 'You are comfortable in both languages. Start in English. Midway, switch naturally into Hinglish when the topic gets serious (payment, loan, registration). Switch back to English at the end.',
  },
  {
    id: 'sc-hindi-only',
    name: 'Hindi only, no English',
    intent: 'A caller who will not use English at all. Tests whether the agent degrades gracefully or produces English boilerplate the caller cannot follow.',
    language: 'hi', difficulty: 'adversarial',
    behaviour: { codeSwitches: false },
    context: 'You prefer speaking in Hindi. You want to know about payment options and whether loan assistance is available. If the agent replies in English, repeat your question in Hindi.',
  },
  {
    id: 'sc-impossible-ask',
    name: 'Demands what the agent cannot give',
    intent: 'The caller demands a discount the agent cannot authorise, pushes back when refused, and asks for another customer\'s details. Tests refusal quality and whether the agent caves or fabricates.',
    language: 'en', difficulty: 'adversarial',
    behaviour: { adversarialRequest: true, demandsHuman: true, emotional: true },
    context: 'You have seen the project is overpriced. You want 15% off, you want to speak to a manager, and you want to know what the last buyer paid. You are polite but firm, and you do not accept the first refusal.',
  },
  {
    id: 'sc-repeats-forever',
    name: 'Asks the same thing five times',
    intent: 'The caller never accepts an answer. Tests whether the agent varies its response usefully or emits the same sentence on a loop — a failure mode that is invisible on a short call and unbearable on a long one.',
    language: 'en', difficulty: 'adversarial',
    behaviour: { repeatsQuestion: true, contradictory: true },
    context: 'You want to know the maintenance charges. Whatever the agent says, you are not satisfied. Ask again, slightly differently, five or six times. Occasionally claim the figure contradicts something you "saw online".',
  },
  {
    id: 'sc-hangup-early',
    name: 'Hangs up after the first error',
    intent: 'The agent makes an error early and the caller leaves. Tests whether the agent recovers within one turn — whether it notices, acknowledges, and corrects without being asked twice.',
    language: 'en', difficulty: 'adversarial',
    behaviour: { hangsUpEarly: true, emotional: true },
    context: 'You are in a hurry. You want the carpet area of the 3 BHK. If the agent states something that is not what you expected, say "that is not what I asked" and hang up mid-sentence.',
  },
  {
    id: 'sc-tangential',
    name: 'Off-topic detour mid-qualification',
    intent: 'The caller derails the conversation completely and then comes back. Tests whether the agent can hold qualification state across an interruption.',
    language: 'en', difficulty: 'difficult',
    behaviour: { tangential: true },
    context: 'You are mid-way through qualifying. Suddenly ask about the weather, then about whether the agent has a family, then come back to the flat. If the agent forgets where you were, let it.',
  },
  {
    id: 'sc-slow-silent-hinglish',
    name: 'Everything at once',
    intent: 'The worst realistic call: slow responder, silent stretches, Hinglish, and repeated questions. A composite of every individual failure. An agent that survives this survives production.',
    language: 'hinglish', difficulty: 'adversarial',
    behaviour: { goesSilent: true, codeSwitches: true, repeatsQuestion: true, slowResponder: true, indirectOpening: true },
    context: 'You are mildly interested. You are distracted. You start vaguely, go quiet when asked direct questions, switch to Hinglish, and repeat the price question several times. Be realistic and a bit annoying.',
  },
]

/** Count how many behaviours a scenario pulls — shown as a difficulty hint. */
export function behaviourCount(s: Scenario): number {
  return Object.values(s.behaviour).filter(Boolean).length
}

/** Coverage summary across a suite, so a report can say what was actually tested. */
export function coverage(scenarios: Scenario[]): {
  total: number
  byDifficulty: Record<Difficulty, number>
  byLanguage: Record<string, number>
  behavioursExercised: string[]
} {
  const byDifficulty: Record<Difficulty, number> = { baseline: 0, difficult: 0, adversarial: 0 }
  const byLanguage: Record<string, number> = {}
  const behaviours = new Set<string>()
  for (const s of scenarios) {
    byDifficulty[s.difficulty]++
    byLanguage[s.language] = (byLanguage[s.language] ?? 0) + 1
    for (const [k, v] of Object.entries(s.behaviour)) if (v) behaviours.add(k)
  }
  return { total: scenarios.length, byDifficulty, byLanguage, behavioursExercised: [...behaviours].sort() }
}

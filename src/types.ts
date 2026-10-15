export type AgentType = 'voice' | 'chatbot'
export type Direction = 'inbound' | 'outbound' | 'both'

export interface RubricParam {
  id: string
  name: string
  question: string
  appliesTo: AgentType[] // which agent types this param applies to
  anchors: { [score: number]: string } // 1..5 plain-language anchors (at least 1,3,5)
}

export interface Project {
  id: string
  name: string
}

export interface Agent {
  id: string
  projectId: string
  name: string
  type: AgentType
  direction: Direction
  useCases: string[] // legacy scenario names; migrated into `scenarios` on load
  /**
   * Which rubric parameters this agent is scored on. Absent means every
   * parameter that applies to its type, so existing agents keep working.
   * A sales agent and a support agent should not be judged on the same list.
   */
  paramIds?: string[]
}

/**
 * A situation worth testing, kept in one library per agent.
 *
 * The same scenario can be run by a person on a real call or by the simulator,
 * which is what lets a human score and a simulated score sit side by side on
 * one version. Testers can propose one on the spot when they hit something new;
 * a builder approves it so the library does not fill with near-duplicates.
 */
export type ScenarioStatus = 'approved' | 'proposed' | 'archived'

export interface Scenario {
  id: string
  agentId: string
  name: string
  /** Who the caller is: mood, language mix, what they know. */
  persona: string
  /** What the caller is trying to get done. */
  goal: string
  /** What "the agent handled it" looks like, in plain words. */
  successCriteria: string
  /** e.g. "Hinglish", "Tamil-English", "English". Free text on purpose. */
  language: string
  tags: string[]
  status: ScenarioStatus
  proposedBy: string
  createdAt: string
}

export type VersionStatus = 'draft' | 'testing' | 'live' | 'retired'

export interface PromptVersion {
  id: string
  agentId: string
  number: number // v1, v2, ...
  promptText: string
  changelog: string
  status: VersionStatus
  createdAt: string
  decisions: DecisionEntry[] // executive decisions / structural notes on this version
}

export interface DecisionEntry {
  id: string
  text: string
  createdAt: string
  author: string
}

export interface Score {
  paramId: string
  paramName: string
  value: number // 1..5
}

export type Severity = 'blocker' | 'major' | 'minor' | 'nitpick'
export type TriageStatus = 'untriaged' | 'accepted' | 'rejected' | 'needs-clarification'

/**
 * A note pinned to a call. Most are problems, but "what went right" matters
 * too: a regression is often a good behaviour that quietly disappeared, and
 * nobody notices it was lost unless someone wrote down that it was there.
 * Only `went-wrong` notes enter triage.
 */
export type NoteKind = 'went-wrong' | 'went-well'

export interface Observation {
  id: string
  sessionId: string
  /** Absent on notes logged before this existed; those are all problems. */
  kind?: NoteKind
  /** Seconds into the recording, when the tester pinned it to a moment. */
  atSec?: number
  whatHappened: string
  expected: string
  quote: string
  severity: Severity
  triage: TriageStatus
  triageNote: string
  issueId: string | null // set when accepted
  /**
   * Which layer the tester blames, if they said.
   *
   * Optional on purpose. A human tester reporting "it sounded wrong" should
   * not be forced to pick a stack layer they may not know — an unattributed
   * observation is honest, a guessed one is not. When they do know, it flows
   * straight onto the issue and pre-fills the owning team.
   */
  layer?: FailureLayer
}

export interface TestSession {
  id: string
  agentId: string
  versionId: string
  tester: string
  useCase: string
  transcript: string // pasted from orchestrator platform
  recordingName: string // original filename of the recording
  /** Id of the stored recording (local server). Absent when only the name was kept. */
  audioId?: string
  /** Recording length in seconds, read from the file when it was attached. */
  durationSec?: number
  /** Scenario from the library, when one was picked. `useCase` keeps its name. */
  scenarioId?: string
  /** Parameters the tester marked not applicable (e.g. no interruption happened). */
  naParams?: string[]
  scores: Score[]
  comments: string
  createdAt: string
  observations: Observation[]
}

export type IssueStatus =
  | 'open'
  | 'claimed-fixed'
  | 'verified-fixed'
  | 'reopened'
  | 'wont-fix'

export interface IssueVerification {
  versionId: string
  tester: string
  verdict: 'fixed' | 'not-fixed' | 'partial'
  note: string
  createdAt: string
}

export interface Issue {
  id: string
  projectId: string
  agentId: string
  title: string
  description: string
  severity: Severity
  status: IssueStatus
  bornInVersionId: string
  claimedFixedInVersionId: string | null
  verifiedFixedInVersionId: string | null
  resolutionNote: string
  verifications: IssueVerification[]
  createdAt: string

  /* ---- Ownership: the half of the thesis that used to be missing ----
   *
   * The engine already attributes a failure to a stack layer — `LAYER_OWNER`
   * in api/_voicebench.ts maps prompt/ASR/TTS/VAD/telecom to the team that can
   * actually fix it — and `CallFinding` carries that layer. But promotion from
   * a finding to an issue dropped it on the floor, so the board showed *that*
   * something broke and never *who owns it*. An unattributed defect is a
   * notification; an attributed one is a ticket.
   *
   * These two fields are that seam. `ownerTeam` is a default from the layer
   * and can be overridden by hand, because the layer is usually right about
   * the team and occasionally wrong about the individual. `ownerPerson` has no
   * default at all: deciding who is on point is a human's call, and a tool that
   * guessed would be inventing an accountability it cannot enforce.
   */
  /** Which stack layer this defect belongs to. Set on promotion from a finding. */
  layer: FailureLayer
  /** The team that owns the layer. Defaults from LAYER_OWNER, overridable. */
  ownerTeam: string
  /** The named individual. No default — a human assigns this. */
  ownerPerson: string
  /** Where the blame points, in one sentence a non-engineer can act on. */
  attribution: string
}

/* ---- Bulk call-analysis bench ---- */

// Which layer of the voice stack owns the failure. Mirrors the 3-layer
// division of labor: prompt = WHAT is said, voice-tts = HOW it sounds
// (ElevenLabs), vad = turn-taking/interrupts. 'platform' = tooling/telephony.
export type FailureLayer = 'prompt' | 'voice-tts' | 'vad' | 'asr' | 'llm' | 'telecom' | 'platform' | 'unknown'

/**
 * The layer -> accountable team map, in one place.
 *
 * Duplicated deliberately from `LAYER_OWNER` in api/_voicebench.ts rather than
 * imported, for one reason: that file is server-side and this one renders in
 * the browser. Importing across that boundary would pull the whole bench
 * engine — and its audio fixture data — into the client bundle.
 *
 * The duplication is guarded by a test that asserts the two maps stay in step,
 * because a layer that routes to the wrong team in the UI is worse than one
 * that does not route at all.
 *
 * The wording is the point. "Voice & TTS settings (ElevenLabs voice,
 * stability, model)" tells a TTS engineer this is theirs without being told.
 * "TTS team" would have them checking whether it is.
 */
export const LAYER_TEAM: Record<FailureLayer, string> = {
  prompt: 'Prompt engineering',
  'voice-tts': 'Voice & TTS settings (ElevenLabs voice, stability, model)',
  asr: 'Platform / ASR configuration',
  llm: 'Prompt engineering',
  telecom: 'Telephony provider / network',
  vad: 'Turn-taking / VAD thresholds',
  platform: 'Telephony / platform config',
  unknown: 'Unattributed — needs a human',
}

/**
 * What to check first, per layer.
 *
 * Written as the first diagnostic step rather than the diagnosis, because the
 * bench reports symptoms and the owner needs to know where to start. Each is
 * the thing that is most often wrong when this layer produces this symptom.
 */
export const FAILURE_LAYERS: FailureLayer[] = ['prompt', 'asr', 'llm', 'voice-tts', 'vad', 'telecom', 'unknown']
export const LAYER_LABEL: Record<FailureLayer, string> = { prompt: 'Prompt', asr: 'ASR', llm: 'LLM', 'voice-tts': 'TTS / voice', vad: 'VAD / turn-taking', telecom: 'Telephony', platform: 'Telephony (legacy platform)', unknown: 'Unknown' }

export const LAYER_FIRST_CHECK: Record<FailureLayer, string> = {
  asr: 'Check the recognizer configuration against the recording and reference transcript.',
  llm: 'Check the model and response configuration against the prompt and evidence.',
  telecom: 'Check provider latency, line quality and network telemetry for this call.',
  prompt: 'Read the prompt around the evidence quote — usually a rule that says one thing and the flow does another.',
  'voice-tts': 'Check the voice, stability setting and model on the failing segment before touching the text.',
  vad: 'Check the silence threshold and end-of-turn timeout. Most VAD failures are a threshold, not a model.',
  platform: 'Check line quality and provider latency for the affected numbers — a bad line is not a prompt bug.',
  unknown: 'The layer could not be determined from the signal. Play the call before assigning this.',
}

/**
 * Coerce free-text layer labels onto the closed set.
 *
 * The layer does not arrive from a type — it arrives from an LLM judge that
 * writes prose, and it arrives from a simulator that uses `simulation` as a
 * pseudo-layer. Both mean the same thing here: not one of the four real layers.
 *
 * So this matches generously on substrings ("asr", "speech recognition",
 * "transcription" -> asr; "tts", "elevenlabs", "voice" -> voice-tts) and
 * falls back to `unknown` for anything unrecognised. The fallback matters
 * more than the matching: an unroutable label has to land on `unknown` and
 * show up as "needs a human" rather than being forced into the nearest fit.
 * A confidently mis-routed defect is worse than an admitted unknown, because
 * it sends the VAD team to fix a prompt.
 *
 * Note `simulation` is explicitly NOT a layer. It records that the failure was
 * found by a simulated caller rather than a real one, which is provenance and
 * belongs in the description — but as an owner it means nobody, because the
 * simulated caller is not a customer whose complaint needs routing.
 */
export function toFailureLayer(raw: string | undefined | null): FailureLayer {
  if (!raw) return 'unknown'
  const s = raw.toLowerCase()
  if (/simulation|simulated|synthetic/.test(s)) return 'unknown'

  // A label naming two layers has no single owner, and picking one silently
  // converts a two-team problem into a one-team problem that the other team
  // never learns about. Count the distinct layers that match and refuse to
  // guess when there is more than one.
  const asr = /asr|speech recognition|transcri|speech to text|\bstt\b/.test(s)
  const tts = /tts|voice|speech synth|elevenlabs|vocal|audio quality|pronunciation/.test(s)
  const vad = /vad|turn.?taking|interrupt|barge|silence|endpoint|latency|backchannel/.test(s)
  const telecom = /telecom|telephon|platform|network/.test(s)
  const llm = /llm|language model/.test(s)
  const prompt = /prompt|response|instruction|instructional|tone|persona|content|flow|node/.test(s)

  const hits = [asr, tts, vad, prompt, llm, telecom].filter(Boolean).length
  if (hits === 0) return 'unknown'
  if (hits > 1) return 'unknown'

  // Single hit. Order within this block does not matter now that ambiguity is
  // excluded above — that was the whole reason for counting first.
  //
  // The word "platform" is folded into the ASR branch on purpose: `platform` is
  // the app-level layer (telephony, ASR config, provider settings) and the enum
  // value the analyser emits for it. Treating it as its own case meant
  // `toFailureLayer('platform')` — the exact enum value — fell through to
  // unknown, which is the worst kind of bug in a lookup: it works on every
  // value except the one you typed.
  if (asr) return 'asr'
  if (llm) return 'llm'
  if (telecom) return 'telecom'
  if (tts) return 'voice-tts'
  if (vad) return 'vad'
  return 'prompt'
}

export type CallVerdict = 'pending' | 'analyzing' | 'good' | 'mixed' | 'bad' | 'error'

export interface CallFinding {
  id: string
  layer: FailureLayer
  severity: Severity
  what: string // what went wrong on this call
  evidence: string // transcript quote proving it
  suggestedFix: string // concrete edit (prompt line / setting change)
  issueId: string | null // set when promoted to the Issue board
}

export interface CallAnalysis {
  id: string
  batchId: string
  fileName: string
  transcript: string
  recordingName: string // matched audio file, if any (metadata only)
  verdict: CallVerdict
  summary: string // 1-2 lines: what happened on this call
  goalAchieved: boolean | null // did the call reach the agent's goal
  scores: Score[] // AI-judged on the same rubric testers use
  findings: CallFinding[]
  error: string
  createdAt: string
}

export interface BulkBatch {
  id: string
  agentId: string
  versionId: string
  name: string
  report: string // aggregate improvement plan (markdown), generated after runs
  createdAt: string
}

export interface AppState {
  gates?: import('../api/_gate').GatePolicy[]
  projects: Project[]
  agents: Agent[]
  versions: PromptVersion[]
  sessions: TestSession[]
  issues: Issue[]
  rubric: RubricParam[]
  testers: string[]
  batches: BulkBatch[]
  calls: CallAnalysis[]
  scenarios: Scenario[]
}

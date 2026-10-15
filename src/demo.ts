import type { AppState, Observation, Scenario, TestSession } from './types'
import { defaultRubric } from './data'

/**
 * A sample workspace, so a first-time user sees every screen working before
 * they have logged anything.
 *
 * Every record is fabricated and says so: the project name ends "(sample data)"
 * and every tester is named "Sample tester". Nothing here is a measurement and
 * none of it should be quoted as one. It is shaped to show the one thing the
 * product exists for: v2 fixes the discount answer and quietly breaks
 * interruption handling, which the version comparison catches and a composite
 * score would hide.
 */

export const DEMO_PROJECT_ID = 'demo-project'
export const isDemo = (s: AppState): boolean => s.projects.some(p => p.id === DEMO_PROJECT_ID)

const AGENT = 'demo-agent'
const V1 = 'demo-v1'
const V2 = 'demo-v2'
const T = 'Sample tester'

const PROMPT_V1 = `You are Priya, an outbound sales agent for a residential project.
- Greet in the caller's language. Switch to Hindi the moment they do.
- When the caller interrupts, stop speaking and answer what they asked.
- Do not quote discounts. Offer a callback from a sales expert instead.`

const PROMPT_V2 = `You are Priya, an outbound sales agent for a residential project.
- Greet in the caller's language. Switch to Hindi the moment they do.
- Always finish explaining the payment plan before taking questions.
- If asked about a discount, state that festive offers start at 2% and offer a callback.`

const scen = (id: string, name: string, persona: string, goal: string, success: string, language: string, tags: string[]): Scenario => ({
  id, agentId: AGENT, name, persona, goal, successCriteria: success, language, tags,
  status: 'approved', proposedBy: '', createdAt: '2026-09-20T09:00:00.000Z',
})

const SCENARIOS: Scenario[] = [
  scen('demo-sc-price', 'Price objection', 'First-time buyer, polite but price sensitive.', 'Find out whether any discount is available.', 'Gives a straight answer on offers, then offers a callback.', 'Hinglish', ['objection']),
  scen('demo-sc-hindi', 'Caller switches to Hindi', 'Starts in English, moves to Hindi after the greeting.', 'Ask about possession date.', 'Follows the switch within one turn and keeps the facts right.', 'Hinglish', ['code-switching']),
  scen('demo-sc-interrupt', 'Caller interrupts mid-sentence', 'Busy professional who cuts in with a question.', 'Get the EMI figure without hearing the whole pitch.', 'Stops talking within a second and answers the question asked.', 'English', ['interruption', 'turn-taking']),
]

const TRANSCRIPT_INTERRUPT_V2 = `[00:02] Agent: Namaste, main Priya bol rahi hoon, Green Acres se.
[00:06] Customer: Haan, quickly batao EMI kitna hai?
[00:09] Agent: Ji zaroor. Pehle main aapko payment plan samjhati hoon, isme teen stages hain
[00:13] Customer: Nahi nahi, bas EMI bata do
[00:15] Agent: pehla stage booking ka hai, doosra construction linked
[00:21] Customer: Hello? Main EMI pooch raha hoon
[00:24] Agent: Ji, EMI lagbhag 32,000 rupaye mahina hogi
[00:29] Customer: Theek hai, baad mein baat karte hain`

const TRANSCRIPT_INTERRUPT_V1 = `[00:02] Agent: Namaste, main Priya bol rahi hoon, Green Acres se.
[00:06] Customer: Haan, quickly batao EMI kitna hai?
[00:08] Agent: Ji, 2BHK ke liye EMI lagbhag 32,000 rupaye mahina hai.
[00:13] Customer: Accha, aur possession kab hai?
[00:16] Agent: December 2027 ka target hai.`

let n = 0
type NoteIn = Partial<Omit<Observation, 'id' | 'sessionId'>> & Pick<Observation, 'whatHappened'>
const note = (o: NoteIn): NoteIn => o

/** scores in rubric order: understanding, accuracy, helpfulness, naturalness, recovery, tone, clarity, pronunciation, interruptions, callflow */
const IDS = ['understanding', 'accuracy', 'helpfulness', 'naturalness', 'recovery', 'tone', 'clarity', 'pronunciation', 'interruptions', 'callflow']

function session(id: string, versionId: string, sc: Scenario, day: number, vals: number[], transcript: string, notes: NoteIn[] = []): TestSession {
  return {
    id, agentId: AGENT, versionId, tester: T, useCase: sc.name, scenarioId: sc.id,
    transcript, recordingName: '', comments: '',
    createdAt: new Date(Date.UTC(2026, 8, day, 10, 30)).toISOString(),
    scores: IDS.map((pid, i) => ({ paramId: pid, paramName: defaultRubric.find(r => r.id === pid)?.name ?? pid, value: vals[i] })),
    observations: notes.map(x => {
      const well = x.kind === 'went-well'
      return {
        kind: 'went-wrong' as const, expected: '', quote: '', severity: well ? 'nitpick' as const : 'major' as const,
        triage: well ? 'accepted' as const : 'untriaged' as const, triageNote: '', issueId: null,
        ...x, id: `demo-o-${++n}`, sessionId: id,
      }
    }),
  }
}

export function demoState(base: AppState): AppState {
  n = 0
  const [price, hindi, interrupt] = SCENARIOS
  const sessions: TestSession[] = [
    // v1: interruption handling is good, the discount answer is evasive.
    session('demo-s1', V1, price, 21, [4, 4, 2, 4, 3, 3, 4, 4, 4, 4], '', [
      note({ whatHappened: 'Dodged the discount question three times', expected: 'Say whether an offer exists, then offer a callback', severity: 'major' }),
    ]),
    session('demo-s2', V1, price, 21, [4, 4, 2, 4, 4, 3, 4, 4, 4, 4], ''),
    session('demo-s3', V1, interrupt, 22, [5, 4, 4, 4, 4, 4, 4, 4, 5, 4], TRANSCRIPT_INTERRUPT_V1, [
      note({ kind: 'went-well', whatHappened: 'Stopped and answered the EMI question straight away', atSec: 8, quote: 'Ji, 2BHK ke liye EMI lagbhag 32,000 rupaye mahina hai.', triage: 'accepted', severity: 'nitpick' }),
    ]),
    session('demo-s4', V1, interrupt, 22, [4, 4, 4, 4, 4, 4, 4, 4, 4, 4], ''),
    session('demo-s5', V1, hindi, 23, [4, 4, 4, 4, 4, 4, 4, 3, 4, 4], ''),
    // v2: discount fixed, interruption handling broken by "finish the payment plan first".
    session('demo-s6', V2, price, 28, [4, 4, 5, 4, 4, 4, 4, 4, 4, 4], '', [
      note({ kind: 'went-well', whatHappened: 'Answered the discount question directly', triage: 'accepted', severity: 'nitpick' }),
    ]),
    session('demo-s7', V2, price, 28, [4, 5, 5, 4, 4, 4, 4, 4, 4, 4], ''),
    session('demo-s8', V2, interrupt, 29, [4, 4, 3, 3, 2, 3, 4, 4, 2, 3], TRANSCRIPT_INTERRUPT_V2, [
      note({ whatHappened: 'Kept explaining the payment plan after I asked for the EMI twice', atSec: 13, quote: 'pehla stage booking ka hai, doosra construction linked', expected: 'Stop and give the EMI', severity: 'blocker', layer: 'prompt' }),
    ]),
    session('demo-s9', V2, interrupt, 29, [4, 4, 3, 3, 2, 3, 4, 4, 1, 3], '', [
      note({ whatHappened: 'Talked over the caller for about 6 seconds', expected: 'Yield within a second', severity: 'major', layer: 'vad' }),
    ]),
    session('demo-s10', V2, hindi, 30, [4, 4, 4, 4, 4, 4, 4, 4, 3, 4], ''),
  ]

  return {
    ...base,
    projects: [...base.projects.filter(p => p.id !== DEMO_PROJECT_ID), { id: DEMO_PROJECT_ID, name: 'Green Acres sales (sample data)' }],
    agents: [...base.agents.filter(a => a.id !== AGENT), {
      id: AGENT, projectId: DEMO_PROJECT_ID, name: 'Priya (sample)', type: 'voice', direction: 'outbound', useCases: [],
    }],
    versions: [
      ...base.versions.filter(v => v.agentId !== AGENT),
      { id: V1, agentId: AGENT, number: 1, promptText: PROMPT_V1, changelog: 'First version', status: 'retired', createdAt: '2026-09-20T09:00:00.000Z', decisions: [] },
      { id: V2, agentId: AGENT, number: 2, promptText: PROMPT_V2, changelog: 'Answer discount questions; explain the payment plan first', status: 'testing', createdAt: '2026-09-27T09:00:00.000Z', decisions: [] },
    ],
    sessions: [...base.sessions.filter(s => s.agentId !== AGENT), ...sessions],
    scenarios: [...(base.scenarios ?? []).filter(s => s.agentId !== AGENT), ...SCENARIOS],
    testers: base.testers.includes(T) ? base.testers : [...base.testers, T],
    rubric: base.rubric.length ? base.rubric : defaultRubric,
  }
}

/** Remove every sample record and nothing else. */
export function withoutDemo(s: AppState): AppState {
  return {
    ...s,
    projects: s.projects.filter(p => p.id !== DEMO_PROJECT_ID),
    agents: s.agents.filter(a => a.id !== AGENT),
    versions: s.versions.filter(v => v.agentId !== AGENT),
    sessions: s.sessions.filter(x => x.agentId !== AGENT),
    issues: s.issues.filter(i => i.agentId !== AGENT),
    scenarios: (s.scenarios ?? []).filter(x => x.agentId !== AGENT),
    testers: s.testers.filter(t => t !== T),
  }
}

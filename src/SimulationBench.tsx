import { adapterLabel } from './adapters'
import { DEMO_MODE, DEMO_SERVER_REASON } from './mode'
import { useEffect, useRef, useState } from 'react'
import { SuiteResult, type SimResult, type SimFinding } from './SuiteResult'

import { useStore, currentVersion } from './store.tsx'
import type { Severity } from './types'
import { LAYER_TEAM, LAYER_FIRST_CHECK, toFailureLayer } from './types'
import { uid, now, defaultRubric } from './data'

/**
 * Client half of the simulation engine.
 *
 * Mirrors api/_simulate.ts. The scenario library is duplicated here rather than
 * imported because the API directory is server-only and this needs to render
 * the scenario browser before any call is made. The duplication is a
 * maintenance cost and it is the right trade: the alternative is a shared
 * module that both the edge bundle and the client bundle pull in, and the
 * judge's prompt ; which is the part that must never drift ; still lives
 * server-side and is the only copy that matters.
 *
 * Everything here goes through /api/simulate and /api/simulate-suite, so the
 * model key never reaches the browser and the transcripts are redacted on the
 * way in.
 */

export type Difficulty = 'baseline' | 'difficult' | 'adversarial'

export interface Behaviour {
  indirectOpening?: boolean
  interrupts?: boolean
  goesSilent?: boolean
  codeSwitches?: boolean
  mishears?: boolean
  repeatsQuestion?: boolean
  contradictory?: boolean
  noGoal?: boolean
  demandsHuman?: boolean
  hangsUpEarly?: boolean
  adversarialRequest?: boolean
  slowResponder?: boolean
  tangential?: boolean
  emotional?: boolean
}

export interface Scenario {
  id: string
  name: string
  intent: string
  language: 'en' | 'hi' | 'hinglish'
  difficulty: Difficulty
  behaviour: Behaviour
  context: string
}

export const DEFAULT_SCENARIOS: Scenario[] = [
  {
    id: 'sc-baseline-hot-lead', name: 'Hot lead, clear goal', difficulty: 'baseline', language: 'en',
    behaviour: {},
    intent: 'The happy path. A qualified lead calls knowing what they want. This should pass ; if it fails, nothing else on the board means anything.',
    context: 'You want a 2 BHK in the 80-90 lakh range. You have seen the brochure and you have two specific questions: the possession date and whether the project is RERA registered.',
  },
  {
    id: 'sc-cold-vague', name: 'Cold call, will not state a goal', difficulty: 'baseline', language: 'en',
    behaviour: { noGoal: true },
    intent: 'An inbound enquiry from someone with no intent. Tests whether the agent can qualify instead of pitching at a wall.',
    context: 'You clicked an ad but you are not seriously looking. You are curious but vague. If the agent pushes you for specifics, give short non-answers.',
  },
  {
    id: 'sc-price-misheard', name: 'Mishears the price', difficulty: 'difficult', language: 'en',
    behaviour: { mishears: true },
    intent: 'The agent states a figure, the caller mishears it and acts on the wrong number. Tests factual consistency across turns and whether the agent catches a wrong assumption.',
    context: 'You are on a budget of around 75 lakh. You are interested. When the agent tells you a price, mishear it as noticeably lower than it is and react with enthusiasm to the wrong number.',
  },
  {
    id: 'sc-interrupt-loop', name: 'Interrupts mid-sentence, three times', difficulty: 'difficult', language: 'en',
    behaviour: { interrupts: true, slowResponder: true },
    intent: 'The agent is mid-explanation and the caller cuts in, three times, then returns to the earlier point. Tests text recovery when the caller changes topic. Acoustic barge-in and stop latency are NOT MEASURED.',
    context: 'You are genuinely interested but you are in a hurry and you are talking to your spouse in the other room. You interrupt to say things like "wait, what about parking?" and "sorry, what was the size?"',
  },
  {
    id: 'sc-dead-air', name: 'Goes silent after the question', difficulty: 'difficult', language: 'en',
    behaviour: { goesSilent: true },
    intent: 'The agent asks a qualifying question and the caller simply stops responding. Tests recovery from a simulated silent turn in text. Real silence detection and hangup timing are NOT MEASURED.',
    context: 'You are interested but distracted. When the agent asks you a direct question, just stop talking. Come back only if the agent explicitly asks whether you are still there.',
  },
  {
    id: 'sc-hinglish-switch', name: 'Hinglish switch mid-call', difficulty: 'difficult', language: 'hinglish',
    behaviour: { codeSwitches: true },
    intent: 'The caller starts in English and switches to Hinglish without warning. Tests whether the agent follows the language or stays stuck in its English script. This checks language switching in text; ASR and pronunciation are NOT MEASURED.',
    context: 'You are comfortable in both languages. Start in English. Midway, switch naturally into Hinglish when the topic gets serious (payment, loan, registration). Switch back to English at the end.',
  },
  {
    id: 'sc-hindi-only', name: 'Hindi only, no English', difficulty: 'adversarial', language: 'hi',
    behaviour: {},
    intent: 'A caller who will not use English at all. Tests whether the agent degrades gracefully or produces English boilerplate the caller cannot follow.',
    context: 'You prefer speaking in Hindi. You want to know about payment options and whether loan assistance is available. If the agent replies in English, repeat your question in Hindi.',
  },
  {
    id: 'sc-impossible-ask', name: 'Demands what the agent cannot give', difficulty: 'adversarial', language: 'en',
    behaviour: { adversarialRequest: true, demandsHuman: true, emotional: true },
    intent: 'The caller demands a discount the agent cannot authorise, pushes back when refused, and asks for another customer\'s details. Tests refusal quality and whether the agent caves or fabricates.',
    context: 'You have seen the project is overpriced. You want 15% off, you want to speak to a manager, and you want to know what the last buyer paid. You are polite but firm, and you do not accept the first refusal.',
  },
  {
    id: 'sc-repeats-forever', name: 'Asks the same thing five times', difficulty: 'adversarial', language: 'en',
    behaviour: { repeatsQuestion: true, contradictory: true },
    intent: 'The caller never accepts an answer. Tests whether the agent varies its response usefully or emits the same sentence on a loop ; a failure mode that is invisible on a short call and unbearable on a long one.',
    context: 'You want to know the maintenance charges. Whatever the agent says, you are not satisfied. Ask again, slightly differently, five or six times. Occasionally claim the figure contradicts something you "saw online".',
  },
  {
    id: 'sc-hangup-early', name: 'Hangs up after the first error', difficulty: 'adversarial', language: 'en',
    behaviour: { hangsUpEarly: true, emotional: true },
    intent: 'The agent makes an error early and the caller leaves. Tests whether the agent recovers within one turn ; whether it notices, acknowledges, and corrects without being asked twice.',
    context: 'You are in a hurry. You want the carpet area of the 3 BHK. If the agent states something that is not what you expected, say "that is not what I asked" and hang up mid-sentence.',
  },
  {
    id: 'sc-tangential', name: 'Off-topic detour mid-qualification', difficulty: 'difficult', language: 'en',
    behaviour: { tangential: true },
    intent: 'The caller derails the conversation completely and then comes back. Tests whether the agent can hold qualification state across an interruption.',
    context: 'You are mid-way through qualifying. Suddenly ask about the weather, then about whether the agent has a family, then come back to the flat. If the agent forgets where you were, let it.',
  },
  {
    id: 'sc-slow-silent-hinglish', name: 'Everything at once', difficulty: 'adversarial', language: 'hinglish',
    behaviour: { goesSilent: true, codeSwitches: true, repeatsQuestion: true, slowResponder: true, indirectOpening: true },
    intent: 'The worst realistic call: slow responder, silent stretches, Hinglish, and repeated questions. A composite of every individual failure. Success here shows text behavior on this scenario. Production reliability is NOT MEASURED.',
    context: 'You are mildly interested. You are distracted. You start vaguely, go quiet when asked direct questions, switch to Hinglish, and repeat the price question several times. Be realistic and a bit annoying.',
  },
]

/* ---------------- server call helpers ---------------- */

export interface SimJudgement {
  verdict?: 'good' | 'mixed' | 'bad'
  summary?: string
  goalAchieved?: boolean | null
  scores?: { paramId: string; value: number }[]
  findings?: { layer: string; severity: string; what: string; evidence: string; suggestedFix: string }[]
}

async function post(path: string, body: unknown): Promise<any> {
  if (DEMO_MODE) throw new Error(DEMO_SERVER_REASON)
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!(res.headers.get('content-type') ?? '').includes('json')) {
    throw new Error('The simulation API is not running. Use `vercel dev`, or the deployed site.')
  }
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
  return data
}

export function runSuite(args: {
  agentName: string
  prompt: string
  scenarios: Scenario[]
  rubric: { id: string; name: string; question: string }[]
  signal?: AbortSignal
}) {
  return post('/api/simulate-suite', args)
}

/* ---------------- the view ---------------- */

const DIFF_ORDER: Difficulty[] = ['baseline', 'difficult', 'adversarial']

export function SimulationBench({ projectId }: { projectId: string }) {
  const { state, mutate } = useStore()
  const agents = state.agents.filter(a => a.projectId === projectId)
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '')
  const agent = agents.find(a => a.id === agentId)
  const version = agent ? currentVersion(state.versions, agent.id) : undefined

  const [selected, setSelected] = useState<string[]>(() => DEFAULT_SCENARIOS.map(s => s.id))
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; current: string }>({ done: 0, total: 0, current: '' })
  const [err, setErr] = useState('')
  const [lastRun, setLastRun] = useState<{ at: string; agentId: string; versionId: string } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // What the last run produced, held in local state rather than the shared
  // document. A simulation is a point-in-time measurement of a specific prompt
  // version; persisting it into the merged store would let two people run
  // suites concurrently and fight over the same record.
  const [result, setResult] = useState<SimResult | null>(null)

  useEffect(() => { setResult(null); setErr('') }, [agentId])

  if (!agent) return <p className="muted">Add an agent in Settings first.</p>
  if (!version) return <p className="muted">This agent has no prompt version to test yet. Add one in Versions.</p>

  const toggle = (id: string) =>
    setSelected(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]))

  const run = async () => {
    setErr(''); setRunning(true)
    setProgress({ done: 0, total: selected.length, current: 'starting…' })
    const ac = new AbortController()
    abortRef.current = ac
    try {
      const data = await runSuite({
        agentName: agent.name,
        prompt: version.promptText,
        scenarios: DEFAULT_SCENARIOS.filter(s => selected.includes(s.id)),
        rubric: (state.rubric.length ? state.rubric : defaultRubric).map(p => ({ id: p.id, name: p.name, question: p.question })),
        signal: ac.signal,
      })
      setResult(data)
      setLastRun({ at: now(), agentId: agent.id, versionId: version.id })
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }

  const promote = (finding: SimFinding, scenarioName: string) => {
    // The judge writes prose for `layer`, so it is normalised here rather than
    // trusted. An unroutable label must surface as "needs a human" rather than
    // landing on whichever team matched a substring.
    const L = toFailureLayer(finding.layer)
    const issue = {
      id: uid(), projectId, agentId: agent!.id,
      title: finding.what.slice(0, 90),
      description: `[${finding.layer}] ${finding.what}${finding.evidence ? ` ; "${finding.evidence}"` : ''}\nSuggested fix: ${finding.suggestedFix}\n(from simulation: ${scenarioName})`,
      severity: finding.severity as Severity,
      status: 'open' as const,
      bornInVersionId: version!.id,
      claimedFixedInVersionId: null, verifiedFixedInVersionId: null,
      resolutionNote: '', verifications: [], createdAt: now(),
      // Same seam as the bulk path: the simulator knows the layer, so the
      // issue is born routed instead of born anonymous.
      layer: L, ownerTeam: LAYER_TEAM[L], ownerPerson: '',
      attribution: LAYER_FIRST_CHECK[L],
    }
    mutate(d => { d.issues.push(issue) })
  }

  return (
    <>
      {/* ---------- the proactive banner ---------- */}
      <div className="card sim-hero">
        <div className="row">
          <h2 style={{ margin: 0 }}>Simulate before you ship</h2>
          <span className={`badge ${version.status}`}>v{version.number}</span>
          <div style={{ flex: 1 }} />
          <select className="field-input" value={agentId} onChange={e => setAgentId(e.target.value)} aria-label="Agent">
            {agents.map(a => <option key={a.id} value={a.id}>{adapterLabel(a.name)}</option>)}
          </select>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Runs your real prompt against {DEFAULT_SCENARIOS.length} simulated customers ; interruptions, silence, Hinglish
          switches, repeat questions, impossible demands. No phone line, no real customer, no waiting for real calls to
          go wrong. Results are scored on the same rubric and can go straight into the release gate.
        </p>
      </div>

      <p className="notice">Audio, interruption timing and production reliability are NOT MEASURED by these text simulations.</p>
      {/* ---------- scenario picker ---------- */}
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Scenarios</h2>
          <span className="muted">{selected.length} of {DEFAULT_SCENARIOS.length} selected</span>
          <div style={{ flex: 1 }} />
          <button className="btn small secondary" onClick={() => setSelected(DEFAULT_SCENARIOS.map(s => s.id))}>All</button>
          <button className="btn small secondary" onClick={() => setSelected([])}>None</button>
          <button className="btn small secondary"
            onClick={() => setSelected(DEFAULT_SCENARIOS.filter(s => s.difficulty === 'adversarial').map(s => s.id))}>
            Adversarial only
          </button>
        </div>
        {DIFF_ORDER.map(d => {
          const group = DEFAULT_SCENARIOS.filter(s => s.difficulty === d)
          if (!group.length) return null
          return (
            <div key={d} style={{ marginBottom: 10 }}>
              <div className="nav-group-label">{d} ({group.length})</div>
              {group.map(s => (
                <label key={s.id} className="sc-row">
                  <input type="checkbox" checked={selected.includes(s.id)} onChange={() => toggle(s.id)} />
                  <div className="grow">
                    <strong>{s.name}</strong>
                    <span className="muted"> ; {s.intent}</span>
                    <div className="row" style={{ gap: 4, marginTop: 4 }}>
                      <span className="badge draft">{s.language}</span>
                      {Object.entries(s.behaviour).filter(([, v]) => v).map(([k]) => (
                        <span key={k} className="badge layer-prompt">{k}</span>
                      ))}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )
        })}
        <div className="row">
          <button className="btn big" onClick={run} disabled={DEMO_MODE || running || selected.length === 0}>
            {running ? `Running… ${progress.done}/${progress.total}` : `▶ Simulate ${selected.length} call${selected.length === 1 ? '' : 's'}`}
          </button>
          {running && <button className="btn secondary" onClick={() => abortRef.current?.abort()}>Stop</button>}
          {err && <span style={{ color: 'var(--bad)' }}>{err}</span>}
        </div>
        {DEMO_MODE && <p className="muted">{DEMO_SERVER_REASON}</p>}
        {running && <p className="muted" style={{ marginBottom: 0 }}>Each call is several model round-trips. The full suite takes a few minutes.</p>}
      </div>

      {result && <SuiteResult result={result} onPromote={promote} />}
    </>
  )
}

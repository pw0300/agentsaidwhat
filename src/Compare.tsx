import { useState } from 'react'
import type { AppState, TestSession } from './types'
import { useStore, heatClass } from './store.tsx'
import { isProblem, paramsFor } from './notes'
import { EmptyState } from './nav'

/**
 * Two prompt versions, side by side, on the same scenarios.
 *
 * The question a builder asks before shipping is not "what is v13's score" but
 * "what did v13 change". A composite can go up while one parameter collapses,
 * which is the regression a single number hides. So this shows every parameter
 * as a delta, splits human from simulated evidence, and refuses to call a
 * difference when there are too few calls behind it.
 */

const MIN_CALLS = 3          // per version, per parameter, before a delta is shown as real
const NOISE = 0.25           // smaller moves are reported as "no change"

interface Side {
  sessions: TestSession[]
  humanSessions: number
  simulatedSessions: number
  aiCalls: number
  perParam: Record<string, { mean: number | null; n: number }>
  problems: number
  blockers: number
  byScenario: Record<string, { n: number; mean: number | null }>
}

export function measure(state: AppState, versionId: string, paramIds: string[]): Side {
  const sessions = state.sessions.filter(s => s.versionId === versionId)
  const batchIds = new Set(state.batches.filter(b => b.versionId === versionId).map(b => b.id))
  const calls = state.calls.filter(c => batchIds.has(c.batchId))
  const perParam: Side['perParam'] = {}
  for (const id of paramIds) {
    const vals = [...sessions.flatMap(s => s.scores.filter(x => !s.naParams?.includes(x.paramId))), ...calls.flatMap(c => c.scores)].filter(x => x.paramId === id).map(x => x.value)
    perParam[id] = { mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null, n: vals.length }
  }
  const problems = sessions.flatMap(s => s.observations).filter(isProblem)
  const byScenario: Side['byScenario'] = {}
  for (const s of sessions.filter(s => (s as TestSession & { source?: string }).source !== 'simulated')) {
    const vals = s.scores.filter(x => !s.naParams?.includes(x.paramId)).map(x => x.value)
    const e = (byScenario[s.useCase] ??= { n: 0, mean: null })
    const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
    if (mean != null) e.mean = e.mean == null ? mean : (e.mean * e.n + mean) / (e.n + 1)
    if (mean != null) e.n += 1
  }
  return {
    humanSessions: sessions.filter(s => (s as TestSession & { source?: string }).source !== 'simulated').length,
    simulatedSessions: sessions.filter(s => (s as TestSession & { source?: string }).source === 'simulated').length,
    sessions, aiCalls: calls.length, perParam, byScenario,
    problems: problems.length, blockers: problems.filter(o => o.severity === 'blocker').length,
  }
}

function verdict(a: { mean: number | null; n: number }, b: { mean: number | null; n: number }) {
  if (a.mean == null || b.mean == null) return { kind: 'none' as const, delta: null }
  const delta = b.mean - a.mean
  if (a.n < MIN_CALLS || b.n < MIN_CALLS) return { kind: 'thin' as const, delta }
  if (Math.abs(delta) < NOISE) return { kind: 'same' as const, delta }
  return { kind: delta > 0 ? 'up' as const : 'down' as const, delta }
}

export function Compare({ projectId }: { projectId: string }) {
  const { state } = useStore()
  const agents = state.agents.filter(a => a.projectId === projectId)
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '')
  const agent = agents.find(a => a.id === agentId)
  const versions = state.versions.filter(v => v.agentId === agentId).sort((a, b) => b.number - a.number)
  const [bId, setBId] = useState(versions[0]?.id ?? '')
  const [aId, setAId] = useState(versions[1]?.id ?? '')

  if (!agent) return <EmptyState icon="Agents" title="Add an agent to compare versions" body="An agent needs two tested versions to compare." actionLabel="Add an agent" to="settings" />
  if (versions.length < 2) {
    return <div className="card"><EmptyState icon="Versions" title="Comparison needs two versions" body={`${agent.name} needs another prompt version to compare.`} actionLabel="Add a version" to="versions" /></div>
  }

  const params = paramsFor(state, agent)
  const A = measure(state, aId, params.map(p => p.id))
  const B = measure(state, bId, params.map(p => p.id))
  const va = versions.find(v => v.id === aId)
  const vb = versions.find(v => v.id === bId)
  const rows = params.map(p => ({ p, a: A.perParam[p.id], b: B.perParam[p.id], v: verdict(A.perParam[p.id], B.perParam[p.id]) }))
  const ups = rows.filter(r => r.v.kind === 'up').length
  const downs = rows.filter(r => r.v.kind === 'down')
  const thin = rows.filter(r => r.v.kind === 'thin').length
  const scenarios = [...new Set([...Object.keys(A.byScenario), ...Object.keys(B.byScenario)])].sort()

  return (
    <div className="card">
      <div className="row">
        <h2 style={{ margin: 0 }}>Compare versions</h2>
        <div className="spacer" />
        <select className="field-input" style={{ width: 'auto' }} value={agentId} onChange={e => {
          const id = e.target.value
          const vs = state.versions.filter(v => v.agentId === id).sort((a, b) => b.number - a.number)
          setAgentId(id); setBId(vs[0]?.id ?? ''); setAId(vs[1]?.id ?? '')
        }} aria-label="Agent">
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select className="field-input" style={{ width: 'auto' }} value={aId} onChange={e => setAId(e.target.value)} aria-label="Baseline version">
          {versions.map(v => <option key={v.id} value={v.id}>v{v.number}</option>)}
        </select>
        <span className="muted">→</span>
        <select className="field-input" style={{ width: 'auto' }} value={bId} onChange={e => setBId(e.target.value)} aria-label="Candidate version">
          {versions.map(v => <option key={v.id} value={v.id}>v{v.number}</option>)}
        </select>
      </div>

      <p className="compare-summary">
        {downs.length > 0
          ? <><strong className="delta-down">v{vb?.number} is worse on {downs.map(r => r.p.name).join(', ')}.</strong> </>
          : ups > 0 ? <strong className="delta-up">No parameter got worse. </strong> : null}
        {ups > 0 && <>{ups} improved. </>}
        {thin > 0 && <span className="muted">{thin} parameter{thin === 1 ? ' has' : 's have'} fewer than {MIN_CALLS} calls on one side, so no call is made on {thin === 1 ? 'it' : 'them'}.</span>}
      </p>

      <table className="compare-table">
        <thead>
          <tr><th>Parameter</th><th>v{va?.number}</th><th>v{vb?.number}</th><th>Change</th></tr>
        </thead>
        <tbody>
          {rows.map(({ p, a, b, v }) => (
            <tr key={p.id} className={v.kind}>
              <td><strong>{p.name}</strong></td>
              <td><span className={`heat-pill ${heatClass(a.mean)}`}>{a.mean != null ? a.mean.toFixed(1) : '–'}</span> <span className="muted">n={a.n}</span></td>
              <td><span className={`heat-pill ${heatClass(b.mean)}`}>{b.mean != null ? b.mean.toFixed(1) : '–'}</span> <span className="muted">n={b.n}</span></td>
              <td>
                {v.kind === 'none' && <span className="muted">no data</span>}
                {v.kind === 'thin' && <span className="muted">{v.delta! >= 0 ? '+' : ''}{v.delta!.toFixed(1)} · too few calls</span>}
                {v.kind === 'same' && <span className="muted">no change</span>}
                {v.kind === 'up' && <span className="delta-up">▲ {v.delta!.toFixed(1)}</span>}
                {v.kind === 'down' && <span className="delta-down">▼ {Math.abs(v.delta!).toFixed(1)}</span>}
              </td>
            </tr>
          ))}
          <tr className="compare-foot">
            <td>Problems logged</td><td>{A.problems}{A.blockers ? ` (${A.blockers} blocker)` : ''}</td><td>{B.problems}{B.blockers ? ` (${B.blockers} blocker)` : ''}</td><td />
          </tr>
          <tr className="compare-foot">
            <td>Evidence</td>
            <td className="muted">{A.humanSessions} human · {A.aiCalls + A.simulatedSessions} simulated</td>
            <td className="muted">{B.humanSessions} human · {B.aiCalls + B.simulatedSessions} simulated</td><td />
          </tr>
        </tbody>
      </table>

      {scenarios.length > 0 && (
        <>
          <h3>By scenario (human calls)</h3>
          <table className="compare-table">
            <thead><tr><th>Scenario</th><th>v{va?.number}</th><th>v{vb?.number}</th></tr></thead>
            <tbody>
              {scenarios.map(sc => {
                const a = A.byScenario[sc], b = B.byScenario[sc]
                return (
                  <tr key={sc}>
                    <td>{sc}</td>
                    <td>{a ? <><span className={`heat-pill ${heatClass(a.mean)}`}>{a.mean?.toFixed(1) ?? '–'}</span> <span className="muted">n={a.n}</span></> : <span className="muted">not tested</span>}</td>
                    <td>{b ? <><span className={`heat-pill ${heatClass(b.mean)}`}>{b.mean?.toFixed(1) ?? '–'}</span> <span className="muted">n={b.n}</span></> : <span className="muted">not tested</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}
      <p className="muted" style={{ marginBottom: 0 }}>
        A change smaller than {NOISE} is shown as no change, and none is called with fewer than {MIN_CALLS} calls on either side.
        Human and simulated scores are pooled; the evidence row shows how much of each.
      </p>
    </div>
  )
}

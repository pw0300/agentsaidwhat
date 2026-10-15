import { adapterLabel } from './adapters'
import { useState } from 'react'
import type { Scenario, ScenarioStatus } from './types'
import { deleteScenario } from './workspaceActions'
import { uid, now } from './data'
import { useStore } from './store.tsx'
import { EmptyState } from './nav'
import { isProblem } from './notes'

/**
 * The scenario library: what to test, per agent.
 *
 * A scenario is written once and run two ways: by a person on a real call
 * (Log a call picks it) and by the simulator (Simulate calls uses the persona
 * and goal). Proposals from testers land here for a builder to approve, merge
 * or archive, so the library grows from what testers actually hit.
 */
export function Scenarios({ projectId, initialAgentId, initialScenarioId }: { projectId: string; initialAgentId?: string; initialScenarioId?: string }) {
  const { state, mutate } = useStore()
  const agents = state.agents.filter(a => a.projectId === projectId)
  const [agentId, setAgentId] = useState(initialAgentId ?? agents[0]?.id ?? '')
  const [editing, setEditing] = useState<string | null>(initialScenarioId ?? null)
  const [filter, setFilter] = useState<ScenarioStatus | 'all'>(initialScenarioId ? (state.scenarios ?? []).find(s => s.id === initialScenarioId)?.status ?? 'all' : 'all')

  if (agents.length === 0) {
    return <div className="card"><EmptyState icon="🎙" title="Add an agent first" body="Scenarios belong to an agent." actionLabel="Add an agent" to="settings" /></div>
  }

  const all = (state.scenarios ?? []).filter(s => s.agentId === agentId)
  const proposed = all.filter(s => s.status === 'proposed')
  const list = all.filter(s => filter === 'all' ? s.status !== 'archived' : s.status === filter)
    .sort((a, b) => (a.status === 'proposed' ? -1 : 0) - (b.status === 'proposed' ? -1 : 0) || a.name.localeCompare(b.name))

  const update = (id: string, patch: Partial<Scenario>) =>
    mutate(d => { const s = (d.scenarios ?? []).find(x => x.id === id); if (s) Object.assign(s, patch) })

  const add = () => {
    const sc: Scenario = {
      id: uid(), agentId, name: 'New scenario', persona: '', goal: '', successCriteria: '', language: '',
      tags: [], status: 'approved', proposedBy: '', createdAt: now(),
    }
    mutate(d => { (d.scenarios ??= []).push(sc) })
    setEditing(sc.id)
  }

  const usage = (sc: Scenario) => {
    const sessions = state.sessions.filter(s => s.agentId === sc.agentId && (s.scenarioId === sc.id || s.useCase === sc.name))
    const problems = sessions.reduce((n, s) => n + s.observations.filter(isProblem).length, 0)
    return { calls: sessions.length, problems }
  }

  return (
    <>
      <div className="card">
        <div className="row">
          <select className="field-input" style={{ width: 'auto' }} value={agentId} onChange={e => setAgentId(e.target.value)} aria-label="Agent">
            {agents.map(a => <option key={a.id} value={a.id}>{adapterLabel(a.name)}</option>)}
          </select>
          <div className="seg small">
            {(['all', 'approved', 'proposed', 'archived'] as const).map(f => (
              <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
                {f === 'all' ? 'Active' : f[0].toUpperCase() + f.slice(1)}{f === 'proposed' && proposed.length ? ` (${proposed.length})` : ''}
              </button>
            ))}
          </div>
          <div className="spacer" />
          <button className="btn" onClick={add}>+ Scenario</button>
        </div>
        {proposed.length > 0 && filter !== 'proposed' && (
          <p className="notice" style={{ marginBottom: 0 }}>{proposed.length} scenario{proposed.length === 1 ? '' : 's'} proposed by testers, waiting for review.</p>
        )}
      </div>

      {list.length === 0 && (
        <div className="card"><EmptyState icon="🗂" title="No scenarios here" body="A scenario is a situation worth testing: who is calling, what they want, and what a good outcome looks like." actionLabel="Add a scenario" onAction={add} /></div>
      )}

      {list.map(sc => {
        const u = usage(sc)
        const open = editing === sc.id
        return (
          <div key={sc.id} className={`card scenario ${sc.status}`}>
            {open ? (
              <>
                <label className="field" style={{ marginTop: 0 }}>Name</label>
                <input type="text" autoFocus value={sc.name} onChange={e => update(sc.id, { name: e.target.value })} />
                <div className="two-col">
                  <div>
                    <label className="field">Caller persona</label>
                    <textarea value={sc.persona} onChange={e => update(sc.id, { persona: e.target.value })} placeholder="Who is calling? Mood, what they know, how they talk. e.g. Busy professional, switches between Hindi and English, impatient with long answers." />
                  </div>
                  <div>
                    <label className="field">Caller's goal</label>
                    <textarea value={sc.goal} onChange={e => update(sc.id, { goal: e.target.value })} placeholder="What are they trying to get done? e.g. Find out the EMI for a 2BHK without giving their number." />
                  </div>
                </div>
                <label className="field">What success looks like</label>
                <textarea value={sc.successCriteria} onChange={e => update(sc.id, { successCriteria: e.target.value })} placeholder="e.g. Agent gives an EMI range, does not push for a site visit before answering, offers a callback." style={{ minHeight: 60 }} />
                <div className="two-col">
                  <div>
                    <label className="field">Language</label>
                    <input type="text" value={sc.language} onChange={e => update(sc.id, { language: e.target.value })} placeholder="e.g. Hinglish, Tamil-English, English" />
                  </div>
                  <div>
                    <label className="field">Tags (comma separated)</label>
                    <input type="text" value={sc.tags.join(', ')} onChange={e => update(sc.id, { tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean) })} placeholder="interruption, objection, noisy line" />
                  </div>
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="link danger" onClick={() => { if (confirm(`Delete "${sc.name}"? Calls logged against it keep its name.`)) mutate(d => { deleteScenario(d, sc.id) }) }}>Delete</button>
                  <div className="spacer" />
                  <button className="btn small" onClick={() => setEditing(null)}>Done</button>
                </div>
              </>
            ) : (
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div className="grow" onClick={() => setEditing(sc.id)} style={{ cursor: 'pointer' }}>
                  <div className="row" style={{ gap: 8 }}>
                    <strong>{sc.name}</strong>
                    {sc.status !== 'approved' && <span className={`badge ${sc.status === 'proposed' ? 'testing' : 'retired'}`}>{sc.status}</span>}
                    {sc.language && <span className="badge draft">{sc.language}</span>}
                    {sc.tags.map(t => <span key={t} className="badge draft">{t}</span>)}
                  </div>
                  {(sc.persona || sc.goal) ? (
                    <div className="muted" style={{ marginTop: 4 }}>{sc.persona}{sc.persona && sc.goal ? ' · ' : ''}{sc.goal}</div>
                  ) : (
                    <div className="muted" style={{ marginTop: 4 }}>No persona or goal yet. Add them so the simulator can run this scenario too.</div>
                  )}
                  {sc.status === 'proposed' && sc.proposedBy && <div className="muted">Proposed by {sc.proposedBy}</div>}
                </div>
                <div className="scenario-stats">
                  <span><strong>{u.calls}</strong> call{u.calls === 1 ? '' : 's'}</span>
                  <span className={u.problems ? 'warn-ink' : 'muted'}><strong>{u.problems}</strong> problem{u.problems === 1 ? '' : 's'}</span>
                </div>
                {sc.status === 'proposed' && (
                  <>
                    <button className="btn small" onClick={() => update(sc.id, { status: 'approved' })}>Approve</button>
                    <button className="btn small secondary" onClick={() => update(sc.id, { status: 'archived' })}>Archive</button>
                  </>
                )}
                {sc.status === 'archived' && <button className="btn small secondary" onClick={() => update(sc.id, { status: 'approved' })}>Restore</button>}
                {sc.status === 'approved' && <button className="btn small secondary" onClick={() => setEditing(sc.id)}>Edit</button>}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

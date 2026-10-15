import { adapterLabel } from './adapters'
import { useStore, currentVersion, avgScores, composite, heatClass } from './store.tsx'
import { useNav, EmptyState } from './nav'
import { untriagedCount } from './notes'

/** The landing view. The app used to open directly into a task (score a call)
 *  with no way to see the state of anything, which is why nothing felt
 *  navigable. This answers "what's going on?" before asking you to do work. */
export function Overview({ projectId, tester }: { projectId: string; tester: string }) {
  const { state } = useStore()
  const go = useNav()

  const agents = state.agents.filter(a => a.projectId === projectId)
  const agentIds = new Set(agents.map(a => a.id))
  const sessions = state.sessions.filter(s => agentIds.has(s.agentId))
  const issues = state.issues.filter(i => i.projectId === projectId)
  const untriaged = untriagedCount(state, agentIds)
  const openIssues = issues.filter(i => ['open', 'reopened'].includes(i.status)).length
  const awaitingVerify = issues.filter(i => i.status === 'claimed-fixed').length

  const weekAgo = Date.now() - 7 * 864e5
  const recent = sessions.filter(s => new Date(s.createdAt).getTime() > weekAgo).length

  // First run: the only honest thing to show is the path to a working setup.
  if (agents.length === 0) {
    return (
      <>
        <div className="hero">
          <h2 style={{ margin: '0 0 4px' }}>Welcome, {tester}</h2>
          <p>Three steps and you can start logging calls.</p>
        </div>
        <div className="card">
          <ol className="checklist">
            <li className="done"><span className="check">✓</span><div><strong>Project created</strong><div className="muted">You can add more later in Settings.</div></div></li>
            <li><span className="check">2</span><div><strong>Add an agent</strong><div className="muted">The voice or chat agent you want to test.</div><button className="btn small" onClick={() => go('settings')}>Add an agent →</button></div></li>
            <li><span className="check">3</span><div><strong>Add its first prompt version</strong><div className="muted">Every score is pinned to a version, so you can prove a change helped.</div><button className="btn small secondary" onClick={() => go('versions')}>Go to Versions →</button></div></li>
          </ol>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="stat-row">
        <Stat label="Calls scored (7 days)" value={recent} sub={`${sessions.length} all time`} onClick={() => go('scorecard')} />
        <Stat label="Waiting on triage" value={untriaged} tone={untriaged > 0 ? 'warn' : 'ok'} sub={untriaged ? 'Tester reports not yet reviewed' : 'Inbox zero'} onClick={() => go('triage')} />
        <Stat label="Open issues" value={openIssues} tone={openIssues > 0 ? 'bad' : 'ok'} sub={`${awaitingVerify} awaiting verification`} onClick={() => go('issues')} />
        <Stat label="Agents" value={agents.length} sub={`${state.versions.filter(v => agentIds.has(v.agentId)).length} prompt versions`} onClick={() => go('versions')} />
      </div>

      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Start something</h2>
          <div className="spacer" style={{ flex: 1 }} />
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          {/* Same glyph as the sidebar entry it leads to — a destination should
              carry one mark everywhere, and colour emoji fought the accent fill. */}
          <button className="btn big" onClick={() => go('score')}>✎ Log a call</button>
          <button className="btn big secondary" onClick={() => go('calls')}>🎧 Review calls</button>
          <button className="btn big secondary" onClick={() => go('bulk')}>⛁ Analyse calls in bulk</button>
          {untriaged > 0 && <button className="btn big secondary" onClick={() => go('triage')}>⚑ Triage {untriaged} report{untriaged === 1 ? '' : 's'}</button>}
        </div>
      </div>

      <div className="card">
        <h2>Agents</h2>
        <div className="agent-cards">
          {agents.map(a => {
            const v = currentVersion(state.versions, a.id)
            const vSessions = v ? sessions.filter(s => s.versionId === v.id) : []
            const comp = composite(avgScores(vSessions))
            const open = issues.filter(i => i.agentId === a.id && ['open', 'reopened', 'claimed-fixed'].includes(i.status)).length
            const last = vSessions.map(s => s.createdAt).sort().pop()
            return (
              <div key={a.id} className="agent-card" onClick={() => go('score')}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div className="name">{adapterLabel(a.name)}</div>
                  <span className={`score-chip ${heatClass(comp)}`}>
                    {comp != null ? comp.toFixed(1) : '–'}
                  </span>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <span className={`badge ${a.type}`}>{a.type === 'voice' ? '🎙 Voice' : '💬 Chatbot'}</span>
                  {v ? <span className={`badge ${v.status}`}>v{v.number}</span> : <span className="badge draft">no version</span>}
                </div>
                <div className="muted" style={{ marginTop: 8 }}>
                  {vSessions.length} call{vSessions.length === 1 ? '' : 's'} scored
                  {open > 0 && <> · {open} open issue{open === 1 ? '' : 's'}</>}
                </div>
                <div className="muted">{last ? `Last tested ${new Date(last).toLocaleDateString()}` : 'Never tested'}</div>
              </div>
            )
          })}
        </div>
      </div>

      {sessions.length === 0 && (
        <div className="card">
          <EmptyState
            icon="📞"
            title="No calls scored yet"
            body="Make a real call to one of your agents, then score it here. It takes about three minutes."
            actionLabel="Score your first call"
            to="score"
          />
        </div>
      )}
    </>
  )
}

function Stat({ label, value, sub, tone, onClick }: {
  label: string; value: number; sub?: string; tone?: 'ok' | 'warn' | 'bad'; onClick?: () => void
}) {
  return (
    <button className={`stat ${tone ?? ''}`} onClick={onClick}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </button>
  )
}

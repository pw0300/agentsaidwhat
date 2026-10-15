import { adapterLabel } from './adapters'
import { deleteProject, toggleParameter } from './workspaceActions'
import { portableBackup, parseBackup } from './backup'
import { audioUrl } from './audio'
import { DEMO_MODE, DEMO_SERVER_REASON } from './mode'
import { useEffect, useState } from 'react'
import type { AgentType, Direction } from './types'
import { migrateScenarios, uid } from './data'
import { isDemo, withoutDemo } from './demo'
import { useStore } from './store.tsx'
import { apiHealth, getAccessCode, setAccessCode, type ApiHealth } from './api'

/**
 * There is no API key field here any more. The key used to be pasted into this
 * browser and sent to Anthropic directly, which meant every tester who got the
 * link also got the key. Analysis now runs through this app's own /api/anthropic
 * function and the key lives in a Vercel environment variable.
 *
 * What is left is status — a tester who clicks "AI: what to fix" and gets an
 * error should be able to come here and see whether the deployment is missing
 * its key or whether their access code is wrong.
 */
function AiAnalysisCard() {
  const [health, setHealth] = useState<ApiHealth | null | 'loading'>('loading')
  const [code, setCode] = useState(getAccessCode())

  useEffect(() => { apiHealth().then(setHealth) }, [])

  return (
    <div className="card">
      <h2>AI analysis</h2>
      {DEMO_MODE && <p className="muted">{DEMO_SERVER_REASON}</p>}
      {health === 'loading' && <p className="muted">Checking the analysis service…</p>}
      {health === null && (
        <p className="muted">
          No analysis service on this origin. That is expected with <code>npm run dev</code>, which serves the app but
          not the functions. Run <code>npm run local</code> and set <code>ANTHROPIC_API_KEY</code> in the server environment for AI analysis. Manual logging and scoring still work without it.
        </p>
      )}
      {health && health !== 'loading' && (
        <>
          <p className="muted">
            {health.anthropic
              ? 'Ready. Analysis runs on the server — no API key is stored in your browser.'
              : 'Set ANTHROPIC_API_KEY in the server environment and restart or redeploy for AI analysis and simulation. Manual logging, scoring, triage and gates over saved evidence still work without it.'}
          </p>
          {health.accessCodeRequired && (
            <>
              <label className="field">Team access code</label>
              <input
                type="password"
                value={code}
                placeholder="ask whoever set up this deployment"
                onChange={e => { setCode(e.target.value); setAccessCode(e.target.value.trim()) }}
              />
              <p className="muted">Gates the analysis endpoint so a shared link is not an open relay. Revocable, and worth nothing outside this deployment.</p>
            </>
          )}
        </>
      )}
    </div>
  )
}

export function Settings({ testerMode, onTesterMode, dense, onDense }: {
  dense: boolean
  onDense: (dense: boolean) => void
  testerMode: boolean
  onTesterMode: (on: boolean) => void
}) {
  const { state, mutate, sync } = useStore()
  const [health, setHealth] = useState<ApiHealth | null>(null)
  useEffect(() => { void apiHealth().then(setHealth) }, [])
  const [projName, setProjName] = useState('')
  const [rubricFor, setRubricFor] = useState<string | null>(null)
  const [agent, setAgent] = useState({ name: '', projectId: state.projects[0]?.id ?? '', type: 'voice' as AgentType, direction: 'outbound' as Direction, useCases: '' })
  const [tester, setTester] = useState('')

  return (
    <div className="page">
      <div className="card"><h2>Display</h2><label className="toggle"><input type="checkbox" checked={dense} onChange={e => onDense(e.target.checked)} /> Dense mode</label><p className="muted">Tighter spacing for reviewing more calls at once.</p></div>
      <div className="card">
        <h2>Backup & sync</h2>
        {/* Whether two testers on this link see each other's work is the single
            most consequential fact about the deployment, so it is stated first
            and in those terms — not as a connection-status decoration. */}
        {DEMO_MODE ? <p className="muted">Read-only sample workspace. Nothing is saved to a server.</p> : health?.mode === 'local' ? (
          <p className="muted">
            <strong>Saved on this machine</strong> in <code>{health.home}</code>: one SQLite file plus an <code>audio</code> folder.
            Every revision is kept, so a bad edit can be undone. Anyone on your network can use this workspace if you start the
            server with <code>HOST=0.0.0.0</code>.
          </p>
        ) : sync.status === 'local-only' ? (
          <p className="muted">
            <strong>This browser only.</strong> No shared store is connected, so anyone else on this link builds a
            separate dataset. Export/import is the only way to move data between people. To turn on sharing, add an
            Upstash Redis database from the Vercel marketplace and redeploy.
          </p>
        ) : (
          <p className="muted">
            <strong>Shared.</strong> Everyone on this link reads and writes one record; your edits go up a couple of
            seconds after you make them and other people's arrive within a minute.
            {sync.status === 'syncing' && ' Syncing…'}
            {sync.status === 'error' && ` Last sync failed: ${sync.error}`}
            {sync.status === 'idle' && sync.lastAt && ` Last synced ${new Date(sync.lastAt).toLocaleTimeString()}.`}
            {' '}
            <button className="btn small secondary" onClick={sync.syncNow}>Sync now</button>
          </p>
        )}
        <p className="muted">Export regularly regardless — it is the only copy you control.</p>
        <p className="muted">Workspace JSON includes transcripts, scores, notes, issues, scenarios and policies. Recordings are not included. Export recordings separately below. Restore keeps filenames and removes server audio links; attach the downloaded recordings to restored calls.</p>
        <button className="btn secondary" disabled={DEMO_MODE || !state.sessions.some(s => s.audioId)} onClick={async () => {
          try {
            for (const session of state.sessions.filter(s => s.audioId)) {
              const response = await fetch(audioUrl(session.audioId!))
              if (!response.ok || response.headers.get('content-type')?.includes('text/html')) throw new Error(`Recording unavailable for ${session.recordingName || session.id}.`)
              const url = URL.createObjectURL(await response.blob())
              const link = document.createElement('a')
              link.href = url; link.download = `${session.id}-${session.recordingName || 'recording'}`; link.click()
              setTimeout(() => URL.revokeObjectURL(url), 10000)
            }
          } catch (error) { alert(`Recording export stopped: ${error instanceof Error ? error.message : error}`) }
        }}>Export recordings separately</button>
        <p className="muted">Downloads one file per recorded call. Allow multiple downloads in your browser. A filename alone does not mean audio was stored.</p>
        <div className="row">
          <button className="btn secondary" onClick={() => {
            const blob = new Blob([JSON.stringify(portableBackup(state), null, 2)], { type: 'application/json' })
            const a = document.createElement('a')
            a.href = URL.createObjectURL(blob)
            a.download = `saidwhat-backup-${new Date().toISOString().slice(0, 10)}.json`
            a.click()
            URL.revokeObjectURL(a.href)
          }}>⬇ Export workspace JSON</button>
          <label className="btn secondary" style={{ display: 'inline-block' }}>
            ⬆ Import backup
            <input type="file" accept=".json" style={{ display: 'none' }} onChange={e => {
              const f = e.target.files?.[0]
              if (!f) return
              f.text().then(txt => {
                try {
                  const parsed = parseBackup(txt)
                  if (confirm('Replace ALL current data with this backup?')) mutate(d => Object.assign(d, parsed))
                } catch (err) { alert(`Could not import: ${err instanceof Error ? err.message : err}`) }
              }).catch(err => alert(`Could not read backup: ${err instanceof Error ? err.message : err}`))
              e.target.value = ''
            }} />
          </label>
        </div>
      </div>

      <div className="card">
        <h2>Who is using this link</h2>
        <p className="muted">
          Tester view hides everything except call scoring, so someone you hand the link to can only do the one job you
          need from them. It applies to this browser only — switching it here does not affect anyone else.
        </p>
        <div className="row">
          <button className={`btn ${testerMode ? 'secondary' : ''}`} onClick={() => onTesterMode(false)}>
            Builder view {!testerMode && '✓'}
          </button>
          <button className={`btn ${testerMode ? '' : 'secondary'}`} onClick={() => onTesterMode(true)}>
            Tester view {testerMode && '✓'}
          </button>
        </div>
      </div>

      <AiAnalysisCard />

      <div className="card">
        <h2>Projects</h2>
        {state.projects.map(p => (
          <div key={p.id} className="row" style={{ marginBottom: 6 }}>
            <span className="grow">{p.name}</span>
            <button className="btn small danger" onClick={() => { if (confirm(`Delete project "${p.name}" and all its agents/data?`)) mutate(d => {
              deleteProject(d, p.id)
            }) }}>delete</button>
          </div>
        ))}
        <div className="row">
          <input type="text" className="grow" value={projName} onChange={e => setProjName(e.target.value)} placeholder="New project name" />
          <button className="btn secondary" disabled={!projName.trim()} onClick={() => { mutate(d => { d.projects.push({ id: uid(), name: projName.trim() }) }); setProjName('') }}>Add</button>
        </div>
      </div>

      {isDemo(state) && (
        <div className="card notice-card">
          <h2>Sample data is loaded</h2>
          <p className="muted">The "Green Acres sales (sample data)" project, its agent, versions and ten calls are made up. Removing them leaves everything you created untouched.</p>
          <button className="btn danger" onClick={() => { if (confirm('Remove all sample data?')) mutate(d => { Object.assign(d, withoutDemo(d)) }) }}>Remove sample data</button>
        </div>
      )}

      <div className="card">
        <h2>Agents</h2>
        <p className="muted">Vapi, Retell, Pipecat and LiveKit adapters are experimental. Text connectors and SDK bridges have not been verified on live deployments. Audio and timing remain NOT MEASURED.</p>
        {state.agents.map(a => (
          <div key={a.id} className="row" style={{ marginBottom: 6 }}>
            <span className="grow">{adapterLabel(a.name)} <span className={`badge ${a.type}`}>{a.type}</span> <span className="muted">{a.direction} · {state.projects.find(p => p.id === a.projectId)?.name} · {a.paramIds?.length ? `${a.paramIds.length} rubric parameters` : 'all rubric parameters'}</span></span>
            <button className="btn small secondary" onClick={() => setRubricFor(rubricFor === a.id ? null : a.id)}>{rubricFor === a.id ? 'Done' : 'Rubric'}</button>
            <button className="btn small danger" onClick={() => { if (confirm(`Delete agent "${adapterLabel(a.name)}" and its data?`)) mutate(d => {
              d.agents = d.agents.filter(x => x.id !== a.id)
              d.versions = d.versions.filter(v => v.agentId !== a.id)
              d.sessions = d.sessions.filter(s => s.agentId !== a.id)
              d.issues = d.issues.filter(i => i.agentId !== a.id)
              d.scenarios = (d.scenarios ?? []).filter(x => x.agentId !== a.id)
            }) }}>delete</button>
            {rubricFor === a.id && (
              <div className="rubric-pick">
                <p className="muted" style={{ margin: '0 0 6px' }}>Which parameters is {adapterLabel(a.name)} scored on? Unticking one hides it from testers for this agent; past scores are kept.</p>
                {state.rubric.filter(p => p.appliesTo.includes(a.type)).map(p => {
                  const on = !a.paramIds?.length || a.paramIds.includes(p.id)
                  return (
                    <label key={p.id} className="toggle" style={{ display: 'flex', margin: '4px 0' }}>
                      <input type="checkbox" checked={on} onChange={() => mutate(d => {
                        const ag = d.agents.find(x => x.id === a.id)
                        if (!ag) return
                        if (!toggleParameter(ag, d.rubric, p.id)) alert('Keep at least one rubric parameter selected.')
                      })} />
                      <span><strong>{p.name}</strong> <span className="muted">{p.question}</span></span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        ))}
        <label className="field">Add agent</label>
        <div className="row">
          <input type="text" className="grow" value={adapterLabel(agent.name)} onChange={e => setAgent({ ...agent, name: e.target.value })} placeholder="Agent name" />
          <select className="field-input" style={{ width: 'auto' }} value={agent.projectId} onChange={e => setAgent({ ...agent, projectId: e.target.value })}>
            {state.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select className="field-input" style={{ width: 'auto' }} value={agent.type} onChange={e => setAgent({ ...agent, type: e.target.value as AgentType })}>
            <option value="voice">Voice</option><option value="chatbot">Chatbot</option>
          </select>
          <select className="field-input" style={{ width: 'auto' }} value={agent.direction} onChange={e => setAgent({ ...agent, direction: e.target.value as Direction })}>
            <option value="outbound">Outbound</option><option value="inbound">Inbound</option><option value="both">Both</option>
          </select>
        </div>
        <label className="field">Starting scenarios (one per line; manage them later under Scenarios)</label>
        <textarea value={agent.useCases} onChange={e => setAgent({ ...agent, useCases: e.target.value })} placeholder={'Cold lead follow-up\nPrice objection\nSchedule a site visit'} />
        <div style={{ marginTop: 8 }}>
          <button className="btn secondary" disabled={!agent.name.trim() || !agent.projectId} onClick={() => {
            mutate(d => {
              d.agents.push({ id: uid(), projectId: agent.projectId, name: agent.name.trim(), type: agent.type, direction: agent.direction, useCases: agent.useCases.split('\n').map(s => s.trim()).filter(Boolean) })
              migrateScenarios(d)
            })
            setAgent({ ...agent, name: '', useCases: '' })
          }}>Add agent</button>
        </div>
      </div>

      <div className="card">
        <h2>Testers</h2>
        <div className="row" style={{ marginBottom: 8 }}>
          {state.testers.map(t => (
            <span key={t} className="badge draft">{t} <button className="chip-x" aria-label={`Remove ${t}`} onClick={() => mutate(d => { d.testers = d.testers.filter(x => x !== t) })}>✕</button></span>
          ))}
        </div>
        <div className="row">
          <input type="text" className="grow" value={tester} onChange={e => setTester(e.target.value)} placeholder="Tester name" />
          <button className="btn secondary" disabled={!tester.trim()} onClick={() => { mutate(d => { if (!d.testers.includes(tester.trim())) d.testers.push(tester.trim()) }); setTester('') }}>Add</button>
        </div>
      </div>

      <div className="card">
        <h2>Rubric</h2>
        <p className="muted">Edit the questions testers answer. Changing wording is safe; deleting a parameter keeps old scores (they're stored with their name).</p>
        {state.rubric.map(p => (
          <div key={p.id} className="row" style={{ marginBottom: 6 }}>
            <input type="text" style={{ width: 180 }} value={p.name} onChange={e => mutate(d => { const r = d.rubric.find(x => x.id === p.id); if (r) r.name = e.target.value })} />
            <input type="text" className="grow" value={p.question} onChange={e => mutate(d => { const r = d.rubric.find(x => x.id === p.id); if (r) r.question = e.target.value })} />
            <select className="field-input" style={{ width: 'auto' }} value={p.appliesTo.join('+')} onChange={e => mutate(d => { const r = d.rubric.find(x => x.id === p.id); if (r) r.appliesTo = e.target.value.split('+') as AgentType[] })}>
              <option value="voice+chatbot">Both</option>
              <option value="voice">Voice only</option>
              <option value="chatbot">Chatbot only</option>
            </select>
            <button className="btn small danger" onClick={() => mutate(d => { d.rubric = d.rubric.filter(x => x.id !== p.id) })}>✕</button>
          </div>
        ))}
        <button className="btn secondary" onClick={() => mutate(d => { d.rubric.push({ id: uid(), name: 'New parameter', question: 'What should the tester judge?', appliesTo: ['voice', 'chatbot'], anchors: { 1: 'Bad', 3: 'Okay', 5: 'Great' } }) })}>+ Add parameter</button>
      </div>
    </div>
  )
}

import { adapterLabel } from './adapters'
import { DEMO_MODE, DEMO_SERVER_REASON } from './mode'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { audioUrl } from './audio'
import { formatTime } from './transcript'
import { diffLines } from 'diff'
import type { Agent, Issue, IssueStatus, PromptVersion, TestSession } from './types'
import { LAYER_TEAM, LAYER_FIRST_CHECK } from './types'
import { uid, now } from './data'
import { useStore, currentVersion, avgScores, composite, heatClass } from './store.tsx'
import { analyzeSession } from './ai'
import { isProblem } from './notes'
import { EmptyState } from './nav'
import { useHotkeys, Kbd } from './hotkeys'
import { Player, useAudioClock } from './Player'
import { IssueDrawer } from './IssueDrawer'
import { adjacentIssue } from './issueNavigation'

/* Each of these is a top-level destination in the sidebar — they used to be
   tabs nested inside a "Workbench" tab, which buried them two levels deep. */

/* A horizontally scrolling table whose first column is frozen. The shadow only
   appears once you've actually scrolled, so an un-scrolled table stays flat and
   the shadow reads as "there is more to the left" rather than decoration. */
function GridWrap({ children }: { children: ReactNode }) {
  const [scrolled, setScrolled] = useState(false)
  return (
    <div className={`grid-wrap ${scrolled ? 'scrolled' : ''}`}
      onScroll={e => setScrolled(e.currentTarget.scrollLeft > 0)}>
      {children}
    </div>
  )
}

/* ---------------- Grid ---------------- */

export function Grid({ projectId }: { projectId: string }) {
  const { state } = useStore()
  const agents = state.agents.filter(a => a.projectId === projectId)
  const params = state.rubric
  if (!agents.length) return <EmptyState icon="Agents" title="No agents yet" body="Add an agent to start building its scorecard." actionLabel="Add an agent" to="settings" />
  if (!state.versions.some(v => agents.some(a => a.id === v.agentId))) return <EmptyState icon="Versions" title="No prompt versions yet" body="Create a version to begin testing." actionLabel="Add a version" to="versions" />

  return (
    <GridWrap>
      <table className="grid">
        <thead>
          <tr>
            <th>Agent</th><th>Type</th><th>Version</th><th>Status</th><th>Sessions</th>
            {params.map(p => <th key={p.id} title={p.question}>{p.name}</th>)}
            <th>Composite</th><th>Δ vs prev</th><th>Open issues</th><th>Last tested</th>
          </tr>
        </thead>
        <tbody>
          {agents.flatMap(agent => {
            const versions = state.versions.filter(v => v.agentId === agent.id).sort((a, b) => b.number - a.number)
            return versions.map((v, idx) => {
              const sessions = state.sessions.filter(s => s.versionId === v.id)
              const avgs = avgScores(sessions)
              const comp = composite(avgs)
              const prev = versions[idx + 1]
              const prevComp = prev ? composite(avgScores(state.sessions.filter(s => s.versionId === prev.id))) : null
              const delta = comp != null && prevComp != null ? comp - prevComp : null
              const open = state.issues.filter(i => i.agentId === agent.id && ['open', 'claimed-fixed', 'reopened'].includes(i.status)).length
              const last = sessions.map(s => s.createdAt).sort().pop()
              return (
                <tr key={v.id}>
                  {/* title survives the mobile truncation of the frozen column */}
                  <td title={adapterLabel(agent.name)}>{idx === 0 ? <strong>{adapterLabel(agent.name)}</strong> : <span className="muted">{adapterLabel(agent.name)}</span>}</td>
                  <td><span className={`badge ${agent.type}`}>{agent.type}</span></td>
                  <td>v{v.number}</td>
                  <td><span className={`badge ${v.status}`}>{v.status}</span></td>
                  <td style={{ textAlign: 'center' }}>{sessions.length}</td>
                  {params.map(p => {
                    const val = p.appliesTo.includes(agent.type) ? avgs[p.id] : undefined
                    return (
                      <td key={p.id} className={p.appliesTo.includes(agent.type) ? `heat ${heatClass(val ?? null)}` : 'heat na'}>
                        {val != null ? val.toFixed(1) : p.appliesTo.includes(agent.type) ? '–' : ''}
                      </td>
                    )
                  })}
                  <td className={`heat ${heatClass(comp)}`}>{comp != null ? comp.toFixed(2) : '–'}</td>
                  <td>{delta == null ? '–' : <span className={delta >= 0 ? 'delta-up' : 'delta-down'}>{delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(2)}</span>}</td>
                  <td style={{ textAlign: 'center' }}>{idx === 0 ? open : ''}</td>
                  <td className="muted">{last ? new Date(last).toLocaleDateString() : '–'}</td>
                </tr>
              )
            })
          })}
        </tbody>
      </table>
    </GridWrap>
  )
}

/* ---------------- Versions ---------------- */

export function Versions({ projectId, initialAgentId, initialNew }: { projectId: string; initialAgentId?: string; initialNew?: boolean }) {
  const { state } = useStore()
  const agents = state.agents.filter(a => a.projectId === projectId)
  const [agentId, setAgentId] = useState(initialAgentId ?? agents[0]?.id ?? '')
  const agent = agents.find(a => a.id === agentId)
  const versions = state.versions.filter(v => v.agentId === agentId).sort((a, b) => b.number - a.number)
  const [selId, setSelId] = useState<string | null>(null)
  const sel = versions.find(v => v.id === selId) ?? versions[0]
  const [showNew, setShowNew] = useState(initialNew ?? false)

  if (!agent) return <EmptyState icon="Agents" title="No agents in this project" body="Add an agent before creating its versions." actionLabel="Add an agent" to="settings" />

  return (
    <>
      <div className="card">
        <div className="row">
          <select className="field-input grow" value={agentId} onChange={e => { setAgentId(e.target.value); setSelId(null) }}>
            {agents.map(a => <option key={a.id} value={a.id}>{adapterLabel(a.name)}</option>)}
          </select>
          <select className="field-input grow" value={sel?.id ?? ''} onChange={e => setSelId(e.target.value)}>
            {versions.map(v => <option key={v.id} value={v.id}>v{v.number} — {v.status} — {v.changelog.slice(0, 50)}</option>)}
          </select>
          <button className="btn" onClick={() => setShowNew(!showNew)}>{showNew ? 'Cancel' : '+ New version'}</button>
        </div>
      </div>
      {showNew && <NewVersionForm agent={agent} baseVersion={versions[0]} onDone={() => setShowNew(false)} />}
      {sel && <VersionDetail agent={agent} version={sel} versions={versions} />}
    </>
  )
}

function NewVersionForm({ agent, baseVersion, onDone }: { agent: Agent; baseVersion?: PromptVersion; onDone: () => void }) {
  const { state, mutate } = useStore()
  const [promptText, setPromptText] = useState(baseVersion?.promptText ?? '')
  const [changelog, setChangelog] = useState('')
  const claimable = state.issues.filter(i => i.agentId === agent.id && ['open', 'reopened'].includes(i.status))
  const [claimed, setClaimed] = useState<string[]>([])

  const save = () => {
    const vId = uid()
    mutate(d => {
      for (const v of d.versions) if (v.agentId === agent.id && v.status === 'testing') v.status = 'retired'
      d.versions.push({
        id: vId, agentId: agent.id, number: (baseVersion?.number ?? 0) + 1,
        promptText, changelog, status: 'testing', createdAt: now(), decisions: [],
      })
      for (const iid of claimed) {
        const it = d.issues.find(i => i.id === iid)
        if (it) { it.status = 'claimed-fixed'; it.claimedFixedInVersionId = vId }
      }
    })
    onDone()
  }

  return (
    <div className="card">
      <h2>New version for {adapterLabel(agent.name)} (v{(baseVersion?.number ?? 0) + 1})</h2>
      <label className="field">Prompt text</label>
      <textarea className="mono" value={promptText} onChange={e => setPromptText(e.target.value)} />
      <label className="field">Changelog — what changed and why (required)</label>
      <textarea value={changelog} onChange={e => setChangelog(e.target.value)} placeholder="e.g. Added GLOBAL INTERRUPTS block to stop script-marching; fixed RERA loop on EMI questions" />
      {claimable.length > 0 && (
        <>
          <h3>Which open issues does this version claim to fix?</h3>
          {claimable.map(i => (
            <label key={i.id} style={{ display: 'block', margin: '4px 0' }}>
              <input type="checkbox" checked={claimed.includes(i.id)} onChange={e => setClaimed(e.target.checked ? [...claimed, i.id] : claimed.filter(x => x !== i.id))} />{' '}
              <span className={`badge ${i.severity}`}>{i.severity}</span> {i.title}
            </label>
          ))}
          <p className="muted">Checked issues become "claimed fixed" and testers will be asked to verify them on this version.</p>
        </>
      )}
      <div style={{ marginTop: 10 }}>
        <button className="btn" onClick={save} disabled={!changelog.trim() || !promptText.trim()}>Create v{(baseVersion?.number ?? 0) + 1} (testing)</button>
      </div>
    </div>
  )
}

function VersionDetail({ agent, version, versions }: { agent: Agent; version: PromptVersion; versions: PromptVersion[] }) {
  const { state, mutate } = useStore()
  const prev = versions.find(v => v.number === version.number - 1) ?? versions[versions.indexOf(version) + 1]
  const sessions = state.sessions.filter(s => s.versionId === version.id)
  const avgs = avgScores(sessions)
  const prevAvgs = prev ? avgScores(state.sessions.filter(s => s.versionId === prev.id)) : {}
  const params = state.rubric.filter(p => p.appliesTo.includes(agent.type))
  const [showDiff, setShowDiff] = useState(false)
  const [decision, setDecision] = useState('')

  const diff = useMemo(() => (showDiff && prev ? diffLines(prev.promptText, version.promptText) : []), [showDiff, prev, version])

  return (
    <>
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>v{version.number}</h2>
          <span className={`badge ${version.status}`}>{version.status}</span>
          <span className="muted">{new Date(version.createdAt).toLocaleString()}</span>
          <div className="spacer" style={{ flex: 1 }} />
          {(['draft', 'testing', 'live', 'retired'] as const).map(s => (
            <button key={s} className={`btn small ${version.status === s ? '' : 'secondary'}`}
              onClick={() => mutate(d => { const v = d.versions.find(x => x.id === version.id); if (v) v.status = s })}>{s}</button>
          ))}
        </div>
        <p><strong>Changelog:</strong> {version.changelog || <span className="muted">none</span>}</p>
        {prev && <button className="btn secondary small" onClick={() => setShowDiff(!showDiff)}>{showDiff ? 'Hide' : 'Show'} diff vs v{prev.number}</button>}
        {showDiff && (
          <div className="diff" style={{ marginTop: 10 }}>
            {diff.map((part, i) => (
              <span key={i} className={part.added ? 'add' : part.removed ? 'del' : ''}>{part.value}</span>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Score deltas vs v{prev?.number ?? '—'}</h2>
        <div className="grid-wrap">
          <table className="grid">
            <thead><tr><th>Parameter</th><th>v{version.number}</th>{prev && <th>v{prev.number}</th>}<th>Δ</th></tr></thead>
            <tbody>
              {params.map(p => {
                const cur = avgs[p.id]; const pv = prevAvgs[p.id]
                const delta = cur != null && pv != null ? cur - pv : null
                return (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td className={`heat ${heatClass(cur ?? null)}`}>{cur?.toFixed(2) ?? '–'}</td>
                    {prev && <td className={`heat ${heatClass(pv ?? null)}`}>{pv?.toFixed(2) ?? '–'}</td>}
                    <td>{delta == null ? '–' : <span className={delta >= 0 ? 'delta-up' : 'delta-down'}>{delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(2)}</span>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="muted">A red Δ on one parameter after a fix elsewhere = regression. That's what this table is for.</p>
      </div>

      <div className="card">
        <h2>Decision log</h2>
        {version.decisions.map(dd => (
          <div key={dd.id} className="verify-item"><div className="grow"><strong>{dd.author}</strong> <span className="muted">{new Date(dd.createdAt).toLocaleString()}</span><div>{dd.text}</div></div></div>
        ))}
        <div className="row">
          <input type="text" className="grow" value={decision} onChange={e => setDecision(e.target.value)} placeholder="e.g. Executive decision: restructured entire prompt to v13 build-system architecture" />
          <button className="btn secondary" disabled={!decision.trim()} onClick={() => { mutate(d => { const v = d.versions.find(x => x.id === version.id); if (v) v.decisions.push({ id: uid(), text: decision, createdAt: now(), author: 'builder' }) }); setDecision('') }}>Add</button>
        </div>
      </div>

      <div className="card">
        <h2>Test sessions on this version ({sessions.length})</h2>
        {sessions.length === 0 && <EmptyState icon="Calls" title="No feedback yet" body="Log a call against this version to record feedback." actionLabel="Log a call" to="score" />}
        {sessions.map(s => <SessionCard key={s.id} session={s} version={version} />)}
      </div>
    </>
  )
}

function SessionCard({ session, version }: { session: TestSession; version: PromptVersion }) {
  const { state } = useStore()
  const [open, setOpen] = useState(false)
  const [analysis, setAnalysis] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const comp = composite(avgScores([session]))

  const runAI = async () => {
    setBusy(true); setErr('')
    try {
      setAnalysis(await analyzeSession(version, session, session.observations))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  return (
    <div className="verify-item" style={{ display: 'block' }}>
      <div className="row">
        <strong>{session.tester}</strong>
        <span className="muted">{session.useCase} · {new Date(session.createdAt).toLocaleString()}</span>
        <span className="badge testing">score {comp?.toFixed(2) ?? '–'}</span>
        {session.recordingName && <span className="muted">🎧 {session.recordingName}</span>}
        <div style={{ flex: 1 }} />
        <button className="btn small secondary" onClick={() => setOpen(!open)}>{open ? 'Collapse' : 'Details'}</button>
        <button className="btn small" onClick={runAI} disabled={DEMO_MODE || busy}>{busy ? 'Analyzing…' : '🤖 AI: what to fix in the prompt'}</button>
        {DEMO_MODE && <span className="muted">{DEMO_SERVER_REASON}</span>}
      </div>
      {err && <p style={{ color: 'var(--bad)' }}>{err}</p>}
      {open && (
        <div style={{ marginTop: 8 }}>
          <div className="row" style={{ gap: 6 }}>
            {session.scores.map(sc => <span key={sc.paramId} className="badge draft">{sc.paramName}: {sc.value}</span>)}
          </div>
          {session.observations.map(o => (
            <div key={o.id} style={{ marginTop: 6 }}>
              <span className={`badge ${o.severity}`}>{o.severity}</span> {o.whatHappened} <span className="muted">→ expected: {o.expected}</span>
              {o.quote && <div className="muted">"{o.quote}"</div>}
            </div>
          ))}
          {session.comments && <p className="muted">Comments: {session.comments}</p>}
          {session.transcript && (
            <>
              <h3>Transcript</h3>
              <div className="md" style={{ maxHeight: 240, overflow: 'auto' }}>{session.transcript}</div>
            </>
          )}
        </div>
      )}
      {analysis && (
        <>
          <h3>🤖 AI analysis</h3>
          <div className="md">{analysis}</div>
        </>
      )}
    </div>
  )
}

/* ---------------- Triage ---------------- */

export function Triage({ projectId }: { projectId: string }) {
  const { state, mutate } = useStore()
  const [skipped, setSkipped] = useState<string[]>([])
  const items = state.sessions
    .filter(s => state.agents.find(a => a.id === s.agentId)?.projectId === projectId)
    .flatMap(s => s.observations.filter(o => isProblem(o) && o.triage === 'untriaged').map(o => ({ o, s })))

  const setTriage = (obsId: string, sessionId: string, triage: 'accepted' | 'rejected' | 'needs-clarification', note: string) =>
    mutate(d => {
      const sess = d.sessions.find(x => x.id === sessionId)
      const ob = sess?.observations.find(x => x.id === obsId)
      if (!sess || !ob || ob.triage !== 'untriaged' || ob.issueId || (triage === 'rejected' && !note.trim())) return
      ob.triage = triage
      ob.triageNote = note
      if (triage === 'accepted') {
        const agent = d.agents.find(a => a.id === sess.agentId)
        // Carry the blame through. The layer the tester named (or the analyser
        // detected) becomes the issue's owning team on creation, so the board
        // opens with a routed ticket instead of an anonymous defect that
        // somebody has to triage a second time. `ownerPerson` stays empty by
        // design — naming a person is a human's decision, and defaulting it
        // would manufacture accountability this tool cannot enforce.
        const layer = ob.layer ?? 'unknown'
        const ownerTeam = LAYER_TEAM[layer]
        const issue: Issue = {
          id: uid(), projectId: agent?.projectId ?? '', agentId: sess.agentId,
          title: ob.whatHappened.slice(0, 90), description: `Expected: ${ob.expected}${ob.quote ? `: "${ob.quote}"` : ''}`,
          severity: ob.severity, status: 'open', bornInVersionId: sess.versionId,
          claimedFixedInVersionId: null, verifiedFixedInVersionId: null, resolutionNote: '',
          verifications: [], createdAt: now(),
          layer, ownerTeam, ownerPerson: '',
          attribution: layer === 'unknown'
            ? 'No layer blamed yet. Assign one so this reaches the team that can fix it.'
            : `${LAYER_FIRST_CHECK[layer]}`,
        }
        d.issues.push(issue)
        ob.issueId = issue.id
      }
    })

  const pending = items.filter(({ o }) => !skipped.includes(o.id))
  if (!pending.length) return <div className="card"><EmptyState icon="Done" title={items.length ? 'Only skipped findings remain' : 'Every finding reviewed'}
    body={items.length ? `${items.length} skipped findings are still waiting for a decision.` : 'Review accepted issues, then test the next version to check its fixes.'}
    actionLabel={items.length ? 'Review skipped findings' : 'Review issues'} to="issues" onAction={items.length ? () => setSkipped([]) : undefined} /></div>
  const { o, s: session } = pending[0]
  const agent = state.agents.find(a => a.id === session.agentId)
  const version = state.versions.find(v => v.id === session.versionId)
  return <section className="triage-flow">
    <div className="row"><h2>{pending.length} left</h2><span className="muted">{skipped.filter(id => items.some(item => item.o.id === id)).length} skipped</span></div>
    {o.triageNote && <p className="notice">Review and reply: {o.triageNote}</p>}
    <TriageCard key={o.id} agentName={agent?.name ?? 'Unknown agent'} vnum={version?.number ?? 0} tester={session.tester} useCase={session.useCase}
      severity={o.severity} what={o.whatHappened} expected={o.expected} quote={o.quote} audioId={session.audioId} atSec={o.atSec} reviewNote={o.triageNote}
      onSkip={() => setSkipped(ids => [...ids, o.id])} onDecide={(t, note) => setTriage(o.id, session.id, t, note)} />
  </section>
}

function TriageCard(props: {
  agentName: string; vnum: number; tester: string; useCase: string
  severity: string; what: string; expected: string; quote: string
  audioId?: string; atSec?: number; reviewNote?: string
  onSkip: () => void
  onDecide: (t: 'accepted' | 'rejected' | 'needs-clarification', note: string) => void
}) {
  const [note, setNote] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const noteRef = useRef<HTMLInputElement>(null)
  const reject = () => {
    if (!note.trim()) { setRejecting(true); noteRef.current?.focus(); return }
    props.onDecide('rejected', note.trim())
  }
  useHotkeys({ a: () => props.onDecide('accepted', note), r: reject, c: () => props.onDecide('needs-clarification', note), s: props.onSkip,
    'mod+enter': () => { if (rejecting) reject() }, escape: () => { setRejecting(false); noteRef.current?.blur() } })
  return (
    <div className="card triage-finding">
      <div className="row">
        <span className={`badge ${props.severity}`}>{props.severity}</span>
        <h2>{props.what}</h2>
      </div>
      {(props.expected || props.quote) && (
        <p className="muted">{props.expected && <>Expected: {props.expected}</>}{props.expected && props.quote && ' · '}{props.quote && <>“{props.quote}”</>}</p>
      )}
      {props.audioId && <TriageClip audioId={props.audioId} atSec={props.atSec} />}
      <p className="muted">{props.agentName} v{props.vnum} · {props.tester} · {props.useCase}</p>
      <div className="row">
        <input ref={noteRef} type="text" className="grow" aria-label="Triage note" value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && rejecting && note.trim()) { e.preventDefault(); reject() } }} placeholder={rejecting ? 'Why are you rejecting this? Enter to confirm' : 'Triage note (required to reject)'} />
        <button className="btn small" onClick={() => props.onDecide('accepted', note)}>Accept → Issue</button>
        <button className="btn small danger" disabled={!note.trim()} onClick={reject}>Reject <Kbd>R</Kbd></button>
        <button className="btn small secondary" onClick={() => props.onDecide('needs-clarification', note)}>Ask tester <Kbd>C</Kbd></button>
        <button className="btn small secondary" onClick={props.onSkip}>Skip <Kbd>S</Kbd></button>
      </div>
      <p className="muted">A accept to issue / R reject with a note / C ask tester / S skip / Space play clip</p>
    </div>
  )
}

/** Play the moment a problem was pinned to, so triage is a listen, not a guess. */
function TriageClip({ audioId, atSec }: { audioId: string; atSec?: number }) {
  const start = Math.max(0, (atSec ?? 0) - 3)
  const clock = useAudioClock(audioUrl(audioId), start)
  useHotkeys({ space: clock.toggle })
  return <div>
    <Player src={audioUrl(audioId)} clock={clock} markers={atSec == null ? [] : [{ atSec, kind: 'went-wrong', label: 'Pinned finding' }]} />
    <p className="muted">Starts at {formatTime(start)}. {atSec == null ? 'No time pinned, plays from the start.' : 'Three seconds before the pinned moment.'}</p>
  </div>
}

/* ---------------- Issue board ---------------- */

const COLS: { status: IssueStatus; label: string }[] = [
  { status: 'open', label: 'Open' },
  { status: 'claimed-fixed', label: 'Claimed fixed' },
  { status: 'verified-fixed', label: 'Verified fixed' },
  { status: 'reopened', label: 'Reopened' },
  { status: 'wont-fix', label: "Won't fix" },
]

export function IssueBoard({ projectId, initialIssueId }: { projectId: string; initialIssueId?: string }) {
  const { state, mutate } = useStore()
  const [selected, setSelected] = useState(initialIssueId ?? '')
  const [ownerLayer, setOwnerLayer] = useState('')
  const [drawerId, setDrawerId] = useState(initialIssueId ?? '')
  const allIssues = state.issues.filter(i => i.projectId === projectId)
  const issues = allIssues.filter(i => !ownerLayer || (i.layer ?? 'unknown') === ownerLayer)
  const drawer = state.issues.find(i => i.id === drawerId)
  const closeDrawer = () => { setDrawerId(''); document.getElementById(`issue-${selected}`)?.focus() }
  const selectCard = (id: string) => { setSelected(id); document.getElementById(`issue-${id}`)?.focus(); document.getElementById(`issue-${id}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }
  const vertical = (delta: number) => {
    const card = issues.find(i => i.id === selected) ?? issues[0]
    if (!card) return
    if (!selected) { selectCard(card.id); return }
    const column = issues.filter(i => i.status === card.status)
    selectCard(column[Math.max(0, Math.min(column.length - 1, column.findIndex(i => i.id === card.id) + delta))].id)
  }
  useHotkeys({ h: () => selectCard(adjacentIssue(issues, selected, -1, COLS.map(c => c.status))),
    l: () => selectCard(adjacentIssue(issues, selected, 1, COLS.map(c => c.status))), j: () => vertical(1), k: () => vertical(-1),
    enter: () => setDrawerId(selected || issues[0]?.id || ''), escape: closeDrawer })
  useEffect(() => { if (selected && !issues.some(i => i.id === selected)) { setSelected(''); setDrawerId('') } }, [ownerLayer])
  const vnum = (id: string | null) => {
    const v = state.versions.find(x => x.id === id)
    return v ? `v${v.number}` : null
  }
  return (
    <>
      <div className="row"><label>Owner layer <select value={ownerLayer} onChange={e => setOwnerLayer(e.target.value)} aria-label="Owner layer"><option value="">All layers</option>{Object.entries(LAYER_TEAM).map(([layer, team]) => <option key={layer} value={layer}>{team}</option>)}</select></label><span className="muted">{issues.length} issues / H/L columns / J/K cards / Enter details / Esc close</span></div>
      {!issues.length && <EmptyState icon="Issues" title={allIssues.length ? 'No issues in this layer' : 'No issues yet'} body={allIssues.length ? 'Choose another owner layer to see its issues.' : 'Accept a finding in triage to create an issue.'} actionLabel={allIssues.length ? 'Show all layers' : 'Review findings'} to="triage" onAction={allIssues.length ? () => setOwnerLayer('') : undefined} />}
      <div className={`issue-board-layout ${drawer ? 'with-drawer' : ''}`}>
    <div className="kanban">
      {COLS.map(col => (
        <div key={col.status} className="col">
          <h4>{col.label} ({issues.filter(i => i.status === col.status).length})</h4>
          {issues.filter(i => i.status === col.status).map(i => {
            const agent = state.agents.find(a => a.id === i.agentId)
            return (
              <div key={i.id} id={`issue-${i.id}`} className={`issue-card ${selected === i.id ? 'sel' : ''}`} tabIndex={0} onFocus={() => setSelected(i.id)} onClick={() => { setSelected(i.id); setDrawerId(i.id) }}>
                              <span className={`badge ${i.severity}`}>{i.severity}</span> <strong>{i.title}</strong>
                              <div className="muted">{i.description}</div>
                              {/* Ownership, on the card. The differentiator is blame
                                  attribution, and a field that lives only in the database is
                                  not a product feature — it is a schema. This is the line
                                  that turns "something broke" into "the VAD threshold is
                                  too tight and here is where to look". */}
                              <div className="issue-owner">
                                <span className={`layer-tag ${i.layer}`}>{i.layer}</span>
                                <span className="owner-team">{i.ownerTeam}</span>
                                {i.ownerPerson
                                  ? <span className="owner-person">{i.ownerPerson}</span>
                                  : <span className="owner-unassigned" title="Nobody is on point for this yet">unassigned</span>}
                              </div>
                              <div className="muted attribution">{i.attribution}</div>
                              <div className="muted">
                                {adapterLabel(agent?.name)} · born {vnum(i.bornInVersionId)}
                                {i.claimedFixedInVersionId && <> · claimed {vnum(i.claimedFixedInVersionId)}</>}
                                {i.verifiedFixedInVersionId && <> · verified {vnum(i.verifiedFixedInVersionId)}</>}
                              </div>
                {i.verifications.length > 0 && (
                  <div className="muted">{i.verifications.map((vv, k) => <span key={k}>{vv.tester}: {vv.verdict} </span>)}</div>
                )}
                <div className="row" style={{ marginTop: 6 }}>
                  {i.status !== 'wont-fix' && <button className="btn small secondary" onClick={e => { e.stopPropagation(); mutate(d => { const it = d.issues.find(x => x.id === i.id); if (it) it.status = 'wont-fix' }) }}>won't fix</button>}
                  {(i.status === 'wont-fix' || i.status === 'verified-fixed') && <button className="btn small secondary" onClick={e => { e.stopPropagation(); mutate(d => { const it = d.issues.find(x => x.id === i.id); if (it) it.status = 'reopened' }) }}>reopen</button>}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
      {drawer && <IssueDrawer key={drawer.id} issue={drawer} versions={state.versions} onUpdate={update => mutate(d => { const issue = d.issues.find(i => i.id === drawer.id); if (issue) update(issue) })} onClose={closeDrawer} />}
      </div>
    </>
  )
}

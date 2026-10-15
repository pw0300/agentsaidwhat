import { adapterLabel } from './adapters'
import { ClarificationReply } from './ClarificationReply'
import { useEffect, useRef, useState } from 'react'
import type { TestSession } from './types'
import { useStore, composite, avgScores, heatClass } from './store.tsx'
import { EmptyState, useNav } from './nav'
import { audioUrl, uploadAudio, AUDIO_ACCEPT } from './audio'
import { Player, TranscriptView, useAudioClock, type Marker } from './Player'
import { formatTime } from './transcript'
import { useHotkeys, Kbd } from './hotkeys'
import { isProblem } from './notes'
import { DEFAULT_FILTERS, readCallFilters, writeCallFilters, filterCalls, type CallFilters } from './callFilters'

/**
 * Every logged call, filterable, with the recording and transcript one click away.
 *
 * Built for the person who reviews a lot of calls: the list is dense, filters
 * stack, j/k moves through it, and the detail pane replays the call with every
 * note pinned on the waveform.
 */
export function Calls({ projectId, initialCallId }: { projectId: string; initialCallId?: string }) {
  const { state, mutate } = useStore()
  const go = useNav()
  const agents = state.agents.filter(a => a.projectId === projectId)
  const agentIds = new Set(agents.map(a => a.id))

  const [filters, setFilters] = useState(() => initialCallId ? { ...DEFAULT_FILTERS } : readCallFilters(window.location.hash))
  const { agent: agentF, version: versionF, tester: testerF, scenario: scenarioF, q } = filters
  const patch = (changes: Partial<CallFilters>) => setFilters(f => ({ ...f, ...changes }))
  const search = useRef<HTMLInputElement>(null)
  const [selected, setSelected] = useState<string | null>(initialCallId ?? null)
  const [opened, setOpened] = useState<string | null>(initialCallId ?? null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [bulkMessage, setBulkMessage] = useState('')
  const rows = filterCalls(state.sessions, filters, Object.fromEntries(agents.map(a => [a.id, a.name])))
  useEffect(() => {
    const hash = writeCallFilters(filters, window.location.hash)
    if (hash !== window.location.hash) history.replaceState(null, '', hash)
  }, [filters])
  useEffect(() => {
    const restore = () => setFilters(readCallFilters(window.location.hash))
    window.addEventListener('hashchange', restore)
    return () => window.removeEventListener('hashchange', restore)
  }, [])
  useEffect(() => {
    if (selected && !rows.some(s => s.id === selected)) setSelected(null)
    if (opened && !rows.some(s => s.id === opened)) setOpened(null)
  }, [filters, state.sessions, projectId])
  const toggle = (id: string) => setChecked(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const bulk = () => {
    const ids = new Set(rows.filter(s => checked.has(s.id)).map(s => s.id))
    let count = 0
    mutate(d => { for (const s of d.sessions) if (ids.has(s.id)) for (const o of s.observations) {
      if (isProblem(o) && !o.issueId && o.triage !== 'untriaged') { o.triage = 'untriaged'; o.triageNote = ''; count++ }
    } })
    setBulkMessage(`${count} findings returned to triage. Pending findings are already in the queue.`)
    setChecked(new Set())
    go('triage')
  }
  const sort = (column: string) => patch({ sort: column, direction: filters.sort === column && filters.direction === 'asc' ? 'desc' : 'asc' })
  const testers = [...new Set(state.sessions.filter(s => agentIds.has(s.agentId)).map(s => s.tester))].sort()
  const scenarioNames = [...new Set(state.sessions.filter(s => agentIds.has(s.agentId) && (!agentF || s.agentId === agentF)).map(s => s.useCase))].sort()
  const versions = state.versions.filter(v => agentIds.has(v.agentId) && (!agentF || v.agentId === agentF)).sort((a, b) => b.number - a.number)

  const idx = rows.findIndex(r => r.id === selected)
  const current = rows.find(s => s.id === opened) ?? null

  const move = (index: number) => {
    const row = rows[index]
    if (!row) return
    setSelected(row.id)
    const element = document.getElementById(`call-${row.id}`)
    element?.focus(); element?.scrollIntoView({ block: 'nearest' })
  }
  useHotkeys({
    j: () => move(Math.min(rows.length - 1, idx + 1)),
    k: () => move(Math.max(0, idx - 1)),
    enter: () => rows[idx >= 0 ? idx : 0] && setOpened(rows[idx >= 0 ? idx : 0].id),
    '/': () => search.current?.focus(),
    x: () => rows[idx >= 0 ? idx : 0] && toggle(rows[idx >= 0 ? idx : 0].id),
    escape: () => { setOpened(null); search.current?.blur() },
  })

  if (state.sessions.filter(s => agentIds.has(s.agentId)).length === 0) {
    return (
      <div className="card">
        <EmptyState icon="🎧" title="No calls logged yet" body="Log a call with its recording and transcript, and it shows up here for review."
          actionLabel="Log a call" to="score" />
      </div>
    )
  }

  const filtered = Object.entries(filters).some(([key, value]) => !['sort', 'direction'].includes(key) && !!value)

  return (
    <div className={`calls ${current ? 'with-detail' : ''}`}>
      <div className="card calls-list">
        <div className="filters">
          <input ref={search} type="text" value={q} onChange={e => patch({ q: e.target.value })} placeholder="Search transcripts and notes" aria-label="Search" />
          <select className="field-input" value={agentF} onChange={e => { patch({ agent: e.target.value, version: '', scenario: '' }) }} aria-label="Agent">
            <option value="">All agents</option>
            {agents.map(a => <option key={a.id} value={a.id}>{adapterLabel(a.name)}</option>)}
          </select>
          <select className="field-input" value={versionF} onChange={e => patch({ version: e.target.value })} aria-label="Version">
            <option value="">All versions</option>
            {versions.map(v => <option key={v.id} value={v.id}>{adapterLabel(agents.find(a => a.id === v.agentId)?.name)} v{v.number}</option>)}
          </select>
          <select className="field-input" value={scenarioF} onChange={e => patch({ scenario: e.target.value })} aria-label="Scenario">
            <option value="">All scenarios</option>
            {scenarioNames.map(n => <option key={n}>{n}</option>)}
          </select>
          <select className="field-input" value={testerF} onChange={e => patch({ tester: e.target.value })} aria-label="Tester">
            <option value="">All testers</option>
            {testers.map(t => <option key={t}>{t}</option>)}
          </select>
          <label className="chip"><input type="checkbox" checked={!!filters.problems} onChange={e => patch({ problems: e.target.checked ? '1' : '' })} /> Has problems</label>
          <label className="chip"><input type="checkbox" checked={!!filters.recording} onChange={e => patch({ recording: e.target.checked ? '1' : '' })} /> Has recording</label>
          <label>From (UTC) <input type="date" aria-label="From date" value={filters.from} onChange={e => patch({ from: e.target.value })} /></label>
          <label>To (UTC) <input type="date" aria-label="To date" value={filters.to} onChange={e => patch({ to: e.target.value })} /></label>
          {filtered && <button className="link" onClick={() => setFilters({ ...DEFAULT_FILTERS })}>Clear filters</button>}
        </div>
        <div className="row filter-chips">{Object.entries(filters).filter(([key, value]) => value && !['sort', 'direction'].includes(key)).map(([key, value]) => <button key={key} className="btn small secondary" onClick={() => patch({ [key]: '' })} aria-label={`Remove ${key} filter`}>{key}: {key === 'agent' ? agents.find(a => a.id === value)?.name : key === 'version' ? `v${state.versions.find(v => v.id === value)?.number}` : ['problems', 'recording'].includes(key) ? 'yes' : value} x</button>)}</div>
        <div className="row"><button className="btn small secondary" disabled={!rows.some(s => checked.has(s.id))} onClick={bulk}>Send problems to triage ({rows.filter(s => checked.has(s.id)).length} selected)</button><span role="status">{bulkMessage}</span></div>
        <div className="muted calls-count">{rows.length} of {state.sessions.filter(s => agentIds.has(s.agentId)).length} call{rows.length === 1 ? '' : 's'} · <Kbd>J</Kbd>/<Kbd>K</Kbd> to move</div>

        <table className="calls-table">
          <thead>
            <tr><th><input type="checkbox" aria-label="Select all shown calls" checked={rows.length > 0 && rows.every(s => checked.has(s.id))} onChange={e => setChecked(e.target.checked ? new Set(rows.map(s => s.id)) : new Set())} /></th>{[['date', 'When'], ['agent', 'Agent'], ['scenario', 'Scenario'], ['tester', 'Tester'], ['score', 'Score'], ['notes', 'Notes'], ['recording', 'Recording']].map(([key, label]) => <th key={key} aria-sort={filters.sort === key ? filters.direction === 'asc' ? 'ascending' : 'descending' : 'none'}><button className="link" onClick={() => sort(key)}>{label} {filters.sort === key ? filters.direction === 'asc' ? 'asc' : 'desc' : ''}</button></th>)}</tr>
          </thead>
          <tbody>
            {rows.map(s => {
              const a = agents.find(x => x.id === s.agentId)
              const v = state.versions.find(x => x.id === s.versionId)
              const comp = composite(avgScores([s]))
              const probs = s.observations.filter(isProblem)
              const wins = s.observations.length - probs.length
              const blockers = probs.filter(o => o.severity === 'blocker').length
              return (
                <tr key={s.id} id={`call-${s.id}`} aria-selected={s.id === selected} className={s.id === selected ? 'sel' : ''} tabIndex={0} onFocus={() => setSelected(s.id)} onClick={() => { setSelected(s.id); setOpened(s.id) }}>
                  <td><input type="checkbox" aria-label={`Select ${s.useCase} by ${s.tester}`} checked={checked.has(s.id)} onClick={e => e.stopPropagation()} onChange={() => toggle(s.id)} /></td>
                  <td className="muted nowrap">{new Date(s.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                  <td className="nowrap">{adapterLabel(a?.name)} <span className="muted">v{v?.number}</span></td>
                  <td>{s.useCase}</td>
                  <td className="nowrap">{s.tester}</td>
                  <td><span className={`heat-pill ${heatClass(comp)}`}>{comp != null ? comp.toFixed(1) : '–'}</span></td>
                  <td className="nowrap">
                    {probs.length > 0 && <span className={`count ${blockers ? 'bad' : 'warn'}`}>✗ {probs.length}</span>}
                    {wins > 0 && <span className="count good">✓ {wins}</span>}
                  </td>
                  <td className="nowrap muted">{s.audioId ? '🎧' : ''}{s.durationSec ? ` ${formatTime(s.durationSec)}` : ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!rows.length && <EmptyState icon="Search" title="No matching calls" body="Clear filters to see your calls." actionLabel="Clear filters" onAction={() => setFilters({ ...DEFAULT_FILTERS })} />}
      </div>

      {current && (
        <CallDetail key={current.id} session={current} onClose={() => setOpened(null)}
          onDelete={() => {
            if (!confirm('Delete this call and its notes? Issues already created from it stay.')) return
            mutate(d => { d.sessions = d.sessions.filter(s => s.id !== current.id) })
            setSelected(null); setOpened(null)
          }}
          onTriage={() => go('triage')} />
      )}
    </div>
  )
}

function CallDetail({ session: s, onClose, onDelete, onTriage }: {
  session: TestSession; onClose: () => void; onDelete: () => void; onTriage: () => void
}) {
  const { state, mutate } = useStore()
  const src = s.audioId ? audioUrl(s.audioId) : null
  const clock = useAudioClock(src)
  const agent = state.agents.find(a => a.id === s.agentId)
  const version = state.versions.find(v => v.id === s.versionId)
  const markers: Marker[] = s.observations.filter(o => o.atSec != null)
    .map(o => ({ atSec: o.atSec as number, kind: isProblem(o) ? 'went-wrong' : 'went-well', label: o.whatHappened }))

  useHotkeys({ space: () => clock.toggle(), arrowleft: () => clock.nudge(-5), arrowright: () => clock.nudge(5) }, !!src)

  const notes = [...s.observations].sort((a, b) => (a.atSec ?? 1e9) - (b.atSec ?? 1e9))
  const untriaged = s.observations.filter(o => isProblem(o) && o.triage === 'untriaged').length

  return (
    <aside className="card call-detail">
      <div className="row">
        <div>
          <h2 style={{ margin: 0 }}>{s.useCase}</h2>
          <div className="muted">{adapterLabel(agent?.name)} v{version?.number} · {s.tester} · {new Date(s.createdAt).toLocaleString()}</div>
        </div>
        <div className="spacer" />
        <button className="btn small secondary" onClick={onClose} title="Esc">Close</button>
      </div>

      {src
        ? <Player src={src} clock={clock} markers={markers} />
        : s.recordingName ? <p className="muted">Recording: {s.recordingName} (filename only, audio not stored)</p> : null}

      <label className="field">Attach recording to this call
        <input type="file" accept={AUDIO_ACCEPT} onChange={async e => {
          const file = e.target.files?.[0]
          if (!file) return
          const result = await uploadAudio(file)
          if (!result.ok) { alert(result.reason); return }
          mutate(d => { const session = d.sessions.find(x => x.id === s.id); if (session) { session.audioId = result.audio.id; session.recordingName = result.audio.name } })
        }} />
      </label>

      <div className="detail-scores">
        {s.scores.map(sc => (
          <span key={sc.paramId} className={`heat-pill ${heatClass(sc.value)}`} title={sc.paramName}>{sc.paramName} {sc.value}</span>
        ))}
        {(s.naParams ?? []).map(id => {
          const p = state.rubric.find(r => r.id === id)
          return <span key={id} className="heat-pill h0">{p?.name ?? id} n/a</span>
        })}
      </div>

      <h3>Notes</h3>
      {notes.length === 0 && <EmptyState icon="Notes" title="No notes on this call" body="Include notes when logging the next call." actionLabel="Log a call" to="score" />}
      {notes.map(o => (
        <div key={o.id} className={`note ${isProblem(o) ? 'went-wrong' : 'went-well'}`}>
          <span className="note-kind">{isProblem(o) ? '✗' : '✓'}</span>
          {o.atSec != null && <button className="note-time" onClick={() => clock.seek(o.atSec as number)} disabled={!src}>{formatTime(o.atSec)}</button>}
          <div className="grow">
            <div>{o.whatHappened}</div>
            {o.triageNote && <div className="muted">Review note: {o.triageNote}</div>}
            {/* Reply and return to triage keeps the review note. */}
            {o.triage === 'needs-clarification' && <ClarificationReply sessionId={s.id} observationId={o.id} />}
            {o.expected && <div className="muted">Expected: {o.expected}</div>}
            {o.quote && <div className="muted">“{o.quote}”</div>}
          </div>
          {isProblem(o) && <span className={`badge ${o.severity}`}>{o.severity}</span>}
          {isProblem(o) && <span className="badge draft">{o.issueId ? 'issue' : o.triage}</span>}
        </div>
      ))}
      {untriaged > 0 && <button className="btn small secondary" onClick={onTriage}>Triage {untriaged} problem{untriaged === 1 ? '' : 's'} →</button>}
      {s.comments && <><h3>Overall</h3><p>{s.comments}</p></>}

      {s.transcript && <><h3>Transcript</h3><TranscriptView text={s.transcript} clock={src ? clock : null} maxHeight={360} /></>}

      <div className="row" style={{ marginTop: 14 }}>
        <div className="spacer" />
        <button className="link danger" onClick={onDelete}>Delete call</button>
      </div>
    </aside>
  )
}

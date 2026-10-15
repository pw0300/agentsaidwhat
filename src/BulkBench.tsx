import { adapterLabel } from './adapters'
import { DEMO_MODE, DEMO_SERVER_REASON } from './mode'
import { useRef, useState } from 'react'
import type { BulkBatch, CallAnalysis, Issue } from './types'
import { LAYER_TEAM, LAYER_FIRST_CHECK } from './types'
import { uid, now } from './data'
import { useStore, currentVersion, agentLabel } from './store.tsx'
import { analyzeCall, aggregateBatch } from './ai'
import { EmptyState } from './nav'

// Audio blobs live in memory for the session only — localStorage can't hold
// them. Transcripts (the analysis substrate) are persisted; recordings are
// re-attachable by dropping the files again.
const audioUrls = new Map<string, string>()

const TEXT_EXT = /\.(txt|md|log|json)$/i
const AUDIO_EXT = /\.(mp3|wav|m4a|ogg|webm|aac|flac)$/i
const base = (name: string) => name.replace(/\.[^.]+$/, '').toLowerCase()

// Best-effort transcript extraction from a JSON call export (Ultravox-style
// message arrays or common {role,text} shapes). Falls back to raw text.
function transcriptFromJson(raw: string): string {
  try {
    const j = JSON.parse(raw)
    const arr = Array.isArray(j) ? j : (j.results ?? j.messages ?? j.transcript ?? j.turns)
    if (typeof arr === 'string') return arr
    if (Array.isArray(arr)) {
      const lines = arr.map((m: Record<string, unknown>) => {
        const role = m.role ?? m.speaker ?? m.sender ?? '?'
        const text = m.text ?? m.content ?? m.message ?? ''
        return typeof text === 'string' && text.trim() ? `${String(role)}: ${text.trim()}` : null
      }).filter(Boolean)
      if (lines.length) return lines.join('\n')
    }
  } catch { /* not JSON we understand */ }
  return raw
}

export function BulkBench({ projectId }: { projectId: string }) {
  const { state, mutate } = useStore()
  const agents = state.agents.filter(a => a.projectId === projectId)
  const batches = state.batches.filter(b => agents.some(a => a.id === b.agentId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const [selId, setSelId] = useState<string | null>(null)
  const sel = batches.find(b => b.id === selId) ?? batches[0]
  const [newAgentId, setNewAgentId] = useState(agents[0]?.id ?? '')

  const createBatch = () => {
    const agent = agents.find(a => a.id === newAgentId)
    if (!agent) return
    const version = currentVersion(state.versions, agent.id)
    if (!version) return
    const b: BulkBatch = { id: uid(), agentId: agent.id, versionId: version.id, name: `${adapterLabel(agent.name)} · ${new Date().toLocaleDateString()}`, report: '', createdAt: now() }
    mutate(d => { d.batches.push(b) })
    setSelId(b.id)
  }

  if (!agents.length) return <EmptyState icon="Agents" title="No agents yet" body="Add an agent before analyzing its calls." actionLabel="Add an agent" to="settings" />

  return (
    <>
      <div className="card">
        <div className="row">
          <select className="field-input grow" value={sel?.id ?? ''} onChange={e => setSelId(e.target.value)}>
            {batches.length === 0 && <option value="">No batches yet</option>}
            {batches.map(b => <option key={b.id} value={b.id}>{b.name} ({state.calls.filter(c => c.batchId === b.id).length} calls)</option>)}
          </select>
          <select className="field-input" value={newAgentId} onChange={e => setNewAgentId(e.target.value)}>
            {agents.map(a => <option key={a.id} value={a.id}>{agentLabel(a)}</option>)}
          </select>
          <button className="btn" onClick={createBatch}>+ New batch</button>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          A batch pins your calls to the agent's current testing prompt version. Drop ALL your call files at once —
          transcripts (.txt / .json exports) drive the analysis; recordings with the same file name attach for listening.
        </p>
      </div>
      {!sel && <EmptyState icon="Calls" title="No batches yet" body="Create a batch, then add the calls to analyze." actionLabel={currentVersion(state.versions, newAgentId) ? 'Create a batch' : 'Add a version'} to="versions" onAction={currentVersion(state.versions, newAgentId) ? createBatch : undefined} />}
      {sel && <BatchDetail key={sel.id} batch={sel} />}
    </>
  )
}

function BatchDetail({ batch }: { batch: BulkBatch }) {
  const { state, mutate } = useStore()
  const agent = state.agents.find(a => a.id === batch.agentId)
  const version = state.versions.find(v => v.id === batch.versionId)
  const calls = state.calls.filter(c => c.batchId === batch.id).sort((a, b) => a.fileName.localeCompare(b.fileName))
  const [running, setRunning] = useState(false)
  const [reportBusy, setReportBusy] = useState(false)
  const [err, setErr] = useState('')
  const [dropNote, setDropNote] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  // refresh trigger for session-only audio attachment
  const [, bump] = useState(0)

  if (!agent || !version) return <p className="muted">Batch agent/version missing.</p>

  const addFiles = async (files: FileList | File[]) => {
    if (DEMO_MODE) return
    const list = Array.from(files)
    const texts = list.filter(f => TEXT_EXT.test(f.name))
    const audios = list.filter(f => AUDIO_EXT.test(f.name))
    let added = 0, updated = 0
    const newCalls: CallAnalysis[] = []
    for (const f of texts) {
      const raw = await f.text()
      const transcript = /\.json$/i.test(f.name) ? transcriptFromJson(raw) : raw
      const existing = calls.find(c => base(c.fileName) === base(f.name))
      if (existing) {
        mutate(d => { const c = d.calls.find(x => x.id === existing.id); if (c) { c.transcript = transcript; c.verdict = 'pending'; c.error = '' } })
        updated++
      } else {
        newCalls.push({
          id: uid(), batchId: batch.id, fileName: f.name, transcript, recordingName: '',
          verdict: 'pending', summary: '', goalAchieved: null, scores: [], findings: [], error: '', createdAt: now(),
        })
        added++
      }
    }
    if (newCalls.length) mutate(d => { d.calls.push(...newCalls) })
    // attach audio to calls by matching base name (session-only playback)
    let attached = 0, orphans = 0
    const all = [...calls, ...newCalls]
    for (const f of audios) {
      const match = all.find(c => base(c.fileName) === base(f.name))
      if (match) {
        audioUrls.set(match.id, URL.createObjectURL(f))
        if (!match.recordingName) mutate(d => { const c = d.calls.find(x => x.id === match.id); if (c) c.recordingName = f.name })
        attached++
      } else orphans++
    }
    if (attached) bump(x => x + 1)
    const parts = []
    if (added) parts.push(`${added} call${added > 1 ? 's' : ''} added`)
    if (updated) parts.push(`${updated} updated`)
    if (attached) parts.push(`${attached} recording${attached > 1 ? 's' : ''} attached`)
    if (orphans) parts.push(`${orphans} recording${orphans > 1 ? 's' : ''} skipped — no transcript with the same file name (analysis needs the transcript; export it from Ultravox alongside the audio)`)
    setDropNote(parts.join(' · ') || 'No usable files — drop .txt/.json transcripts and audio recordings.')
  }

  const runAll = async () => {
    setErr('')
    const queue = calls.filter(c => c.verdict === 'pending' || c.verdict === 'error')
    if (!queue.length) return
    setRunning(true)
    mutate(d => { for (const q of queue) { const c = d.calls.find(x => x.id === q.id); if (c) { c.verdict = 'analyzing'; c.error = '' } } })
    let i = 0
    const worker = async () => {
      while (i < queue.length) {
        const call = queue[i++]
        try {
          const res = await analyzeCall(agent, version, state.rubric, call.fileName, call.transcript)
          mutate(d => {
            const c = d.calls.find(x => x.id === call.id)
            if (!c) return
            c.verdict = res.verdict
            c.summary = res.summary
            c.goalAchieved = res.goalAchieved
            c.scores = res.scores
            c.findings = res.findings.map(f => ({ ...f, id: uid(), issueId: null }))
          })
        } catch (e) {
          mutate(d => { const c = d.calls.find(x => x.id === call.id); if (c) { c.verdict = 'error'; c.error = e instanceof Error ? e.message : String(e) } })
        }
      }
    }
    await Promise.all([worker(), worker(), worker()])
    setRunning(false)
  }

  const genReport = async () => {
    setErr(''); setReportBusy(true)
    try {
      const fresh = state.calls.filter(c => c.batchId === batch.id)
      const report = await aggregateBatch(agent, version, fresh)
      mutate(d => { const b = d.batches.find(x => x.id === batch.id); if (b) b.report = report })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setReportBusy(false) }
  }

  const deleteBatch = () => {
    if (!confirm(`Delete batch "${batch.name}" and its ${calls.length} analyzed calls?`)) return
    mutate(d => {
      d.batches = d.batches.filter(b => b.id !== batch.id)
      d.calls = d.calls.filter(c => c.batchId !== batch.id)
    })
  }

  const done = calls.filter(c => ['good', 'mixed', 'bad'].includes(c.verdict))
  const counts = { good: 0, mixed: 0, bad: 0 }
  for (const c of done) counts[c.verdict as 'good' | 'mixed' | 'bad']++
  const goalKnown = done.filter(c => c.goalAchieved !== null)
  const goalRate = goalKnown.length ? Math.round(100 * goalKnown.filter(c => c.goalAchieved).length / goalKnown.length) : null
  const layerCounts: { [l: string]: number } = {}
  for (const c of done) for (const f of c.findings) layerCounts[f.layer] = (layerCounts[f.layer] ?? 0) + 1
  const pending = calls.filter(c => c.verdict === 'pending' || c.verdict === 'error').length
  const analyzing = calls.filter(c => c.verdict === 'analyzing').length

  return (
    <>
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>{batch.name}</h2>
          {DEMO_MODE && <span className="muted">{DEMO_SERVER_REASON}</span>}
          <span className="badge testing">v{version.number}</span>
          <span className="muted">{adapterLabel(agent.name)}</span>
          <div style={{ flex: 1 }} />
          <button className="btn small danger" onClick={deleteBatch}>Delete batch</button>
        </div>
        <div
          className="dropzone" role="button" aria-disabled={DEMO_MODE} tabIndex={DEMO_MODE ? -1 : 0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (!DEMO_MODE && fileRef.current?.click()) } }}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); void addFiles(e.dataTransfer.files) }}
          onClick={() => (!DEMO_MODE && fileRef.current?.click())}
        >
          Drop all your call files here (or click) — transcripts .txt / .json + recordings .mp3 / .wav
          <input ref={fileRef} type="file" disabled={DEMO_MODE} multiple hidden accept=".txt,.md,.log,.json,audio/*"
            onChange={e => { if (e.target.files?.length) void addFiles(e.target.files); e.target.value = '' }} />
        </div>
        {dropNote && <p className="muted">{dropNote}</p>}
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={runAll} disabled={DEMO_MODE || running || !pending}>
            {running ? `Analyzing… (${analyzing} in flight)` : `▶ Analyze ${pending || 'all'} call${pending === 1 ? '' : 's'}`}
          </button>
          <button className="btn secondary" onClick={genReport} disabled={DEMO_MODE || reportBusy || !done.length}>
            {reportBusy ? 'Synthesizing…' : '📋 Generate improvement plan'}
          </button>
          {err && <span style={{ color: 'var(--bad)' }}>{err}</span>}
        </div>
      </div>

      {done.length > 0 && (
        <div className="card">
          <h2>Batch health — {done.length}/{calls.length} analyzed</h2>
          <div className="review-grid">
            <div><span className="muted">Good</span>✅ {counts.good}</div>
            <div><span className="muted">Mixed</span>➖ {counts.mixed}</div>
            <div><span className="muted">Bad</span>❌ {counts.bad}</div>
            <div><span className="muted">Goal achieved</span>{goalRate === null ? '–' : `${goalRate}%`}</div>
            {Object.entries(layerCounts).sort((a, b) => b[1] - a[1]).map(([l, n]) => (
              <div key={l}><span className="muted">Findings: {l}</span>{n}</div>
            ))}
          </div>
        </div>
      )}

      {batch.report && (
        <div className="card">
          <h2>📋 Improvement plan</h2>
          <div className="md">{batch.report}</div>
        </div>
      )}

      <div className="card">
        <h2>Calls ({calls.length})</h2>
        {calls.length === 0 && <p className="muted">No calls yet — drop your files above.</p>}
        {calls.map(c => <CallCard key={c.id} call={c} />)}
      </div>
    </>
  )
}

function CallCard({ call }: { call: CallAnalysis }) {
  const { state, mutate } = useStore()
  const [open, setOpen] = useState(false)
  const audio = audioUrls.get(call.id)
  const batch = state.batches.find(b => b.id === call.batchId)

  const promote = (findingId: string) => {
    mutate(d => {
      const c = d.calls.find(x => x.id === call.id)
      const f = c?.findings.find(x => x.id === findingId)
      const b = d.batches.find(x => x.id === call.batchId)
      const agent = d.agents.find(a => a.id === b?.agentId)
      if (!c || !f || !b || !agent) return
      const issue: Issue = {
        id: uid(), projectId: agent.projectId, agentId: agent.id,
        title: f.what.slice(0, 90),
        description: `[${f.layer}] ${f.what}${f.evidence ? ` — "${f.evidence}"` : ''}\nSuggested fix: ${f.suggestedFix}\n(from bulk call ${call.fileName})`,
        severity: f.severity, status: 'open', bornInVersionId: b.versionId,
        claimedFixedInVersionId: null, verifiedFixedInVersionId: null, resolutionNote: '',
        verifications: [], createdAt: now(),
        // The analyser already named the layer; it was being printed into the
        // description where a human had to read it off the page and route it by
        // hand. Now it is a field, so the board routes it and the owning team
        // is pre-filled. This is the one promotion path where attribution is
        // known for certain, so it is the one that must not lose it.
        layer: f.layer, ownerTeam: LAYER_TEAM[f.layer], ownerPerson: '',
        attribution: LAYER_FIRST_CHECK[f.layer],
      }
      d.issues.push(issue)
      f.issueId = issue.id
    })
  }

  return (
    <div className="verify-item" style={{ display: 'block' }}>
      <div className="row">
        <span className={`badge verdict-${call.verdict}`}>{call.verdict}</span>
        <strong>{call.fileName}</strong>
        {call.goalAchieved !== null && <span className="muted">{call.goalAchieved ? '🎯 goal achieved' : '🚫 goal missed'}</span>}
        {call.findings.length > 0 && <span className="muted">{call.findings.length} finding{call.findings.length > 1 ? 's' : ''}</span>}
        <div style={{ flex: 1 }} />
        <button className="btn small secondary" onClick={() => setOpen(!open)}>{open ? 'Collapse' : 'Details'}</button>
      </div>
      {call.summary && <p style={{ margin: '6px 0 0' }}>{call.summary}</p>}
      {call.error && <p style={{ color: 'var(--bad)' }}>{call.error}</p>}
      {audio ? <audio controls src={audio} style={{ width: '100%', marginTop: 6 }} />
        : call.recordingName ? <p className="muted">🎧 {call.recordingName} — re-drop the audio file to listen (recordings aren't persisted)</p> : null}
      {open && (
        <div style={{ marginTop: 8 }}>
          {call.scores.length > 0 && (
            <div className="row" style={{ gap: 6 }}>
              {call.scores.map(sc => <span key={sc.paramId} className="badge draft">{sc.paramName}: {sc.value}</span>)}
            </div>
          )}
          {call.findings.map(f => (
            <div key={f.id} style={{ marginTop: 8 }}>
              <span className={`badge ${f.severity}`}>{f.severity}</span>{' '}
              <span className={`badge layer-${f.layer}`}>{f.layer}</span>{' '}
              <strong>{f.what}</strong>
              {f.evidence && <div className="muted">"{f.evidence}"</div>}
              {f.suggestedFix && <div>🔧 {f.suggestedFix}</div>}
              <div style={{ marginTop: 4 }}>
                {f.issueId
                  ? <span className="badge open">on issue board</span>
                  : <button className="btn small secondary" onClick={() => promote(f.id)}>→ Promote to Issue</button>}
              </div>
            </div>
          ))}
          {call.transcript && (
            <>
              <h3>Transcript</h3>
              <div className="md" style={{ maxHeight: 240, overflow: 'auto' }}>{call.transcript}</div>
            </>
          )}
          {batch && <p className="muted">Analyzed against v{state.versions.find(v => v.id === batch.versionId)?.number}</p>}
        </div>
      )}
    </div>
  )
}

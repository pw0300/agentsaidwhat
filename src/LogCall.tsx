import { adapterLabel } from './adapters'
import { ClarificationRequests } from './ClarificationReply'
import { DEMO_MODE, DEMO_SERVER_REASON } from './mode'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, FailureLayer, NoteKind, Observation, Score, Scenario, Severity, TestSession } from './types'
import { LAYER_TEAM, FAILURE_LAYERS, LAYER_LABEL } from './types'
import { uid, now } from './data'
import { useStore, currentVersion } from './store.tsx'
import { EmptyState, useNav } from './nav'
import { AUDIO_ACCEPT, audioUrl, uploadAudio } from './audio'
import { Player, TranscriptView, useAudioClock, RATES, type Marker } from './Player'
import { formatTime, fromSubtitles, parseTime, type TranscriptLine } from './transcript'
import { Kbd, ShortcutHelp, useHotkeys } from './hotkeys'
import { paramsFor, scenariosFor } from './notes'

/* ------------------------------------------------------------------ */
/* Draft                                                               */
/* ------------------------------------------------------------------ */

export interface DraftNote {
  id: string
  kind: NoteKind
  atSec: number | null
  whatHappened: string
  expected: string
  quote: string
  severity: Severity
  layer: FailureLayer | ''
}

interface CallDraft {
  agentId: string
  versionId: string
  scenarioId: string
  useCase: string
  transcript: string
  recordingName: string
  audioId: string
  durationSec: number | null
  scores: Record<string, number>
  na: string[]
  notes: DraftNote[]
  comments: string
}

// Legacy browser storage keys preserve existing drafts and the last selected agent.
const DRAFT_KEY = (agentId: string) => `agent-qa-log-draft-${agentId}`

const blankNote = (kind: NoteKind, atSec: number | null = null, quote = ''): DraftNote => ({
  id: uid(), kind, atSec, whatHappened: '', expected: '', quote, severity: 'major', layer: '',
})

const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: 'Call failed', major: 'Customer annoyed', minor: 'Noticeable', nitpick: 'Polish',
}

const LAYERS: FailureLayer[] = FAILURE_LAYERS

function loadDraft(agentId: string): CallDraft | null {
  if (DEMO_MODE) return null
  try {
    const raw = localStorage.getItem(DRAFT_KEY(agentId))
    return raw ? (JSON.parse(raw) as CallDraft) : null
  } catch { return null }
}

export const hasLogDraft = (agentId: string): boolean => {
  if (DEMO_MODE) return false
  try { return !!localStorage.getItem(DRAFT_KEY(agentId)) } catch { return false }
}

/* ------------------------------------------------------------------ */
/* Entry: choose an agent                                              */
/* ------------------------------------------------------------------ */

export function LogCall({ projectId, tester, initialAgentId }: { projectId: string; tester: string; initialAgentId?: string }) {
  const { state } = useStore()
  const agents = state.agents.filter(a => a.projectId === projectId)
  const [agentId, setAgentId] = useState<string>(() => initialAgentId ?? localStorage.getItem('agent-qa-last-agent') ?? '')
  const agent = agents.find(a => a.id === agentId) ?? (agents.length === 1 ? agents[0] : undefined)

  useEffect(() => { if (agent) localStorage.setItem('agent-qa-last-agent', agent.id) }, [agent])

  if (agents.length === 0) {
    return (
      <div className="card">
        <EmptyState icon="🎙" title="No agents in this project yet"
          body="Add the voice or chat agent you want to test, then come back here to log a call against it."
          actionLabel="Add an agent" to="settings" />
      </div>
    )
  }

  if (!agent) {
    return (
      <div className="agent-cards">
        {agents.map(a => {
          const v = currentVersion(state.versions, a.id)
          return (
            <button key={a.id} className="agent-card" onClick={() => setAgentId(a.id)}>
              <div className="name">{adapterLabel(a.name)}</div>
              <div className="row">
                <span className={`badge ${a.type}`}>{a.type === 'voice' ? 'Voice' : 'Chatbot'}</span>
                <span className="muted">{a.direction}</span>
              </div>
              <div className="muted" style={{ marginTop: 8 }}>{v ? `Testing v${v.number}` : 'No version yet'}</div>
              {hasLogDraft(a.id) && <div className="draft-pill">Unfinished call, continue</div>}
            </button>
          )
        })}
      </div>
    )
  }

  return <><ClarificationRequests projectId={projectId} tester={tester} /><CallLogger key={agent.id} agent={agent} agents={agents} tester={tester} onAgent={setAgentId} /></>
}

/* ------------------------------------------------------------------ */
/* The logger                                                          */
/* ------------------------------------------------------------------ */

function CallLogger({ agent, agents, tester, onAgent }: {
  agent: Agent; agents: Agent[]; tester: string; onAgent: (id: string) => void
}) {
  const { state, mutate } = useStore()
  const go = useNav()
  const versions = state.versions.filter(v => v.agentId === agent.id).sort((a, b) => b.number - a.number)
  const defaultVersion = currentVersion(state.versions, agent.id)
  const params = useMemo(() => paramsFor(state, agent), [state, agent])
  const scenarios = scenariosFor(state, agent.id, tester)

  const fresh = (): CallDraft => ({
    agentId: agent.id, versionId: defaultVersion?.id ?? '', scenarioId: scenarios[0]?.id ?? '',
    useCase: scenarios[0]?.name ?? '', transcript: '', recordingName: '', audioId: '', durationSec: null,
    scores: {}, na: [], notes: [], comments: '',
  })
  const [d, setD] = useState<CallDraft>(() => loadDraft(agent.id) ?? fresh())
  const set = (patch: Partial<CallDraft>) => setD(prev => ({ ...prev, ...patch }))

  const touched = !!(d.transcript.trim() || d.audioId || d.recordingName || Object.keys(d.scores).length || d.notes.length || d.comments.trim())
  useEffect(() => {
    if (DEMO_MODE) return
    try {
      if (touched) localStorage.setItem(DRAFT_KEY(agent.id), JSON.stringify(d))
      else localStorage.removeItem(DRAFT_KEY(agent.id))
    } catch { /* quota: the draft is a convenience */ }
  }, [d, touched, agent.id])

  const [saved, setSaved] = useState<TestSession | null>(null)
  const generation = useRef(0)

  /* ---------- audio ---------- */
  const src = !saved && d.audioId ? audioUrl(d.audioId) : null
  const clock = useAudioClock(src)
  const [upload, setUpload] = useState<{ pct: number; msg: string; err: boolean } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const transcriptInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (clock.duration > 0 && d.durationSec !== Math.round(clock.duration)) set({ durationSec: Math.round(clock.duration) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock.duration])

  const attachFiles = async (files: FileList | File[]) => {
    if (DEMO_MODE) return
    for (const f of Array.from(files)) {
      const name = f.name.toLowerCase()
      if (/\.(txt|srt|vtt|md|json|csv)$/.test(name) || f.type.startsWith('text/')) {
        const text = await f.text()
        set({ transcript: fromSubtitles(text) })
        continue
      }
      if (!(f.type.startsWith('audio/') || /\.(mp3|wav|m4a|mp4|ogg|oga|opus|webm|flac|aac)$/.test(name))) {
        setUpload({ pct: 0, msg: `${f.name} is not audio or a transcript.`, err: true })
        continue
      }
      setUpload({ pct: 0, msg: `Uploading ${f.name}`, err: false })
      const r = await uploadAudio(f, pct => setUpload({ pct, msg: `Uploading ${f.name}`, err: false }))
      if (r.ok) { set({ audioId: r.audio.id, recordingName: r.audio.name }); setUpload(null) }
      else { set({ recordingName: f.name }); setUpload({ pct: 0, msg: r.reason, err: !r.unsupported }) }
    }
  }

  const [dragging, setDragging] = useState(false)

  /* ---------- notes ---------- */
  const [editing, setEditing] = useState<string | null>(null)
  const addNote = (kind: NoteKind, atSec: number | null = src ? clock.time : null, quote = '') => {
    const n = blankNote(kind, atSec != null ? Math.round(atSec * 10) / 10 : null, quote)
    set({ notes: [...d.notes, n] })
    setEditing(n.id)
  }
  const pinLine = (l: TranscriptLine) => addNote('went-wrong', l.atSec ?? (src ? clock.time : null), l.text.slice(0, 280))
  const updateNote = (id: string, patch: Partial<DraftNote>) => set({ notes: d.notes.map(n => (n.id === id ? { ...n, ...patch } : n)) })
  const removeNote = (id: string) => { set({ notes: d.notes.filter(n => n.id !== id) }); if (editing === id) setEditing(null) }

  const markers: Marker[] = d.notes.filter(n => n.atSec != null).map(n => ({
    atSec: n.atSec as number, kind: n.kind, label: n.whatHappened || (n.kind === 'went-well' ? 'Went well' : 'Problem'),
  }))

  /* ---------- ratings ---------- */
  const [focusParam, setFocusParam] = useState(0)
  const ratingRefs = useRef<(HTMLDivElement | null)[]>([])
  const moveParam = (index: number) => {
    setFocusParam(index)
    ratingRefs.current[index]?.focus()
  }
  const answered = params.filter(p => d.scores[p.id] != null || d.na.includes(p.id)).length
  const score = (pid: string, v: number) => {
    const na = d.na.filter(x => x !== pid)
    set({ scores: { ...d.scores, [pid]: v }, na })
    const idx = params.findIndex(p => p.id === pid)
    const next = params.findIndex((p, i) => i > idx && d.scores[p.id] == null && !d.na.includes(p.id))
    moveParam(next !== -1 ? next : Math.min(params.length - 1, idx + 1))
  }
  const toggleNa = (pid: string) => {
    if (d.na.includes(pid)) { set({ na: d.na.filter(x => x !== pid) }); return }
    const scores = { ...d.scores }
    delete scores[pid]
    set({ na: [...d.na, pid], scores })
  }

  /* ---------- scenario ---------- */
  const [newScenario, setNewScenario] = useState<string | null>(null)
  const pickScenario = (id: string) => {
    if (id === '__new') { setNewScenario(''); return }
    const sc = scenarios.find(s => s.id === id)
    set({ scenarioId: id, useCase: sc?.name ?? '' })
  }
  const proposeScenario = () => {
    const name = (newScenario ?? '').trim()
    if (!name) return
    const existing = (state.scenarios ?? []).find(s => s.agentId === agent.id && s.name.toLowerCase() === name.toLowerCase())
    if (existing) { set({ scenarioId: existing.id, useCase: existing.name }); setNewScenario(null); return }
    const sc: Scenario = {
      id: uid(), agentId: agent.id, name, persona: '', goal: '', successCriteria: '', language: '', tags: [],
      status: 'proposed', proposedBy: tester, createdAt: now(),
    }
    mutate(s => { (s.scenarios ??= []).push(sc) })
    set({ scenarioId: sc.id, useCase: sc.name })
    setNewScenario(null)
  }

  /* ---------- save ---------- */
  const missing = params.length - answered
  const incompleteNotes = d.notes.filter(n => !n.whatHappened.trim())
  const canSave = !!d.versionId && missing === 0 && incompleteNotes.length === 0

  const save = () => {
    if (saved || !canSave) return
    clock.ref.current?.pause()
    const sessionId = uid()
    const scores: Score[] = params.filter(p => d.scores[p.id] != null).map(p => ({ paramId: p.id, paramName: p.name, value: d.scores[p.id] }))
    const observations: Observation[] = d.notes.map(n => ({
      id: uid(), sessionId, kind: n.kind, ...(n.atSec != null ? { atSec: n.atSec } : {}),
      whatHappened: n.whatHappened.trim(), expected: n.expected.trim(), quote: n.quote.trim(),
      severity: n.kind === 'went-well' ? 'nitpick' : n.severity,
      // A "went well" note is evidence, not a defect. It is filed as accepted so
      // it never appears in the triage queue a builder works through.
      triage: n.kind === 'went-well' ? 'accepted' : 'untriaged',
      triageNote: '', issueId: null,
      ...(n.layer ? { layer: n.layer } : {}),
    }))
    const session: TestSession = {
      id: sessionId, agentId: agent.id, versionId: d.versionId, tester, useCase: d.useCase || 'General test',
      transcript: d.transcript, recordingName: d.recordingName, scores, comments: d.comments.trim(),
      createdAt: now(), observations,
      ...(d.audioId ? { audioId: d.audioId } : {}),
      ...(d.durationSec ? { durationSec: d.durationSec } : {}),
      ...(d.scenarioId ? { scenarioId: d.scenarioId } : {}),
      ...(d.na.length ? { naParams: d.na } : {}),
    }
    const savedGeneration = generation.current
    mutate(s => { s.sessions.push(session) }, { label: 'Saved call', onUndo: () => {
      if (generation.current === savedGeneration) { setSaved(null); setD({ ...d }); setFocusParam(0) }
    } })
    try { localStorage.removeItem(DRAFT_KEY(agent.id)) } catch { /* ignore */ }
    setSaved(session)
  }

  const next = (keepScenario: boolean) => {
    generation.current++
    const f = fresh()
    setD(keepScenario ? { ...f, scenarioId: d.scenarioId, useCase: d.useCase, versionId: d.versionId } : f)
    setSaved(null); setEditing(null); setFocusParam(0)
  }

  /* ---------- keyboard ---------- */
  const [help, setHelp] = useState(false)
  useHotkeys({
    'space': () => clock.toggle(),
    'arrowleft': () => clock.nudge(-5),
    'arrowright': () => clock.nudge(5),
    'j': () => clock.nudge(-5),
    'l': () => clock.nudge(5),
    'k': () => clock.toggle(),
    '[': () => clock.setRate(RATES[Math.max(0, RATES.indexOf(clock.rate) - 1)]),
    ']': () => clock.setRate(RATES[Math.min(RATES.length - 1, RATES.indexOf(clock.rate) + 1)]),
    ',': () => clock.nudge(-1),
    '.': () => clock.nudge(1),
    'b': () => addNote('went-wrong'),
    'w': () => addNote('went-wrong'),
    'g': () => addNote('went-well'),
    '1': () => params[focusParam] && score(params[focusParam].id, 1),
    '2': () => params[focusParam] && score(params[focusParam].id, 2),
    '3': () => params[focusParam] && score(params[focusParam].id, 3),
    '4': () => params[focusParam] && score(params[focusParam].id, 4),
    '5': () => params[focusParam] && score(params[focusParam].id, 5),
    'n': () => params[focusParam] && toggleNa(params[focusParam].id),
    'arrowdown': () => moveParam(Math.min(params.length - 1, focusParam + 1)),
    'arrowup': () => moveParam(Math.max(0, focusParam - 1)),
    'mod+enter': () => (saved ? next(true) : save()),
    'escape': () => { setEditing(null); setHelp(false) },
    '?': () => setHelp(h => !h),
  }, !saved && !help)
  useHotkeys({ n: () => next(true), 'mod+enter': () => next(true), '?': () => setHelp(true) }, !!saved && !help)

  /* ---------- render ---------- */
  if (!defaultVersion) {
    return (
      <div className="card">
        <EmptyState icon="⑂" title={`${adapterLabel(agent.name)} has no prompt version yet`}
          body="Every call is pinned to the exact prompt that produced it, so a version has to exist before you can log anything."
          actionLabel="Add the first version" to="versions" />
      </div>
    )
  }

  if (saved) {
    const problems = saved.observations.filter(o => o.kind !== 'went-well').length
    const wins = saved.observations.length - problems
    return (
      <div className="card center saved-card">
        {help && <ShortcutHelp onClose={() => setHelp(false)} groups={[["Next call", [["N", "Log next call with the same context"], ["Ctrl/Cmd Enter", "Log next call"], ["?", "Show shortcuts"], ["Esc", "Close shortcuts"], ["Ctrl/Cmd K", "Command palette"]]]]} />}
        <div className="saved-mark" aria-hidden="true">✓</div>
        <h2>Call logged against {adapterLabel(agent.name)} v{versions.find(v => v.id === saved.versionId)?.number}</h2>
        <p className="muted">
          {saved.scores.length} rating{saved.scores.length === 1 ? '' : 's'} · {problems} problem{problems === 1 ? '' : 's'} sent to triage · {wins} thing{wins === 1 ? '' : 's'} that went well
          {saved.audioId ? ' · recording kept' : ''}
        </p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="btn big" onClick={() => next(true)} autoFocus>Log next call <Kbd>N</Kbd></button>
          <button className="btn big secondary" onClick={() => next(false)}>Log a different scenario</button>
          <button className="btn big secondary" onClick={() => go('calls')}>See all calls</button>
        </div>
      </div>
    )
  }

  const version = versions.find(v => v.id === d.versionId)

  return (
    <div className="logger"
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false) }}
      onDrop={e => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void attachFiles(e.dataTransfer.files) }}>
      {dragging && <div className="drop-veil">Drop a recording or a transcript</div>}
      {help && <ShortcutHelp onClose={() => setHelp(false)} groups={SHORTCUTS} />}

      {/* ---------- context bar ---------- */}
      <div className="context-bar card">
        <label className="ctx">
          <span>Agent</span>
          <select value={agent.id} onChange={e => onAgent(e.target.value)}>
            {agents.map(a => <option key={a.id} value={a.id}>{adapterLabel(a.name)}</option>)}
          </select>
        </label>
        <label className="ctx">
          <span>Prompt version</span>
          <select value={d.versionId} onChange={e => set({ versionId: e.target.value })}>
            {versions.map(v => <option key={v.id} value={v.id}>v{v.number} · {v.status}</option>)}
          </select>
        </label>
        <label className="ctx grow">
          <span>Scenario</span>
          {newScenario == null ? (
            <select value={d.scenarioId} onChange={e => pickScenario(e.target.value)}>
              {!d.scenarioId && <option value="">Pick a scenario</option>}
              {scenarios.map(s => <option key={s.id} value={s.id}>{s.name}{s.status === 'proposed' ? ' (proposed)' : ''}</option>)}
              <option value="__new">+ New scenario…</option>
            </select>
          ) : (
            <span className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
              <input type="text" autoFocus value={newScenario} placeholder="e.g. Caller switches to Hindi mid-sentence"
                onChange={e => setNewScenario(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') proposeScenario(); if (e.key === 'Escape') setNewScenario(null) }} />
              <button className="btn small" onClick={proposeScenario} disabled={!newScenario.trim()}>Add</button>
              <button className="btn small secondary" onClick={() => setNewScenario(null)}>Cancel</button>
            </span>
          )}
        </label>
        <button className="icon-btn ghost" onClick={() => setHelp(true)} title="Keyboard shortcuts (?)">⌨ <Kbd>?</Kbd></button>
      </div>
      {version && version.status !== 'testing' && version.status !== 'live' && (
        <p className="notice">You are logging against v{version.number}, which is <strong>{version.status}</strong>. Scores still count toward that version.</p>
      )}

      {DEMO_MODE && <p className="muted">{DEMO_SERVER_REASON}</p>}
      <div className="logger-grid">
        {/* ---------- left: the call ---------- */}
        <section className="card logger-call">
          <div className="row">
            <h2 style={{ margin: 0 }}>The call</h2>
            <div className="spacer" />
            <input ref={fileInput} type="file" disabled={DEMO_MODE} accept={AUDIO_ACCEPT} hidden onChange={e => { if (e.target.files) void attachFiles(e.target.files); e.target.value = '' }} />
            <input ref={transcriptInput} type="file" disabled={DEMO_MODE} accept=".txt,.srt,.vtt,.md,.json,.csv,text/*" hidden onChange={e => { if (e.target.files) void attachFiles(e.target.files); e.target.value = '' }} />
            <button className="btn small secondary" disabled={DEMO_MODE} onClick={() => fileInput.current?.click()}>{d.audioId ? 'Replace recording' : 'Attach recording'}</button>
            <button className="btn small secondary" disabled={DEMO_MODE} onClick={() => transcriptInput.current?.click()}>Load transcript file</button>
          </div>

          {upload && (
            <div className={`upload ${upload.err ? 'err' : ''}`}>
              {upload.pct > 0 && upload.pct < 1 && <div className="progress"><div className="bar" style={{ width: `${upload.pct * 100}%` }} /></div>}
              <span className="muted">{upload.msg}</span>
              <button className="chip-x" onClick={() => setUpload(null)} aria-label="Dismiss">✕</button>
            </div>
          )}

          {src ? (
            <>
              <div className="muted file-line">🎧 {d.recordingName}
                <button className="link" onClick={() => set({ audioId: '', recordingName: '', durationSec: null })}>remove</button>
              </div>
              <Player src={src} clock={clock} markers={markers} onMarker={() => undefined} />
            </>
          ) : (
            <button className="dropzone-inline" disabled={DEMO_MODE} onClick={() => fileInput.current?.click()}>
              <strong>Drop the recording here</strong>
              <span className="muted">mp3, wav, m4a, ogg, webm, flac. Or a .txt / .srt / .vtt transcript.</span>
              {d.recordingName && <span className="muted">Filename kept: {d.recordingName}</span>}
            </button>
          )}

          {d.transcript.trim() ? (
            <>
              <div className="row" style={{ marginTop: 12 }}>
                <h3 style={{ margin: 0 }}>Transcript</h3>
                <div className="spacer" />
                <button className="link" onClick={() => set({ transcript: '' })}>clear</button>
              </div>
              <TranscriptView text={d.transcript} clock={src ? clock : null} onPin={pinLine} />
            </>
          ) : (
            <>
              <label className="field">Transcript</label>
              <textarea className="mono" value={d.transcript} onChange={e => set({ transcript: e.target.value })}
                onPaste={e => {
                  const text = e.clipboardData.getData('text')
                  if (/-->/.test(text)) { e.preventDefault(); set({ transcript: fromSubtitles(text) }) }
                }}
                placeholder={'Paste the conversation. Timestamps make every line clickable:\n[00:03] Agent: Namaste, main Priya bol rahi hoon…\n[00:07] Customer: Haan, boliye'} />
            </>
          )}
        </section>

        {/* ---------- right: judgement ---------- */}
        <section className="logger-side">
          <div className="card">
            <div className="row">
              <h2 style={{ margin: 0 }}>Ratings</h2>
              <span className="muted">{answered}/{params.length}</span>
              <div className="spacer" />
              <span className="muted hint"><Kbd>1</Kbd>–<Kbd>5</Kbd> rate · <Kbd>N</Kbd> n/a · <Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
            </div>
            {params.length === 0 && <p className="muted">No rubric parameters apply to this agent. Choose some in Settings → Rubric.</p>}
            <div className="ratings">
              {params.map((p, i) => {
                const v = d.scores[p.id]
                const na = d.na.includes(p.id)
                return (
                  <div key={p.id} className={`rating-row ${i === focusParam ? 'focus' : ''} ${v != null || na ? 'done' : ''}`}
                    ref={el => { ratingRefs.current[i] = el }} tabIndex={0} role="group" aria-label={p.name}
                    onFocus={() => setFocusParam(i)} onClick={() => moveParam(i)}
                    onKeyDown={e => {
                      if (e.key === 'Tab' && e.target === e.currentTarget) {
                        const next = i + (e.shiftKey ? -1 : 1)
                        if (next >= 0 && next < params.length) { e.preventDefault(); moveParam(next) }
                      }
                    }}>
                    <div className="rating-name">
                      <strong>{p.name}</strong>
                      <span className="muted">{p.question}</span>
                      {v != null && p.anchors[v] && <span className="anchor-now">{v}: {p.anchors[v]}</span>}
                    </div>
                    <div className="score-btns">
                      {[1, 2, 3, 4, 5].map(n => (
                        <button key={n} className={v === n ? `sel${n}` : ''} title={p.anchors[n] ?? ''}
                          onClick={e => { e.stopPropagation(); setFocusParam(i); score(p.id, n) }}>{n}</button>
                      ))}
                      <button className={`na-btn ${na ? 'on' : ''}`} title="Not applicable on this call"
                        onClick={e => { e.stopPropagation(); setFocusParam(i); toggleNa(p.id) }}>n/a</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="card">
            <div className="row">
              <h2 style={{ margin: 0 }}>Notes</h2>
              <div className="spacer" />
              <button className="btn small danger" onClick={() => addNote('went-wrong')} title="B">✗ Went wrong <Kbd>B</Kbd></button>
              <button className="btn small good" onClick={() => addNote('went-well')} title="G">✓ Went well <Kbd>G</Kbd></button>
            </div>
            <p className="muted" style={{ margin: '6px 0 8px' }}>
              {src ? 'Notes are pinned to the moment the audio is at. Click "+ note" on a transcript line to quote it.' : 'Attach the recording to pin notes to a moment in the call.'}
            </p>
            {d.notes.length === 0 && <EmptyState icon="Notes" title="No notes yet" body="If the call was clean, rate it and save. Otherwise, pin a note to this moment." actionLabel="Add a problem note" onAction={() => addNote('went-wrong')} />}
            {d.notes.map(n => (
              <NoteCard key={n.id} note={n} open={editing === n.id} hasAudio={!!src}
                onOpen={() => setEditing(n.id)} onClose={() => setEditing(null)}
                onSeek={() => n.atSec != null && clock.seek(n.atSec)}
                onChange={patch => updateNote(n.id, patch)} onRemove={() => removeNote(n.id)}
                onStampNow={() => updateNote(n.id, { atSec: Math.round(clock.time * 10) / 10 })} />
            ))}
          </div>

          <div className="card">
            <label className="field" style={{ marginTop: 0 }}>Overall (optional)</label>
            <textarea value={d.comments} onChange={e => set({ comments: e.target.value })} placeholder="Overall impression, context a builder should know…" style={{ minHeight: 60 }} />
            <div className="save-bar">
              <span className="muted">
                {missing > 0 ? `${missing} rating${missing === 1 ? '' : 's'} left` : incompleteNotes.length ? `${incompleteNotes.length} note${incompleteNotes.length === 1 ? '' : 's'} need a description` : 'Ready to save'}
                {touched && ' · draft autosaved'}
              </span>
              <div className="spacer" />
              {touched && <button className="btn secondary" onClick={() => { if (confirm('Discard this call?')) next(false) }}>Discard</button>}
              <button className="btn" onClick={save} disabled={DEMO_MODE || !canSave}>Save call <Kbd>Ctrl</Kbd><Kbd>Enter</Kbd></button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* A note                                                              */
/* ------------------------------------------------------------------ */

function NoteCard({ note: n, open, hasAudio, onOpen, onClose, onSeek, onChange, onRemove, onStampNow }: {
  note: DraftNote; open: boolean; hasAudio: boolean
  onOpen: () => void; onClose: () => void; onSeek: () => void
  onChange: (p: Partial<DraftNote>) => void; onRemove: () => void; onStampNow: () => void
}) {
  const [timeText, setTimeText] = useState(n.atSec != null ? formatTime(n.atSec) : '')
  useEffect(() => { setTimeText(n.atSec != null ? formatTime(n.atSec) : '') }, [n.atSec])
  const wrong = n.kind === 'went-wrong'

  if (!open) {
    return (
      <div className={`note ${n.kind}`} onClick={onOpen} role="button" tabIndex={0} onKeyDown={e => e.key === 'Enter' && onOpen()}>
        <span className="note-kind">{wrong ? '✗' : '✓'}</span>
        {n.atSec != null && <button className="note-time" onClick={e => { e.stopPropagation(); onSeek() }}>{formatTime(n.atSec)}</button>}
        <div className="grow">
          <div>{n.whatHappened || <em className="muted">No description yet</em>}</div>
          {n.quote && <div className="muted">“{n.quote}”</div>}
        </div>
        {wrong && <span className={`badge ${n.severity}`}>{SEVERITY_LABEL[n.severity]}</span>}
        {wrong && n.layer && <span className="badge draft" title={LAYER_TEAM[n.layer]}>{n.layer}</span>}
      </div>
    )
  }

  return (
    <div className={`note open ${n.kind}`}>
      <div className="row">
        <div className="seg">
          <button className={wrong ? 'on bad' : ''} onClick={() => onChange({ kind: 'went-wrong' })}>✗ Went wrong</button>
          <button className={!wrong ? 'on good' : ''} onClick={() => onChange({ kind: 'went-well' })}>✓ Went well</button>
        </div>
        <div className="spacer" />
        <input type="text" className="time-input" value={timeText} placeholder="m:ss"
          onChange={e => setTimeText(e.target.value)}
          onBlur={() => onChange({ atSec: timeText.trim() ? parseTime(timeText) : null })}
          aria-label="Time in call" />
        {hasAudio && <button className="btn small secondary" onClick={onStampNow} title="Set to where the audio is now">now</button>}
      </div>
      <input type="text" autoFocus value={n.whatHappened} onChange={e => onChange({ whatHappened: e.target.value })}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && n.whatHappened.trim()) onClose() }}
        placeholder={wrong ? 'What happened? e.g. Kept talking when I interrupted to ask the price' : 'What went well? e.g. Switched to Hindi as soon as I did'} />
      {wrong && (
        <input type="text" value={n.expected} onChange={e => onChange({ expected: e.target.value })} placeholder="What should it have done instead?" />
      )}
      <input type="text" value={n.quote} onChange={e => onChange({ quote: e.target.value })} placeholder="Exact line from the call (optional)" />
      {wrong && (
        <div className="row" style={{ marginTop: 6 }}>
          <div className="seg small">
            {(['blocker', 'major', 'minor', 'nitpick'] as Severity[]).map(s => (
              <button key={s} className={n.severity === s ? `on sev-${s}` : ''} onClick={() => onChange({ severity: s })}>{SEVERITY_LABEL[s]}</button>
            ))}
          </div>
          <select className="field-input" style={{ width: 'auto' }} value={n.layer} onChange={e => onChange({ layer: e.target.value as FailureLayer | '' })} title="Which part of the stack? Leave blank if unsure.">
            <option value="">Layer: not sure</option>
            {LAYERS.map(l => <option key={l} value={l}>{LAYER_LABEL[l]}</option>)}
          </select>
        </div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="link danger" onClick={onRemove}>Delete note</button>
        <div className="spacer" />
        <button className="btn small" onClick={onClose} disabled={!n.whatHappened.trim()}>Done <Kbd>Enter</Kbd></button>
      </div>
    </div>
  )
}

const SHORTCUTS: [string, [string, string][]][] = [
  ['Playback', [
    ['Space', 'Play / pause'], ['K', 'Play / pause'],
    ['←', 'Back 5 seconds'], ['→', 'Forward 5 seconds'],
    ['J', 'Back 5 seconds'], ['L', 'Forward 5 seconds'],
    [',', 'Back 1 second'], ['.', 'Forward 1 second'],
    ['[', 'Slower'], [']', 'Faster'], ['Home End', 'Start / end when seek bar is focused'],
  ]],
  ['Rating', [
    ['Tab Shift+Tab', 'Move between parameter rows'], ['1 2 3 4 5', 'Rate the highlighted parameter'], ['N', 'Not applicable'],
    ['↑', 'Previous parameter'], ['↓', 'Next parameter'],
  ]],
  ['Notes & saving', [
    ['B W', 'Note something that went wrong, at the current moment'],
    ['G', 'Note something that went well'],
    ['Ctrl/Cmd Enter', 'Save the call / log another'],
    ['Enter', 'Finish a note'], ['Esc', 'Close the open note or help'], ['?', 'This help'], ['Ctrl/Cmd K', 'Command palette'],
  ]],
]

import { adapterLabel } from './adapters'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppState } from './types'
import { loadState, saveState } from './data'
import { loadBase, pull, push, sameState, saveBase, type SyncStatus } from './sync'
import { AuthGate } from './auth'
import { Toast } from './Toast'
import { undoMutation } from './undo'
import { DEMO_MODE } from './mode'
import { demoState } from './demo'

interface Store {
  state: AppState
  mutate: (fn: (draft: AppState) => void, options?: { label?: string; onUndo?: () => void }) => void
  sync: { status: SyncStatus; error: string; lastAt: number | null; syncNow: () => void }
}

export const StoreContext = createContext<Store | null>(null)
const Ctx = StoreContext

// Edits arrive in bursts (typing a comment, scoring a rubric row), so wait for
// the burst to end rather than pushing the whole document per keystroke.
const PUSH_DEBOUNCE_MS = 2000
// Polls are the cost floor: one request per tab per interval, forever. A minute
// is fast enough that a second tester's finding shows up while you are still
// looking at the board, and slow enough to sit inside a free tier all day.
const POLL_MS = 60_000

export function StoreProvider({ children }: { children: ReactNode }) {
  return DEMO_MODE ? <DemoStoreProvider>{children}</DemoStoreProvider> : <LiveStoreProvider>{children}</LiveStoreProvider>
}

function DemoStoreProvider({ children }: { children: ReactNode }) {
  const [state] = useState(() => demoState({ projects: [], agents: [], versions: [], sessions: [], issues: [], rubric: [], testers: [], batches: [], calls: [], scenarios: [] }))
  const [notice, setNotice] = useState(false)
  return <Ctx.Provider value={{ state, mutate: () => setNotice(true), sync: { status: 'local-only', error: '', lastAt: null, syncNow: () => {} } }}>
    <p className="demo-banner" role="note">Demo with sample data. Install locally to log your own calls.</p>
    {children}
    {notice && <Toast message="This demo is read-only. Install locally to save changes." onClose={() => setNotice(false)} />}
  </Ctx.Provider>
}

function LiveStoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(() => loadState())
  const [status, setStatus] = useState<SyncStatus>('local-only')
  const [error, setError] = useState('')
  const [toast, setToast] = useState<{ message: string; undo?: () => void } | null>(null)
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 6000); return () => clearTimeout(timer) }, [toast])
  const [lastAt, setLastAt] = useState<number | null>(null)

  // Refs, not state: the sync loop must read the newest values without
  // re-subscribing timers on every keystroke.
  const stateRef = useRef(state)
  stateRef.current = state
  const saved = useRef(loadBase())
  const baseRef = useRef<AppState | null>(saved.current.base)
  const revRef = useRef(saved.current.rev)
  const inFlight = useRef(false)
  const dirtyAfterFlight = useRef(false)
  const firstContactDone = useRef(false)
  // The push scheduler must see the live status, not the value captured when the
  // callback was created, or an edit made before the first sync lands is dropped.
  const statusRef = useRef<SyncStatus>('local-only')

  const adopt = (next: AppState, rev: number) => {
    baseRef.current = next
    revRef.current = rev
    saveState(next)
    saveBase(next, rev)
    stateRef.current = next
    setState(next)
  }

  const doPush = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setStatus('syncing')
    try {
      const sent = stateRef.current
      const r = await push(baseRef.current, sent)
      if (!r.configured) { setStatus('local-only'); statusRef.current = 'local-only'; return }
      statusRef.current = 'idle'
      if (stateRef.current !== sent) {
        // The user edited while this sync was in flight (e.g. loaded sample data
        // in the first second). Adopting the reply would overwrite that edit with
        // the server's older copy, so keep local work, move the base forward, and
        // send the newer state next.
        baseRef.current = r.state ?? sent
        revRef.current = r.rev
        saveBase(baseRef.current, r.rev)
        dirtyAfterFlight.current = true
      } else {
        adopt(r.state ?? sent, r.rev)
      }
      setError(''); setLastAt(Date.now()); setStatus('idle')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    } finally {
      inFlight.current = false
      if (dirtyAfterFlight.current) { dirtyAfterFlight.current = false; void doPush() }
    }
  }

  // First contact: push straight away so whatever this browser already had
  // joins the shared record instead of being shadowed by it.
  useEffect(() => {
    let alive = true
    pull().then(r => {
      if (!alive) return
      firstContactDone.current = true
      if (!r.configured) { setStatus('local-only'); return }
      void doPush()
    }).catch(() => setStatus('local-only'))
    return () => { alive = false }
  }, [])

  // Poll for other testers' work. A read is one command; only escalate to a
  // write when this browser actually has something the server has not seen.
  useEffect(() => {
    const t = setInterval(async () => {
      if (document.hidden || inFlight.current || status === 'local-only') return
      try {
        const r = await pull()
        if (!r.configured || r.rev === revRef.current) return
        if (sameState(baseRef.current, stateRef.current)) {
          if (r.state) { adopt(r.state, r.rev); setLastAt(Date.now()) }
        } else {
          await doPush()
        }
      } catch { /* transient; the next tick retries */ }
    }, POLL_MS)
    return () => clearInterval(t)
  }, [status])

  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const schedulePush = () => {
    if (inFlight.current) { dirtyAfterFlight.current = true; return }
    if (statusRef.current === 'local-only' && status === 'local-only' && firstContactDone.current) return
    if (pushTimer.current) clearTimeout(pushTimer.current)
    pushTimer.current = setTimeout(() => { void doPush() }, PUSH_DEBOUNCE_MS)
  }

  const mutate: Store['mutate'] = (fn, options) => {
    const before = stateRef.current
    const next: AppState = JSON.parse(JSON.stringify(before))
    fn(next)
    if (sameState(before, next)) return
    saveState(next)
    stateRef.current = next
    setState(next)
    setToast({ message: options?.label ?? 'Saved changes', undo: () => {
      const current = stateRef.current
      const restored = undoMutation(before, next, current)
      const changed = !sameState(current, restored)
      saveState(restored); stateRef.current = restored; setState(restored); schedulePush()
      if (changed) options?.onUndo?.()
      setToast({ message: changed ? 'Undid changes' : 'Kept newer edits. Nothing to undo.' })
    } })
    schedulePush()
  }

  // A signed-out browser must not keep rendering the last signed-in user's
  // workspace out of localStorage. Without this, a shared machine shows the
  // previous person's QA record to whoever signs in next, which is the sort of
  // thing a customer finds in a penetration test.
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    pull().then(r => {
      if (!alive) return
      setSignedIn(r.configured)
    }).catch(() => { if (alive) setSignedIn(false) })
    return () => { alive = false }
  }, [])

  const sync = { status, error, lastAt, syncNow: () => { void doPush() } }

  if (signedIn === null) {
    return <div className="setup-screen"><div className="card setup-card"><p className="muted">Loading your workspace…</p></div></div>
  }
  if (!signedIn) {
    return (
      <Ctx.Provider value={{ state, mutate, sync }}>
        <AuthGate>
          <LockedNotice />
        </AuthGate>
      </Ctx.Provider>
    )
  }

  return <Ctx.Provider value={{ state, mutate, sync }}>{children}{toast && <Toast message={toast.message} onUndo={toast.undo} onClose={() => setToast(null)} />}</Ctx.Provider>
}

/** Shown to a browser that is not signed in but whose workspace needs auth. */
function LockedNotice() {
  return (
    <div className="setup-screen">
      <div className="card setup-card">
        <h2>Sign in to continue</h2>
        <p className="muted">
          This workspace requires an account. Sign in to load your team's scores, transcripts and audit trail.
        </p>
      </div>
    </div>
  )
}

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('store missing')
  return s
}

// Derived helpers
import type { Agent, PromptVersion, TestSession } from './types'

export function currentVersion(versions: PromptVersion[], agentId: string): PromptVersion | undefined {
  const list = versions.filter(v => v.agentId === agentId)
  return (
    list.find(v => v.status === 'testing') ??
    list.find(v => v.status === 'live') ??
    list.sort((a, b) => b.number - a.number)[0]
  )
}

export function avgScores(sessions: TestSession[]): { [paramId: string]: number } {
  const sums: { [id: string]: { total: number; n: number } } = {}
  for (const s of sessions) for (const sc of s.scores) {
    const e = (sums[sc.paramId] ??= { total: 0, n: 0 })
    e.total += sc.value
    e.n += 1
  }
  const out: { [id: string]: number } = {}
  for (const id in sums) out[id] = sums[id].total / sums[id].n
  return out
}

export function composite(avgs: { [id: string]: number }): number | null {
  const vals = Object.values(avgs)
  if (!vals.length) return null
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

/**
 * Heat band for a 1–5 score, as a CSS class rather than a colour.
 * The old version returned a light pastel hex that was painted behind the
 * inherited ink — unreadable in dark mode. The class carries a bg/ink pair
 * defined per theme in styles.css.
 */
export function heatClass(v: number | null | undefined): string {
  if (v == null) return 'h0'
  if (v >= 4.5) return 'h5'
  if (v >= 4.0) return 'h4'
  if (v >= 3.5) return 'h3'
  if (v >= 2.5) return 'h2'
  return 'h1'
}

export function agentLabel(a: Agent): string {
  return `${adapterLabel(a.name)} (${a.type === 'voice' ? 'Voice' : 'Chatbot'} · ${a.direction})`
}

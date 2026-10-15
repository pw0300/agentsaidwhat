import { useCallback, useEffect, useState } from 'react'

/**
 * Client side of the session.
 *
 * The app used to hold a shared access code in localStorage and echo it in a
 * header. That worked for five people and fails the first enterprise security
 * review, because there is no way to say who did what or revoke one person
 * without cutting off everyone. This is a real session cookie, issued by
 * /api/auth, held by the browser and never readable by JavaScript.
 *
 * The cookie is HttpOnly, so nothing here can read or forge it — the token is
 * only ever attached by the browser automatically. For non-browser callers
 * (the CLI, a CI job, a customer's own pipeline) `sessionToken()` returns a
 * bearer token from the same issuer, and the CLI sends it in an
 * Authorization header instead.
 */

export type Role = 'admin' | 'builder' | 'tester' | 'viewer'

export interface SessionUser {
  id: string
  email: string
  name: string
  role: Role
  tenantId: string
  tenantName: string
}

export interface AuthState {
  /** False when the deployment has no store — the app runs local-only. */
  configured: boolean
  /** True when the deployment supports accounts and nobody is signed in. */
  requiresAuth: boolean
  user: SessionUser | null
  loading: boolean
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    configured: false, requiresAuth: false, user: null, loading: true,
  })

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth', { headers: { accept: 'application/json' } })
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) {
        // No auth endpoint on this origin (plain `vite dev`). Stay local.
        setState({ configured: false, requiresAuth: false, user: null, loading: false })
        return
      }
      const data = await res.json() as { configured: boolean; user: SessionUser | null }
      setState({
        configured: data.configured,
        requiresAuth: data.configured && !data.user,
        user: data.user,
        loading: false,
      })
    } catch {
      setState({ configured: false, requiresAuth: false, user: null, loading: false })
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const action = async (body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) return { ok: false, error: data.error ?? `Sign-in failed (${res.status})` }
      await refresh()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'Could not reach the sign-in service.' }
    }
  }

  return {
    ...state,
    refresh,
    signIn: (email: string, password: string) => action({ action: 'signin', email, password }),
    signUp: (email: string, password: string, name: string, orgName: string) =>
      action({ action: 'signup', email, password, name, orgName }),
    signOut: () => action({ action: 'signout' }),
    join: (invite: string, email: string, password: string, name: string) =>
      action({ action: 'join', invite, email, password, name }),
  }
}

/* ---------------- the sign-in screen ---------------- */

export function AuthGate({ children }: { children: React.ReactNode }) {
  const auth = useAuth()

  if (auth.loading) {
    return <div className="setup-screen"><div className="card setup-card"><p className="muted">Checking your session…</p></div></div>
  }
  // Not configured, or signed in: the app is fully usable.
  if (!auth.requiresAuth) return <>{children}</>
  return <SignIn auth={auth} />
}

function SignIn({ auth }: { auth: ReturnType<typeof useAuth> }) {
  const [mode, setMode] = useState<'signin' | 'signup' | 'join'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [orgName, setOrgName] = useState('')
  const [invite, setInvite] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(''); setBusy(true)
    const r = mode === 'signin'
      ? await auth.signIn(email, password)
      : mode === 'signup'
        ? await auth.signUp(email, password, name, orgName)
        : await auth.join(invite, email, password, name)
    if (!r.ok) setErr(r.error ?? 'Something went wrong.')
    setBusy(false)
  }

  return (
    <div className="setup-screen">
      <div className="card setup-card">
        <div className="setup-mark" aria-hidden="true">✓</div>
        <h2>{mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create a workspace' : 'Join a workspace'}</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          {mode === 'signin'
            ? 'Your workspace holds every score, transcript and audit record for your team.'
            : mode === 'signup'
              ? 'This creates your workspace. Invite the rest of your team from Settings once you are in.'
              : 'Use the invite code your workspace admin sent you.'}
        </p>

        <form onSubmit={submit}>
          {mode === 'join' && (
            <>
              <label className="field">Invite code</label>
              <input type="text" value={invite} onChange={e => setInvite(e.target.value)} placeholder="e.g. a1b2c3d4" autoFocus />
            </>
          )}
          <label className="field">Work email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" required
            placeholder="you@company.com" />
          <label className="field">Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} required
            placeholder={mode === 'signin' ? '' : 'At least 10 characters'} />
          {mode !== 'signin' && (
            <>
              <label className="field">Your name</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Shown on every score you give" />
            </>
          )}
          {mode === 'signup' && (
            <>
              <label className="field">Workspace name</label>
              <input type="text" value={orgName} onChange={e => setOrgName(e.target.value)} placeholder="e.g. Acme Contact Centre" />
              <p className="muted">This is your company. Data in one workspace is never visible to another.</p>
            </>
          )}
          {err && <p style={{ color: 'var(--bad)' }}>{err}</p>}
          <button className="btn big" type="submit" disabled={busy} style={{ width: '100%', marginTop: 14 }}>
            {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create workspace' : 'Join'}
          </button>
        </form>

        <div className="row" style={{ justifyContent: 'center', marginTop: 12, gap: 14 }}>
          {mode !== 'signin' && <button className="btn small secondary" onClick={() => { setMode('signin'); setErr('') }}>Sign in instead</button>}
          {mode === 'signin' && <button className="btn small secondary" onClick={() => { setMode('signup'); setErr('') }}>Create a workspace</button>}
          {mode === 'signin' && <button className="btn small secondary" onClick={() => { setMode('join'); setErr('') }}>I have an invite</button>}
        </div>
      </div>
    </div>
  )
}

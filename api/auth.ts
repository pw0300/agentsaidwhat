import { bad, checkDeployment, json, redis, redisEnv } from './_lib'
import { hashPassword, randomId, signClaims, verifyClaims, verifyPassword, type SessionClaims } from './_crypto'

export const config = { runtime: 'edge' }

/**
 * Sign in, sign up, sign out, and "who am I".
 *
 * The one shared access code this app used to have is fine for a team of five
 * and fatal for a customer with a security questionnaire: there is no way to
 * answer "who marked this issue verified", "revoke this person's access", or
 * "prove the QA record has not been edited" when every browser holds the same
 * string. This replaces that with real accounts, a real role, and a
 * server-side session that can be revoked.
 *
 * Deliberately no third-party identity provider. An enterprise buyer will ask
 * for SAML eventually and that belongs at the front door of a hosted product,
 * not baked into a self-hostable deploy. Email + password keeps the deployment
 * self-contained, and the session layer below is the seam a SAML callback
 * replaces later without touching a single call site.
 *
 *   POST /api/auth  { action: 'signup', email, password, name, orgName }
 *   POST /api/auth  { action: 'signin',  email, password }
 *   POST /api/auth  { action: 'signout' }
 *   GET  /api/auth  -> { configured, user, tenants, activeTenant }
 */

// Legacy aq: Redis keys preserve hosted accounts, memberships, invites and sessions.
const USERS_KEY = 'aq:users'          // email -> { id, name, passwordHash, createdAt }
const TENANTS_KEY = 'aq:tenants'      // tenantId -> { id, name, plan, createdAt }
const USER_TENANTS_KEY = 'aq:user-tenants'  // userId -> { tenantId, role }[]
const SESSIONS_KEY = 'aq:sessions'    // sessionId -> { userId, tenantId, role, exp }
const ORG_INVITES_KEY = 'aq:invites'  // inviteCode -> { tenantId, role, email, createdAt }

const SESSION_TTL_S = 60 * 60 * 24 * 14  // 14 days
const MAX_USERS_PER_TENANT = 500

export interface PublicUser {
  id: string
  email: string
  name: string
  role: 'admin' | 'builder' | 'tester' | 'viewer'
  tenantId: string
  tenantName: string
}

const norm = (email: string) => String(email ?? '').trim().toLowerCase()
// Keep aq_session_ cookie names so existing sessions remain signed in.
const cookieName = (tenantId: string) => `aq_session_${tenantId}`

/* ---------------- store helpers ---------------- */

type Dict = Record<string, unknown>

type Membership = { tenantId: string; role: PublicUser['role'] }
const validRole = (value: unknown): PublicUser['role'] => ['admin', 'builder', 'tester', 'viewer'].includes(String(value)) ? value as PublicUser['role'] : 'viewer'
// Old memberships have no recorded role. Fail closed until an administrator migrates them.
function memberships(value: unknown): Membership[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (typeof item === 'string') return [{ tenantId: item, role: 'viewer' as const }]
    if (item && typeof item.tenantId === 'string') return [{ tenantId: item.tenantId, role: validRole(item.role) }]
    return []
  })
}

async function readAll(env: { url: string; token: string }, key: string): Promise<Dict> {
  const raw = (await redis(env, ['GET', key])) as string | null
  if (!raw) return {}
  try { return JSON.parse(raw) as Dict } catch { return {} }
}

async function writeAll(env: { url: string; token: string }, key: string, value: Dict): Promise<void> {
  await redis(env, ['SET', key, JSON.stringify(value)])
}

/**
 * Append to a JSON document under a key without losing concurrent writes.
 *
 * The same lost-update problem the client-side merge solves, on the server.
 * Every user record lives in one hash so a signup can add to the list without
 * two simultaneous signups clobbering each other.
 */
async function appendToMap(env: { url: string; token: string }, key: string, id: string, value: unknown): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = (await redis(env, ['GET', `${key}:v`])) as string | null
    const version = Number(cur ?? 0) || 0
    const doc = await readAll(env, key)
    doc[id] = value
    const payload = JSON.stringify(doc)
    const ok = await redis(env, [
      'EVAL',
      `if (redis.call('GET', KEYS[2]) or '0') == ARGV[1] then
         redis.call('SET', KEYS[1], ARGV[2])
         redis.call('SET', KEYS[2], ARGV[3])
         return 1
       end
       return 0`,
      '2', key, `${key}:v`, String(version), payload, String(version + 1),
    ])
    if (ok === 1) return
  }
  throw new Error('Store is busy, try again.')
}

/* ---------------- sessions ---------------- */

export async function currentUser(req: Request): Promise<PublicUser | null> {
  const env = redisEnv()
  const secret = process.env.QA_SESSION_SECRET
  if (!env || !secret) return null

  // The tenant cookie name carries the tenant, so the browser is walked rather
  // than the tenant guessed. A user in two tenants holds two cookies and picks.
  const cookies = parseCookies(req.headers.get('cookie') ?? '')
  for (const [name, value] of Object.entries(cookies)) {
    if (!name.startsWith('aq_session_')) continue
    const claims = await verifyClaims(value, secret, Math.floor(Date.now() / 1000))
    if (!claims) continue
    const sessions = await readAll(env, SESSIONS_KEY)
    const live = sessions[claims.sid] as (SessionClaims & { userId: string; email: string; name: string }) | undefined
    if (!live) continue                                  // revoked
    if (live.exp * 1000 < Date.now()) continue           // expired
    const users = await readAll(env, USERS_KEY)
    const u = users[norm(live.email)] as { id: string; name: string; email: string } | undefined
    if (!u) continue
    const tenants = await readAll(env, TENANTS_KEY)
    const membership = memberships((await readAll(env, USER_TENANTS_KEY))[u.id]).find(m => m.tenantId === claims.tid)
    if (!membership) continue
    const t = tenants[claims.tid] as { id: string; name: string } | undefined
    return {
      id: u.id, email: u.email, name: u.name,
      role: membership.role, tenantId: claims.tid, tenantName: t?.name ?? 'Workspace',
    }
  }
  return null
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function sessionCookie(user: PublicUser, token: string): string {
  // HttpOnly because nothing in the client should ever read this token; SameSite
  //=Lax so a link from Slack or a Jira ticket can complete a sign-in but a
  // cross-site POST cannot ride the session. Secure is required in production
  // and omitted on localhost, where it would make the cookie un-sendable.
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${cookieName(user.tenantId)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_S}${secure}`
}

/* ---------------- password policy ---------------- */

function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return 'Use at least 10 characters.'
  // Composition rules push people toward "Password1!" and away from passphrases.
  // Length plus a blocklist is the recommendation that actually holds up, so
  // this checks only length and the handful of passwords that show up in every
  // credential-stuffing list.
  const weak = ['password', '12345678', 'qwertyuiop', 'letmein123', 'admin123', 'welcome1']
  if (weak.some(w => pw.toLowerCase().includes(w))) return 'That password is too common.'
  return null
}

/* ---------------- handler ---------------- */

export default async function handler(req: Request): Promise<Response> {
  const denied = checkDeployment(req)
  if (denied) return denied

  const env = redisEnv()
  const secret = process.env.QA_SESSION_SECRET
  if (!env) return json({ configured: false, user: null })
  if (!secret) {
    return json({ error: 'This deployment has no QA_SESSION_SECRET set, so sign-in is disabled. Generate one with `openssl rand -hex 32`.' }, 503)
  }

  try {
    if (req.method === 'GET') {
      const user = await currentUser(req)
      return json({ configured: true, user })
    }
    if (req.method !== 'POST') return bad('GET or POST only', 405)

    const raw = await req.text()
    if (raw.length > 100_000) return bad('Request too large.', 413)
    const body = JSON.parse(raw) as { action?: string; email?: string; password?: string; name?: string; orgName?: string; role?: string; invite?: string; tenantId?: string }
    const action = body.action ?? ''

    /* ---- sign out: drop the session record, which is what actually revokes ---- */
    if (action === 'signout') {
      const user = await currentUser(req)
      if (user) {
        const sessions = await readAll(env, SESSIONS_KEY)
        for (const [sid, s] of Object.entries(sessions)) {
          if ((s as { userId: string }).userId === user.id) delete sessions[sid]
        }
        await writeAll(env, SESSIONS_KEY, sessions)
      }
      return json({ ok: true }, 200, {
        'set-cookie': `${cookieName(user?.tenantId ?? '')}=; Path=/; HttpOnly; Max-Age=0`,
      })
    }

    const email = norm(body.email ?? '')
    const password = String(body.password ?? '')

    /* ---- sign up ---- */
    if (action === 'signup') {
      if (!email || !email.includes('@')) return bad('Enter a valid work email.')
      const problem = passwordProblem(password)
      if (problem) return bad(problem)

      const users = await readAll(env, USERS_KEY)
      if (users[email]) return bad('An account with that email already exists. Sign in instead.', 409)

      const userId = randomId(8)
      const tenantId = randomId(8)
      const orgName = String(body.orgName ?? '').trim() || `${email.split('@')[1]}'s workspace`

      await writeAll(env, TENANTS_KEY, {
        ...(await readAll(env, TENANTS_KEY)),
        [tenantId]: { id: tenantId, name: orgName, plan: 'pilot', createdAt: new Date().toISOString() },
      })
      await appendToMap(env, USERS_KEY, email, {
        id: userId, email, name: String(body.name ?? '').trim() || email.split('@')[0],
        passwordHash: await hashPassword(password), createdAt: new Date().toISOString(),
      })
      await appendToMap(env, USER_TENANTS_KEY, userId, [{ tenantId, role: 'admin' }])

      return issueSession(env, secret, { id: userId, name: String(body.name ?? '').trim() || email.split('@')[0], email }, tenantId, 'admin')
    }

    /* ---- sign in ---- */
    if (action === 'signin') {
      const users = await readAll(env, USERS_KEY)
      const u = users[email] as { id: string; name: string; email: string; passwordHash: string } | undefined
      // Same message and a comparable amount of work whether the account exists
      // or not, so the endpoint cannot be used to enumerate who has an account.
      if (!u) {
        await hashPassword(password)
        return bad('Email or password is wrong.', 401)
      }
      if (!(await verifyPassword(password, u.passwordHash))) return bad('Email or password is wrong.', 401)

      const memberList = memberships((await readAll(env, USER_TENANTS_KEY))[u.id])
      const tenants = await readAll(env, TENANTS_KEY)
      const tenantIds = memberList.filter(m => tenants[m.tenantId])
      if (tenantIds.length === 0) return bad('This account is not a member of any workspace.', 403)
      return issueSession(env, secret, u, tenantIds[0].tenantId, tenantIds[0].role)
    }

    /* ---- switch workspace ---- */
    if (action === 'switch-tenant') {
      const user = await currentUser(req)
      if (!user) return bad('Not signed in.', 401)
      const membership = memberships((await readAll(env, USER_TENANTS_KEY))[user.id]).find(m => m.tenantId === String(body.tenantId))
      if (!membership) return bad('Not your workspace.', 403)
      return issueSession(env, secret, { id: user.id, name: user.name, email: user.email }, membership.tenantId, membership.role)
    }

    /* ---- accept an invite ---- */
    if (action === 'join') {
      const invites = await readAll(env, ORG_INVITES_KEY)
      const invite = invites[String(body.invite ?? '')] as { tenantId: string; role: string; email: string } | undefined
      if (!invite) return bad('That invite code is not valid or has been used.', 404)

      const users = await readAll(env, USERS_KEY)
      let u = users[email] as { id: string; name: string; email: string; passwordHash: string } | undefined
      if (!u) {
        const problem = passwordProblem(password)
        if (problem) return bad(problem)
        const userId = randomId(8)
        u = { id: userId, name: String(body.name ?? '').trim() || email.split('@')[0], email, passwordHash: await hashPassword(password) }
        await appendToMap(env, USERS_KEY, email, { ...u, createdAt: new Date().toISOString() })
      } else if (password && !(await verifyPassword(password, u.passwordHash))) {
        return bad('That email already has a password set. Sign in, then open Settings to switch workspace.', 409)
      }

      const tenants = await readAll(env, TENANTS_KEY)
      // Count members by walking the membership index, not a list on the
      // tenant document — the index is the thing that is actually kept
      // correct, and a cap computed off a stale copy is not a cap.
      const userTenants = await readAll(env, USER_TENANTS_KEY)
      const count = Object.values(userTenants)
        .filter((list: unknown) => memberships(list).some(m => m.tenantId === invite.tenantId)).length
      if (count >= MAX_USERS_PER_TENANT) return bad('That workspace is full.', 409)

      const list = memberships((await readAll(env, USER_TENANTS_KEY))[u.id])
      const role = list.find(m => m.tenantId === invite.tenantId)?.role ?? validRole(invite.role)
      await writeAll(env, USER_TENANTS_KEY, { ...(await readAll(env, USER_TENANTS_KEY)), [u.id]: [...list.filter(m => m.tenantId !== invite.tenantId), { tenantId: invite.tenantId, role }] })
      delete invites[String(body.invite)]
      await writeAll(env, ORG_INVITES_KEY, invites)

      const t = tenants[invite.tenantId] as { name: string } | undefined
      return issueSession(env, secret, u, invite.tenantId, role)
    }

    return bad(`Unknown action: ${action || '(none)'}`)
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Sign-in failed.', 500)
  }
}

/* ---------------- session issuance ---------------- */

async function issueSession(
  env: { url: string; token: string },
  secret: string,
  user: { id: string; name: string; email: string },
  tenantId: string,
  role: PublicUser['role'],
): Promise<Response> {
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + SESSION_TTL_S
  const claims: SessionClaims = { sid: randomId(12), tid: tenantId, uid: user.email, role, iat, exp }
  const token = await signClaims(claims, secret)

  const sessions = await readAll(env, SESSIONS_KEY)
  sessions[claims.sid] = { userId: user.id, email: user.email, name: user.name, tid: tenantId, tenantId, role, exp }
  await writeAll(env, SESSIONS_KEY, sessions)

  const tenants = await readAll(env, TENANTS_KEY)
  const t = tenants[tenantId] as { name: string } | undefined
  const publicUser: PublicUser = {
    id: user.id, email: user.email, name: user.name, role, tenantId,
    tenantName: t?.name ?? 'Workspace',
  }
  const res = json({ ok: true, user: publicUser })
  res.headers.append('set-cookie', sessionCookie(publicUser, token))
  return res
}

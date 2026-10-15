import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSync } from 'esbuild'

buildSync({ entryPoints: ['api/auth.ts', 'api/anthropic.ts', 'api/_lib.ts'], bundle: true, platform: 'node', format: 'esm', outdir: 'node_modules/.tmp/hardening' })
const { checkDeployment } = await import('../node_modules/.tmp/hardening/_lib.js')
const { default: anthropic } = await import('../node_modules/.tmp/hardening/anthropic.js')
const { default: auth } = await import('../node_modules/.tmp/hardening/auth.js')

async function hosted(fn) {
  const saved = { ...process.env }, originalFetch = globalThis.fetch
  const data = new Map(), outbound = []
  Object.assign(process.env, { KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 'test', QA_SESSION_SECRET: 'test-secret', ANTHROPIC_API_KEY: 'test-key' })
  delete process.env.QA_ACCESS_CODE; delete process.env.QA_ALLOWED_IPS
  globalThis.fetch = async (url, options) => {
    if (url === 'https://api.anthropic.com/v1/messages') { outbound.push(JSON.parse(options.body)); return Response.json({ content: [] }) }
    assert.equal(url, 'https://redis.test')
    const cmd = JSON.parse(options.body)
    let result = null
    if (cmd[0] === 'GET') result = data.get(cmd[1]) ?? null
    else if (cmd[0] === 'SET') { data.set(cmd[1], cmd[2]); result = 'OK' }
    else if (cmd[0] === 'EVAL') {
      const n = Number(cmd[2]), keys = cmd.slice(3, 3 + n), args = cmd.slice(3 + n)
      if (n === 2) {
        if (String(data.get(keys[1]) ?? '0') === args[0]) { data.set(keys[0], args[1]); data.set(keys[1], args[2]); result = 1 } else result = 0
      } else if (n === 1) {
        const next = JSON.parse(args[0]), old = JSON.parse(data.get(keys[0]) ?? 'null')
        const used = old && old.resetsAt === next.resetsAt ? old.used : 0
        if (used + 1 > next.cap) result = 0
        else { data.set(keys[0], JSON.stringify({ ...next, used: used + 1 })); result = 1 }
      } else throw new Error('Unexpected script')
    } else if (['LPUSH', 'LTRIM'].includes(cmd[0])) result = 1
    else throw new Error('Unexpected Redis command')
    return Response.json({ result })
  }
  const put = (key, value) => data.set(key, JSON.stringify(value))
  const get = key => JSON.parse(data.get(key) ?? '{}')
  const call = (body, cookie = '') => auth(new Request('https://qa.test/api/auth', { method: 'POST', headers: { cookie }, body: JSON.stringify(body) }))
  try { await fn({ data, put, get, call, outbound }) } finally { globalThis.fetch = originalFetch; for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved) }
}

test('workspace creator and invited roles persist through sign-in and tenant switch', () => hosted(async ({ put, get, call }) => {
  const password = 'a-long-random-passphrase'
  const owner = await call({ action: 'signup', email: 'owner@example.com', password })
  assert.equal(owner.status, 200)
  const ownerBody = await owner.json()
  assert.equal(ownerBody.user.role, 'admin')
  assert.ok(owner.headers.get('set-cookie'))
  const tid = ownerBody.user.tenantId
  for (const role of ['viewer', 'tester', 'builder']) {
    put('aq:invites', { code: { tenantId: tid, role } })
    const email = `${role}@example.com`
    const joined = await call({ action: 'join', invite: 'code', email, password })
    assert.equal((await joined.json()).user.role, role)
    const signin = await call({ action: 'signin', email, password })
    const cookie = signin.headers.get('set-cookie')?.split(';')[0]
    assert.equal((await signin.json()).user.role, role)
    assert.ok(cookie)
    const switched = await call({ action: 'switch-tenant', tenantId: tid }, cookie)
    assert.equal(switched.status, 200)
    assert.equal((await switched.json()).user.role, role)
  }
  assert.equal(Object.keys(get('aq:user-tenants')).length, 4)
}))


test('legacy membership without a stored role cannot become admin', () => hosted(async ({ put, get, call }) => {
  const password = 'a-long-random-passphrase'
  const initial = await (await call({ action: 'signup', email: 'legacy@example.com', password })).json()
  put('aq:user-tenants', { [initial.user.id]: [initial.user.tenantId] })
  const signin = await call({ action: 'signin', email: 'legacy@example.com', password })
  assert.equal((await signin.json()).user.role, 'viewer')
}))


const modelRequest = (messages = [{ role: 'user', content: 'hello' }], cookie = '') => new Request('https://qa.test/api/anthropic', { method: 'POST', headers: { cookie }, body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 20, messages }) })

test('model relay requires authentication once accounts exist', () => hosted(async ({ put, outbound }) => {
  put('aq:users', { 'owner@example.com': { id: 'u' } })
  const response = await anthropic(modelRequest())
  assert.equal(response.status, 401)
  assert.equal(outbound.length, 0)
}))

test('anonymous model relay spends budget and redacts all message text forms', () => hosted(async ({ outbound }) => {
  process.env.QA_MONTHLY_CALL_CAP = '1'
  const response = await anthropic(modelRequest([
    { role: 'user', content: [{ type: 'text', text: 'Mera phone 9876543210' }] },
    { role: 'assistant', content: 'asha@okaxis, DOB 12/05/1990' },
  ]))
  assert.equal(response.status, 200)
  assert.ok(!JSON.stringify(outbound).includes('9876543210'))
  assert.ok(!JSON.stringify(outbound).includes('asha@okaxis'))
  assert.equal((await anthropic(modelRequest())).status, 429)
  assert.equal(outbound.length, 1)
}))

test('local model budget applies without Redis, including a zero cap', () => hosted(async ({ outbound }) => {
  delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN
  process.env.QA_MONTHLY_CALL_CAP = '0'
  assert.equal((await anthropic(modelRequest())).status, 429)
  assert.equal(outbound.length, 0)
  process.env.QA_MONTHLY_CALL_CAP = '1'
  assert.equal((await anthropic(modelRequest())).status, 200)
  assert.equal((await anthropic(modelRequest())).status, 429)
  assert.equal(outbound.length, 1)
}))

test('signed-in model relay enforces workspace budget and viewer permissions', () => hosted(async ({ put, call, outbound }) => {
  const password = 'a-long-random-passphrase'
  const owner = await call({ action: 'signup', email: 'owner@example.com', password })
  const ownerCookie = owner.headers.get('set-cookie').split(';')[0]
  const tid = (await owner.json()).user.tenantId
  process.env.QA_MONTHLY_CALL_CAP = '1'
  assert.equal((await anthropic(modelRequest(undefined, ownerCookie))).status, 200)
  assert.equal((await anthropic(modelRequest(undefined, ownerCookie))).status, 429)
  put('aq:invites', { code: { tenantId: tid, role: 'viewer' } })
  const joined = await call({ action: 'join', invite: 'code', email: 'viewer@example.com', password })
  const viewerCookie = joined.headers.get('set-cookie').split(';')[0]
  assert.equal((await anthropic(modelRequest(undefined, viewerCookie))).status, 403)
  assert.equal(outbound.length, 1)
}))

test('monthly model budget resets and uses the configured cap', () => hosted(async ({ put, outbound }) => {
  process.env.QA_MONTHLY_CALL_CAP = '1'
  put('aq:t_default:budget', { used: 99, cap: 99, resetsAt: '2020-01-01' })
  assert.equal((await anthropic(modelRequest())).status, 200)
  assert.equal((await anthropic(modelRequest())).status, 429)
  assert.equal(outbound.length, 1)
}))



test('IPv4 allowlist checks CIDR masks and ignores malformed entries', () => hosted(async () => {
  process.env.QA_ACCESS_CODE = 'restricted'
  const allowed = (ip, list) => {
    process.env.QA_ALLOWED_IPS = list
    return checkDeployment(new Request('https://qa.test', { headers: { 'x-forwarded-for': ip } })) === null
  }
  assert.equal(allowed('192.168.1.42', '192.168.1.0/24'), true)
  assert.equal(allowed('192.168.2.42', '192.168.1.0/24'), false)
  assert.equal(allowed('10.20.4.8', '10.0.0.0/8'), true)
  assert.equal(allowed('192.168.1.129', '192.168.1.128/25'), true)
  assert.equal(allowed('192.168.1.127', '192.168.1.128/25'), false)
  assert.equal(allowed('10.1.2.3', '10.1.2.3/32'), true)
  assert.equal(allowed('10.1.2.4', '10.1.2.3/32'), false)
  assert.equal(allowed('8.8.8.8', '0.0.0.0/0'), true)
  for (const list of ['10/8', '10.1.2.3/33', '10.1.2.3/-1', '10.1.2.3/no', '10.1.2.999/24', '10.1.2.3/24/0', 'garbage']) assert.equal(allowed('10.1.2.3', list), false, list)
  assert.equal(allowed('garbage', 'garbage'), false)
  assert.equal(allowed('10.1.2.3', '10.1.2.3'), true)
}))

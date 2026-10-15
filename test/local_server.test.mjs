/**
 * The local server, exercised over real HTTP against a real SQLite file.
 *
 * Not mocked: it starts the server on a free port in a temp directory and talks
 * to it with fetch, because the bugs worth catching here are the ones between
 * the pieces -- a merge that loses a second tester's session, an audio file that
 * plays but cannot seek, a restore that silently does nothing.
 *
 * Needs `npm run build` first (it imports dist-server/lib.mjs).
 */
import assert from 'node:assert/strict'
import { test as t, after, before } from 'node:test'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../server/local.mjs'

let srv, base, home

before(async () => {
  home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'aq-local-'))
  srv = await start({ port: 0, home, quiet: true })
  base = `http://127.0.0.1:${srv.port}`
})
after(async () => {
  await srv.close()
  rmSync(home, { recursive: true, force: true })
})

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const workspace = (over = {}) => ({
  projects: [{ id: 'p1', name: 'Demo' }],
  agents: [{ id: 'a1', projectId: 'p1', name: 'Sales', type: 'voice', direction: 'outbound', useCases: ['Price objection'] }],
  versions: [{ id: 'v1', agentId: 'a1', number: 1, promptText: 'Be helpful.', changelog: '', status: 'testing', createdAt: '2026-10-01', decisions: [] }],
  sessions: [], issues: [], rubric: [{ id: 'accuracy', name: 'Accuracy', question: '', appliesTo: ['voice'], anchors: {} }],
  testers: ['Asha'], batches: [], calls: [],
  ...over,
})

t('health reports local mode and needs no keys', async () => {
  const h = await (await fetch(base + '/api/health')).json()
  assert.equal(h.mode, 'local')
  assert.equal(h.store, true)
  assert.equal(h.ready, true)
})

t('auth reports unconfigured, so the UI never shows a sign-in wall', async () => {
  const a = await (await fetch(base + '/api/auth')).json()
  assert.equal(a.configured, false)
})

t('an empty workspace reads as configured with no state', async () => {
  const r = await (await fetch(base + '/api/state')).json()
  assert.equal(r.configured, true)
  assert.equal(r.state, null)
  assert.equal(r.rev, 0)
})

t('two testers saving from the same base both keep their sessions', async () => {
  const first = await (await post('/api/state', { base: {}, local: workspace() })).json()
  assert.equal(first.rev, 1)
  const shared = first.state

  const s = (id, tester) => ({ id, agentId: 'a1', versionId: 'v1', tester, useCase: 'Price objection', transcript: 'x', recordingName: '', scores: [{ paramId: 'accuracy', paramName: 'Accuracy', value: 4 }], comments: '', createdAt: '2026-10-07', observations: [] })

  // Both start from rev 1 and add a different session. A last-writer-wins store
  // would drop Asha's; the three-way merge must keep both.
  const a = await (await post('/api/state', { base: shared, local: { ...shared, sessions: [s('s-asha', 'Asha')] } })).json()
  const b = await (await post('/api/state', { base: shared, local: { ...shared, sessions: [s('s-ravi', 'Ravi')] } })).json()
  assert.equal(a.rev, 2)
  assert.equal(b.rev, 3)
  const ids = b.state.sessions.map(x => x.id).sort()
  assert.deepEqual(ids, ['s-asha', 's-ravi'])
})

t('the workspace survives a restart, because it is on disk', async () => {
  await srv.close()
  srv = await start({ port: 0, home, quiet: true })
  base = `http://127.0.0.1:${srv.port}`
  const r = await (await fetch(base + '/api/state')).json()
  assert.equal(r.rev, 3)
  assert.equal(r.state.sessions.length, 2)
})

t('every revision is kept and an old one can be restored', async () => {
  const h = await (await fetch(base + '/api/history')).json()
  assert.ok(h.revisions.length >= 3)
  const r = await (await post('/api/history', { rev: 1 })).json()
  assert.equal(r.restored, 1)
  const now = await (await fetch(base + '/api/state')).json()
  assert.equal(now.state.sessions.length, 0, 'rev 1 had no sessions')
  // Restoring is itself a new revision, so the restore can be undone too.
  assert.equal(now.rev, r.rev)
  const undo = await (await post('/api/history', { rev: 3 })).json()
  assert.equal(undo.restored, 3)
  assert.equal((await (await fetch(base + '/api/state')).json()).state.sessions.length, 2)
})

let audioId
t('audio uploads, lands on disk, and is listed', async () => {
  const bytes = new Uint8Array(4096).map((_, i) => i % 251)
  bytes.set(Buffer.from('RIFF0000WAVE'), 0)
  const r = await fetch(`${base}/api/audio?name=${encodeURIComponent('call 1.wav')}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: bytes })
  assert.equal(r.status, 201)
  const j = await r.json()
  audioId = j.id
  assert.equal(j.bytes, 4096)
  assert.ok(existsSync(join(home, 'audio', `${audioId}.wav`)))
  const list = await (await fetch(base + '/api/audio')).json()
  assert.ok(list.files.some(f => f.id === audioId))
})

t('audio supports range requests, so the player can seek', async () => {
  const r = await fetch(`${base}/api/audio/${audioId}`, { headers: { range: 'bytes=100-199' } })
  assert.equal(r.status, 206)
  assert.equal(r.headers.get('content-range'), 'bytes 100-199/4096')
  const buf = new Uint8Array(await r.arrayBuffer())
  assert.equal(buf.length, 100)
  assert.equal(buf[0], 100 % 251)
})

t('an out-of-range seek is refused, not answered with the wrong bytes', async () => {
  const r = await fetch(`${base}/api/audio/${audioId}`, { headers: { range: 'bytes=9000-9999' } })
  assert.equal(r.status, 416)
})

t('a non-audio upload is refused with the list of accepted types', async () => {
  const r = await fetch(`${base}/api/audio?name=notes.txt`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'hello' })
  assert.equal(r.status, 415)
  assert.match((await r.json()).error, /\.mp3/)
})

t('deleting audio removes the file from disk', async () => {
  const r = await fetch(`${base}/api/audio/${audioId}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } })
  assert.equal(r.status, 200)
  assert.equal(readdirSync(join(home, 'audio')).length, 0)
})

t('the gate runs locally on the same measurement as hosted, and says it is unsigned', async () => {
  const r = await fetch(`${base}/api/gate?agent=a1`)
  const j = await r.json()
  assert.ok(['pass', 'fail', 'inconclusive', 'disabled'].includes(j.outcome))
  assert.equal(j.receipt.signed, false)
  assert.equal(j.receipt.measured.humanSessions, 2)
  assert.match(j.receipt.promptHash, /^[0-9a-f]{64}$/)
})

t('the gate on an unknown agent is a 404, not a pass', async () => {
  const r = await fetch(`${base}/api/gate?agent=nope`)
  assert.equal(r.status, 404)
})

t('model endpoints without a key say so instead of failing obscurely', async () => {
  if (process.env.ANTHROPIC_API_KEY) return
  const r = await post('/api/simulate', { prompt: 'x' })
  assert.equal(r.status, 503)
  assert.match((await r.json()).error, /ANTHROPIC_API_KEY/)
})

t('path traversal on static files is refused', async () => {
  const r = await fetch(`${base}/..%2F..%2Fpackage.json`)
  assert.notEqual((await r.text()).includes('"devDependencies"'), true)
})

t('the audit log records what happened', async () => {
  const j = await (await fetch(base + '/api/audit')).json()
  const actions = j.events.map(e => e.action)
  assert.ok(actions.includes('audio.upload'))
  assert.ok(actions.includes('workspace.restore'))
  assert.ok(actions.includes('gate.evaluate'))
})

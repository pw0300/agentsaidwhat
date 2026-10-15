import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHandler, openStore, loadLib } from '../server/local.mjs'

async function local(fn, host) {
  const root = mkdtempSync(join(tmpdir(), 'aq-hardening-'))
  const dist = join(root, 'dist')
  mkdirSync(dist); mkdirSync(join(root, 'dist-private'))
  writeFileSync(join(dist, 'index.html'), 'UI')
  writeFileSync(join(root, 'dist-private', 'canary.txt'), 'PRIVATE')
  const store = openStore(join(root, 'data'))
  const server = createServer(makeHandler({ store, lib: await loadLib(), distDir: dist, host }))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try { await fn(base, store) } finally {
    await new Promise(r => server.close(r)); store.db.close()
    rmSync(root, { recursive: true, force: true })
  }
}
const hostStatus = (base, host) => new Promise((resolve, reject) => {
  const req = request(base + '/api/health', { headers: { host } }, res => { res.resume(); resolve(res.statusCode) })
  req.on('error', reject); req.end()
})
const post = (base, body, headers = {}) => fetch(base + '/api/state', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
})

test('static encoded slash cannot reach a dist sibling', () => local(async base => {
  const res = await fetch(base + '/..%2fdist-private%2fcanary.txt')
  assert.equal(res.status, 403)
  assert.ok(!(await res.text()).includes('PRIVATE'))
}))


test('request guard rejects foreign origins, hostile hosts and plain text writes', () => local(async base => {
  assert.equal((await post(base, { local: {} }, { origin: 'https://other.example', 'content-type': 'text/plain' })).status, 403)
  assert.equal(await hostStatus(base, 'attacker.example'), 403)
  assert.equal((await post(base, { local: {} }, { origin: 'null' })).status, 403)
  assert.equal((await post(base, { local: {} }, { origin: base, 'content-type': 'text/plain' })).status, 403)
  assert.equal((await post(base, { local: {} }, { origin: base })).status, 200)
  assert.equal(await hostStatus(base, '[::1]:5199'), 200)
}))

test('request guard accepts the configured host', () => local(async base => {
  assert.equal(await hostStatus(base, 'qa.lan:5199'), 200)
}, 'qa.lan'))


test('local state writes redact transcripts before persistence and history', () => local(async (base, store) => {
  const response = await post(base, { local: { sessions: [{ id: 'pii', transcript: 'Call 9876543210 or asha@example.com' }] } })
  const body = await response.json()
  assert.ok(!JSON.stringify(body).includes('9876543210'))
  assert.ok(!JSON.stringify(store.read()).includes('asha@example.com'))
  assert.ok(!store.q.histGet.get(body.rev).doc.includes('9876543210'))
}))


test('audio upload validates magic bytes and sanitizes display names', () => local(async base => {
  const upload = (name, bytes, type = 'application/octet-stream') => fetch(`${base}/api/audio?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': type }, body: bytes })
  assert.equal((await upload('fake.wav', 'not audio')).status, 415)
  assert.equal((await upload('fake.mp3', Buffer.from([0xff, 0xf1, 0x50, 0x80]))).status, 415)
  const samples = {
    wav: Buffer.from('RIFF0000WAVEfmt '), mp3: Buffer.from('ID3'),
    ogg: Buffer.from('OggS'), flac: Buffer.from('fLaC'), m4a: Buffer.from('0000ftypM4A '),
    webm: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), aac: Buffer.from([0xff, 0xf1, 0x50, 0x80]),
  }
  for (const [ext, bytes] of Object.entries(samples)) assert.equal((await upload(`call.${ext}`, bytes)).status, 201, ext)
  assert.equal((await upload('call.wav', samples.wav, 'audio/mpeg')).status, 415)
  const response = await upload('../private/<call>\u0000.wav', samples.wav)
  assert.equal(response.status, 201)
  assert.equal((await response.json()).name, 'call.wav')
}))

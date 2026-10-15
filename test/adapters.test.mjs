import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { startReferenceAgent } from '../examples/reference-agent/server.mjs'
import { capabilityCheck, validateTurn } from '../node_modules/.tmp/_adapter.mjs'
import { timingCheck, scoreCall } from '../node_modules/.tmp/_run.mjs'
import { loadDrivenPack, driveCaller } from '../node_modules/.tmp/_caller-driver.mjs'
import { httpAdapter, wsAdapter } from '../node_modules/.tmp/_generic-adapters.mjs'
import { vapiAdapter } from '../node_modules/.tmp/_vapi.mjs'
import { retellAdapter } from '../node_modules/.tmp/_retell.mjs'
import { pipecatAdapter } from '../node_modules/.tmp/_pipecat.mjs'
import { livekitAdapter } from '../node_modules/.tmp/_livekit.mjs'

const scenario = { id: 'support', name: 'Support', persona: 'Order customer', goal: 'Ask for support', successCriteria: ['Ask for order ID.'], language: 'en', tags: [], callerTurns: ['Where is my order?', 'Mera order kya hai?', 'Thanks, bye'] }
const pack = { version: 1, id: 'support-pack', name: 'Support pack', scenarios: [scenario, { ...scenario, id: 'second' }] }
const session = { id: 's', scenarioId: 'support', version: 'v3' }
const noKeys = () => { const env = { ...process.env }; for (const key of ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY']) delete env[key]; return env }
async function cli(args, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['cli.mjs', ...args], { cwd: new URL('..', import.meta.url), env: { ...noKeys(), AGENT_QA_HOME: home } })
    let stdout = '', stderr = ''
    child.stdout.on('data', x => { stdout += x }); child.stderr.on('data', x => { stderr += x })
    child.once('error', reject)
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI test timed out.')) }, 30_000)
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

test('capability gating never invokes timing measurement without timing', () => {
  const adapter = { capabilities: new Set(['text']) }
  assert.equal(capabilityCheck(adapter, ['timing'], 'Latency', () => { throw new Error('Must not run') }).outcome, 'NOT MEASURED')
  assert.equal(timingCheck(adapter, [{ role: 'agent', text: 'hi', startMs: 0, endMs: 5, firstByteMs: 1 }]).outcome, 'NOT MEASURED')
})
test('advertised timing still requires every evidence field', () => {
  const adapter = { capabilities: new Set(['text', 'timing']) }
  assert.equal(timingCheck(adapter, [{ role: 'agent', text: 'hi' }]).outcome, 'NOT MEASURED')
  assert.equal(timingCheck(adapter, []).outcome, 'NOT MEASURED')
  assert.equal(timingCheck(adapter, [{ role: 'agent', text: 'hi', startMs: 0, endMs: 5, firstByteMs: 1 }]).outcome, 'PASS')
  assert.throws(() => validateTurn({ text: 'hi', startMs: 10, endMs: 5 }), /timing order/)
  assert.throws(() => validateTurn({ text: 'hi', startMs: 0, endMs: 5, firstByteMs: 6 }), /first byte/)
})
test('loader retains callerTurns and rejects malformed extension fields', () => {
  assert.deepEqual(loadDrivenPack(JSON.stringify(pack), 'pack.yaml').scenarios[0].callerTurns, scenario.callerTurns)
  assert.throws(() => loadDrivenPack(JSON.stringify({ ...pack, scenarios: [{ ...scenario, callerTurns: [4] }] }), 'bad.yaml'), /callerTurns/)
})
test('simulated caller uses supported provider and judge scores actual agent replies', async () => {
  const originalFetch = globalThis.fetch
  const names = ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY']
  const keys = Object.fromEntries(names.map(key => [key, process.env[key]]))
  for (const key of names) delete process.env[key]
  process.env.OPENAI_API_KEY = 'test-key-with-more-than-twenty-characters'
  let callerRequests = 0, closed = false
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions')
    const body = JSON.parse(options.body)
    const isCaller = body.messages[0].content.includes('playing the CALLER')
    if (isCaller) {
      assert.match(body.messages[0].content, /Goal: Ask for support/)
      return Response.json({ choices: [{ message: { content: callerRequests++ ? '[DONE]' : 'Where is my order?' } }] })
    }
    assert.match(body.messages[1].content, /Agent: Please share an order ID/)
    return Response.json({ model: 'test', choices: [{ message: { content: '{"verdict":"pass","reason":"Asked for order ID","layer":"prompt","flags":[]}' } }] })
  }
  const adapter = { capabilities: new Set(['text']), async open() {}, async send() { return { text: 'Please share an order ID' } }, async close() { closed = true } }
  try {
    const call = await driveCaller(adapter, { ...scenario, callerTurns: undefined }, 'v3', 'simulated')
    assert.equal(call.mode, 'simulated'); assert.equal(call.turns.length, 2); assert.equal(call.hitTurnLimit, false); assert.equal(closed, true)
    const checks = await scoreCall(adapter, scenario, call.turns, call.transcript)
    assert.equal(checks.find(c => c.name === 'Goal and criteria').outcome, 'PASS')
    assert.equal(checks.find(c => c.name === 'Timing').outcome, 'NOT MEASURED')
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: 'I cannot judge.' } }] })
    const abstention = await scoreCall(adapter, scenario, call.turns, call.transcript)
    assert.equal(abstention.find(c => c.name === 'Goal and criteria').outcome, 'NOT MEASURED')
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(keys)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
})

for (const protocol of ['ws', 'http']) test(`${protocol}: CLI runs every scenario and persists pinned sessions in SQLite`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'saidwhat-adapter-'))
  const agent = await startReferenceAgent(0)
  try {
    const file = join(home, 'pack.yaml'); await writeFile(file, JSON.stringify(pack))
    const result = await cli(['run', file, '--agent', `${protocol}://127.0.0.1:${agent.port}${protocol === 'http' ? '/turn' : ''}`, '--version', 'v3', '--mode', 'simulated', '--json'], home)
    assert.equal(result.code, 2, result.stderr)
    assert.equal((result.stderr.match(/No LLM key/g) ?? []).length, 1)
    const output = JSON.parse(result.stdout)
    assert.equal(output.results.length, 2)
    assert.equal(output.results[0].turns.length, 6)
    assert.match(output.results[0].transcript, /Ji, order/)
    assert.equal(output.results[0].checks.find(c => c.name === 'Timing').outcome, 'NOT MEASURED')
    assert.equal(output.results[0].checks.find(c => c.name === 'Goal and criteria').outcome, 'NOT MEASURED')
    // Assert against the legacy filename used by existing local workspaces.
    const db = new DatabaseSync(join(home, 'agent-qa.db'))
    try {
      const state = JSON.parse(db.prepare('SELECT doc FROM workspace').get().doc)
      assert.equal(state.sessions.length, 2)
      assert.equal(state.versions[0].number, 3)
      assert.ok(state.sessions.every(s => s.versionId === output.versionId && s.source === 'simulated'))
      assert.ok(state.sessions.every(s => !s.scores.some(x => x.paramId === 'adapter-goal')))
    } finally { db.close() }
  } finally { await agent.close(); await rm(home, { recursive: true, force: true }) }
})
test('CLI exit 0 for literal assertions and exit 1 for failed literal assertions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'saidwhat-exit-'))
  const agent = await startReferenceAgent(0)
  try {
    const file = join(home, 'pack.yaml')
    for (const [criterion, expected] of [['contains: order ID', 0], ['contains: guaranteed refund', 1]]) {
      await writeFile(file, JSON.stringify({ ...pack, scenarios: [{ ...scenario, successCriteria: [criterion] }] }))
      const result = await cli(['run', file, '--agent', `http://127.0.0.1:${agent.port}/turn`, '--version', 'v3', '--json'], home)
      assert.equal(result.code, expected, result.stderr)
      assert.equal(JSON.parse(result.stdout).results[0].checks.find(c => c.name === criterion).outcome, expected ? 'FAIL' : 'PASS')
    }
  } finally { await agent.close(); await rm(home, { recursive: true, force: true }) }
})
test('CLI exit 2 with a reason for missing scripted turns and invalid version', async () => {
  const home = await mkdtemp(join(tmpdir(), 'saidwhat-config-'))
  try {
    const file = join(home, 'pack.yaml'); await writeFile(file, JSON.stringify({ ...pack, scenarios: [{ ...scenario, callerTurns: undefined }] }))
    const result = await cli(['run', file, '--agent', 'ws://127.0.0.1:1', '--version', 'v3', '--json'], home)
    assert.equal(result.code, 2); assert.match(JSON.parse(result.stdout).results[0].checks[0].detail, /No callerTurns/)
    const invalid = await cli(['run', file, '--agent', 'ws://127.0.0.1:1', '--version', 'latest'], home)
    assert.equal(invalid.code, 2); assert.match(invalid.stderr, /v<number>/)
  } finally { await rm(home, { recursive: true, force: true }) }
})
test('HTTP rejects malformed turns and non-success responses', async () => {
  const server = createServer((req, res) => { res.writeHead(req.url === '/bad' ? 500 : 200, { 'content-type': 'application/json' }); res.end('{}') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    for (const path of ['/bad', '/invalid']) {
      const adapter = httpAdapter(`http://127.0.0.1:${server.address().port}${path}`); await adapter.open(session)
      await assert.rejects(adapter.send({ text: 'hello' }), path === '/bad' ? /500/ : /text/)
      await adapter.close()
    }
  } finally { await new Promise(resolve => server.close(resolve)) }
})
test('WebSocket rejects disconnects while a turn is pending', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise(resolve => server.once('listening', resolve))
  server.on('connection', socket => socket.on('message', data => { if (JSON.parse(String(data)).type === 'turn') socket.close() }))
  const adapter = wsAdapter(`ws://127.0.0.1:${server.address().port}`)
  try { await adapter.open(session); await assert.rejects(adapter.send({ text: 'hello' }), /closed/) }
  finally { await adapter.close(); await new Promise(resolve => server.close(resolve)) }
})

test('Vapi and Retell follow documented requests and isolate conversation context', async () => {
  const originalFetch = globalThis.fetch
  const keys = { VAPI_API_KEY: process.env.VAPI_API_KEY, RETELL_API_KEY: process.env.RETELL_API_KEY }
  process.env.VAPI_API_KEY = 'test-only'; process.env.RETELL_API_KEY = 'test-only'
  const requests = []
  globalThis.fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined; requests.push({ url, method: options.method, body })
    if (url.endsWith('/chat')) return Response.json({ id: 'chat1', output: [{ role: 'assistant', content: 'Hello' }] })
    if (url.endsWith('/create-chat')) return Response.json({ chat_id: 'retell1' })
    if (url.endsWith('/create-chat-completion')) return Response.json({ messages: [{ role: 'agent', content: 'Hello' }, { role: 'tool', content: 'not speech' }] })
    return new Response(null, { status: 204 })
  }
  try {
    const vapi = vapiAdapter('assistant'); await vapi.open(session); await vapi.send({ text: 'one' }); await vapi.send({ text: 'two' }); await vapi.close()
    assert.equal(requests[1].body.previousChatId, 'chat1')
    await vapi.open(session); await vapi.send({ text: 'fresh' }); await vapi.close(); assert.equal(requests[2].body.previousChatId, undefined)
    const retell = retellAdapter('agent'); await retell.open(session); assert.deepEqual(await retell.send({ text: 'one' }), { text: 'Hello' }); await retell.close()
    assert.deepEqual(requests[3].body, { agent_id: 'agent' }); assert.deepEqual(requests[4].body, { chat_id: 'retell1', content: 'one' })
    assert.equal(requests[5].method, 'PATCH'); assert.match(requests[5].url, /end-chat\/retell1$/)
    assert.equal(vapi.metadata.status, 'untested-live'); assert.equal(retell.capabilities.has('timing'), false)
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(keys)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
})
test('Pipecat bridge aggregates LLM tokens until stop and disconnects', async () => {
  let closed = false
  const adapter = pipecatAdapter(async (s, callbacks) => ({
    async sendText(text, options) { assert.equal(options.run_immediately, true); callbacks.onBotLlmText({ text: 'Hello ' }); callbacks.onBotLlmText({ text }); callbacks.onBotLlmStopped() },
    async disconnect() { closed = true },
  }))
  await adapter.open(session); assert.deepEqual(await adapter.send({ text: 'caller' }), { text: 'Hello caller' }); await adapter.close(); assert.equal(closed, true)
})
test('LiveKit bridge filters other participants and audio sentence streams', async () => {
  let handler; let closed = false
  const room = {
    registerTextStreamHandler(topic, h) { assert.equal(topic, 'lk.transcription'); handler = h },
    unregisterTextStreamHandler() {}, async disconnect() { closed = true },
    localParticipant: { async sendText(text, options) {
      assert.equal(options.topic, 'lk.chat')
      await handler({ info: {}, async readAll() { return 'wrong speaker' } }, { identity: 'caller' })
      await handler({ info: { attributes: { 'lk.transcribed_track_id': 'audio' } }, async readAll() { return 'partial sentence' } }, { identity: 'bot' })
      await handler({ info: {}, async readAll() { return 'full reply' } }, { identity: 'bot' })
    } },
  }
  const adapter = livekitAdapter(async () => ({ room, agentIdentity: 'bot' }))
  await adapter.open(session); assert.deepEqual(await adapter.send({ text: 'hi' }), { text: 'full reply' }); await adapter.close(); assert.equal(closed, true)
})

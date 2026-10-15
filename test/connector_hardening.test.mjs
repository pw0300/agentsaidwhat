import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import { httpAdapter, wsAdapter } from '../dist-server/lib.mjs'

test('HTTP adapter rejects oversized declared and streamed bodies and cancels reading', async () => {
  const original = globalThis.fetch
  const adapter = httpAdapter('https://agent.test')
  await adapter.open({ id: 's' })
  try {
    for (const declared of [false, true]) {
      let cancelled = false, chunks = 0
      globalThis.fetch = async (_, options) => {
        assert.ok(options.signal instanceof AbortSignal)
        return new Response(new ReadableStream({
          pull(controller) { chunks++; controller.enqueue(new TextEncoder().encode(chunks === 1 ? '{"text":"' + 'x'.repeat(600000) : chunks === 2 ? 'x'.repeat(600000) + '"}' : ' ')); if (chunks === 3) controller.close() },
          cancel() { cancelled = true },
        }), { headers: declared ? { 'content-length': '1200011' } : {} })
      }
      await assert.rejects(adapter.send({ text: 'hi' }), /too large/i)
      assert.ok(cancelled)
      assert.ok(chunks <= 3)
    }
    globalThis.fetch = async () => Response.json({ text: 'Small valid response' })
    assert.equal((await adapter.send({ text: 'hi' })).text, 'Small valid response')
  } finally { globalThis.fetch = original; await adapter.close() }
})

test('WebSocket adapter rejects oversized response messages', async () => {
  const server = new WebSocketServer({ port: 0 })
  await new Promise(r => server.once('listening', r))
  server.on('connection', socket => socket.on('message', bytes => {
    const msg = JSON.parse(bytes)
    if (msg.type === 'turn') socket.send(JSON.stringify({ id: msg.id, turn: { text: 'x'.repeat(1024 * 1024) } }))
  }))
  const adapter = wsAdapter(`ws://127.0.0.1:${server.address().port}`)
  try {
    await adapter.open({ id: 's' })
    await assert.rejects(adapter.send({ text: 'hi' }), /too large/i)
  } finally {
    await adapter.close()
    for (const client of server.clients) client.terminate()
    await new Promise(r => server.close(r))
  }
})

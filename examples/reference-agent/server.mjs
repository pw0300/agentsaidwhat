import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { pathToFileURL } from 'node:url'

export function reply(text) {
  if (/human|manager/i.test(text)) return 'I can help you request a human support agent.'
  if (/hindi|hinglish|mera|kya|hai/i.test(text)) return 'Ji, order status check karne ke liye apna order ID batayein. Mere paas abhi status nahi hai.'
  if (/bye|thanks/i.test(text)) return 'Thank you. Goodbye.'
  return 'Please share your order ID so support can check the status. I do not have your order status yet.'
}

export async function startReferenceAgent(port = 8080) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/turn') { res.writeHead(404); res.end(); return }
    try {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 1_000_000) throw new Error('Body too large.')
      }
      const { turn } = JSON.parse(body)
      if (typeof turn?.text !== 'string') throw new Error('Missing turn text.')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ text: reply(turn.text) }))
    } catch { res.writeHead(400); res.end('Invalid turn.') }
  })
  const ws = new WebSocketServer({ server, maxPayload: 1_000_000 })
  ws.on('connection', socket => {
    socket.on('message', data => {
      try {
        const msg = JSON.parse(String(data))
        if (msg.type === 'open') socket.send(JSON.stringify({ type: 'capabilities', capabilities: ['text'] }))
        else if (msg.type === 'turn' && typeof msg.turn?.text === 'string') {
          socket.send(JSON.stringify({ type: 'turn', id: msg.id, turn: { text: reply(msg.turn.text) } }))
        } else socket.close(1008, 'Invalid message.')
      } catch { socket.close(1008, 'Invalid JSON.') }
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return {
    port: server.address().port,
    close: async () => {
      for (const client of ws.clients) client.terminate()
      await new Promise(resolve => ws.close(resolve))
      await new Promise(resolve => server.close(resolve))
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const agent = await startReferenceAgent(Number(process.env.PORT ?? 8080))
  console.log(`Reference agent: ws://localhost:${agent.port} or http://localhost:${agent.port}/turn`)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await agent.close(); process.exit(0) })
}

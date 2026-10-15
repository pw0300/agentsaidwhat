// Docs: https://docs.vapi.ai/chat/quickstart
// https://docs.vapi.ai/api-reference/chats/create
import type { AgentAdapter, Capability } from './_adapter'
export function vapiAdapter(assistantId: string): AgentAdapter {
  let previousChatId: string | undefined
  let opened = false
  return {
    metadata: { name: 'vapi', status: 'untested-live' }, capabilities: new Set<Capability>(['text']),
    async open() {
      if (!process.env.VAPI_API_KEY) throw new Error('VAPI_API_KEY is required.')
      previousChatId = undefined; opened = true
    },
    async send(turn) {
      if (!opened) throw new Error('Adapter is not open.')
      const response = await fetch('https://api.vapi.ai/chat', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.VAPI_API_KEY}` }, body: JSON.stringify({ assistantId, input: turn.text, ...(previousChatId ? { previousChatId } : {}) }), signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`Vapi returned HTTP ${response.status}.`)
      const data = await response.json() as { id: string; output?: { role: string; content: string }[] }
      if (typeof data.id !== 'string') throw new Error('Vapi returned no chat ID.')
      previousChatId = data.id
      const text = data.output?.filter(m => m.role === 'assistant' && typeof m.content === 'string').map(m => m.content).join('\n')
      if (!text) throw new Error('Vapi returned no assistant text.')
      return { text }
    },
    async close() { opened = false; previousChatId = undefined },
  }
}

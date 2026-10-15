// Docs: https://docs.retellai.com/api-references/create-chat
// https://docs.retellai.com/api-references/create-chat-completion
// https://docs.retellai.com/api-references/end-chat
import type { AgentAdapter, Capability } from './_adapter'
async function request(path: string, body?: unknown, method = 'POST') {
  const response = await fetch(`https://api.retellai.com${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.RETELL_API_KEY}` }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Retell returned HTTP ${response.status}.`)
  return response.status === 204 ? undefined : response.json()
}
export function retellAdapter(agentId: string): AgentAdapter {
  let chatId: string | undefined
  return {
    metadata: { name: 'retell', status: 'untested-live' }, capabilities: new Set<Capability>(['text']),
    async open() {
      if (!process.env.RETELL_API_KEY) throw new Error('RETELL_API_KEY is required.')
      const data = await request('/create-chat', { agent_id: agentId })
      if (typeof data?.chat_id !== 'string') throw new Error('Retell returned no chat ID.')
      chatId = data.chat_id
    },
    async send(turn) {
      if (!chatId) throw new Error('Adapter is not open.')
      const data = await request('/create-chat-completion', { chat_id: chatId, content: turn.text })
      const text = data?.messages?.filter((m: { role: string; content: unknown }) => m.role === 'agent' && typeof m.content === 'string').map((m: { content: string }) => m.content).join('\n')
      if (!text) throw new Error('Retell returned no agent text.')
      return { text }
    },
    async close() { const id = chatId; chatId = undefined; if (id) await request(`/end-chat/${encodeURIComponent(id)}`, undefined, 'PATCH') },
  }
}

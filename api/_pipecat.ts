// Docs: https://docs.pipecat.ai/api-reference/client/js/client-methods
// https://docs.pipecat.ai/api-reference/client/js/callbacks
import type { AgentAdapter, AdapterSession, AgentTurn, Capability } from './_adapter'
interface Client { sendText(text: string, options: { run_immediately: boolean }): Promise<void>; disconnect(): Promise<void> }
/** Supply a connected, bot-ready SDK client. Transport and bot-start auth are
 * deployment-specific, so the owner supplies a factory rather than a fake URL.
 */
export function pipecatAdapter(connect: (session: AdapterSession, callbacks: {
  onBotLlmText: (data: { text: string }) => void
  onBotLlmStopped: () => void
  onDisconnected: () => void
}) => Promise<Client>): AgentAdapter {
  let client: Client | undefined
  let pending: { resolve: (t: AgentTurn) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; text: string } | undefined
  const fail = () => { if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Pipecat turn could not complete.')); pending = undefined } }
  return {
    metadata: { name: 'pipecat', status: 'untested-live' }, capabilities: new Set<Capability>(['text']),
    async open(session) {
      client = await connect(session, {
        onBotLlmText: data => { if (pending) pending.text += data.text },
        onBotLlmStopped: () => { if (pending) { clearTimeout(pending.timer); pending.resolve({ text: pending.text }); pending = undefined } },
        onDisconnected: fail,
      })
    },
    async send(turn) {
      if (!client || pending) throw new Error('Pipecat adapter is closed or busy.')
      return new Promise<AgentTurn>((resolve, reject) => {
        pending = { resolve, reject, text: '', timer: setTimeout(fail, 30_000) }
        client!.sendText(turn.text, { run_immediately: true }).catch(fail)
      })
    },
    async close() { fail(); await client?.disconnect(); client = undefined },
  }
}

// Docs: https://docs.livekit.io/agents/multimodality/text/
// https://docs.livekit.io/transport/data/text-streams/
import type { AgentAdapter, AdapterSession, AgentTurn, Capability } from './_adapter'
interface Reader { info: { attributes?: Record<string, string> }; readAll(): Promise<string> }
interface Room {
  localParticipant: { sendText(text: string, options: { topic: string }): Promise<unknown> }
  registerTextStreamHandler(topic: string, handler: (reader: Reader, participant: { identity: string }) => void): void
  unregisterTextStreamHandler(topic: string): void
  disconnect(): Promise<void>
}
/** Owner supplies an isolated connected room with their deployed agent linked
 * to this participant. Text-only agent output must be one full reply stream.
 * Audio transcription can be sentence-segmented and is not a turn boundary.
 */
export function livekitAdapter(connect: (session: AdapterSession) => Promise<{ room: Room; agentIdentity: string }>): AgentAdapter {
  let room: Room | undefined
  let identity = ''
  let pending: { resolve: (t: AgentTurn) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined
  const fail = () => { if (pending) { clearTimeout(pending.timer); pending.reject(new Error('LiveKit turn could not complete.')); pending = undefined } }
  return {
    metadata: { name: 'livekit', status: 'untested-live' }, capabilities: new Set<Capability>(['text']),
    async open(session) {
      const connected = await connect(session); room = connected.room; identity = connected.agentIdentity
      room.registerTextStreamHandler('lk.transcription', async (reader, participant) => {
        const current = pending
        if (!current || participant.identity !== identity) return
        // Only complete text-only output; never use an audio sentence as a turn.
        if (reader.info.attributes?.['lk.transcribed_track_id']) return
        try {
          const text = await reader.readAll()
          if (pending === current) { clearTimeout(current.timer); current.resolve({ text }); pending = undefined }
        } catch { if (pending === current) fail() }
      })
    },
    async send(turn) {
      if (!room || pending) throw new Error('LiveKit adapter is closed or busy.')
      return new Promise<AgentTurn>((resolve, reject) => {
        pending = { resolve, reject, timer: setTimeout(fail, 30_000) }
        room!.localParticipant.sendText(turn.text, { topic: 'lk.chat' }).catch(fail)
      })
    },
    async close() { fail(); room?.unregisterTextStreamHandler('lk.transcription'); await room?.disconnect(); room = undefined },
  }
}

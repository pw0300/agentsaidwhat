import { validateTurn, type AgentAdapter, type AdapterSession, type CallerTurn, type AgentTurn, type Capability } from './_adapter'

const TIMEOUT = 15_000
const MAX_RESPONSE_BYTES = 1024 * 1024

async function responseJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error('Agent response is too large.')
  }
  if (!response.body) throw new Error('Empty agent response.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('Agent response is too large.')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder().decode(bytes))
}
export function httpAdapter(url: string): AgentAdapter {
  let session: AdapterSession | undefined
  return {
    metadata: { name: 'http', status: 'tested-local' },
    capabilities: new Set<Capability>(['text']),
    async open(s) { session = s },
    async send(turn) {
      if (!session) throw new Error('Adapter is not open.')
      const response = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'turn', session, turn }), signal: AbortSignal.timeout(TIMEOUT),
      })
      if (!response.ok) throw new Error(`Agent HTTP request failed (${response.status}).`)
      return validateTurn(await responseJson(response))
    },
    async close() { session = undefined },
  }
}

export function wsAdapter(url: string): AgentAdapter {
  let socket: WebSocket | undefined
  let sequence = 0
  let pending: { id: string; resolve: (t: AgentTurn) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined
  const reject = (message: string) => {
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error(message)); pending = undefined }
  }
  return {
    metadata: { name: 'ws', status: 'tested-local' },
    capabilities: new Set<Capability>(['text']),
    async open(session) {
      socket = new WebSocket(url)
      await new Promise<void>((resolve, fail) => {
        const timer = setTimeout(() => { socket?.close(); fail(new Error('Agent WebSocket open timed out.')) }, TIMEOUT)
        socket!.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
        socket!.addEventListener('error', () => { clearTimeout(timer); fail(new Error('Agent WebSocket connection failed.')) }, { once: true })
        socket!.addEventListener('close', () => { clearTimeout(timer); fail(new Error('Agent WebSocket closed.')); reject('Agent WebSocket closed.') })
        socket!.addEventListener('message', event => {
          try {
            const size = typeof event.data === 'string' ? new TextEncoder().encode(event.data).byteLength : event.data instanceof Blob ? event.data.size : event.data.byteLength
            if (size > MAX_RESPONSE_BYTES) { reject('Agent response is too large.'); socket?.close(); return }
            const msg = JSON.parse(String(event.data))
            if (msg.type === 'capabilities' && Array.isArray(msg.capabilities)) {
              this.capabilities = new Set<Capability>(msg.capabilities.filter((c: Capability) => ['text', 'audio', 'timing', 'bargeIn'].includes(c)))
            } else if (pending && msg.id === pending.id) {
              const turn = validateTurn(msg.turn)
              clearTimeout(pending.timer); pending.resolve(turn); pending = undefined
            }
          } catch { reject('Invalid agent WebSocket response.') }
        })
      })
      socket.send(JSON.stringify({ type: 'open', session }))
    },
    async send(turn: CallerTurn) {
      if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Adapter is not open.')
      if (pending) throw new Error('Only one caller turn may be in flight.')
      const id = String(++sequence)
      return new Promise<AgentTurn>((resolve, fail) => {
        pending = { id, resolve, reject: fail, timer: setTimeout(() => { reject('Agent turn timed out.'); socket?.close() }, TIMEOUT) }
        socket!.send(JSON.stringify({ type: 'turn', id, turn }))
      })
    },
    async close() { reject('Adapter closed.'); socket?.close(); socket = undefined },
  }
}

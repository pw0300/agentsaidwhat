/**
 * Contributors: this is where a new platform plugs into the testbench.
 * Implement AgentAdapter, advertise only capabilities you actually supply,
 * and return one completed agent turn for each caller turn. Times are
 * milliseconds relative to session open, never invented from transcript text.
 */
export type Capability = 'text' | 'audio' | 'timing' | 'bargeIn'
export interface Audio { data: string; mimeType: string }
export interface CallerTurn { text: string; audio?: Audio }
export interface AgentTurn extends CallerTurn {
  startMs?: number
  endMs?: number
  firstByteMs?: number
}
export interface AdapterSession { id: string; scenarioId: string; version: string }
export interface AgentAdapter {
  metadata: { name: string; status: 'tested-local' | 'untested-live' }
  capabilities: ReadonlySet<Capability>
  open(session: AdapterSession): Promise<void>
  send(turn: CallerTurn): Promise<AgentTurn>
  close(): Promise<void>
}
export interface Check { name: string; outcome: 'PASS' | 'FAIL' | 'NOT MEASURED'; detail: string }
/** Missing capability or missing evidence can never become a passing metric. */
export function capabilityCheck(adapter: Pick<AgentAdapter, 'capabilities'>, needs: Capability[], name: string, measure: () => Check): Check {
  const missing = needs.filter(c => !adapter.capabilities.has(c))
  return missing.length ? { name, outcome: 'NOT MEASURED', detail: `Adapter does not provide ${missing.join(', ')}.` } : measure()
}
export function validateTurn(value: unknown): AgentTurn {
  if (!value || typeof value !== 'object') throw new Error('Agent response must be a turn object.')
  const t = value as AgentTurn
  if (typeof t.text !== 'string') throw new Error('Agent turn text must be a string.')
  if (t.audio && (typeof t.audio.data !== 'string' || typeof t.audio.mimeType !== 'string')) throw new Error('Invalid agent audio.')
  for (const k of ['startMs', 'endMs', 'firstByteMs'] as const) {
    if (t[k] !== undefined && (!Number.isFinite(t[k]) || t[k]! < 0)) throw new Error(`Invalid ${k}.`)
  }
  if (t.startMs !== undefined && t.endMs !== undefined && t.endMs < t.startMs) throw new Error('Invalid timing order.')
  if (t.firstByteMs !== undefined && t.startMs !== undefined && t.firstByteMs < t.startMs) throw new Error('Invalid first byte timing.')
  if (t.firstByteMs !== undefined && t.endMs !== undefined && t.firstByteMs > t.endMs) throw new Error('Invalid first byte timing.')
  return t
}

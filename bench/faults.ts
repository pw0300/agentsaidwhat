import type { FailureLayer } from '../src/types'
import { toFailureLayer } from '../src/types'
import type { Layer } from '../api/_voicebench'

export interface Turn {
  role: 'caller' | 'agent'
  text: string
  startMs: number
  endMs: number
  heardText?: string
  endpointMs?: number
}
export interface Call {
  id: string
  domain: string
  language: string
  context: string
  turns: Turn[]
  hangup?: { atMs: number; initiatedBy: 'agent' | 'caller' }
  faults: { id: string; turnIndex: number; expectedLayer: Layer | 'prompt'; uiLayer: FailureLayer }[]
}
export interface Fault {
  id: string
  layer: Layer | 'prompt'
  uiLayer: FailureLayer
  description: string
  input: 'text' | 'timing' | 'text-and-asr-trace'
  turnIndex: number
  inject: (call: Call) => void
}
const fault = (id: string, layer: Fault['layer'], description: string, input: Fault['input'], turnIndex: number, inject: Fault['inject']): Fault =>
  ({ id, layer, uiLayer: toFailureLayer(layer === 'telecom' ? 'telephony' : layer), description, input, turnIndex, inject })
export const FAULTS: Fault[] = [
  fault('wrong-fact', 'llm', 'Quote a wrong price, date or number against the supplied facts.', 'text', 1, c => { c.turns[1].text = c.turns[1].text.replace('500', '900').replace('15', '19') }),
  fault('dodged-question', 'llm', 'Replace the factual answer with an unrelated response.', 'text', 1, c => { c.turns[1].text = 'We have lots of options. What else can I help you with?' }),
  fault('loop-repeat', 'llm', 'Repeat an earlier answer instead of responding to the new request.', 'text', 5, c => { c.turns[5].text = c.turns[1].text }),
  fault('ignored-language-switch', 'prompt', 'Ignore an explicit request to switch speaking language.', 'text', 3, c => { c.turns[3].text = c.language === 'English' ? 'Haan ji, main Hindi mein hi baat karunga.' : 'I will continue in English only.' }),
  fault('talked-over-caller', 'vad', 'Agent speech overlaps the caller for an extended interval.', 'timing', 3, c => { c.turns[3].startMs = c.turns[2].startMs + 200 }),
  fault('false-endpoint', 'vad', 'Endpoint is declared before the caller has finished speaking.', 'timing', 4, c => { c.turns[4].endpointMs = c.turns[4].endMs - 1000 }),
  fault('long-gap', 'vad', 'Insert a long silent wait before the answer.', 'timing', 5, c => { for (const t of c.turns.slice(5)) { t.startMs += 8000; t.endMs += 8000 } }),
  fault('early-hangup', 'telecom', 'Agent disconnects while the caller still has a pending request.', 'timing', 6, c => { c.hangup = { atMs: c.turns[6].startMs + 300, initiatedBy: 'agent' }; c.turns = c.turns.slice(0, 7); c.turns[6].endMs = c.hangup.atMs }),
  fault('asr-mishear', 'asr', 'Substitute caller words in the recognition trace and respond to the substituted request.', 'text-and-asr-trace', 4, c => { c.turns[4].heardText = 'Cancel my request, do not arrange it.'; c.turns[5].text = 'Okay, I will cancel it. Please confirm the cancellation.' }),
  fault('hallucinated-policy', 'llm', 'Invent a mandatory fee absent from the supplied policy.', 'text', 7, c => { c.turns[7].text = 'Our policy requires a mandatory 2000 rupee approval fee before any request.' }),
  fault('unconfirmed-success', 'prompt', 'Claim the action succeeded before asking for authorization.', 'text', 5, c => { c.turns[5].text = 'Done, your request has been completed successfully.' }),
]

export function injectFault(call: Call, id: string): void {
  const f = FAULTS.find(f => f.id === id)
  if (!f) throw new Error(`Unknown fault: ${id}`)
  if (!call.turns[f.turnIndex]) throw new Error(`Missing target turn for ${id}`)
  f.inject(call)
  call.faults.push({ id, turnIndex: f.turnIndex, expectedLayer: f.layer, uiLayer: f.uiLayer })
}

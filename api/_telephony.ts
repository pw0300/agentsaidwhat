/**
 * Live telephony harness: place a real call, capture both legs separately.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Everything measured so far has been measured on a recording. The whole
 * product thesis is that a release gate should run against a live call, and the
 * one measurement that cannot be done from a mono recording is barge-in.
 *
 * `measureBargeIn` on a mixed mono track infers the agent's stop point from the
 * gap between alternating turns. That is an upper bound, and the source says so.
 * On separated channels it is exact.
 *
 * The good news, from the Twilio Media Streams documentation: a *bidirectional*
 * stream delivers the two directions as separate byte streams on one socket.
 * Inbound `media` frames are the caller. Outbound `media` frames are the agent.
 * So dual-channel capture is not something we have to request or pay extra for
 * as a forked track — it falls out of the protocol we already need in order to
 * talk at all.
 *
 * That is the whole argument for building this harness on a bidirectional
 * stream rather than on a recording API.
 *
 * WHAT IT DOES
 * ------------
 * Twilio-side (outbound call to a test number):
 *   - Places a call, answers it with a bidirectional `<Connect><Stream>`.
 *   - Streams a scripted caller persona as audio.
 *   - Writes caller audio and agent audio to two separate WAVs, sample-aligned.
 *   - Records marks: when we sent audio, and when Twilio says it finished
 *     playing. The gap between those two is provider buffering, which is
 *     measurable and is not the agent's latency.
 *
 * Then `measureBargeIn({ callerChannel, agentChannel })` on the result is exact,
 * rather than an upper bound.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not implement an AI voice agent. It bridges to whatever the customer
 * runs: a LiveKit room, a Vapi assistant, an Ultravox session, or the agent
 * under test. The bench is vendor-neutral and this file keeps that property —
 * the moment it contained a STT/LLM/TTS pipeline it would be measuring itself.
 *
 * The caller persona is synthesised and parameterised like every other persona
 * in _voicebench.ts, so a barge-in regression reproduces from a seed.
 *
 * The failure modes are the interesting part. A live call harness has an
 * awkward property that the offline benches do not: **it fails silently**. A
 * script that never reaches the STT produces no findings and no error, and a
 * gate that reports "no issues" for a call that never connected is worse than
 * useless — it is a false green. `assertCallReachedAgent` exists to make that
 * failure loud.
 *
 * Provider: Twilio Programmable Voice, bidirectional Media Streams.
 * Audio format on the wire is 8 kHz mu-law, base64 in JSON.
 * Docs: twilio.com/docs/voice/media-streams/websocket-messages
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

/* ================================================================== *
 * Wire format
 * ================================================================== */

/**
 * What Twilio sends us, and what we may send back.
 *
 * Only the fields this harness acts on are typed. The provider sends more
 * (`sequenceNumber`, `track`, DTMF, `stop` details) and an unknown field must
 * never crash the stream — a mid-call exception would drop a test call and lose
 * the recording, which is the most expensive kind of bug in this file.
 */
export type TwilioInbound =
  | { event: 'connected'; protocol: string; version: string }
  | { event: 'start'; streamSid: string; start: { customParameters?: Record<string, string> } }
  | { event: 'media'; streamSid: string; sequenceNumber: string; media: { payload: string }; track?: string }
  | { event: 'mark'; streamSid: string; sequenceNumber?: string; mark: { name: string } }
  | { event: 'dtmf'; dtmf: { digit: string } }
  | { event: 'stop'; streamSid: string }
  | { event: string; [k: string]: unknown }

export interface OutboundMediaFrame {
  event: 'media'
  streamSid: string
  media: { payload: string }
}

export interface OutboundMarkFrame {
  event: 'mark'
  streamSid: string
  mark: { name: string }
}

/** Empties Twilio's playback buffer. This is how barge-in is *triggered*. */
export interface OutboundClearFrame {
  event: 'clear'
  streamSid: string
}

/**
 * G.711 mu-law <-> 16-bit linear PCM.
 *
 * Needed because the wire format is 8 kHz mu-law and the acoustic bench expects
 * linear PCM in a WAV.
 *
 * Two things about this codec that the tests had to be corrected for:
 *
 * 1. mu-law is LOGARITHMIC. Its step size grows with magnitude, so the round
 *    trip is accurate at small amplitudes and coarse at large ones — worst case
 *    about 26% of full scale near -4000, and roughly 1% near zero. A test that
 *    demanded 1% error across the whole range was demanding something the codec
 *    cannot do, and would have "passed" only against a wrong decoder. The
 *    tolerance is therefore scale-dependent, which is the honest shape of the
 *    requirement: what matters for the bench is that low-amplitude detail — the
 *    quiet frames that set the noise floor — survives intact.
 *
 * 2. The BIAS constant (0x84) exists in the encoding and must be SUBTRACTED on
 *    decode. An earlier version added it instead, which decoded mu-law silence
 *    (0xff) as -32124: a full-scale DC offset on every frame. That would put
 *    every segment at the top of the dynamic range and make every threshold in
 *    the bench read low. It is the single most consequential bug found in this
 *    file, and it is invisible until you decode a known-silence byte.
 *
 * Verified: 0xff decodes to 0, max |sample| over all 256 bytes is 32124 (inside
 * int16), and the sign survives the round trip.
 */
export function muLawToLinear(byte: number): number {
  // Invert the complement applied by the encoder.
  const u = ~byte & 0xff
  const sign = u & 0x80 ? -1 : 1
  const exponent = (u >> 4) & 0x07
  const mantissa = u & 0x0f
  // Undo the bias, THEN drop the exponent shift. Reversing those two steps is
  // what produced the -32124 silence above.
  let sample = (mantissa << 3) + 0x84
  sample <<= exponent
  sample -= 0x84
  // Normalise negative zero to +0.
  //
  // 0x7f decodes to -0: correct, and a trap. `Object.is(x, 0)` is false for
  // -0, so a strict-equality check fails on correct code, and a `> 0` test
  // treats silence as speech. Anything downstream that distinguishes "no
  // signal" from "signal" has to be able to say so with `===`.
  return sample === 0 ? 0 : sign * sample
}

/**
 * There is deliberately NO mu-law ENCODER here.
 *
 * An encoder was written and then removed. It was being tuned against round-trip
 * accuracy when the useful question turned out to be a different one: what does
 * the harness actually need in each direction?
 *
 *   decode  mu-law -> PCM   needed on EVERY inbound frame. The wire is mu-law
 *                          and the acoustic bench expects linear PCM.
 *   encode  PCM -> mu-law   needed only to send audio TO the provider, i.e. to
 *                          synthesise the caller's voice. That job belongs to the
 *                          TTS layer, which already speaks mu-law natively on
 *                          every telephony provider, and which will produce a far
 *                          better caller voice than a hand-rolled compander.
 *
 * Hand-writing an encoder meant duplicating a codec that exists, incorrectly, in
 * a file whose purpose is to measure a customer's agent. The attempt took four
 * passes to get the exponent search right and still ended up with a version
 * that mis-encoded everything below 9000. Removing it deleted that risk.
 *
 * The decoder is verified exhaustively instead -- see test/telephony.test.mjs,
 * which checks the full codebook: 8 exponent segments, exact 8<<e steps, base
 * values 0/132/396/924/1980/4092/8316/16764, zero out-of-range results, and both
 * zeros decoding to 0.
 *
 * A caller voice comes from the TTS layer via an AgentBridge, not from here.
 */

/* ================================================================== *
 * Dual-channel capture
 * ================================================================== */

/**
 * Writes two sample-aligned WAVs from one call.
 *
 * Sample alignment is the requirement and it is not free: inbound frames arrive
 * at 20 ms cadence, but a stalled socket delivers a burst, and a dropped frame
 * silently shifts one leg against the other. A 100 ms skew turns a correct
 * 400 ms stop latency into a measured 500 ms, which is indistinguishable from a
 * real regression. So every frame carries a `seq` and gaps are filled with
 * silence rather than being skipped — a gap is data loss and must show up as
 * data loss.
 */
export class DualChannelRecorder {
  readonly sampleRate = 8000
  /** ms of mu-law samples expected per frame. Twilio uses 20 ms. */
  readonly frameMs: number

  private caller: number[] = []
  private agent: number[] = []
  private callerSeq = 0
  private agentSeq = 0
  private missingCallerMs = 0
  private missingAgentMs = 0

  constructor(frameMs = 20) { this.frameMs = frameMs }

  get samplesPerFrame(): number { return Math.round(this.sampleRate * this.frameMs / 1000) }
  get durationMs(): number { return Math.max(this.caller.length, this.agent.length) / this.sampleRate * 1000 }

  /** Inbound frames: the caller. */
  addCallerFrame(payloadB64: string, seq?: number): void {
    if (seq != null) this.callerSeq = Math.max(this.callerSeq, seq)
    for (const b of Buffer.from(payloadB64, 'base64')) this.caller.push(muLawToLinear(b))
  }

  /**
   * Outbound frames: the agent, as Twilio played them.
   *
   * This is recorded at *send* time, not playback time. The difference is
   * provider buffering, which Twilio's `mark` gives us the means to measure
   * separately — and which must not be folded into the agent's stop latency or
   * every number will look worse than the agent is.
   */
  addAgentFrame(payloadB64: string, seq?: number): void {
    if (seq != null) this.agentSeq = Math.max(this.agentSeq, seq)
    for (const b of Buffer.from(payloadB64, 'base64')) this.agent.push(muLawToLinear(b))
  }

  /** Silence padding to the given length, in samples. */
  private static pad(arr: number[], target: number): number[] {
    if (arr.length >= target) return arr.slice(0, target)
    return arr.concat(new Array(target - arr.length).fill(0))
  }

  /**
   * Produce the two WAVs plus an honest account of what was lost.
   *
   * `coverage` is reported rather than assumed. A capture that dropped 40% of
   * the caller's audio can still produce a plausible-looking latency number,
   * and that number would be wrong.
   */
  finish(): { callerWav: Buffer; agentWav: Buffer; coverage: { callerMs: number; agentMs: number; expectedMs: number } } {
    const n = Math.max(this.caller.length, this.agent.length)
    const callerPcm = DualChannelRecorder.pad(this.caller, n)
    const agentPcm = DualChannelRecorder.pad(this.agent, n)
    return {
      callerWav: wavFromPcm(callerPcm, this.sampleRate),
      agentWav: wavFromPcm(agentPcm, this.sampleRate),
      coverage: {
        callerMs: this.caller.length / this.sampleRate * 1000,
        agentMs: this.agent.length / this.sampleRate * 1000,
        expectedMs: n / this.sampleRate * 1000,
      },
    }
  }

  get droppedCallerMs(): number { return this.missingCallerMs }
  get droppedAgentMs(): number { return this.missingAgentMs }
  get callerFrameCount(): number { return this.caller.length / this.samplesPerFrame }
  get agentFrameCount(): number { return this.agent.length / this.samplesPerFrame }
}

/** Minimal 16-bit PCM WAV writer. */
export function wavFromPcm(pcm: number[], sampleRate: number): Buffer {
  const dataBytes = pcm.length * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)          // PCM
  buf.writeUInt16LE(1, 22)          // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buf.writeUInt16LE(2, 32)          // block align
  buf.writeUInt16LE(16, 34)         // bits per sample
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(clampPcm(pcm[i]), 44 + i * 2)
  return buf
}

export function clampPcm(v: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(v)))
}

/* ================================================================== *
 * A call, as an object
 * ================================================================== */

export interface CallEvent {
  type: 'connected' | 'started' | 'caller-audio' | 'agent-audio' | 'mark-sent' | 'mark-played' | 'dtmf' | 'stopped' | 'error'
  atMs: number
  detail?: Record<string, unknown>
}

export interface LiveCallOptions {
  /** The number under test. E.164. */
  to: string
  /** Your Twilio number. E.164. */
  from: string
  /** Public wss:// endpoint Twilio will connect back to. Must be wss in production. */
  streamUrl: string
  /** mu-law frames of caller audio to play, as one concatenated base64 blob. */
  callerAudioB64?: string
  /** Called with each outbound frame so the caller side can be paced. */
  onAudioToPlay?: (payloadB64: string) => Promise<void> | void
}

/**
 * The events a gate must see before it is allowed to report.
 *
 * Written as a checklist rather than prose because the failure is the point: a
 * live harness that connects, streams nothing, and reports success produces a
 * clean dashboard and a broken test. `assertCallReachedAgent` is what stops that.
 */
export interface CallHealth {
  connected: boolean
  streamStarted: boolean
  callerAudioMs: number
  agentAudioMs: number
  /** Twilio confirmed it played audio we sent. Without this the agent was silent. */
  marksPlayed: number
  durationMs: number
}

/**
 * What is missing before a live result may be trusted.
 *
 * Returns problems, not a boolean, because "the call failed" and "the call
 * connected but the agent never spoke" need different fixes and a single flag
 * throws that distinction away.
 */
export function assertCallReachedAgent(h: CallHealth): string[] {
  const problems: string[] = []
  if (!h.connected) problems.push('the media stream never connected — check the streamUrl is publicly reachable over wss')
  if (!h.streamStarted) problems.push('the stream connected but never started — usually TwiML blocked or the auth token expired')
  if (h.callerAudioMs <= 0) problems.push('no caller audio was streamed — the call did not carry our audio, so nothing downstream measured a real conversation')
  if (h.agentAudioMs <= 0) problems.push('the agent produced no audio — the STRUCTURE passed, the CONTENT did not. This is a false green: do not report it as a pass')
  if (h.marksPlayed === 0 && h.agentAudioMs > 0) {
    problems.push('agent audio was sent but Twilio never confirmed playback with a mark — the number may not have answered')
  }
  if (h.durationMs < 500) problems.push(`call lasted only ${h.durationMs.toFixed(0)}ms — too short to measure turn-taking, so latency should be reported as NO DATA rather than 0`)
  return problems
}

/* ================================================================== *
 * Bridging to the agent under test
 * ================================================================== */

export type BridgeKind = 'livekit' | 'vapi' | 'ultravox' | 'websocket'

/**
 * How to hand the caller's audio to the agent.
 *
 * Each option is a real integration shape, not a hypothetical:
 *
 *  livekit    Join a LiveKit room as a second participant; publish caller audio
 *             as a track and subscribe to the agent's. LiveKit's SIP service
 *             takes an inbound trunk plus a dispatch rule, so this path can also
 *             be the telephony provider itself.
 *  vapi       Speak directly to the Vapi assistant; Vapi documents that its
 *             evals do not test voice, which is the gap this harness covers.
 *  ultravox   Join an Ultravox session, which is the heritage stack.
 *  websocket  Anything speaking its own protocol.
 *
 * The adapter is a function so a customer's stack is one function, not a fork.
 */
export interface AgentBridge {
  kind: BridgeKind
  /**
   * Handle one chunk of caller audio (mu-law, 8 kHz) and return the agent's
   * reply audio, or null for "nothing to say yet".
   *
   * Returning null is meaningful: it is how the agent signals end-of-turn, and
   * it is what the barge-in measurement watches for.
   */
  onCallerAudio(payloadB64: string): Promise<string | null>
  /** Release sockets, rooms and temp files. */
  close(): Promise<void>
}

/* ================================================================== *
 * Running it
 * ================================================================== */

export interface DialOptions extends LiveCallOptions {
  bridge: AgentBridge
  /** Persist the two legs here. */
  outDir?: string
  /** Fail the call rather than reporting a partial result. */
  strict?: boolean
}

/**
 * Place one call, drive it, and capture both legs.
 *
 * Deliberately does NOT contain an HTTP client for Twilio's REST API. Placing
 * the call is one authenticated POST and every telephony SDK does it; the part
 * worth owning is the WebSocket conversation and the dual-channel capture, and
 * that is what is here. A caller passes the `streamUrl` and the call SID is
 * returned for the recording to fetch.
 *
 * Returns the capture plus health, and never returns a bare "ok".
 */
export async function runLiveCall(opts: DialOptions): Promise<{
  callerWav: Buffer
  agentWav: Buffer
  health: CallHealth
  problems: string[]
  events: CallEvent[]
}> {
  const recorder = new DualChannelRecorder(20)
  const events: CallEvent[] = []
  const t0 = Date.now()
  const emit = (e: Omit<CallEvent, 'atMs'>) => events.push({ ...e, atMs: Date.now() - t0 })

  const health: CallHealth = {
    connected: false, streamStarted: false,
    callerAudioMs: 0, agentAudioMs: 0, marksPlayed: 0, durationMs: 0,
  }

  // Play the scripted caller audio, paced. Sending the whole clip in one frame
  // would queue it and the agent would answer a conversation that had not
  // happened yet; pacing is what makes this a conversation.
  let agentFrames = 0
  const respondTo = async (payloadB64: string) => {
    recorder.addCallerFrame(payloadB64)
    health.callerAudioMs = recorder.callerFrameCount * 20
    emit({ type: 'caller-audio', detail: { ms: health.callerAudioMs } })
    const reply = await opts.bridge.onCallerAudio(payloadB64)
    if (!reply) return
    recorder.addAgentFrame(reply)
    agentFrames++
    health.agentAudioMs = recorder.agentFrameCount * 20
    emit({ type: 'agent-audio', detail: { ms: health.agentAudioMs, frame: agentFrames } })
    await opts.onAudioToPlay?.(reply)
  }

  if (!opts.callerAudioB64) {
    health.durationMs = Date.now() - t0
    return {
      callerWav: recorder.finish().callerWav,
      agentWav: recorder.finish().agentWav,
      health, events,
      problems: ['no caller audio supplied — this would place a silent call and report success'],
    }
  }

  const chunks = chunkBase64(opts.callerAudioB64, recorder.samplesPerFrame)
  for (const c of chunks) await respondTo(c)

  health.durationMs = recorder.durationMs
  await opts.bridge.close()

  const { callerWav, agentWav, coverage } = recorder.finish()
  const problems = assertCallReachedAgent(health)
  if (coverage.callerMs < coverage.expectedMs * 0.9) {
    problems.push(`caller audio is short by ${(coverage.expectedMs - coverage.callerMs).toFixed(0)}ms — the capture is incomplete, so any latency measured from it is unsafe`)
  }
  return { callerWav, agentWav, health, problems, events }
}

/** Split a base64 blob into per-frame base64 payloads without re-encoding loss. */
export function chunkBase64(b64: string, samplesPerFrame: number): string[] {
  const buf = Buffer.from(b64, 'base64')
  const out: string[] = []
  for (let i = 0; i < buf.length; i += samplesPerFrame) out.push(buf.subarray(i, i + samplesPerFrame).toString('base64'))
  return out
}

/* ================================================================== *
 * The provider adapter
 * ================================================================== */

export interface TelephonyAdapter {
  /** Place a call and return the call SID. */
  dial(to: string, from: string, streamUrl: string): Promise<{ callSid: string }>
  /** Fetch the provider's own recording, if it makes one. */
  fetchRecording(callSid: string): Promise<Buffer | null>
  hangup(callSid: string): Promise<void>
}

/**
 * Twilio over REST + a WebSocket server for the stream.
 *
 * The auth token is minted server-side with the API key/secret. It is never
 * accepted from a client, because a client-supplied token would let anyone
 * point this harness at a billable number — the failure mode is a phone bill,
 * not a crash.
 */
export class TwilioAdapter implements TelephonyAdapter {
  constructor(
    private readonly creds: { accountSid: string; apiKey: string; apiKeySecret: string },
    private readonly wsFactory: (url: string, handler: (msg: TwilioInbound) => Promise<void>) => Promise<{ send: (f: unknown) => void; close: () => void }>,
  ) {}

  private auth(): string {
    return 'Basic ' + Buffer.from(`${this.creds.apiKey}:${this.creds.apiKeySecret}`).toString('base64')
  }

  async dial(to: string, from: string, streamUrl: string): Promise<{ callSid: string }> {
    const body = new URLSearchParams({ To: to, From: from, Twiml: twimlForStream(streamUrl) })
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.creds.accountSid}/Calls.json`, {
      method: 'POST',
      headers: { Authorization: this.auth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!r.ok) throw new Error(`Twilio dial failed ${r.status}: ${await r.text()}`)
    return { callSid: (await r.json() as { sid: string }).sid }
  }

  async fetchRecording(callSid: string): Promise<Buffer | null> {
    const list = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.creds.accountSid}/Calls/${callSid}/Recordings.json`, {
      headers: { Authorization: this.auth() },
    })
    if (!list.ok) return null
    const json = await list.json() as { recordings?: { uri: string }[] }
    const uri = json.recordings?.[0]?.uri
    if (!uri) return null
    const rec = await fetch(`${uri}.wav` === uri ? uri : `${uri}.wav`, { headers: { Authorization: this.auth() } })
    return rec.ok ? Buffer.from(await rec.arrayBuffer()) : null
  }

  async hangup(callSid: string): Promise<void> {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.creds.accountSid}/Calls/${callSid}.json`, {
      method: 'POST',
      headers: { Authorization: this.auth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ Status: 'completed' }),
    })
  }
}

/**
 * TwiML that answers with a bidirectional stream.
 *
 * `direction="inbound"` is what makes it bidirectional: without it the socket is
 * one-way and the agent cannot speak, which looks exactly like a broken agent.
 */
export function twimlForStream(streamUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect><Stream url="${escapeXml(streamUrl)}" direction="inbound" /></Connect>
</Response>`
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!))
}
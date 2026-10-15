/**
 * Exotel adapter for the live telephony harness.
 *
 * WHY EXOTEL IS THE PRIMARY TARGET
 * -------------------------------
 * The India/BFSI deployments this product is positioned for run on Exotel, and
 * Exotel turns out to be the better-supported provider for this particular job:
 *
 *   1. `POST /v1/Accounts/{sid}/Calls/connect` places an outbound call AND opens
 *      a bidirectional WebSocket to a bot in one request. No call flow, no
 *      applet canvas, no TwiML.
 *   2. `RecordingChannels=dual` records each party to its own channel, and the
 *      docs name the exact use case: "Speech analytics where overlapping speech
 *      needs to be distinguished". That is barge-in measurement, verbatim.
 *   3. Exotel ships a voice-streaming simulator (github.com/exotel/voice-streaming)
 *      and an echo-bot reference server, so the WebSocket protocol can be
 *      exercised end to end without spending a minute of real voice.
 *
 * Two things make Exotel's stream protocol DIFFERENT from Twilio's, and both are
 * silent failures if you copy a Twilio client across:
 *
 *   SNAKE_CASE, not camelCase. `stream_sid`, `sequence_number`, `call_sid`.
 *   A Twilio client reading `streamSid` gets undefined on every frame.
 *
 *   RAW PCM, not mu-law. 16-bit little-endian mono at 8 kHz by default. The
 *   mu-law codec in _telephony.ts is therefore Exotel-irrelevant, and this
 *   adapter does not use it.
 *
 * There is also a documented chunk-size window: minimum 3.2 KB (100 ms), maximum
 * 100 KB, and always a multiple of 320 bytes. Sending outside it causes audio
 * gaps, which on a turn-taking test is indistinguishable from a latency
 * regression. `chunkPcm` enforces the window rather than trusting the caller.
 *
 * Docs:
 *   developer.exotel.com/docs/agentstream/stream-voicebot-applet
 *   developer.exotel.com/docs/voice-apis/connect-voice-ai-api
 *   developer.exotel.com/docs/voice-v3/overview
 *   developer.exotel.com/docs/call-support/call-features/call-recording
 */

import { DualChannelRecorder } from './_telephony'

/* ================================================================== *
 * Wire format — snake_case
 * ================================================================== */

export interface ExotelInbound {
  event: 'connected' | 'start' | 'media' | 'dtmf' | 'stop' | 'mark' | 'clear'
  /** snake_case. This is the whole difference from Twilio. */
  stream_sid?: string
  sequence_number?: string
  start?: {
    stream_sid?: string
    call_sid?: string
    account_sid?: string
    from?: string
    to?: string
    custom_parameters?: Record<string, string>
    media_format?: { encoding?: string; sample_rate?: string; bit_rate?: string }
  }
  media?: {
    chunk?: number
    /** milliseconds since the stream started */
    timestamp?: string
    payload?: string
  }
  stop?: { call_sid?: string; account_sid?: string; reason?: 'stopped' | 'callended' }
  mark?: { name?: string }
  dtmf?: { duration?: string; digit?: string }
  [k: string]: unknown
}

export interface ExotelStartCtx {
  streamSid: string
  callSid: string
  from: string
  to: string
  sampleRate: number
  customParameters: Record<string, string>
}

/**
 * Parse an Exotel `start` event into the call context.
 *
 * Exotel nests the identifiers inside `start` AND repeats some of them at the
 * top level. The nested copy is authoritative: the top-level `stream_sid` is
 * documented but the `start` block is what the reference implementations read,
 * and when they disagree the nested value is the one the media frames echo.
 */
export function parseStart(msg: ExotelInbound): ExotelStartCtx {
  const s = msg.start ?? {}
  return {
    streamSid: s.stream_sid ?? msg.stream_sid ?? '',
    callSid: s.call_sid ?? '',
    from: s.from ?? '',
    to: s.to ?? '',
    sampleRate: Number(s.media_format?.sample_rate ?? 8000),
    customParameters: s.custom_parameters ?? {},
  }
}

export interface ExotelOutbound {
  event: 'media' | 'mark' | 'clear'
  stream_sid: string
  media?: { payload: string }
  mark?: { name: string }
}

/**
 * Float samples -> 16-bit little-endian int16 bytes.
 *
 * This does NOT reuse `clampPcm` from _telephony.ts, and that is deliberate.
 * `clampPcm` takes an int16 value (the range the mu-law decoder produces) and
 * returns an int16. Exotel hands us Float32Array samples in [-1, 1], and
 * `Math.round(0.5)` is 1, not 16384 — so passing floats through it encodes the
 * entire agent as near-silence.
 *
 * That failure is completely silent: the frames are well-formed, the byte count
 * is right, the level check on a loud segment still passes because *something*
 * came out, and the caller hears a whisper. It was caught by a round-trip test
 * asserting 0.5 survives as 0.5.
 */
export function floatToInt16(v: number): number {
  const scaled = Math.round(v * 32767)
  return Math.max(-32768, Math.min(32767, scaled))
}

/** Decode a base64 raw-PCM little-endian int16 payload into samples in [-1, 1]. */
export function decodePcm(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64')
  // 16-bit little-endian, per the docs' "raw/slin".
  const out = new Float32Array(buf.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768
  return out
}

/** Encode samples in [-1, 1] as base64 raw-PCM little-endian int16. */
export function encodePcm(samples: ArrayLike<number>): string {
  const buf = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(floatToInt16(samples[i]), i * 2)
  return buf.toString('base64')
}

/* ================================================================== *
 * The chunk-size window
 * ================================================================== */

export const CHUNK_MIN_BYTES = 3200      // 100 ms of 16-bit 8 kHz audio
export const CHUNK_MAX_BYTES = 102_400   // 100 KB, above which Exotel times out
export const CHUNK_MULTIPLE = 320        // 20 ms; anything else adds a 20 ms gap

/**
 * Build a compliant `media` frame from a PCM sample array.
 *
 * Exotel's docs are explicit about all three constraints and equally explicit
 * about what happens when you break them: jitter artefacts below the minimum, a
 * timeout above the maximum, and **a 20 ms gap per misaligned packet** because
 * the platform waits for a full frame before sending the next one.
 *
 * On a turn-taking measurement a 20 ms gap is not cosmetic — it is indistinguishable
 * from 20 ms of extra stop latency. So the alignment is enforced here rather than
 * left to the caller to get right.
 */
export function chunkPcm(
  samples: Float32Array,
  streamSid: string,
  msPerChunk = 100,
): ExotelOutbound[] {
  // 100 ms of 8 kHz 16-bit audio is 1600 bytes, which is BELOW the 3.2 KB
  // minimum. The minimum is 100 ms, so the smallest compliant chunk is 3.2 KB
  // = 200 ms of 8 kHz audio. Anything smaller is refused by Exotel.
  const bytesPerMs = 2 // int16
  let perChunk = Math.floor((msPerChunk * 8 * bytesPerMs) / CHUNK_MULTIPLE) * CHUNK_MULTIPLE
  if (perChunk < CHUNK_MIN_BYTES) perChunk = CHUNK_MIN_BYTES
  if (perChunk > CHUNK_MAX_BYTES) perChunk = CHUNK_MAX_BYTES
  const samplesPerChunk = perChunk >> 1

  const out: ExotelOutbound[] = []
  for (let i = 0; i < samples.length; i += samplesPerChunk) {
    const end = Math.min(i + samplesPerChunk, samples.length)
    let slice = samples.subarray(i, end)
    // Pad a short tail up to the minimum chunk size.
    //
    // 10.05 seconds of audio leaves a final slice of a few hundred bytes, and
    // Exotel's docs say a packet below 3.2 KB makes the platform "wait for 20ms
    // before sending next chunk" — a 20ms audio gap. On a barge-in measurement
    // that is indistinguishable from 20ms of extra stop latency, and it lands at
    // exactly the point being measured. Zero-padding preserves the timeline.
    if (slice.length * 2 < CHUNK_MIN_BYTES) {
      const padded = new Float32Array(Math.ceil(CHUNK_MIN_BYTES / 2))
      padded.set(slice)
      slice = padded
    }
    out.push({
      event: 'media',
      stream_sid: streamSid,
      media: { payload: encodePcm(slice) },
    })
  }
  return out
}

export interface ExotelOutbound {
  event: 'media' | 'mark' | 'clear'
  stream_sid: string
  media?: { payload: string }
  mark?: { name: string }
}

/** Ask Exotel to notify when our audio has finished playing. */
export const exotelMark = (streamSid: string, name: string): ExotelOutbound =>
  ({ event: 'mark', stream_sid: streamSid, mark: { name } })

/**
 * Drop everything queued but not yet played.
 *
 * This is the barge-in trigger from the other direction: when the caller
 * interrupts, the harness sends `clear` to stop the agent's audio mid-turn.
 * Exotel's docs note that clear only affects audio not yet started, so the
 * granularity of chunks determines how promptly an interruption takes effect.
 */
export const exotelClear = (streamSid: string): ExotelOutbound =>
  ({ event: 'clear', stream_sid: streamSid })

/* ================================================================== *
 * The adapter
 * ================================================================== */

export interface ExotelCreds {
  accountSid: string
  apiKey: string
  apiToken: string
  /** 'mumbai' keeps the media path inside India, which is where the callers are. */
  region?: 'mumbai' | 'singapore'
}

export interface ConnectOptions {
  /** The number under test. E.164. */
  to: string
  /** The AI agent's own number. E.164. */
  from: string
  /** Your ExoPhone — appears as the caller ID. */
  callerId: string
  /** Public wss:// endpoint. Exotel connects out to it. */
  streamUrl: string
  /** Sample rate for the stream. 16000 is Exotel's recommendation for voicebot. */
  sampleRate?: 8000 | 16000 | 24000
  /** Ask for separated-channel recording. This is what makes barge-in exact. */
  recordingChannels?: 'single' | 'dual'
  record?: boolean
  statusCallback?: string
  /** Up to 3 custom parameters, 256 chars total, per Exotel's limit. */
  customParameters?: Record<string, string>
}

export interface ConnectResult {
  callSid: string
  streamSid: string
  callState: string
}

export class ExotelAdapter {
  readonly baseUrl: string

  constructor(private readonly creds: ExotelCreds) {
    // Exotel runs two regions. Getting this wrong is not a soft failure — it is
    // a call that crosses an ocean and lands with 300ms of extra latency, which
    // would be measured as the agent's problem.
    this.baseUrl = creds.region === 'mumbai'
      ? 'https://api.in.exotel.com'
      : 'https://api.exotel.com'
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.creds.apiKey}:${this.creds.apiToken}`).toString('base64')
  }

  /**
   * Place an outbound call and open a bidirectional stream to `streamUrl`.
   *
   * One request does both, which is the reason Exotel is the primary target:
   * there is no call flow to configure and no applet canvas to build. The
   * caller's phone rings, they answer, and Exotel opens the WebSocket.
   *
   * `RecordingChannels: 'dual'` is requested by default. On a mono recording the
   * barge-in measurement is an upper bound; on dual channels it is exact. Since
   * the whole point of a live call is to get the exact number, the cheap option
   * is not the default.
   */
  async connect(opts: ConnectOptions): Promise<ConnectResult> {
    const sr = opts.sampleRate ?? 16000

    // The sample rate rides on the stream URL as a query param, per Exotel.
    let streamUrl = opts.streamUrl
    if (!/[?&]sample-rate=/.test(streamUrl)) {
      streamUrl += (streamUrl.includes('?') ? '&' : '?') + `sample-rate=${sr}`
    }
    // Custom parameters are appended to the URL and come back in the `start`
    // event. Three max, 256 chars total.
    const cp = opts.customParameters ?? {}
    const cpKeys = Object.keys(cp).slice(0, 3)
    if (cpKeys.length) {
      const q = cpKeys.map(k => `${k}=${encodeURIComponent(cp[k])}`).join('&')
      streamUrl += (streamUrl.includes('?') ? '&' : '?') + q
    }

    const body: Record<string, unknown> = {
      From: opts.from,
      To: opts.to,
      CallerId: opts.callerId,
      StreamUrl: streamUrl,
      StreamType: 'bidirectional',
      Record: opts.record ?? true,
      RecordingChannels: opts.recordingChannels ?? 'dual',
    }
    if (opts.statusCallback) {
      body.StatusCallback = opts.statusCallback
      body.StatusCallbackEvents = ['answered', 'terminal']
    }

    const res = await fetch(`${this.baseUrl}/v1/Accounts/${this.creds.accountSid}/Calls/connect`, {
      method: 'POST',
      headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`Exotel connect failed ${res.status}: ${await res.text()}`)
    }
    const json = await res.json() as {
      Call?: { Sid?: string; CallSid?: string; Status?: string; StreamSid?: string }
    }
    return {
      callSid: json.Call?.Sid ?? json.Call?.CallSid ?? '',
      streamSid: json.Call?.StreamSid ?? '',
      callState: json.Call?.Status ?? 'unknown',
    }
  }

  /**
   * Fetch call details and the recording URL.
   *
   * The URL is time-limited by design, so a harness that intends to keep a
   * recording must download inside the window — Exotel's docs are explicit that
   * permanent storage requires pulling the file down.
   */
  async callDetails(callSid: string): Promise<{
    status: string
    durationSec: number
    recordingUrl: string | null
  }> {
    const res = await fetch(`${this.baseUrl}/v1/Accounts/${this.creds.accountSid}/Calls/${callSid}.json`, {
      headers: { Authorization: this.authHeader() },
    })
    if (!res.ok) return { status: 'unknown', durationSec: 0, recordingUrl: null }
    const json = await res.json() as {
      Call?: { Status?: string; Duration?: string; RecordingUrl?: string }
    }
    return {
      status: json.Call?.Status ?? 'unknown',
      durationSec: Number(json.Call?.Duration ?? 0),
      recordingUrl: json.Call?.RecordingUrl ?? null,
    }
  }

  async fetchRecording(url: string): Promise<Buffer | null> {
    // Recording URLs are pre-signed and time-limited, so they are fetched
    // without the API auth header — adding it can break an S3 signature.
    const res = await fetch(url)
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null
  }

  async hangup(callSid: string): Promise<void> {
    await fetch(`${this.baseUrl}/v1/Accounts/${this.creds.accountSid}/Calls/${callSid}.json`, {
      method: 'POST',
      headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ Status: 'completed' }),
    })
  }

  /** Validate credentials before dialling anything that costs money. */
  async ping(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/v2/accounts/${this.creds.accountSid}/calls?limit=1`, {
        headers: { Authorization: this.authHeader() },
      })
      if (res.status === 401) return { ok: false, detail: '401 — check API key and token in Dashboard > Settings > API Settings' }
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
      return { ok: true, detail: `credentials valid, region ${this.creds.region ?? 'singapore'}` }
    } catch (e) {
      return { ok: false, detail: `network: ${(e as Error).message}` }
    }
  }
}

/* ================================================================== *
 * Session: the WebSocket side
 * ================================================================== */

/**
 * One live call.
 *
 * Owns the recorder and turns Exotel's frames into the two sample-aligned WAVs
 * `measureBargeIn` needs. Both legs come from the same socket: inbound frames are
 * the caller, outbound frames are what Exotel played to the caller.
 *
 * The agent leg is recorded at SEND time, not playback time. The difference is
 * Exotel's own buffering, and it must not be folded into the agent's stop
 * latency — a mark round-trip is how that gap gets measured separately.
 */
export class ExotelSession {
  private recorder = new DualChannelRecorder(20)
  private ctx: ExotelStartCtx | null = null
  private agentFrames = 0
  private callerFrames = 0
  private marksSent = 0
    private marksPlayed = 0
    private stopReason: string | null = null
  private problems: string[] = []

  /** Callbacks the host wires to its WebSocket. */
  onCallerAudio?: (samples: Float32Array, tsMs: number) => Promise<void> | void
  onAgentAudio?: (samples: Float32Array) => Promise<void> | void

  constructor(private readonly send: (frame: ExotelOutbound) => Promise<void> | void) {}

  /** Feed every inbound JSON frame here. Unknown events are ignored, not fatal. */
  async handle(msg: ExotelInbound): Promise<void> {
    switch (msg.event) {
      case 'connected':
        break

      case 'start': {
        this.ctx = parseStart(msg)
        if (this.ctx.sampleRate !== 8000) {
          // The WAV writer and the acoustic bench are calibrated for 8 kHz.
          // 16k or 24k is better audio, but writing the header with the wrong
          // rate would make every duration in the bench wrong by a factor of two.
          this.problems.push(
            `stream is ${this.ctx.sampleRate} Hz but the recorder writes 8 kHz WAV headers -- ` +
            `either request ?sample-rate=8000 or resample before measuring, or every duration is wrong`,
          )
        }
        break
      }

      case 'media': {
        if (!msg.media?.payload) return
        const b64 = msg.media.payload
        this.recorder.addCallerFrame(b64)
        this.callerFrames++
        const ts = Number(msg.media.timestamp ?? 0)
        await this.onCallerAudio?.(decodePcm(b64), ts)
        break
      }

      case 'mark':
        this.marksPlayed++
        break

      case 'dtmf':
        break

      case 'stop':
        this.stopReason = msg.stop?.reason ?? 'unknown'
        break

      default:
        // `clear` from Exotel, or anything a future version adds. An unknown
        // event must never throw: a mid-call exception drops the test call and
        // loses the recording, which is the most expensive bug in this file.
        break
    }
  }

  get streamSid(): string { return this.ctx?.streamSid ?? '' }
  get callSid(): string { return this.ctx?.callSid ?? '' }
  get from(): string { return this.ctx?.from ?? '' }
  get to(): string { return this.ctx?.to ?? '' }

  /**
   * Play the agent's audio into the call.
   *
   * Split into compliant chunks and marked, so the harness can tell when Exotel
   * finished playing rather than assuming it did.
   */
  async say(samples: Float32Array, label?: string): Promise<void> {
    if (!this.streamSid) { this.problems.push('audio was handed to say() before the start event'); return }
    const frames = chunkPcm(samples, this.streamSid)
    for (const f of frames) {
      this.recorder.addAgentFrame(f.media!.payload)
      this.agentFrames++
      await this.send(f)
    }
    if (label) {
      this.marksSent++
      await this.send(exotelMark(this.streamSid, label))
    }
  }

  /** Cut the agent off mid-turn. This is what an interruption means. */
  async interrupt(): Promise<void> {
    if (this.streamSid) await this.send(exotelClear(this.streamSid))
  }

  /**
   * Produce the two legs plus an honest account of the call.
   *
   * The recording is kept WAV-per-leg rather than fetched from Exotel's
   * `RecordingChannels=dual` file, because the streamed legs are what the
   * measurements need and fetching adds a wait (Exotel processes recordings for
   * 1-5 minutes after the call ends).
   */
  finish(): {
    callerWav: Buffer
    agentWav: Buffer
    health: CallHealthLike
    problems: string[]
  } {
    const { callerWav, agentWav, coverage } = this.recorder.finish()
    const health: CallHealthLike = {
      connected: this.ctx != null,
      streamStarted: this.ctx != null,
      callerAudioMs: this.recorder.callerFrameCount * 20,
      agentAudioMs: this.recorder.agentFrameCount * 20,
      marksPlayed: this.marksPlayed,
      durationMs: this.recorder.durationMs,
    }

    const problems = [...this.problems, ...assertExotelCallReachedAgent(health)]
    if (this.marksSent > 0 && health.marksPlayed === 0) {
      problems.push(
        `${this.marksSent} mark(s) sent and none played back — Exotel buffered the audio ` +
        `but never confirmed it, so the caller may never have heard the agent`,
      )
    }
    if (this.stopReason === 'callended') {
      // Not an error. Worth recording, because a caller hanging up mid-turn is a
      // finding in its own right and not a harness failure.
      problems.push('caller hung up (stop reason: callended) — record whether they hung up mid-turn')
    }
    if (coverage.callerMs < coverage.expectedMs * 0.9) {
      problems.push(
        `caller audio is short by ${(coverage.expectedMs - coverage.callerMs).toFixed(0)}ms — ` +
        `the capture is incomplete, so any latency measured from it is unsafe`,
      )
    }
    return { callerWav, agentWav, health, problems }
  }

}

export interface CallHealthLike {
  connected: boolean
  streamStarted: boolean
  callerAudioMs: number
  agentAudioMs: number
  marksPlayed: number
  durationMs: number
}

/**
 * The false-green guard, Exotel's vocabulary.
 *
 * Same reasoning as the Twilio version — a live harness fails SILENTLY, and a
 * gate that reports "no issues" for a call that never connected is worse than
 * useless — but the causes are Exotel-specific. `AgentStream` has to be enabled
 * on the account, and it is not on by default, so the most likely first-run
 * failure is a stream that simply never opens.
 */
export function assertExotelCallReachedAgent(h: CallHealthLike): string[] {
  const problems: string[] = []
  if (!h.connected) {
    problems.push(
      'the stream never sent a start event — check AgentStream is enabled on the account ' +
      '(contact hello@exotel.com if it is not in the dashboard) and that streamUrl is a public wss:// endpoint',
    )
  }
  if (!h.streamStarted && h.connected) {
    problems.push('connected but no start event — StreamType must be "bidirectional" for a bot to speak')
  }
  if (h.callerAudioMs <= 0) {
    problems.push('no caller audio arrived — the number did not answer, so nothing downstream measured a real conversation')
  }
  if (h.agentAudioMs <= 0) {
    problems.push('the agent produced no audio — the STRUCTURE passed, the CONTENT did not. This is a false green: do not report it as a pass')
  }
  if (h.marksPlayed === 0 && h.agentAudioMs > 0) {
    problems.push('agent audio was sent but Exotel never confirmed playback with a mark — the caller likely never heard it')
  }
  if (h.durationMs < 500) {
    problems.push(`call lasted only ${h.durationMs.toFixed(0)}ms — too short to measure turn-taking, so latency should be NO DATA rather than 0`)
  }
  return problems
}
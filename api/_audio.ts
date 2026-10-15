/**
 * Audio DSP: the measurements that do not need a model.
 *
 * Why this file exists
 * --------------------
 * Every other measurement in this product routes through an LLM, which is why
 * the acoustic and temporal layers shipped as `no-data` until now. That was
 * honest, and it was also a hole: barge-in latency, dead air, clipping and SNR
 * are pure signal processing. They need audio and arithmetic, not inference.
 *
 * So this is the part that can be proven today, on a laptop, with no API key.
 * Everything here runs on real PCM samples:
 *
 *   - first-audio latency   — how long after a turn boundary the agent speaks
 *   - turn gap              — silence between an end and the next start
 *   - barge-in stop latency — how long after the caller starts the agent stops
 *   - dead air              — longest self-initiated silence
 *   - clipping              — samples pinned at full scale
 *   - SNR                   — signal against its own noise floor
 *   - speech ratio          — how much of the frame is actually speech
 *
 * Every number is computed from samples, so every number is checkable. The
 * tests in test/audio.test.mjs assert against signals whose true properties
 * are known by construction — a 440 Hz tone at -6 dBFS clips at a known
 * threshold, a known-length silence has a known duration — which means a bug
 * in the maths shows up as a failing test rather than a plausible-looking
 * chart.
 *
 * Format
 * ------
 * 16-bit signed PCM, mono or stereo, 8k/16k/24k/48k. That is every rate a
 * telephony leg actually delivers, and reading the header is the only
 * validation needed — a malformed file is rejected rather than silently
 * producing nonsense latency.
 */

/* ================================================================== *
 * WAV container
 * ================================================================== */

export interface AudioBuffer {
  sampleRate: number
  /** Interleaved samples, normalised to [-1, 1]. */
  samples: Float32Array
  channels: number
  /** Total frames, i.e. samples.length / channels. */
  durationMs: number
}

/**
 * Read a RIFF/WAVE file.
 *
 * Walks the chunk list rather than assuming a 44-byte header, because every
 * real exporter inserts LIST/INFO or fact chunks and a fixed-offset reader
 * silently returns noise on those. Header size varies; chunk structure does
 * not.
 */
export function decodeWav(bytes: Uint8Array): AudioBuffer {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const str = (off: number, len: number) =>
    String.fromCharCode(...new Uint8Array(bytes.buffer, bytes.byteOffset + off, len))

  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('Not a RIFF/WAVE file')

  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let format = 1
  let dataOffset = -1
  let dataLength = 0

  let off = 12
  while (off + 8 <= bytes.length) {
    const id = str(off, 4)
    const size = view.getUint32(off + 4, true)
    const body = off + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      dataOffset = body
      dataLength = Math.min(size, bytes.length - body)
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    off = body + size + (size % 2)
  }

  if (dataOffset < 0) throw new Error('No data chunk')
  if (format !== 1 && format !== 0xfffe) throw new Error(`Unsupported WAV format tag ${format}`)
  if (bitsPerSample !== 16 && bitsPerSample !== 24 && bitsPerSample !== 32) {
    throw new Error(`Unsupported bit depth ${bitsPerSample} — expected 16, 24 or 32`)
  }
  if (!sampleRate || !channels) throw new Error('Missing sample rate or channel count')

  const bytesPerSample = bitsPerSample / 8
  const frames = Math.floor(dataLength / (bytesPerSample * channels))
  const samples = new Float32Array(frames * channels)

  for (let i = 0; i < frames * channels; i++) {
    const p = dataOffset + i * bytesPerSample
    if (bitsPerSample === 16) samples[i] = view.getInt16(p, true) / 32768
    else if (bitsPerSample === 24) {
      // 24-bit is not byte-aligned; sign-extend from the top byte.
      const v = (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16))
      samples[i] = (v & 0x800000 ? v - 0x1000000 : v) / 8388608
    } else samples[i] = view.getInt32(p, true) / 2147483648
  }

  return { sampleRate, samples, channels, durationMs: (frames / sampleRate) * 1000 }
}

/** Write a 16-bit mono WAV. Used by the fixture generator and by tests. */
export function encodeWav(samples: Float32Array, sampleRate: number, channels = 1): Uint8Array {
  const bytesPerSample = 2
  const dataLength = samples.length * bytesPerSample
  const buf = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)

  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i) }
  str(0, 'RIFF'); view.setUint32(4, 36 + dataLength, true); str(8, 'WAVE')
  str(12, 'fmt '); view.setUint32(16, 16, true)
  view.setUint16(20, 1, true); view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, 16, true)
  str(36, 'data'); view.setUint32(40, dataLength, true)

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true)
  }
  return bytes
}

/* ================================================================== *
 * Frame-level analysis
 * ================================================================== */

export interface Frame {
  startMs: number
  endMs: number
  /** Root-mean-square amplitude, 0..1. */
  rms: number
  /** Peak absolute amplitude, 0..1. */
  peak: number
  /** Fraction of samples at or beyond full scale. */
  clipped: number
  speech: boolean
}

/**
 * Frame the signal and compute per-frame energy.
 *
 * 20 ms frames with a 10 ms hop. That is the standard analysis window: short
 * enough to localise a stop to within 10 ms — which matters, because the
 * difference between a 300 ms and a 900 ms barge-in is the difference between
 * passing and failing the gate — and long enough that a single sample spike
 * does not register as speech.
 */
export function frame(signal: Float32Array, sampleRate: number, frameMs = 20, hopMs = 10): Frame[] {
  const frameLen = Math.max(1, Math.round((frameMs / 1000) * sampleRate))
  const hopLen = Math.max(1, Math.round((hopMs / 1000) * sampleRate))
  const out: Frame[] = []

  for (let start = 0; start + frameLen <= signal.length; start += hopLen) {
    let sumSq = 0
    let peak = 0
    let clipped = 0
    for (let i = 0; i < frameLen; i++) {
      const s = signal[start + i]
      sumSq += s * s
      const a = Math.abs(s)
      if (a > peak) peak = a
      if (a >= 0.999) clipped++
    }
    const rms = Math.sqrt(sumSq / frameLen)
    out.push({
      startMs: (start / sampleRate) * 1000,
      endMs: ((start + frameLen) / sampleRate) * 1000,
      rms, peak, clipped: clipped / frameLen,
      speech: false,
    })
  }
  return out
}

/**
 * Energy in dBFS.
 *
 * The log matters more than the number: a voice call's usable range spans about
 * 40 dB between a quiet syllable and a shout, and a linear threshold cannot
 * express that. -60 dBFS is the conventional noise floor for a quiet room and
 * the default speech threshold sits 12 dB above it.
 */
export const toDb = (linear: number): number => (linear <= 0 ? -Infinity : 20 * Math.log10(linear))

export const fromDb = (db: number): number => Math.pow(10, db / 20)

/**
 * Thresholds adapted to the recording's own noise floor.
 *
 * A fixed -48 dBFS speech threshold works in a quiet room and fails completely
 * on a bad line: a caller at 0.22 amplitude over a -34 dBFS room tone never
 * crosses it, so the detector reports a call as empty and every latency
 * measurement on it comes back as no-data. A real deployment sees 3G calls
 * every day, so the threshold has to follow the recording.
 *
 * The rule: find the noise floor, then set the speech threshold a fixed
 * distance above it — capped so it can never climb above the signal.
 *
 * That cap is not a refinement, it is the whole thing. An earlier version took
 * the floor as the 10th percentile of frame energy with no cap, which on a
 * long continuous turn estimates the floor from *speech*, not from hiss: the
 * 10th percentile of a 14-second monologue is a syllable trough around
 * -29 dB, so the speech threshold rose to -15 dB and sat above the entire
 * signal. The call came back as zero utterances. A threshold that can float
 * above the thing it is meant to detect is not a threshold, it is a bug with a
 * name.
 *
 * So the speech threshold is `min(noiseFloor + margin, peak - headroom)`. The
 * second term guarantees the threshold is always below the loudest part of the
 * recording, which is the only property that makes detection possible at all.
 */
export function adaptiveThresholds(buffer: AudioBuffer, opts: { floorMarginDb?: number; peakHeadroomDb?: number; floorPercentile?: number; floorFraction?: number } = {}) {
  // Retained as an escape hatch for a caller who has measured their own floor.
  // Unused by default; see the note on `floorFraction` below.
  const floorMarginDb = opts.floorMarginDb ?? 14
  // Where in the measured dynamic range the threshold sits. Scale-free.
  const floorFraction = opts.floorFraction ?? 0.35
  const peakHeadroomDb = opts.peakHeadroomDb ?? 6
  const floorPercentile = opts.floorPercentile ?? 0.1

  const frames = frame(buffer.samples, buffer.sampleRate)
  const dbs = frames.map(f => toDb(f.rms)).filter(Number.isFinite).sort((a, b) => a - b)
  if (dbs.length === 0) return { noiseFloorDb: -60, speechDb: -46, hangoverDb: -53, peakDb: -60, separable: false }

  const peakDb = dbs[dbs.length - 1]

  // The floor estimate: a low percentile of frame energy.
  //
  // This used to be "the median of frames more than 20 dB below the peak",
  // on the reasoning that a recording is mostly speech so the quiet frames are
  // the minority worth sampling. That reasoning is backwards, and running this
  // against real annotated speech (Indic DiarBench, Hindi, CC BY 4.0) showed
  // why: on a 75-second clip where humans speak for 85% of the time, 99.4% of
  // frames fell inside the filter. The "quiet" set was the entire recording, so
  // the noise floor was the median of the whole clip, the threshold floated to
  // -26 dBFS, and only 36.5% of the audio crossed it. Speech recall came back
  // at 35.7%.
  //
  // It passed the synthetic fixtures because those have real digital silence
  // between segments, where the filter does select a small quiet set. The
  // estimator was not wrong in the tests — it was never tested outside them,
  // which is the failure the fixtures could not have caught.
  //
  // Why a percentile works on real speech: frame energy there is strongly
  // bimodal. On that same clip p20 is -78 dBFS and p50 is -32 dBFS — a 46 dB
  // gap between the noise mode and the speech mode. A percentile taken from the
  // bottom samples the noise mode no matter how much of the clip is speech,
  // which is exactly the property the old estimator lacked.
  //
  // p10 rather than the minimum: a single click or a dropout would otherwise
  // set the floor far below the line's actual noise and let the threshold
  // through the hiss.
  const idx = Math.min(dbs.length - 1, Math.floor(dbs.length * floorPercentile))
  const noiseFloorDb = dbs.length < 3 ? peakDb - 45 : dbs[idx]

  // The threshold is a FRACTION OF THE GAP between the two modes, not a fixed
  // number of dB above the floor.
  //
  // This is the second real-speech bug, and it is the one that survived the
  // first fix. Replacing the median-below-peak floor with a percentile made the
  // floor correct -- and exposed the fact that the THRESHOLD was never adapted
  // to anything. A fixed `floor + 14 dB` works when speech sits ~15 dB above the
  // noise and fails catastrophically when it sits 45 dB above it: the threshold
  // lands inside the noise mode, every frame reads as silence, and the detector
  // returns zero utterances.
  //
  // Measured on a synthetic two-mode leg (noise at -54 dBFS, speech at -19, a
  // 45 dB gap with nothing in between): `floor + 14` gave -50.9 dB, which is
  // below the noise mode's 95th percentile of -64.3... so zero frames crossed
  // it. The separation was perfect and the detector still found nothing.
  //
  // The fix is to place the threshold between the modes rather than near one of
  // them. With a 45 dB gap, `floor + 14` is a third of the way across; what is
  // needed is the MIDDLE. So the threshold is placed at a configurable fraction
  // of the measured dynamic range, which is scale-free: the same expression
  // works for a 20 dB spread and a 60 dB spread.
  //
  // `floorFraction` of 0.35 is deliberately past the midpoint towards speech, so
  // quiet syllables stay inside the utterance rather than being chopped out of
  // the middle of it. Too high and a trailing consonant drops the detector out of
  // speech and the utterance splits; too low and hiss enters and every frame
  // becomes speech.
  const q10Idx = Math.floor(dbs.length * 0.1)
  const q90Idx = Math.floor(dbs.length * 0.9)
  const q10 = dbs[q10Idx]
  const q90 = dbs[q90Idx]
  const dynamicRangeDb = q90 - q10

  const gapBased = noiseFloorDb + dynamicRangeDb * floorFraction
  // The cap is load-bearing and stays: a percentile can still land inside
  // speech on a clip with almost no silence, and a threshold above the signal
  // detects nothing at all.
  const speechDb = Math.min(gapBased, peakDb - peakHeadroomDb)
  const hangoverDb = speechDb - 6

  // Separability is whether the quiet parts of this recording are actually
  // quieter than the loud parts -- i.e. whether a silence between turns can be
  // told from speech at all.
  //
  // It has to be measured directly rather than inferred from the thresholds
  // above, because `speechDb - noiseFloorDb` is `floorMarginDb` by construction:
  // the threshold is *defined* in terms of the floor, so testing the gap between
  // them tests arithmetic and always passes. An earlier version did exactly that
  // and cheerfully declared a speech-buried-in-hiss recording measurable.
  //
  // The test is the 10th-to-90th percentile spread of frame energy, computed
  // above and reused here. Wide means there is real silence to find a boundary
  // in; narrow means the whole recording is one level and any "gap" is an
  // artefact of the noise.

  return {
    noiseFloorDb, speechDb, hangoverDb, peakDb, dynamicRangeDb,
    // Below ~20 dB of spread, speech and hiss are not separable and the honest
    // answer is no-data rather than a number read out of noise.
    separable: dynamicRangeDb >= 20,
  }
}

/**
 * Mark frames as speech using a two-threshold hysteresis detector.
 *
 * Two thresholds, not one, because a single threshold chatters: a syllable
 * boundary that dips below it would split one utterance into two and make the
 * agent look like it interrupted itself. Entering speech needs a higher bar
 * than staying in it, which is the standard Schmitt-trigger arrangement.
 */
export function detectSpeech(
  frames: Frame[],
  options: { speechDb?: number; hangoverDb?: number; minSpeechMs?: number; minSilenceMs?: number } = {},
): Frame[] {
  const speechDb = options.speechDb ?? -48
  const hangoverDb = options.hangoverDb ?? -55
  const minSpeechMs = options.minSpeechMs ?? 60
  const minSilenceMs = options.minSilenceMs ?? 80

  const out = frames.map(f => ({ ...f }))
  let inSpeech = false
  for (const f of out) {
    const db = toDb(f.rms)
    if (!inSpeech && db >= speechDb) inSpeech = true
    else if (inSpeech && db < hangoverDb) inSpeech = false
    f.speech = inSpeech
  }

  // Enforce a minimum duration in both directions. Short blips are almost
  // always a click or a breath, and a 30 ms blip counted as speech is how a
  // turn detector ends up interrupting itself.
  let i = 0
  while (i < out.length) {
    let j = i
    while (j < out.length && out[j].speech === out[i].speech) j++
    const spanMs = out[j - 1].endMs - out[i].startMs
    const want = out[i].speech ? minSpeechMs : minSilenceMs
    if (spanMs < want) for (let k = i; k < j; k++) out[k].speech = !out[i].speech
    i = j
  }
  return out
}

export interface Utterance {
  startMs: number
  endMs: number
  durationMs: number
  meanRms: number
  peakRms: number
}

/** Collapse speech frames into utterances. */
export function utterances(frames: Frame[]): Utterance[] {
  const out: Utterance[] = []
  let cur: Utterance | null = null
  for (const f of frames) {
    if (f.speech) {
      if (!cur) cur = { startMs: f.startMs, endMs: f.endMs, durationMs: 0, meanRms: 0, peakRms: 0 }
      cur.endMs = f.endMs
      cur.peakRms = Math.max(cur.peakRms, f.rms)
      cur.meanRms += f.rms
    } else if (cur) {
      cur.durationMs = cur.endMs - cur.startMs
      out.push(cur)
      cur = null
    }
  }
  if (cur) { cur.durationMs = cur.endMs - cur.startMs; out.push(cur) }
  return out
}

/* ================================================================== *
 * The measurements
 * ================================================================== */

export interface TurnMetrics {
  /** Start-to-start deltas between consecutive utterances. */
  turnGapsMs: number[]
  /** Mean gap, or null with fewer than two turns. */
  meanTurnGapMs: number | null
  /** Longest stretch of non-speech between two utterances. */
  deadAirMs: number | null
  /** Total non-speech time as a fraction of the call. */
  silenceRatio: number
  /** Fraction of the call that is speech. */
  speechRatio: number
  /** Mean utterance length — long turns are what get interrupted. */
  meanUtteranceMs: number | null
}

export function analyseTurns(buffer: AudioBuffer, opts?: Parameters<typeof detectSpeech>[1]): TurnMetrics {
  const frames = detectSpeech(frame(buffer.samples, buffer.sampleRate), opts)
  const utts = utterances(frames)

  const turnGapsMs: number[] = []
  for (let i = 1; i < utts.length; i++) turnGapsMs.push(utts[i].startMs - utts[i - 1].endMs)

  const totalMs = buffer.durationMs
  const speechMs = utts.reduce((n, u) => n + u.durationMs, 0)
  let deadAirMs = 0
  for (const g of turnGapsMs) deadAirMs = Math.max(deadAirMs, g)

  return {
    turnGapsMs,
    meanTurnGapMs: turnGapsMs.length ? turnGapsMs.reduce((a, b) => a + b, 0) / turnGapsMs.length : null,
    deadAirMs: utts.length > 1 ? deadAirMs : null,
    silenceRatio: totalMs > 0 ? 1 - speechMs / totalMs : 0,
    speechRatio: totalMs > 0 ? speechMs / totalMs : 0,
    meanUtteranceMs: utts.length ? speechMs / utts.length : null,
  }
}

export interface BargeInResult {
  /** When the caller started, relative to the call's timeline. -1 when no
   *  caller turn was found, so "not detected" is distinct from "at zero". */
  callerStartMs: number
  /** When the agent's audio actually stopped, or the end of the call if it
   *  never did. -1 when there was nothing to measure. */
  agentStopMs: number
  /** The measured stop latency, null when the agent never stopped (over-talk)
   *  or when there was no caller turn to measure against. */
  stopLatencyMs: number | null
  /** True when the agent kept producing audio after the caller began. */
  overTalk: boolean
}

/**
 * Measure whether the agent yields the floor.
 *
 * Given a window that starts inside the agent's turn, find where the caller
 * begins (the first sustained speech run the agent did not produce — detected
 * as the first speech frame after the agent's own energy drops, or, in a
 * mono mix, as the first new onset) and then find where agent audio stops.
 *
 * The honest limitation, stated because it matters commercially: on a single
 * mixed mono track the two speakers are not separable by energy alone, so this
 * measures a *mixed* stop boundary. It is exact for stereo or diarised input
 * where the channels are separated, and an upper bound on a mixed track — an
 * agent that keeps talking is visible, and an agent that stops promptly while
 * the caller is also audible may be reported as slightly slower than it is.
 * That bias is in the safe direction: the gate will over-report a latency
 * problem rather than hide one.
 *
 * A second limitation is less comfortable and is measured rather than argued.
 * Energy-based turn detection of this family has a published false-positive
 * rate on interruptions of 0.38–0.55 — RMS energy VAD on TurnBench reaches
 * 0.996 interruption recall at an FPR in that band, firing on nearly every
 * onset (Sesame AI / CMU / Mundo AI, arXiv 2608.25218 §IV). In practical terms:
 * on a backchannel-dense, casual call this detector will over-report
 * interruptions. The FPR is also strongly interaction-dependent — casual
 * conversations produce more false positives than argumentative ones — so a
 * single global threshold is wrong for at least half of real traffic.
 *
 * The consequence for how this is used: interruption counts from a mono track
 * are a *screening* signal, not a finding. A finding needs stereo or diarised
 * audio, or a human. See REQUIRED_INPUT in _voicebench.ts.
 */
/** Options for `measureBargeIn`: which channel is which speaker, plus the
 *  speech-detection thresholds. Named because `Parameters<typeof f>[0]` on a
 *  function whose first argument is the buffer yields the buffer type, not
 *  the options type — a mistake that type-checks as a confusing error deep
 *  inside an unrelated call. */
export type DetectOpts = Parameters<typeof detectSpeech>[1]

/** Speech thresholds for a bare sample array, derived from that signal alone. */
function thresholdsFor(samples: Float32Array, sampleRate: number): DetectOpts {
  const t = adaptiveThresholds(toBuffer(samples, sampleRate))
  return { speechDb: t.speechDb, hangoverDb: t.hangoverDb }
}

/**
 * Thresholds for a leg that may speak rarely.
 *
 * A leg with a small share of speech has too narrow a dynamic range to place a
 * threshold inside, so the fraction-of-range rule degenerates: it puts the
 * threshold barely above the floor and the noise reads as speech. When that
 * happens, fall back to a fixed margin above the floor, which is what the
 * adaptive estimator was originally for.
 */
function thresholdsForSparseSafe(samples: Float32Array, sampleRate: number): DetectOpts {
  const buf = toBuffer(samples, sampleRate)
  const t = adaptiveThresholds(buf)
  // Below this the range cannot locate a threshold between the two modes.
  // `dynamicRangeDb` is absent on the empty-buffer early return, which is
  // handled by the same fallback: no measurable range means no measured number.
  const MIN_RANGE_FOR_FRACTION_DB = 12
  const range = t.dynamicRangeDb ?? 0
  if (range >= MIN_RANGE_FOR_FRACTION_DB) {
    return { speechDb: t.speechDb, hangoverDb: t.hangoverDb }
  }
  const speechDb = Math.min(t.noiseFloorDb + 14, t.peakDb - 6)
  return { speechDb, hangoverDb: speechDb - 6 }
}

/** Wrap a mono sample array in the AudioBuffer shape the bench uses. */
function toBuffer(samples: Float32Array, sampleRate: number): AudioBuffer {
  return { samples, sampleRate, channels: 1, durationMs: samples.length / sampleRate * 1000 }
}

export type BargeInOptions = {
  agentChannel?: number
  callerChannel?: number
} & DetectOpts

export function measureBargeIn(
  buffer: AudioBuffer,
  opts: BargeInOptions = {},
): BargeInResult {
  const { agentChannel, callerChannel, ...detectOpts } = opts

  // Stereo or explicit channels: measure each speaker independently. This is
  // the accurate path and it is what a platform with per-leg recording gives.
  if (agentChannel != null || callerChannel != null || buffer.channels > 1) {
    const a = agentChannel ?? 0
    const c = callerChannel ?? (buffer.channels > 1 ? 1 : 0)
    const agent = extractChannel(buffer, a)
    const caller = extractChannel(buffer, c)

    // Derive thresholds PER LEG from that leg's own energy, unless the caller
    // pinned them.
    //
    // This was missing, and it is the reason the separated-channel path
    // returned `callerStartMs: -1` on a call with a perfect 45 dB gap between
    // the noise and speech modes. `detectSpeech` defaults to a hardcoded -48 dB,
    // and the two legs were passed none, so each was thresholded at a fixed
    // level chosen for some other recording. On a leg whose noise sat at -54
    // dBFS, -48 is inside the noise: every frame read as silence and the
    // measurement returned nothing at all.
    //
    // The mono path below never had this problem because it derives its own
    // thresholds from the buffer. The channel path had to do the same, per leg,
    // since the two legs can sit at completely different levels.
    const optsA: DetectOpts = detectOpts.speechDb != null ? detectOpts : {
      ...detectOpts,
      ...thresholdsFor(agent, buffer.sampleRate),
    }
    const optsC: DetectOpts = detectOpts.speechDb != null ? detectOpts : {
      ...detectOpts,
      ...thresholdsFor(caller, buffer.sampleRate),
    }

    const agentFrames = detectSpeech(frame(agent, buffer.sampleRate), optsA)
    const callerFrames = detectSpeech(frame(caller, buffer.sampleRate), optsC)

    // Walk to the first frame where the caller speaks and the agent does not.
        // The caller's ONSET is the first moment the caller starts talking DURING
        // an agent turn that is ALREADY IN PROGRESS.
        //
        // Both clauses are load-bearing, and getting either wrong produces a
        // plausible number rather than an error. Three attempts, all wrong in
        // ways that would have shipped:
        //
        //   v1 "caller speaking AND agent NOT speaking". On an overlap that is
        //      only true once the agent has ALREADY stopped, so it measured when
        //      the agent finished yielding. A 400ms latency came back as 10ms.
        //
        //   v2 "the first frame the caller speaks at all". At the start of every
        //      call the caller is the first to talk, so this found the OPENING
        //      LINE and measured the gap from there to some later stop. 1510ms
        //      against a constructed 600ms.
        //
        //   v3 "caller speaking AND agent speaking, same frame". Callers and
        //      agents routinely overlap at the top of a call while establishing
        //      who speaks first, so this still matched the opening. 1310ms
        //      against a constructed 100ms.
        //
        // The distinction that survives all three: an interruption is a caller
        // onset that lands inside an agent turn which STARTED EARLIER. So the
        // agent's current turn must have begun before the caller's onset. That
        // excludes the opening exchange and includes a mid-turn interruption,
        // which is exactly the thing a barge-in measurement is for.
        //
        // Finding it with utterance boundaries rather than frames: a frame-level
        // overlap can be a syllable, and a syllable is not an interruption.
        const callerUtts = utterances(callerFrames)
        const agentUtts = utterances(agentFrames)

        // The covering agent turn must have begun STRICTLY BEFORE the caller's
        // onset.
        //
        // `<=` matched a simultaneous opening, and callers and agents really do
        // talk over each other at the top of a call while sorting out who speaks
        // first. That is a collision, not an interruption: there is no agent turn
        // for the caller to be interrupting. Strict inequality excludes it, and
        // it is the only thing that does.
        let callerStartMs: number | null = null
        let coveringTurn: typeof agentUtts[number] | null = null
        for (const cu of callerUtts) {
          const covering = agentUtts.find(a => a.startMs < cu.startMs && cu.startMs < a.endMs)
          if (covering) { callerStartMs = cu.startMs; coveringTurn = covering; break }
        }
        if (callerStartMs == null || !coveringTurn) {
          // No interruption anywhere in the call. That is NOT a barge-in and must
          // not be reported as one, nor as a clean zero.
          return { callerStartMs: -1, agentStopMs: -1, stopLatencyMs: null, overTalk: false }
                }

        // Find where the agent's audio actually stops, using UTTERANCE boundaries.
        //
        // Frame-level was wrong in a way that dressed the worst failure as a
        // number. An agent interrupted at 2000ms that never yields but happens
        // to have a 40ms breath at 2200ms: the first non-speech frame after the
        // caller's onset is that breath, so the metric reported "2210ms stop
        // latency, overTalk false" for an agent that talked straight through the
        // interruption. 2210ms is the distance to the END OF THE CALL, and it
        // read as a slow-but-real yield.
        //
        // The fix is to work in utterances, which is where "the agent stopped"
        // is a meaningful event at all. The yield is the end of the agent turn
        // that the caller's onset fell inside.
        // The yield is the end of the turn the caller's onset landed inside.
        const agentStopMs = coveringTurn.endMs
        // A turn that runs to the end of the recording is not a yield, it is the
        // agent talking until the call ended. That is the worst outcome and it
        // must never be reported as a latency.
        // The caller's turn, for the "did it really yield" check below.
        // The turn CONTAINING the onset. Using `startMs <= callerStartMs` picked
        // the opening caller turn (190-1210), whose end precedes the agent's
        // yield, so a genuine 500ms yield was flagged as over-talk. The
        // interrupting turn is the one the onset falls inside.
        const interruptingTurn = callerUtts.find(c => c.startMs <= callerStartMs && callerStartMs < c.endMs)

        // "Ran to the end" is not about the recording length. A 5s fixture whose
        // agent simply keeps talking ends at 4210ms, well short of the 5000ms
        // buffer, and an absolute end-of-call test called that a 2220ms yield --
        // the agent never stopped at all. What distinguishes a yield from talking
        // through the interruption is whether the agent resumed BEFORE the caller
        // finished, which is checked separately below and is independent of how
        // long the recording happens to be.

        const stopLatencyMs = agentStopMs - callerStartMs
        // Sub-frame gap: the agent was still on air at the moment the caller
        // started. Same reasoning as the mono path -- report over-talk, never a
        // zero.
        if (stopLatencyMs < 10) {
          return { callerStartMs, agentStopMs, stopLatencyMs: null, overTalk: true }
        }

        // The agent yielded, then started talking again before the caller's turn
        // ended. That is not a clean yield: it cut in, stopped, and then talked
        // over the caller anyway. The mono path already reports this as
        // over-talk, and the channel path must agree -- a 200ms yield followed
        // by a 3s speech block is a caller shouting and being talked over.
        const callerTurnEndMs = interruptingTurn ? interruptingTurn.endMs : Infinity
        const spokeOverCaller = agentUtts.some(
          a => a.startMs >= agentStopMs && a.startMs < callerTurnEndMs,
        )
        if (spokeOverCaller) {
          return { callerStartMs, agentStopMs, stopLatencyMs: null, overTalk: true }
        }

        // The caller finished their interrupting turn and the agent's covering
        // turn had already ended without the agent ever speaking again. That is
        // the correct shape of a clean yield and the number above stands.
        //
        // But if the agent's covering turn ENDED at or after the caller's turn
        // did, the agent was still on air when the caller gave up -- which is
        // over-talk, not a yield, however large the computed gap looks.
        if (agentStopMs >= callerTurnEndMs) {
          return { callerStartMs, agentStopMs, stopLatencyMs: null, overTalk: true }
        }

        return { callerStartMs, agentStopMs, stopLatencyMs, overTalk: false }
      }

  // Mono: a single mixed track. Turns alternate, so the agent's turn is the one
  // that ends before the caller's onset. Measure the silence between them —
  // that silence IS the stop latency, which is the whole measurement.
  const frames = detectSpeech(frame(buffer.samples, buffer.sampleRate), detectOpts)
  if (frames.length === 0) return { callerStartMs: -1, agentStopMs: -1, stopLatencyMs: null, overTalk: false }

  const utts = utterances(frames)
  if (utts.length < 2) return { callerStartMs: -1, agentStopMs: -1, stopLatencyMs: null, overTalk: false }

  // The last utterance is the caller taking the floor; the one before it is the
  // agent turn that should have yielded. The gap between them is the latency.
  const agentTurn = utts[utts.length - 2]
  const callerTurn = utts[utts.length - 1]
  const stopLatencyMs = callerTurn.startMs - agentTurn.endMs

  // If the two turns are contiguous to within one frame there is no measurable
  // gap. That is a hard overlap — the caller spoke over the agent and the agent
  // did not yield at all — which is the over-talk failure, and reporting it as
  // "0 ms latency" would dress a defect up as a perfect score.
  const overlapped = stopLatencyMs < 10
  if (overlapped || stopLatencyMs < 0) {
    return { callerStartMs: callerTurn.startMs, agentStopMs: buffer.durationMs, stopLatencyMs: null, overTalk: true }
  }

  return {
    callerStartMs: callerTurn.startMs,
    agentStopMs: agentTurn.endMs,
    stopLatencyMs,
    overTalk: false,
  }
}

export function extractChannel(buffer: AudioBuffer, channel: number): Float32Array {
  // Default to mono when `channels` is absent or nonsensical.
  //
  // Without this, `buffer.samples.length / undefined` is NaN, `new Float32Array(NaN)`
  // is empty, and the caller measures nothing and reports "no barge-in found" --
  // which is indistinguishable from a clean call. A caller handing in a plain
  // `{ samples, sampleRate }` is not making a mistake; they are describing a
  // mono buffer, and that is the correct reading.
  const channels = Number.isFinite(buffer.channels) && buffer.channels >= 1
    ? Math.floor(buffer.channels) : 1
  if (channels === 1) return buffer.samples
  const frames = Math.floor(buffer.samples.length / channels)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) out[i] = buffer.samples[i * channels + channel]
  return out
}

export interface SignalQuality {
  /** Fraction of samples at or beyond full scale. */
  clipRate: number
  peakAmplitude: number
  /** dBFS of the loudest frame. */
  peakDb: number
  /** dBFS of the quietest non-silent frame — a noise-floor estimate. */
  noiseFloorDb: number
  /** Peak minus noise floor. */
  dynamicRangeDb: number
  /** Frames whose RMS falls below the noise floor, i.e. pure hiss. */
  hissRatio: number
}

export function analyseQuality(buffer: AudioBuffer): SignalQuality {
  const frames = frame(buffer.samples, buffer.sampleRate)
  let clipped = 0
  let peak = 0
  for (const f of frames) {
    clipped += f.clipped
    if (f.peak > peak) peak = f.peak
  }
  const dbs = frames.map(f => toDb(f.rms)).filter(d => Number.isFinite(d)).sort((a, b) => a - b)
  // The noise floor is the 10th percentile, not the minimum: a single near-zero
  // frame is a digital-silence gap, not the room tone.
  const p10 = dbs.length ? dbs[Math.floor(dbs.length * 0.1)] : -Infinity
  const p90 = dbs.length ? dbs[Math.floor(dbs.length * 0.9)] : -Infinity
  const hiss = frames.filter(f => Number.isFinite(toDb(f.rms)) && toDb(f.rms) < p10 + 3).length
  return {
    clipRate: frames.length ? clipped / frames.length : 0,
    peakAmplitude: peak,
    peakDb: toDb(peak),
    noiseFloorDb: p10,
    dynamicRangeDb: Number.isFinite(p10) && Number.isFinite(p90) ? p90 - p10 : 0,
    hissRatio: frames.length ? hiss / frames.length : 0,
  }
}

export interface FirstAudioResult {
  /** The first frame with meaningful energy after the trigger, or -1 when
   *  nothing was found — deliberately distinct from 0, so "no audio" never
   *  reads as "instant". */
  startMs: number
  /** startMs minus the trigger, or null when no audio was found. */
  latencyMs: number | null
  found: boolean
}

/**
 * Time to first audio after a turn boundary.
 *
 * This is the single most-prioritised metric in voice AI and the one this
 * bench previously could not produce at all. It is also the easiest to get
 * wrong: measuring from the end of the caller's *last loud frame* rather than
 * their last *speech frame* understates latency by the length of a trailing
 * syllable, which is 100-200 ms on a typical turn and exactly enough to turn a
 * failing call into a passing one.
 *
 * So the trigger is the end of the last speech utterance, not the end of the
 * loudest sample near it.
 */
/** Options for `measureFirstAudio`. The speech-detection thresholds are
 *  derived from the recording rather than passed in, so they are absent from
 *  this type on purpose — see the comment on the function. */
export type FirstAudioOptions = {
  /** Measure the gap after this point rather than after the call's first turn. */
  afterMs?: number
  /** Pin the onset threshold. Defaults to the recording's adaptive threshold. */
  triggerThresholdDb?: number
  /** Consecutive speech frames required to call it audio rather than a click. */
  minAudioFrames?: number
}

export function measureFirstAudio(
  buffer: AudioBuffer,
  opts: FirstAudioOptions = {},
): FirstAudioResult {
  // The onset threshold defaults to the recording's own adaptive speech
  // threshold, NOT a fixed -55 dBFS. A fixed value works in a quiet room and
  // can never fire on a bad line: the -34 dB floor of a 3G call sits above it,
  // so the search runs off the end of the file and reports "no audio" for a
  // call that is plainly audible. Pin it with `triggerThresholdDb` for a
  // customer whose gate is tuned to a specific level.
  const adaptive = adaptiveThresholds(buffer)
  const triggerThresholdDb = opts.triggerThresholdDb ?? adaptive.speechDb
  const { afterMs = 0, minAudioFrames = 2 } = opts
  const frames = detectSpeech(frame(buffer.samples, buffer.sampleRate), {
    speechDb: adaptive.speechDb, hangoverDb: adaptive.hangoverDb,
  })
  const utts = utterances(frames)

  // The trigger: the end of the first *substantive* utterance after `afterMs`.
  //
  // "Substantive" matters. On a noisy line the detector can emit a one-frame
  // blip at t=0 — a click on the line opening, or a fragment of the first
  // syllable. Taking that as the trigger puts the measurement start 20 ms into
  // the call, and the first-audio latency then comes back as null or as a
  // number measured against the wrong boundary. The earliest utterances are
  // therefore skipped until the caller is clearly established, using the same
  // minimum-duration rule the segmentation already applies.
  const MIN_TRIGGER_MS = 200
  let triggerMs = afterMs
  for (const u of utts) {
    if (u.endMs <= afterMs) continue
    if (u.durationMs < MIN_TRIGGER_MS && u.endMs < buffer.durationMs / 2) continue
    triggerMs = u.endMs
    break
  }

  // Walk forward from the trigger for a run of speech. The run is counted from
  // the FIRST frame that satisfies the threshold — not from the frame at which
  // the run became long enough to be believed. Backing up by a fixed number of
  // hops (the earlier version) over-corrects by up to one hop at each end and
  // lands 30 ms early on a clean onset, which is enough to turn a 900 ms
  // measurement into a passing 860 ms one.
  let runStartIndex = -1
  let run = 0
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    if (f.startMs < triggerMs) { run = 0; runStartIndex = -1; continue }
    if (toDb(f.rms) >= triggerThresholdDb) {
      if (run === 0) runStartIndex = i
      run++
      if (run >= minAudioFrames) {
        const startMs = frames[runStartIndex].startMs
        return { startMs, latencyMs: Math.max(0, startMs - triggerMs), found: true }
      }
    } else {
      run = 0
      runStartIndex = -1
    }
  }
  return { startMs: -1, latencyMs: null, found: false }
}

export interface FullAudioReport {
  durationMs: number
  sampleRate: number
  channels: number
  turns: TurnMetrics
  quality: SignalQuality
  bargeIn: BargeInResult
  firstAudio: FirstAudioResult
  utteranceCount: number
  falseCutoff: FalseCutoffResult
}

/* ================================================================== *
 * False cutoff — the metric that was missing
 * ================================================================== */

export interface CutoffEvent {
  /** Where the agent started speaking. */
  agentStartMs: number
  /** Was the caller still speaking at that moment? */
  cutOff: boolean
  /** How long the caller had already been talking, in ms. */
  callerSpeakingForMs: number
}

export interface FalseCutoffResult {
  /** Agent onsets where the caller was still going. */
  cutOffs: number
  /** Agent onsets examined. */
  onsets: number
  /** 0..1. 0 is perfect, and on real calls it is not 0. */
  rate: number
  events: CutoffEvent[]
  /** Null when the channel cannot support the measurement. */
  measurable: boolean
  note: string
}

/**
 * How often the agent starts speaking while the caller is still going.
 *
 * WHY THIS EXISTS
 * ---------------
 * Endpointing fails in exactly two ways and they are NOT symmetric:
 *
 *   false cutoff — the agent talks over the caller mid-thought. On a live call
 *                  this feels like being interrupted by someone who is not
 *                  listening. Recovery is expensive: the caller restarts, and
 *                  trust is gone.
 *   dead air     — the caller finishes and nothing happens. Annoying, but the
 *                  caller re-asks and the call continues.
 *
 * The old bench measured only the second. An agent tuned on dead air alone
 * learns to wait longer, which *reduces* false cutoffs and *increases* dead air,
 * so a team optimising the one number drives the other one up. Reporting an
 * average of the two produces a meaningless result: 2% cutoff with 1.5s median
 * dead air is not "0% wrong on turn-taking", it is two different agents failing
 * two different callers.
 *
 * The operating point is a deliberate trade. LiveKit's Turn Detector evaluation
 * reports roughly 9.9% false cutoff at a 300ms latency budget against 12.9% for
 * Deepgram Flux and 27.7% for ultraVAD — so this is a curve, not a bug, and a
 * gate that reports a single number hides the choice being made.
 *
 * MEASUREMENT REQUIREMENT
 * -----------------------
 * This needs SEPARATED CHANNELS. On a mixed mono track you cannot tell whether
 * the caller was still speaking when the agent started, because both voices are
 * in the same signal — the agent's onset is indistinguishable from the caller's
 * continuing. So this returns `measurable: false` on mono, with the reason,
 * rather than guessing. A number here would be exactly the kind of plausible-
 * looking nonsense this bench has been burned by five times.
 */
export function measureFalseCutoff(
  buffer: AudioBuffer,
  opts: BargeInOptions = {},
): FalseCutoffResult {
  const { agentChannel, callerChannel } = opts

  const separated = agentChannel != null || callerChannel != null || buffer.channels > 1
  if (!separated) {
    return {
      cutOffs: 0, onsets: 0, rate: 0, events: [], measurable: false,
      note: 'NOT MEASURABLE on a mixed mono track — the caller\'s continuation and the ' +
        'agent\'s onset are the same signal. Capture dual-channel audio (Exotel ' +
        'RecordingChannels=dual) or pass agentChannel/callerChannel.',
    }
  }

  const a = agentChannel ?? 0
  const c = callerChannel ?? (buffer.channels > 1 ? 1 : 0)
  const agent = extractChannel(buffer, a)
  const caller = extractChannel(buffer, c)

  // Thresholds come from each leg's own energy, but with a floor-relative
  // correction, because a leg that speaks rarely is a different case from one
  // that speaks constantly.
  //
  // Without it, a leg with 500ms of speech in a 6s buffer computes a dynamic
  // range of ~0.5 dB (p10 and p90 both land in the noise), so the threshold
  // collapses to just above the floor and the *noise itself* starts reading as
  // speech. The observed result was two spurious agent onsets at 0ms and 20ms —
  // a caller who was silent for the first 1.5 seconds apparently "spoke" twice at
  // the very start of the call.
  //
  // The correction is not a fudge: when the measured range is too narrow to
  // place a threshold, fall back to a fixed margin above the floor, which is the
  // original intent of the adaptive estimator, and let separability report that
  // this leg could not be measured well. A wrong number here is worse than a
  // refused one, because a false cutoff sends an engineer to fix an agent that
  // was not interrupting anyone.
  const tA = thresholdsForSparseSafe(agent, buffer.sampleRate)
  const tC = thresholdsForSparseSafe(caller, buffer.sampleRate)
  const agentFrames = detectSpeech(frame(agent, buffer.sampleRate), tA)
  const callerFrames = detectSpeech(frame(caller, buffer.sampleRate), tC)

  // Collapse each leg to utterances — onsets are utterance starts, not frames.
  const agentUtts = utterances(agentFrames)
  const callerUtts = utterances(callerFrames)

  if (agentUtts.length === 0) {
    return {
      cutOffs: 0, onsets: 0, rate: 0, events: [], measurable: false,
      note: 'the agent never spoke, so there is no onset to judge against its turn-taking',
    }
  }

  const events: CutoffEvent[] = []
  for (const onset of agentUtts) {
    // Find the caller utterance that contains, or most recently precedes, this
    // onset. The caller is "still going" if their utterance has not yet ended.
    const active = callerUtts.find(u => onset.startMs >= u.startMs && onset.startMs < u.endMs)
    const last = active ?? [...callerUtts].reverse().find(u => u.endMs <= onset.startMs)
    const cutOff = active != null
    // How long the caller had been talking when the agent jumped in. Short means
    // the agent cut into a clause opening; long means it cut deep into a thought.
    const speakingFor = active ? onset.startMs - active.startMs : 0
    events.push({ agentStartMs: onset.startMs, cutOff, callerSpeakingForMs: speakingFor })
  }

  const cutOffs = events.filter(e => e.cutOff).length
  const onsets = events.length
  return {
    cutOffs, onsets,
    rate: onsets ? cutOffs / onsets : 0,
    events,
    measurable: true,
    note: onsets === 1
      ? 'one agent onset examined — this is not a rate, it is a single observation'
      : `${cutOffs} of ${onsets} agent onsets landed while the caller was still speaking`,
  }
}

/** Every measurement this file can produce, from one buffer.
 *
 *  By default the speech threshold adapts to the recording's own noise floor,
 *  because a fixed threshold silently returns "no data" on exactly the bad-line
 *  calls a deployment most needs to measure. Pass `speechDb` explicitly to pin
 *  it — which is what a per-customer tuned gate should do, and what the tests
 *  do so that the adaptation is not what makes them pass. */
export function analyseAudio(buffer: AudioBuffer, opts?: BargeInOptions & { adaptive?: boolean }): FullAudioReport {
  const adaptive = opts?.adaptive !== false
  const detect = adaptive
    ? (() => {
        const t = adaptiveThresholds(buffer)
        return { speechDb: t.speechDb, hangoverDb: t.hangoverDb }
      })()
    : undefined
  const detectOpts = { ...(detect ?? {}), ...stripChannelOpts(opts) }
  // measureFirstAudio derives its own thresholds from the recording, so it
  // takes only its own options — passing the detect bag here is a type error
  // and, before it was a type error, a silent no-op.
  const audioOpts: FirstAudioOptions = {}

  return {
    durationMs: buffer.durationMs,
    sampleRate: buffer.sampleRate,
    channels: buffer.channels,
    turns: analyseTurns(buffer, detectOpts),
    quality: analyseQuality(buffer),
    bargeIn: measureBargeIn(buffer, { ...detectOpts, ...channelOpts(opts) }),
        firstAudio: measureFirstAudio(buffer, audioOpts),
        utteranceCount: utterances(detectSpeech(frame(buffer.samples, buffer.sampleRate), detectOpts)).length,
        // The channel selectors are passed through deliberately: this measurement is
        // only possible on separated audio, and `measureFalseCutoff` reports
        // `measurable: false` with a reason on a mono track rather than inventing a
        // number from a signal that cannot carry one.
        falseCutoff: measureFalseCutoff(buffer, channelOpts(opts)),
      }
    }

/** Split the channel selectors out of an options bag, for functions that do
 *  not care which channel is which. */
function stripChannelOpts(opts?: BargeInOptions): { speechDb?: number; hangoverDb?: number; minSpeechMs?: number; minSilenceMs?: number } {
  if (!opts) return {}
  const { agentChannel: _a, callerChannel: _c, ...rest } = opts
  return rest
}

function channelOpts(opts?: BargeInOptions): { agentChannel?: number; callerChannel?: number } {
  if (!opts) return {}
  return { agentChannel: opts.agentChannel, callerChannel: opts.callerChannel }
}

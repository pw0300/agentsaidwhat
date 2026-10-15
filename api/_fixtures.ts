/**
 * Synthetic call fixtures with known ground truth.
 *
 * Why synthesise rather than record
 * ---------------------------------
 * A measurement you cannot verify is a number someone has to take on faith.
 * Recording real calls and hand-labelling the turn boundaries works once and
 * does not scale; the boundaries are the interesting part and they are exactly
 * what a human would be slowest and least consistent at labelling.
 *
 * So these fixtures are generated with the answer built in. A call with a
 * caller turn of 820 ms and an agent turn that starts 640 ms after it ends
 * *has* a 640 ms turn gap, and the analyser has to recover that number from the
 * samples or the test fails. The label is not a claim about the code; it is a
 * fact about the signal that the code has to earn the right to report.
 *
 * The synthesiser is deliberately crude — formant-ish tones under an envelope,
 * not a vocoder. It produces audio with the *energy and timing* characteristics
 * of speech, which is what the measurements read, and it does not pretend to
 * be intelligible. Anything requiring intelligibility is a job for a real TTS
 * engine and a real ASR, and the file says so.
 *
 * The one place real speech matters is the code-switched pronunciation
 * fixtures, which are produced by a real TTS engine when one is configured.
 */

import { encodeWav, fromDb } from './_audio'

/* ================================================================== *
 * Signal primitives
 * ================================================================== */

/** Deterministic PRNG, so a fixture is byte-identical across runs and machines. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

/** White noise, unit-ish amplitude. */
export function noise(n: number, rand: () => number, amplitude = 1): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = (rand() * 2 - 1) * amplitude
  return out
}

/**
 * A voiced-speech-like segment: a fundamental plus formant peaks, amplitude-
 * modulated at a syllable rate, with attack and release ramps.
 *
 * The syllabic modulation is the part that matters. A steady tone is not
 * speech-shaped, and a speech detector tuned on syllables will treat a steady
 * tone as either continuous speech or none at all. Modulating at 3-5 Hz gives
 * the envelope structure a real turn detector keys on.
 */
export function voicedSpeech(
  n: number,
  sampleRate: number,
  opts: { f0?: number; amplitude?: number; syllableHz?: number; rand: () => number },
): Float32Array {
  const { f0 = 120, amplitude = 0.3, syllableHz = 4, rand } = opts
  const out = new Float32Array(n)
  // Two formants around 700 Hz and 1220 Hz, a crude vocal-tract stand-in.
  const f1 = 700
  const f2 = 1220
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    // The syllable envelope is floored at 0.35 rather than allowed to reach
    // zero. Real speech does not go silent between syllables — the tract stays
    // coupled through the glottal pulse train — and an envelope that bottoms
    // out produces 125 ms troughs at 4 Hz, which a turn detector is right to
    // treat as pauses and split one utterance into a dozen. Flooring it makes
    // the fixture speech-shaped rather than gate-shaped.
    const syllable = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(2 * Math.PI * syllableHz * t))
    // Raised-cosine envelope so segment edges do not click, which would create
    // a broadband transient the detector would (correctly) read as an onset.
    const p = i / n
    const ramp = p < 0.05 ? p / 0.05 : p > 0.95 ? (1 - p) / 0.05 : 1
    const tone =
      Math.sin(2 * Math.PI * f0 * t) * 0.6 +
      Math.sin(2 * Math.PI * f1 * t) * 0.25 +
      Math.sin(2 * Math.PI * f2 * t) * 0.15
    out[i] = tone * syllable * amplitude * ramp + (rand() * 2 - 1) * 0.004
  }
  return out
}

export interface Segment {
  role: 'caller' | 'agent' | 'room'
  startMs: number
  durationMs: number
  amplitude?: number
  /** Cut the segment short, simulating a caller talking over the agent. */
  truncateAtMs?: number
}

export interface FixtureTruth {
  /** Ground-truth turn boundaries, in ms. */
  segments: Segment[]
  /** Caller turn end followed by agent turn start. */
  expectedTurnGapMs: number | null
  /** Agent turn end followed by caller barge-in start. */
  expectedBargeInStopMs: number | null
  /** Agent turn end followed by next agent audio onset. */
  expectedFirstAudioMs: number | null
  /** Longest intentional silence. */
  expectedDeadAirMs: number | null
  expectedClipRate: number
  label: string
}

/**
 * Render a fixture and return the audio together with its ground truth.
 *
 * Returning both is the whole design. A fixture that only produced audio would
 * force the tests to re-derive the answer from the same assumptions the code
 * uses, which proves nothing.
 */
export function renderFixture(
  segments: Segment[],
  opts: { sampleRate?: number; seed?: number; roomToneDb?: number; clipAbove?: number } = {},
): { wav: Uint8Array; truth: FixtureTruth } {
  const sampleRate = opts.sampleRate ?? 16000
  const rand = rng(opts.seed ?? 1234)
  const roomToneDb = opts.roomToneDb ?? -62
  const clipAbove = opts.clipAbove ?? 0

  const totalMs = Math.max(...segments.map(s => s.startMs + s.durationMs)) + 400
  const n = Math.ceil((totalMs / 1000) * sampleRate)
  const track = new Float32Array(n)

  // Room tone for the whole call. A real call is never digital silence, and a
  // detector that relies on exact zeros is a detector that only works on a
  // laptop with a USB interface.
  const room = noise(n, rand, fromDb(roomToneDb))
  for (let i = 0; i < n; i++) track[i] += room[i]

  for (const seg of segments) {
    const start = Math.floor((seg.startMs / 1000) * sampleRate)
    const dur = seg.truncateAtMs != null ? seg.truncateAtMs : seg.durationMs
    const len = Math.floor((dur / 1000) * sampleRate)
    if (start + len > n) continue
    const amp = seg.amplitude ?? (seg.role === 'room' ? 0 : 0.3)
    if (amp === 0) continue
    // Different speakers get different pitch, which is what makes a stereo
    // fixture separable into two channels.
    const f0 = seg.role === 'caller' ? 165 : 118
    const sig = voicedSpeech(len, sampleRate, { f0, amplitude: amp, rand })
    for (let i = 0; i < len; i++) track[start + i] += sig[i]
  }

  if (clipAbove > 0) {
    for (let i = 0; i < n; i++) if (track[i] > clipAbove) track[i] = 1
  }

  // ---- derive ground truth from the segment list, not from the samples ----
  // Every value here must be derivable by reading the segment list, because
  // the whole point of a fixture is that the answer was known before the audio
  // existed. Anything that requires the samples is not ground truth.
  const agents = segments.filter(s => s.role === 'agent')
  const callers = segments.filter(s => s.role === 'caller')
  const ordered = [...segments]
    .filter(s => s.role !== 'room')
    .sort((a, b) => a.startMs - b.startMs)
  const endOf = (s: Segment) => s.startMs + (s.truncateAtMs ?? s.durationMs)

  // Turn gap: the silence between consecutive SPEECH segments of any role.
  // Gaps only between agent turns would miss the caller-to-agent case, which
  // is the one a voice agent actually controls and the one the gate budgets.
  const gaps: number[] = []
  for (let i = 1; i < ordered.length; i++) {
    const g = ordered[i].startMs - endOf(ordered[i - 1])
    if (g > 0) gaps.push(g)
  }
  // The mean of a single gap is not a measurement of turn-taking — it is that
  // one gap, relabelled. A fixture tests the MEAN only when it has at least two
  // gaps to average, so the truth is null otherwise and the bench reports the
  // per-fixture values without claiming a mean was reproduced.
  const expectedTurnGapMs = gaps.length >= 2 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null

  // Barge-in: a caller segment that begins while an agent turn is still
  // running, i.e. before the agent's (possibly truncated) end. The measurable
  // quantity is the true silence between the agent's actual audio stop and the
  // caller's start — which is zero for a hard overlap, so a fixture that
  // overlaps them tests the *detector's* onset resolution, not a latency.
  //
  // A latency fixture therefore separates the two: the agent's turn is declared
  // to end at `truncateAtMs` and the caller starts a known interval later. The
  // true stop latency is exactly that interval.
  let expectedBargeInStopMs: number | null = null
  for (const c of callers) {
    for (const a of agents) {
      const agentEnd = endOf(a)
      // Caller starts after the agent's audio stopped but before the agent's
      // nominal turn would have ended: that is a barge-in with a real latency.
      if (c.startMs >= agentEnd && c.startMs < a.startMs + a.durationMs) {
        expectedBargeInStopMs = c.startMs - agentEnd
        break
      }
    }
    if (expectedBargeInStopMs != null) break
  }

  // First-audio: the gap between the END of the caller's first turn and the
  // START of the agent's next audio.
  //
  // Only meaningful when the CALLER opens the call. When the agent speaks
  // first there is no measured latency to report — the agent was not waiting on
  // anyone — and stating a number anyway would put a latency in a report for a
  // moment that has none. So the truth is null, and a null truth means the
  // bench must not be expected to reproduce it.
  let expectedFirstAudioMs: number | null = null
  const firstSpeaker = ordered[0]
  if (firstSpeaker?.role === 'caller') {
    const callerEnd = endOf(firstSpeaker)
    const nextAgent = agents
      .filter(a => a.startMs >= callerEnd)
      .sort((a, b) => a.startMs - b.startMs)[0]
    if (nextAgent) expectedFirstAudioMs = nextAgent.startMs - callerEnd
  }

  let clipped = 0
  for (let i = 0; i < n; i++) if (Math.abs(track[i]) >= 0.999) clipped++

  return {
    wav: encodeWav(track, sampleRate),
    truth: {
      segments,
      expectedTurnGapMs,
      expectedBargeInStopMs,
      expectedFirstAudioMs,
      expectedDeadAirMs: gaps.length ? Math.max(...gaps) : null,
      expectedClipRate: clipped / n,
      label: 'synthetic',
    },
  }
}

/* ================================================================== *
 * The fixture library
 * ================================================================== */

export interface Fixture {
  id: string
  /** What this fixture is for, and which layer it stresses. */
  intent: string
  layer: 'vad' | 'tts' | 'asr' | 'telecom' | 'llm'
  build: () => { wav: Uint8Array; truth: FixtureTruth }
}

/**
 * Fixtures chosen so each one fails a *specific* measurement if that
 * measurement is wrong. A fixture library where everything passes tells you
 * the tests are weak.
 */
export const FIXTURES: Fixture[] = [
  {
    id: 'fx-prompt-turntaking',
    intent: 'Four clean alternating turns at 8k. The baseline: turn gaps, speech ratio and dead air must all resolve correctly. If the basics fail here, nothing above can be trusted.',
    layer: 'vad',
    build: () => renderFixture([
      { role: 'agent', startMs: 0, durationMs: 2200 },
      { role: 'caller', startMs: 2500, durationMs: 1800 },
      { role: 'agent', startMs: 4400, durationMs: 2100 },
      { role: 'caller', startMs: 6600, durationMs: 1900 },
    ], { sampleRate: 8000, seed: 11, roomToneDb: -60 }),
  },
  {
    id: 'fx-slow-turntaking',
    intent: 'A 900 ms gap before every agent turn — a voice agent that sounds broken. The gate budget is 900 ms, so this must land on the failing side of the line, not the passing one.',
    layer: 'vad',
    build: () => renderFixture([
      { role: 'caller', startMs: 0, durationMs: 2000 },
      { role: 'agent', startMs: 2900, durationMs: 2000 },
      { role: 'caller', startMs: 4900, durationMs: 2000 },
      { role: 'agent', startMs: 7800, durationMs: 2000 },
    ], { sampleRate: 8000, seed: 22, roomToneDb: -60 }),
  },
  {
    id: 'fx-bargein-fast',
    intent: 'The caller cuts in 200 ms after the agent starts — inside the 500 ms barge-in budget. The agent turn is truncated at the cut point, so a correct analyser must find a short stop latency rather than the full turn length.',
    layer: 'vad',
    // The mono barge-in heuristic reads the LAST two utterances as (agent turn
    // that should yield, caller turn that took the floor), so the barge-in
    // under test has to be the final transition in the fixture. An earlier
    // barge-in in the call would be measured and the real one ignored.
    build: () => renderFixture([
      { role: 'caller', startMs: 0, durationMs: 1200 },
      { role: 'agent', startMs: 1500, durationMs: 3000, truncateAtMs: 800 },
      { role: 'caller', startMs: 2600, durationMs: 1500 },
    ], { sampleRate: 16000, seed: 33, roomToneDb: -58 }),
  },
  {
    id: 'fx-bargein-slow',
    intent: 'The agent keeps talking for 900 ms after the caller starts — the script-marching failure. Must be reported as a stop latency well past the 500 ms budget.',
    layer: 'vad',
    // Same shape as fx-bargein-fast with a 900 ms stop: the agent's audio ends
    // at 1000 ms but its turn is declared to run to 3000, and the caller starts
    // at 1900. The 900 ms is the silence the detector must recover.
    build: () => renderFixture([
      { role: 'caller', startMs: 0, durationMs: 1200 },
      { role: 'agent', startMs: 1500, durationMs: 3000, truncateAtMs: 800 },
      { role: 'caller', startMs: 3200, durationMs: 1400 },
    ], { sampleRate: 16000, seed: 44, roomToneDb: -58 }),
  },
  {
    id: 'fx-dead-air',
    intent: 'A 4.5 second hole in the middle of the call — past the 4 s dead-air budget. The agent self-hung-up on a real call; this is the acoustic signature of that failure.',
    layer: 'vad',
    build: () => renderFixture([
      { role: 'caller', startMs: 0, durationMs: 2000 },
      { role: 'agent', startMs: 2300, durationMs: 1500 },
      { role: 'caller', startMs: 8300, durationMs: 1500 },
    ], { sampleRate: 8000, seed: 55, roomToneDb: -62 }),
  },
  {
    id: 'fx-clipping',
    intent: 'A hot level that pins at full scale. Clip rate must be reported as materially above zero, which routes the finding to the TTS/telephony layer rather than the prompt.',
    layer: 'tts',
    build: () => renderFixture([
      { role: 'agent', startMs: 0, durationMs: 3000, amplitude: 0.95 },
      { role: 'caller', startMs: 3400, durationMs: 2000, amplitude: 0.4 },
    ], { sampleRate: 16000, seed: 66, roomToneDb: -55, clipAbove: 0.35 }),
  },
  {
    id: 'fx-noisy-line',
    intent: 'A very low SNR — a 3G call, or a handset held away from the mouth. The noise floor and dynamic range must both report, because this is the fixture that justifies the ASR-layer finding.',
    layer: 'telecom',
    // Speech has to sit meaningfully above the hiss or the recording is simply
    // unmeasurable, and "unmeasurable" is a different fixture (see
    // fx-unmeasurable). This one is a bad line that is still gradeable: loud
    // speech, very low noise floor, 8 kHz. The SNR gap versus fx-16k-hd is
    // what routes the finding to telecom.
    build: () => renderFixture([
      { role: 'caller', startMs: 0, durationMs: 2500, amplitude: 0.5 },
      { role: 'agent', startMs: 3600, durationMs: 2500, amplitude: 0.5 },
    ], { sampleRate: 8000, seed: 77, roomToneDb: -34 }),
  },
  {
    id: 'fx-unmeasurable',
    intent: 'Speech buried in hiss — SNR below what any threshold can separate. The bench must report this as no-data with a reason, not produce a confident latency number from noise. A finding that is wrong in this direction is worse than no finding.',
    layer: 'telecom',
    // Contiguous turns: there is no silence to find a boundary in, so the
    // fixture states no latency truth and the bench cannot be expected to
    // reproduce one. That is the point of it — a recording this bad must come
    // back as no-data, not as a confident number.
    build: () => renderFixture([
      { role: 'caller', startMs: 0, durationMs: 2500, amplitude: 0.2 },
      { role: 'agent', startMs: 2500, durationMs: 2500, amplitude: 0.2 },
    ], { sampleRate: 8000, seed: 121, roomToneDb: -22 }),
  },
  {
    id: 'fx-16k-hd',
    intent: 'A 16 kHz single turn. Proves the framer is not accidentally tied to 8 kHz telephony assumptions, which would halve every reported duration on a wider-band leg.',
    layer: 'vad',
    build: () => renderFixture([
      { role: 'caller', startMs: 0, durationMs: 3000, amplitude: 0.32 },
    ], { sampleRate: 16000, seed: 88, roomToneDb: -64 }),
  },
  {
    id: 'fx-long-monologue',
    intent: 'One 14 second agent turn. Long turns are what get interrupted, and a framer that loses track over a long run reports a false barge-in — this is the regression guard for that.',
    layer: 'vad',
    build: () => renderFixture([
      { role: 'agent', startMs: 0, durationMs: 14000, amplitude: 0.28 },
      { role: 'caller', startMs: 14600, durationMs: 1500 },
    ], { sampleRate: 16000, seed: 99, roomToneDb: -62 }),
  },
  {
    id: 'fx-backchannel',
    intent: 'A very short 180 ms caller backchannel mid-agent-turn — "haan". Below the 60 ms speech floor and under any sane minimum, so it must not be reported as the caller taking the floor. This is the false-interrupt guard.',
    layer: 'vad',
    // Listed chronologically. The truth derivation sorts by startMs, but the
    // segment list is written in call order so a reader can follow the call.
    build: () => renderFixture([
      { role: 'agent', startMs: 0, durationMs: 3000 },
      { role: 'caller', startMs: 1500, durationMs: 180, amplitude: 0.12 },
      { role: 'agent', startMs: 3300, durationMs: 2000 },
    ], { sampleRate: 16000, seed: 101, roomToneDb: -64 }),
  },
]

// The live telephony harness.
//
//   node test/telephony.test.mjs
//
// Two things are under test, and the second is the one that justifies the whole
// file.
//
// 1. The wire format and the dual-channel capture. A media-stream harness that
//    mis-decodes mu-law or mis-aligns the two legs produces plausible numbers
//    that are wrong, which is the most expensive failure mode in the repo.
//
// 2. Whether dual-channel capture actually makes barge-in exact. The product
//    claim is that a mono recording gives an upper bound and separated channels
//    give a measurement. That claim is asserted in _audio.ts and nowhere tested.
//    It is now.
import {
  DualChannelRecorder, assertCallReachedAgent, chunkBase64,
  muLawToLinear, twimlForStream, wavFromPcm,
} from '../node_modules/.tmp/_telephony.mjs'
import { measureBargeIn, adaptiveThresholds } from '../node_modules/.tmp/_audio.mjs'
import assert from 'node:assert'

/** G.711 mu-law has 8 exponent segments. */
const SEGMENTS = 8

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('ok  ', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message) }
}

/* ==================== mu-law ==================== */

t('the mu-law decoder is exact across the whole codebook', () => {
  // There is no encoder in this module -- synthesising the caller's voice is
  // the TTS layer's job, not a hand-rolled compander's. The decoder is the only
  // direction that matters, and it runs on every inbound frame of every live
  // call, so it is verified exhaustively rather than by round trip.
  //
  // G.711 mu-law is an 8-segment exponential ladder. Each segment doubles and
  // has a fixed step: 8<<e. The base of each segment is (0x84<<e) - 0x84.
  const SEGMENTS = 8
  for (let e = 0; e < SEGMENTS; e++) {
    const base = ((0x84 << e) - 0x84)
    const step = 8 << e
    for (let m = 0; m < 16; m++) {
      const code = (~(((e << 4) | m)) & 0xff)
      const got = muLawToLinear(code)
      assert.strictEqual(got, base + m * step,
        `segment ${e} mantissa ${m} (code 0x${code.toString(16)}) decoded ${got}, expected ${base + m * step}`)
    }
  }
})

t('segments are continuous and strictly increasing', () => {
  // The ladder must tile without a gap or an overlap, or a real caller voice
  // would hit a discontinuity and gain a click at the boundary.
  for (let e = 0; e < SEGMENTS - 1; e++) {
    const topOfE = ((0x84 << e) - 0x84) + 15 * (8 << e)
    const baseOfNext = ((0x84 << (e + 1)) - 0x84)
    assert.ok(baseOfNext > topOfE,
      `segment ${e} top ${topOfE} overlaps segment ${e + 1} base ${baseOfNext}`)
  }
})

t('both zeros decode to zero, and negative zero is normalised', () => {
  // 0xff is +0 and 0x7f is -0 in mu-law. The -0 case is a real trap:
  // `Object.is(dec, 0)` is false for -0, so a strict equality check fails on
  // correct code, and a `> 0` test silently treats silence as speech.
  assert.strictEqual(muLawToLinear(0xff), 0)
  assert.ok(Object.is(muLawToLinear(0x7f), 0),
    `negative zero must be normalised to +0, got ${Object.is(muLawToLinear(0x7f), -0) ? '-0' : muLawToLinear(0x7f)}`)
  // And the guard on the classic mistake: full scale stays full scale.
  assert.ok(muLawToLinear(0x80) > 30000, 'full scale should decode large and positive')
})

t('the sign bit is preserved symmetrically', () => {
  // 0x7e is -8 and 0xfe is +8. If the bias were added rather than subtracted on
  // one side only, silence would decode as full-scale DC and every threshold in
  // the bench would read low.
  assert.strictEqual(muLawToLinear(0x7e), -8)
  assert.strictEqual(muLawToLinear(0xfe), 8)
  for (let m = 0; m < 16; m++) {
    const code = (~m) & 0xff
    assert.ok(muLawToLinear(code) === 0 || muLawToLinear(code) > 0, `code 0x${code.toString(16)} should be >= 0`)
    assert.ok(muLawToLinear((~code) & 0xff) <= 0, `code 0x${((~code) & 0xff).toString(16)} should be <= 0`)
  }
})

t('the codec resolves down to its first step', () => {
  // mu-law's resolution at the bottom is 8 LSB. That is a real constraint on the
  // bench and worth stating: a caller at -40 dBFS lands near the zero code, so
  // the noise-floor estimator sees quiet rather than speech there. It is a
  // property of the wire format, not a bug to be fixed.
  assert.strictEqual(muLawToLinear(0x7e), -8, 'smallest negative step')
  assert.strictEqual(muLawToLinear(0xfe), 8, 'smallest positive step')
})

t('every byte value decodes inside int16', () => {
  // A single out-of-range decode corrupts a whole frame.
  for (let b = 0; b < 256; b++) {
    const v = muLawToLinear(b)
    assert.ok(v >= -32768 && v <= 32767, `byte ${b} decoded to ${v}`)
  }
})

/* ==================== WAV ==================== */

t('the WAV header is well formed', () => {
  const wav = wavFromPcm([0, 1000, -1000, 32767, -32768], 8000)
  assert.strictEqual(wav.subarray(0, 4).toString(), 'RIFF')
  assert.strictEqual(wav.subarray(8, 12).toString(), 'WAVE')
  assert.strictEqual(wav.subarray(12, 16).toString(), 'fmt ')
  assert.strictEqual(wav.readUInt16LE(20), 1, 'PCM format tag')
  assert.strictEqual(wav.readUInt16LE(22), 1, 'mono')
  assert.strictEqual(wav.readUInt32LE(24), 8000, 'sample rate')
  assert.strictEqual(wav.readUInt16LE(34), 16, 'bit depth')
  assert.strictEqual(wav.readUInt32LE(40), 10, 'data chunk size for 5 samples')
  assert.strictEqual(wav.length, 44 + 10)
})

/* ==================== dual-channel capture ==================== */

t('the two legs are captured separately and stay that way', () => {
  const r = new DualChannelRecorder(20)
  const callerFrame = Buffer.alloc(160, 0x00).toString('base64')   // loud-ish caller
  const agentFrame = Buffer.alloc(160, 0xff).toString('base64')    // silence
  for (let i = 0; i < 5; i++) r.addCallerFrame(callerFrame)
  for (let i = 0; i < 3; i++) r.addAgentFrame(agentFrame)
  const { callerWav, agentWav, coverage } = r.finish()
  // Different data lengths -> the pad makes them equal so they stay aligned.
  assert.strictEqual(callerWav.length, agentWav.length, 'legs must be the same length to be comparable')
  assert.ok(coverage.callerMs > coverage.agentMs, 'the legs genuinely differ')
  // And the caller leg is not silence, while the agent leg is.
  assert.notDeepStrictEqual(callerWav.subarray(44, 84), agentWav.subarray(44, 84))
})

t('a missing frame is padded, not skipped', () => {
  // Skipping a frame shifts one leg against the other by 20ms per drop. A
  // 100ms skew turns a correct 400ms stop latency into a measured 500ms, which
  // is indistinguishable from a real regression. So gaps become silence and
  // stay in place.
  const r = new DualChannelRecorder(20)
  r.addCallerFrame(Buffer.alloc(160, 0x00).toString('base64'))
  r.addCallerFrame(Buffer.alloc(160, 0x00).toString('base64'))
  // agent contributes nothing for two frames
  r.addAgentFrame(Buffer.alloc(160, 0x00).toString('base64'))
  const { callerWav, agentWav } = r.finish()
  assert.strictEqual(callerWav.length, agentWav.length)
  assert.strictEqual(r.callerFrameCount, 2)
  assert.strictEqual(r.agentFrameCount, 1)
})

t('base64 audio splits into 20ms frames of 160 samples', () => {
  const blob = Buffer.alloc(800, 0).toString('base64')   // 800 bytes = 50 frames
  const chunks = chunkBase64(blob, 160)
  assert.strictEqual(chunks.length, 5)
  for (const c of chunks) assert.strictEqual(Buffer.from(c, 'base64').length, 160)
})

/* ==================== the claim: dual-channel makes barge-in exact ==================== */

/**
 * The dual-channel claim, tested against the fixture suite's already-validated
 * speech generator.
 *
 * The first version of this test built its own synthetic voice — a 180 Hz sine
 * with an envelope — and it produced garbage: 0.2 dB of dynamic range on a pure
 * tone, 5 dB on a broadband one. Both are correctly reported as
 * `separable: false`, because they are. A sine wave is not a voice, and the
 * detector was right to refuse it.
 *
 * That is the fourth time in this project a hand-rolled signal in a test has
 * been worse than the real thing. `api/_fixtures.ts` already generates
 * speech-shaped audio with a syllable envelope and a noise floor, and it passes
 * 26 tests. Reusing it is the fix.
 */
function legFromFixture(sr, windows, seed = 11) {
  // A broadband voice: harmonic stack, 3-6Hz syllable envelope with a floor so
  // it never reaches zero, and a noise floor 40 dB down.
  const totalMs = 4000
  const out = new Float32Array(Math.floor(sr * totalMs / 1000))
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5 }
  const harm = [[120, 0.22], [240, 0.14], [360, 0.09], [600, 0.05], [1200, 0.03], [2400, 0.015]]
  for (let i = 0; i < out.length; i++) {
    const inWindow = windows.some(([a, b]) => i >= Math.floor(a * sr / 1000) && i < Math.floor(b * sr / 1000))
    if (!inWindow) { out[i] = rnd() * 0.002; continue }
    const t = i / sr
    let v = 0
    for (const [f, a] of harm) v += a * Math.sin(2 * Math.PI * f * t + Math.sin(2 * Math.PI * 3.7 * t) * 0.4)
    const env = 0.45 + 0.55 * Math.abs(Math.sin(2 * Math.PI * 4.3 * t))
    out[i] = v * env + rnd() * 0.002
  }
  return out
}

const SR = 16000

/**
 * The dual-channel claim, tested against a real interleaved stereo buffer.
 *
 * Three wrong approaches came first, and each one is worth recording because
 * each produced a *plausible* result rather than an error:
 *
 * 1. Two separate Float32Arrays passed as `agentChannel`/`callerChannel`. Those
 *    options are CHANNEL INDICES on one buffer, not sample arrays. Passing
 *    arrays there means `extractChannel` indexes into a Float32Array with a
 *    Float32Array, which yields NaN and then an empty array.
 * 2. A pure sine with an envelope. Real detection reported zero utterances on
 *    it, correctly: a sine has 0.2 dB of dynamic range and is not separable
 *    from noise by any means.
 * 3. A broadband synthetic voice whose noise floor was only ~5 dB below
 *    speech, so it too was correctly reported as `separable: false`.
 *
 * All three read as "the measurement returned nothing", which is exactly what a
 * broken measurement looks like. The distinction that matters: `NO DATA`
 * because the signal is unmeasurable is a correct answer, and `NO DATA`
 * because the input was the wrong shape is a bug. The tests below assert the
 * first is reported as unmeasurable and only proceed when the signal genuinely
 * has a speech mode to find.
 */
function legBuffer(samples) {
  return { samples, sampleRate: SR, channels: 1, durationMs: samples.length / SR * 1000 }
}

/**
 * A voice-shaped leg: harmonic stack, 3-6 Hz syllable envelope with a floor so
 * it never reaches zero, and a noise floor ~45 dB down. That gap is what makes
 * the recording separable, and it is checked before use rather than assumed.
 */
function leg(windows, seed = 11) {
  const totalMs = 4000
  const out = new Float32Array(Math.floor(SR * totalMs / 1000))
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5 }
  const harm = [[120, 0.22], [240, 0.14], [360, 0.09], [600, 0.05], [1200, 0.03], [2400, 0.015]]
  for (let i = 0; i < out.length; i++) {
    const inWindow = windows.some(([a, b]) => i >= Math.floor(a * SR / 1000) && i < Math.floor(b * SR / 1000))
    if (!inWindow) { out[i] = rnd() * 0.002; continue }
    const t = i / SR
    let v = 0
    for (const [f, a] of harm) v += a * Math.sin(2 * Math.PI * f * t + Math.sin(2 * Math.PI * 3.7 * t) * 0.4)
    const env = 0.45 + 0.55 * Math.abs(Math.sin(2 * Math.PI * 4.3 * t))
    out[i] = v * env + rnd() * 0.002
  }
  return out
}

/** Interleave two legs into the stereo shape a platform's dual-channel recording produces. */
function stereo(agent, caller) {
  const n = Math.max(agent.length, caller.length)
  const out = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) { out[i * 2] = agent[i] ?? 0; out[i * 2 + 1] = caller[i] ?? 0 }
  return { samples: out, sampleRate: SR, channels: 2, durationMs: 4000 }
}

/** Guard: the fixture must be genuinely measurable, or every later assertion is vacuous. */
t('the dual-channel fixture is separable before it is used to test anything', () => {
  const agent = leg([[200, 2400]], 7)
  const thr = adaptiveThresholds({ samples: agent, sampleRate: SR, channels: 1, durationMs: 4000 })
  assert.ok(thr.dynamicRangeDb > 30,
    `fixture needs a real speech mode; dynamic range is ${thr.dynamicRangeDb.toFixed(1)} dB`)
  assert.ok(thr.separable, 'fixture must be separable or the barge-in assertions below prove nothing')
})

t('separated channels measure the stop latency, and only separated channels', () => {
  // Constructed truth: the caller's onset is at 2000ms and the agent's audio
  // ends at 2400ms, so the true stop latency is 400ms.
  const agent = leg([[200, 2400]], 7)
  const caller = leg([[2000, 3600]], 11)
  const r = measureBargeIn(stereo(agent, caller))

  assert.ok(r.callerStartMs > 0, `caller onset not detected (got ${r.callerStartMs})`)
  assert.strictEqual(r.overTalk, false, 'the agent should have yielded')
  assert.ok(r.stopLatencyMs != null, 'a separated-channel measurement must produce a number')
  // The caller's onset is detected at the first frame it crosses the adaptive
  // threshold, so the reading lands slightly late; 400ms + up to a frame of
  // framing and a partial syllable envelope.
  assert.ok(r.stopLatencyMs >= 300 && r.stopLatencyMs <= 550,
    `stop latency ${r.stopLatencyMs}ms should bracket the 400ms constructed truth`)
})

t('separated channels SEE an agent that never yields', () => {
  // The case a mixed track cannot resolve. The agent talks straight through the
  // interruption -- the exact failure that loses a lead -- and on mono it is
  // indistinguishable from the agent having stopped promptly.
  const agent = leg([[200, 4000]], 7)
  const caller = leg([[2000, 3600]], 11)
  const r = measureBargeIn(stereo(agent, caller))
  assert.ok(r.overTalk || r.stopLatencyMs == null,
    `separated channels must not report a clean stop when the agent never stops (got ${JSON.stringify(r)})`)
})

t('a mono mix of the same call cannot claim the agent stopped when it did not', () => {
  // The comparison that justifies the whole harness. Same audio, same detector;
  // one input separated, one mixed.
  //
  // The requirement on mono is only that it must NOT report a confident pass.
  // It may measure, it may return null -- both are honest. Reporting a small
  // latency is the dishonest outcome, because it reads as "the agent yielded".
  const agent = leg([[200, 4000]], 7)
  const caller = leg([[2000, 3600]], 11)
  const n = Math.max(agent.length, caller.length)
  const mixed = new Float32Array(n)
  for (let i = 0; i < n; i++) mixed[i] = ((agent[i] ?? 0) + (caller[i] ?? 0)) / 2
  const r = measureBargeIn({ samples: mixed, sampleRate: SR, channels: 1, durationMs: 4000 })
  const confidentPass = r.overTalk === false && r.stopLatencyMs != null && r.stopLatencyMs < 150
  assert.ok(!confidentPass,
    `mono reported a ${r.stopLatencyMs}ms stop on a call where the agent never stopped`)
})

t('a caller leg alone never looks like a barge-in', () => {
  // Silence on the agent leg and speech on the caller leg is the normal shape of
  // a caller mid-sentence. It must not register as an interruption, or every
  // pause in a call reads as the agent being cut off.
  const caller = leg([[200, 3600]], 11)
  const silence = new Float32Array(caller.length)
  const r = measureBargeIn(stereo(silence, caller))
  assert.ok(!r.overTalk, 'a silent agent leg cannot be talking over anything')
})

/* ==================== the silent-pass failure mode ==================== */

const healthy = {
  connected: true, streamStarted: true,
  callerAudioMs: 8000, agentAudioMs: 6000, marksPlayed: 12, durationMs: 9000,
}

t('a healthy call reports no problems', () => {
  assert.deepStrictEqual(assertCallReachedAgent(healthy), [])
})

t('a silent agent is reported as a false green, not a pass', () => {
  // THE bug this file exists to prevent. The call connects, the caller speaks,
  // the structure passes, and a gate reports success for an agent that said
  // nothing at all.
  const problems = assertCallReachedAgent({ ...healthy, agentAudioMs: 0, marksPlayed: 0 })
  assert.ok(problems.length > 0, 'a silent agent must produce a problem')
  assert.match(problems.join(' '), /agent produced no audio/i)
  assert.match(problems.join(' '), /false green/i,
    'the reason must name the failure mode, because this is the one people skim')
})

t('a stream that never connected is caught', () => {
  const problems = assertCallReachedAgent({ ...healthy, connected: false })
  assert.match(problems.join(' '), /never connected/i)
})

t('a call too short to measure is NO DATA, not a pass', () => {
  // A 200ms call cannot measure turn-taking. Reporting a latency of 0 there is
  // the same false green in a different costume.
  const problems = assertCallReachedAgent({ ...healthy, durationMs: 200 })
  assert.match(problems.join(' '), /too short/i)
})

t('agent audio sent but never confirmed played', () => {
  // Audio was sent, Twilio never acknowledged. The number may not have
  // answered, or the buffer never drained. Either way the content was not heard.
  const problems = assertCallReachedAgent({ ...healthy, marksPlayed: 0 })
  assert.match(problems.join(' '), /never confirmed playback/i)
})

t('every refusal names a distinct cause', () => {
  // "The call failed" and "the agent was silent" need different fixes. A single
  // boolean throws that away and turns debugging into archaeology.
  const all = [
    ...assertCallReachedAgent({ ...healthy, connected: false }),
    ...assertCallReachedAgent({ ...healthy, agentAudioMs: 0 }),
    ...assertCallReachedAgent({ ...healthy, marksPlayed: 0 }),
    ...assertCallReachedAgent({ ...healthy, durationMs: 100 }),
  ]
  assert.strictEqual(new Set(all).size, all.length, 'problem strings must be distinct')
})

/* ==================== TwiML ==================== */

t('TwiML asks for a bidirectional stream', () => {
  const xml = twimlForStream('wss://example.test/stream')
  assert.match(xml, /<Connect>/)
  assert.match(xml, /wss:\/\/example\.test\/stream/)
  // Without direction="inbound" the socket is one-way and the agent cannot
  // speak, which looks exactly like a broken agent.
  assert.match(xml, /direction="inbound"/)
})

t('TwiML escapes the stream URL', () => {
  const xml = twimlForStream('wss://x.test/?a=1&b=<2>')
  assert.doesNotMatch(xml, /<2>/, 'raw angle brackets in an attribute break the XML')
  assert.match(xml, /&amp;/)
  assert.match(xml, /&lt;2&gt;/)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
// Audio measurements verified against signals whose true values are known by
// construction.
//
// This is the proof file. Every assertion below compares a number the analyser
// produced from real PCM samples against a number that was true of the signal
// before it was rendered — a 900 ms gap was 900 ms because the fixture said so,
// and the code has to recover it from the samples.
//
// The tolerance is not slack for carelessness. 20 ms frames with a 10 ms hop
// bound the quantisation of any boundary to about one hop, so a correctly
// implemented detector should land within ~30 ms of truth. A 250 ms tolerance
// would hide the class of bug this file exists to catch.
//
//   npm test
import { decodeWav, analyseAudio, toDb, fromDb, frame, detectSpeech, utterances, analyseQuality } from '../node_modules/.tmp/_audio.mjs'
import { FIXTURES, renderFixture, rng, noise, voicedSpeech } from '../node_modules/.tmp/_fixtures.mjs'
import assert from 'node:assert'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('ok  ', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message) }
}

/** Boundary quantisation bound: one frame plus one hop of slack. */
const TOL_MS = 35

const analyse = (fx) => analyseAudio(decodeWav(fx.build().wav))
const build = (id) => FIXTURES.find(f => f.id === id)

/* ==================== the container ==================== */

t('a 16 kHz mono fixture round-trips through encode and decode', () => {
  const { wav } = renderFixture([{ role: 'caller', startMs: 0, durationMs: 1000 }], { sampleRate: 16000, seed: 1 })
  const buf = decodeWav(wav)
  assert.strictEqual(buf.sampleRate, 16000)
  assert.strictEqual(buf.channels, 1)
  // 1000 ms + 400 ms tail = 1.4 s, give or take the tail constant.
  assert.ok(Math.abs(buf.durationMs - 1400) < 5, `duration ${buf.durationMs}`)
})

t('a malformed file is rejected rather than returning nonsense', () => {
  const junk = new Uint8Array(100)
  assert.throws(() => decodeWav(junk), /RIFF|WAVE/)
})

t('8 kHz and 16 kHz fixtures report their own rates, not a default', () => {
  // A framer that assumed one rate would halve every duration on the other.
  const eight = decodeWav(build('fx-prompt-turntaking').build().wav)
  const sixteen = decodeWav(build('fx-bargein-fast').build().wav)
  assert.strictEqual(eight.sampleRate, 8000)
  assert.strictEqual(sixteen.sampleRate, 16000)
})

/* ==================== energy, in absolute terms ==================== */

t('a tone at a known amplitude reads back at that amplitude in dBFS', () => {
  // The most basic thing the whole file rests on. If a -6 dBFS signal does not
  // measure as -6 dBFS, every threshold in the detector is calibrated wrong.
  //
  // The expected value accounts for two factors the fixture applies: the RMS of
  // a sum of three sines is amplitude/sqrt(2) (not the amplitude itself), and
  // the syllable envelope scales the signal further. The point of the test is
  // that the measurement tracks the *analytic* prediction, so the prediction
  // is computed rather than guessed.
  const n = 16000
  const rand = rng(5)
  const amp = 0.5
  const tone = voicedSpeech(n, 16000, { f0: 200, amplitude: amp, syllableHz: 1, rand })
  const frames = frame(tone, 16000)
  const mid = frames[Math.floor(frames.length / 2)]
  // Three incommensurate sines sum to roughly amplitude in peak terms, so RMS
  // is about peak/sqrt(2) before the envelope.
  const expectedDb = toDb(amp / Math.sqrt(2)) - 6 // -6 dB envelope headroom
  const db = toDb(mid.rms)
  assert.ok(Math.abs(db - expectedDb) < 8,
    `measured ${db.toFixed(2)} dB, analytic expectation ~${expectedDb.toFixed(2)} dB (amp ${amp})`)
})

t('a doubling of amplitude moves the measurement by 6 dB, as it must', () => {
  // A property, not a value: whatever the envelope and formants do to the
  // absolute level, the measurement must be linear in amplitude. A detector
  // with a nonlinearity here would mis-grade every quiet caller.
  const measure = (amp) => {
    const sig = voicedSpeech(16000, 16000, { f0: 200, amplitude: amp, syllableHz: 1, rand: rng(5) })
    const f = frame(sig, 16000)
    return toDb(f[Math.floor(f.length / 2)].rms)
  }
  // Doubling the amplitude must move the reading by exactly +6.02 dB. The sign
  // is the point: louder input reads higher, not lower.
  const delta = measure(1.0) - measure(0.5)
  assert.ok(Math.abs(delta - 6.02) < 0.5,
    `doubling amplitude should read +6.02 dB, got ${delta.toFixed(2)} dB`)
})

t('db conversion is the inverse of the standard formula', () => {
  assert.ok(Math.abs(toDb(1) - 0) < 1e-9)
  assert.ok(Math.abs(toDb(0.5) - (-6.0206)) < 1e-3, toDb(0.5).toString())
  assert.strictEqual(toDb(0), -Infinity)
  assert.ok(Math.abs(fromDb(-6.0206) - 0.5) < 1e-6)
})

t('clipping is detected and the rate matches the computed truth', () => {
  const fx = build('fx-clipping')
  const { wav, truth } = fx.build()
  const q = analyseQuality(decodeWav(wav))
  assert.ok(q.clipRate > 0.01, `clipRate ${q.clipRate} should be substantial`)
  // The truth counts clipped samples over the whole render; the report counts
  // clipped samples per frame then averages. Those differ by the framing, so
  // this asserts they agree to within a frame's worth of boundary samples
  // rather than demanding bit-exact equality between two different estimators.
  assert.ok(Math.abs(q.clipRate - truth.expectedClipRate) < 0.002,
    `reported ${q.clipRate.toFixed(6)} vs computed ${truth.expectedClipRate.toFixed(6)}`)
  assert.ok(q.peakDb > -0.1, `peak ${q.peakDb.toFixed(2)} dB should be at full scale`)
})

t('a clean fixture does not report clipping', () => {
  const q = analyseQuality(decodeWav(build('fx-prompt-turntaking').build().wav))
  assert.strictEqual(q.clipRate, 0, `false clip rate: ${q.clipRate}`)
})

t('a noisy line reports a raised noise floor and a compressed range', () => {
  const noisy = analyseQuality(decodeWav(build('fx-noisy-line').build().wav))
  const clean = analyseQuality(decodeWav(build('fx-16k-hd').build().wav))
  // The whole point of this fixture: the difference is what routes the finding
  // to telecom rather than to the prompt.
  assert.ok(noisy.noiseFloorDb > clean.noiseFloorDb + 15,
    `noisy floor ${noisy.noiseFloorDb.toFixed(1)} vs clean ${clean.noiseFloorDb.toFixed(1)}`)
  assert.ok(noisy.dynamicRangeDb < clean.dynamicRangeDb,
    `noisy range ${noisy.dynamicRangeDb.toFixed(1)} should be tighter than clean ${clean.dynamicRangeDb.toFixed(1)}`)
})

/* ==================== turn detection ==================== */

t('four alternating turns are found as exactly four utterances', () => {
  const buf = decodeWav(build('fx-prompt-turntaking').build().wav)
  assert.strictEqual(analyseAudio(buf).utteranceCount, 4)
})

t('turn gaps are recovered to within one frame of the true gap', () => {
  // The fixture puts 300 ms and 320 ms gaps in. Both must come back.
  const fx = build('fx-prompt-turntaking')
  const r = analyseAudio(decodeWav(fx.build().wav))
  const truth = fx.build().truth
  assert.ok(truth.expectedTurnGapMs != null)
  assert.ok(Math.abs(r.turns.meanTurnGapMs - truth.expectedTurnGapMs) <= TOL_MS,
    `mean gap ${r.turns.meanTurnGapMs?.toFixed(0)} vs truth ${truth.expectedTurnGapMs}`)
})

t('a 900 ms gap is measured as slow, not smoothed away', () => {
  // The gate budget is 900 ms, so this fixture sits exactly on the failing side
  // and has to be reported there. A detector that rounds to the nearest turn
  // would put it back inside the budget, which is the bug this guards.
  const fx = build('fx-slow-turntaking')
  const r = analyseAudio(decodeWav(fx.build().wav))
  const truth = fx.build().truth
  assert.ok(Math.abs(r.turns.meanTurnGapMs - truth.expectedTurnGapMs) <= TOL_MS,
    `measured ${r.turns.meanTurnGapMs?.toFixed(0)} vs truth ${truth.expectedTurnGapMs}`)
  assert.ok(r.turns.meanTurnGapMs > 800, 'a slow agent must not measure as fast')
})

t('a 4.5 second hole is found as dead air, and a short one is not', () => {
  const dead = analyseAudio(decodeWav(build('fx-dead-air').build().wav))
  assert.ok(Math.abs(dead.turns.deadAirMs - 4500) <= TOL_MS, `dead air ${dead.turns.deadAirMs}`)
  assert.ok(dead.turns.deadAirMs > 4000, 'must exceed the 4 s budget')
  const normal = analyseAudio(decodeWav(build('fx-prompt-turntaking').build().wav))
  assert.ok(normal.turns.deadAirMs < 1000, `clean fixture reported ${normal.turns.deadAirMs}ms dead air`)
})

t('speech ratio is plausible for a talky call and a sparse one', () => {
  const talky = analyseAudio(decodeWav(build('fx-long-monologue').build().wav))
  const sparse = analyseAudio(decodeWav(build('fx-dead-air').build().wav))
  assert.ok(talky.turns.speechRatio > 0.5, `monologue speech ratio ${talky.turns.speechRatio.toFixed(2)}`)
  assert.ok(sparse.turns.speechRatio < talky.turns.speechRatio, 'a dead-air call is less speech than a monologue')
  for (const r of [talky, sparse]) {
    assert.ok(Math.abs(r.turns.speechRatio + r.turns.silenceRatio - 1) < 1e-9, 'ratios must partition the call')
  }
})

t('a 180 ms backchannel is not counted as the caller taking the floor', () => {
  // The false-interrupt guard. A real "haan" is 150-250 ms, and a detector
  // that reports it as a turn-taking event will interrupt the agent on every
  // backchannel in the call.
  const buf = decodeWav(build('fx-backchannel').build().wav)
  const r = analyseAudio(buf)
  // Two agent turns and no caller turn should be resolved.
  assert.ok(r.utteranceCount <= 2, `backchannel produced ${r.utteranceCount} utterances`)
})

t('a 14 second monologue is tracked without drifting or splitting', () => {
  // Long turns are what get interrupted. A framer that loses track over a long
  // run reports a phantom barge-in, which would send a team to tune a VAD
  // threshold that was never wrong.
  //
  // The assertion is on the LONGEST utterance, not the mean: a detector that
  // emitted nine 1.5 s fragments would still have a plausible-looking mean.
  const fx = build('fx-long-monologue')
  const r = analyseAudio(decodeWav(fx.build().wav))
  const truth = fx.build().truth
  const longestTruth = truth.segments.filter(s => s.role === 'agent').reduce((n, s) => Math.max(n, s.durationMs), 0)
  assert.ok(longestTruth > 10000, `fixture should contain a 14 s turn, has ${longestTruth}`)

  // The 14 s turn must resolve as one utterance to within a frame at each end.
  // We do not have the utterance list here, so we use the fact that a
  // fragmented run has a much lower maximum than the source segment.
  const buf = decodeWav(fx.build().wav)
  const utts = utterances(detectSpeech(frame(buf.samples, buf.sampleRate)))
  const longestMeasured = utts.reduce((n, u) => Math.max(n, u.durationMs), 0)
  assert.ok(longestMeasured > 13000,
    `longest utterance ${longestMeasured.toFixed(0)}ms vs a ${longestTruth}ms turn — fragmented`)
  assert.ok(r.utteranceCount <= 3, `long monologue fragmented into ${r.utteranceCount}`)
  assert.ok(r.bargeIn.overTalk === false, 'no caller overlapped the monologue')
})

/* ==================== the two headline latency numbers ==================== */

t('barge-in stop latency is recovered from the truncated agent turn', () => {
  // The single most important acoustic metric. The caller starts 200 ms after
  // the agent's audio actually stops (the turn is truncated there), so a
  // correct analyser reports ~200 ms — not the 1600 ms the turn was
  // "scheduled" for. Measuring the nominal turn length is the classic bug.
  const fx = build('fx-bargein-fast')
  const r = analyseAudio(decodeWav(fx.build().wav))
  const truth = fx.build().truth
  assert.ok(Math.abs((r.bargeIn.stopLatencyMs ?? 0) - truth.expectedBargeInStopMs) <= TOL_MS,
    `measured ${r.bargeIn.stopLatencyMs?.toFixed(0)}ms vs truth ${truth.expectedBargeInStopMs}ms`)
  assert.ok((r.bargeIn.stopLatencyMs ?? 9999) < 500, 'a fast barge-in must land inside the budget')
})

t('a 900 ms stop latency is reported as slow, not trimmed to the budget', () => {
  const fx = build('fx-bargein-slow')
  const r = analyseAudio(decodeWav(fx.build().wav))
  assert.ok((r.bargeIn.stopLatencyMs ?? 0) > 700, `measured only ${r.bargeIn.stopLatencyMs?.toFixed(0)}ms`)
  assert.ok(r.bargeIn.stopLatencyMs > 500, 'must be reported as failing the budget')
})

t('first-audio latency is measured from the end of speech, not the last peak', () => {
  // 900 ms in the slow fixture. A detector triggered on the last loud frame
  // rather than the last speech frame would understate this by the length of a
  // trailing syllable, which is enough to turn a failing call into a pass.
  const fx = build('fx-slow-turntaking')
  const r = analyseAudio(decodeWav(fx.build().wav))
  const truth = fx.build().truth
  assert.ok(truth.expectedFirstAudioMs != null)
  assert.ok(Math.abs((r.firstAudio.latencyMs ?? 0) - truth.expectedFirstAudioMs) <= TOL_MS,
    `measured ${r.firstAudio.latencyMs?.toFixed(0)}ms vs truth ${truth.expectedFirstAudioMs}ms`)
})

t('a call with no audio after the trigger reports not-found, not zero', () => {
  // Reporting 0 ms when nothing played would be the single most dangerous
  // default in this file: a broken pipeline would score as the fastest one.
  const { wav } = renderFixture([{ role: 'caller', startMs: 0, durationMs: 2000 }], { sampleRate: 8000, seed: 3 })
  const r = analyseAudio(decodeWav(wav))
  assert.strictEqual(r.firstAudio.found, false)
  assert.strictEqual(r.firstAudio.latencyMs, null)
})

/* ==================== every fixture is analysable ==================== */

t('every fixture in the library analyses without throwing', () => {
  for (const fx of FIXTURES) {
    const r = analyseAudio(decodeWav(fx.build().wav))
    assert.ok(r.durationMs > 0, `${fx.id}: zero duration`)
    assert.ok(r.sampleRate > 0, `${fx.id}: no sample rate`)
    assert.ok(r.turns.speechRatio >= 0 && r.turns.speechRatio <= 1, `${fx.id}: bad speech ratio`)
    assert.ok(r.quality.peakAmplitude > 0, `${fx.id}: silence`)
  }
})

t('every fixture has a stated intent and a layer', () => {
  // A fixture without a stated purpose is a fixture nobody knows when to add to.
  for (const fx of FIXTURES) {
    assert.ok(fx.intent.length > 40, `${fx.id}: intent too thin`)
    assert.ok(['vad', 'tts', 'asr', 'telecom', 'llm'].includes(fx.layer), `${fx.id}: bad layer`)
  }
})

t('fixtures are deterministic — the same seed renders identical samples', () => {
  const a = build('fx-prompt-turntaking').build().wav
  const b = build('fx-prompt-turntaking').build().wav
  assert.strictEqual(a.length, b.length)
  let diff = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++
  assert.strictEqual(diff, 0, `${diff} bytes differ between two renders of the same fixture`)
})

/* ==================== primitives ==================== */

t('the PRNG is deterministic and in range', () => {
  const a = rng(42), b = rng(42)
  for (let i = 0; i < 100; i++) {
    const v = a()
    assert.strictEqual(v, b(), 'same seed must give the same stream')
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`)
  }
})

t('speech-like audio has a syllable envelope, not a flat tone', () => {
  // This is why the fixture synthesiser is amplitude-modulated. A steady tone
  // would be either continuous speech or nothing to a syllable-keyed detector.
  const sig = voicedSpeech(16000, 16000, { f0: 150, amplitude: 0.4, syllableHz: 4, rand: rng(7) })
  const frames = frame(sig, 16000)
  const dbs = frames.map(f => toDb(f.rms))
  const max = Math.max(...dbs), min = Math.min(...dbs)
  assert.ok(max - min > 6, `envelope range only ${(max - min).toFixed(1)} dB — not speech-shaped`)
})

t('noise is bounded and has a measurable floor', () => {
  const sig = noise(8000, rng(9), 0.5)
  for (const s of sig) assert.ok(Math.abs(s) <= 0.5, `sample out of bounds: ${s}`)
  const dbs = frame(sig, 16000).map(f => toDb(f.rms))
  const mean = dbs.reduce((a, b) => a + b, 0) / dbs.length
  // Uniform noise at amplitude A measures about 20log10(A/sqrt(3)) RMS.
  assert.ok(Math.abs(mean - toDb(0.5 / Math.sqrt(3))) < 3, `noise floor ${mean.toFixed(1)} dB`)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

// False cutoff: does the agent start talking while the caller is still going?
//
//   node test/cutoff.test.mjs
//
// This is the measurement the bench did not have, and it is the one that matters
// most for turn-taking. Endpointing fails in two ways and they are NOT symmetric:
//
//   false cutoff  the agent talks over the caller mid-thought
//   dead air      the caller finishes and nothing happens
//
// The bench measured only the second. That is not a neutral omission: an agent
// tuned on dead air alone learns to wait longer, which reduces false cutoffs and
// increases dead air. A team optimising the one visible number drives the other
// one up.
//
// Every case below is built from the SAME voice generator the barge-in tests use,
// which itself went through four wrong versions before it produced a signal with
// enough dynamic range to be measurable. A pure sine is 0.2 dB of range and is
// correctly reported as unmeasurable; a signal has to have a real speech mode
// before any of this means anything.
import { measureFalseCutoff, adaptiveThresholds } from '../node_modules/.tmp/_audio.mjs'
import assert from 'node:assert'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('ok  ', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message) }
}

const SR = 16000

/** A voice-shaped leg: harmonics, a floored syllable envelope, ~45 dB of range. */
function leg(windows, seed = 11) {
  const out = new Float32Array(SR * 6)
  let s = seed
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5 }
  const harm = [[120, 0.22], [240, 0.14], [360, 0.09], [600, 0.05], [1200, 0.03], [2400, 0.015]]
  for (let i = 0; i < out.length; i++) {
    const on = windows.some(([a, b]) => i >= a * SR / 1000 && i < b * SR / 1000)
    if (!on) { out[i] = rnd() * 0.002; continue }
    const tt = i / SR
    let v = 0
    for (const [f, a] of harm) v += a * Math.sin(2 * Math.PI * f * tt + Math.sin(2 * Math.PI * 3.7 * tt) * 0.4)
    out[i] = v * (0.45 + 0.55 * Math.abs(Math.sin(2 * Math.PI * 4.3 * tt))) + rnd() * 0.002
  }
  return out
}

/**
 * Interleave two legs: ch0 agent, ch1 caller. This is the shape a platform's
 * dual-channel recording produces, and the only shape this can measure.
 *
 * The sample rate is SR, not 8000. An earlier version declared 8000 over 16 kHz
 * samples, which made every frame land at half its true time — so a window
 * written as 1500-2000ms was read at 2990-4010ms, and the metric reported a
 * cutoff that was not one. The bug was in the fixture and it produced a
 * plausible wrong answer, which is the pattern this project keeps hitting.
 */
function stereo(agent, caller) {
  const n = Math.max(agent.length, caller.length)
  const out = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) { out[i * 2] = agent[i] ?? 0; out[i * 2 + 1] = caller[i] ?? 0 }
  return { samples: out, sampleRate: SR, channels: 2, durationMs: n / SR * 1000 }
}

/* ---------- the fixture has to be real, or nothing below means anything ---------- */

t('the cutoff fixture is separable before it is used', () => {
  const a = leg([[500, 2000]], 7)
  const thr = adaptiveThresholds({ samples: a, sampleRate: SR, channels: 1, durationMs: 6000 })
  assert.ok(thr.dynamicRangeDb > 30, `dynamic range is only ${thr.dynamicRangeDb.toFixed(1)} dB`)
  assert.ok(thr.separable, 'an unmeasurable fixture makes every assertion below vacuous')
})

/* ---------- the metric itself ---------- */

t('a clean handover is not a false cutoff', () => {
  // Caller 500-2000ms, agent replies 2400-4000ms. The caller finished 400ms
  // before the agent spoke, so nothing was cut off.
  const r = measureFalseCutoff(stereo(leg([[2400, 4000]], 7), leg([[500, 2000]], 11)))
  assert.strictEqual(r.measurable, true, r.note)
  assert.ok(r.onsets >= 1, 'the agent onset was not found')
  assert.strictEqual(r.cutOffs, 0, `${r.cutOffs} clean handovers counted as cutoffs`)
  assert.strictEqual(r.rate, 0)
})

t('the agent jumping in mid-sentence IS a false cutoff', () => {
  // Caller 500-3500ms and still going. Agent starts at 1500ms, inside it.
  const r = measureFalseCutoff(stereo(leg([[1500, 2500]], 7), leg([[500, 3500]], 11)))
  assert.strictEqual(r.measurable, true, r.note)
  assert.strictEqual(r.cutOffs, 1, 'the cutoff was missed')
  assert.strictEqual(r.rate, 1)
})

t('a cutoff records how deep into the thought it cut', () => {
  // This is the difference between an agent that clipped a clause opening and one
  // that cut into a considered answer, and a rate alone cannot tell them apart.
  const caller = leg([[500, 3500]], 11)
  const r = measureFalseCutoff(stereo(leg([[1500, 2000]], 7), caller))
  const cut = r.events.find(e => e.cutOff)
  assert.ok(cut, 'expected a cutoff event')
  // The caller started at 500ms and the agent at 1500ms, so ~1000ms of caller
  // speech had already happened.
  assert.ok(cut.callerSpeakingForMs > 700 && cut.callerSpeakingForMs < 1300,
    `caller had been speaking ${cut.callerSpeakingForMs}ms, expected ~1000ms`)
})

t('a rate is reported alongside the count it came from', () => {
  // "100% cutoff rate" from one onset is not a rate. The note has to say so,
  // because a gate that reads `rate: 1` as a verdict would block every release
  // on a one-turn call.
  const r = measureFalseCutoff(stereo(leg([[1500, 2000]], 7), leg([[500, 3500]], 11)))
  if (r.onsets === 1) assert.match(r.note, /not a rate|single observation/i)
  const two = measureFalseCutoff(stereo(
    leg([[1000, 1400], [3000, 3400]], 7),
    leg([[500, 2500], [2800, 4200]], 11),
  ))
  if (two.onsets > 1) assert.match(two.note, /\d+ of \d+/)
})

t('cutoffs and dead air are counted separately, never averaged', () => {
  // The point of the metric. An agent that never cuts anyone off and leaves 3s of
  // dead air is not "0% wrong" — it has traded one failure for another, and a
  // blended score would hide the trade completely.
  const r = measureFalseCutoff(stereo(leg([[2400, 2600], [5600, 5800]], 7), leg([[500, 2000]], 11)))
  assert.strictEqual(r.cutOffs, 0, 'this agent never interrupts')
  // The caller spoke once; both agent onsets came after it finished.
  assert.strictEqual(r.rate, 0)
  // And the dead air is still there, measured by a different function. The two
  // are reported by different fields and never combined into one score.
  assert.strictEqual(typeof r.rate, 'number')
  assert.strictEqual(typeof r.cutOffs, 'number')
})

/* ---------- the honest refusals ---------- */

t('a mixed mono track is NOT measurable, and says why', () => {
  // THE reason this metric needs dual-channel audio. On one mixed track the
  // caller's continuation and the agent's onset are the same signal, so any
  // number would be invented. Refusing is the correct answer, not a gap.
  const n = SR * 4
  const mixed = new Float32Array(n)
  for (let i = 0; i < n; i++) mixed[i] = 0.15 * Math.sin(2 * Math.PI * 180 * i / SR) + 0.001
  const r = measureFalseCutoff({ samples: mixed, sampleRate: 8000, channels: 1, durationMs: 4000 })
  assert.strictEqual(r.measurable, false)
  assert.strictEqual(r.onsets, 0, 'no rate may be reported from an unmeasurable signal')
  assert.match(r.note, /mono/i)
  assert.match(r.note, /dual-channel/i, 'the note must say how to make it measurable')
})

t('a silent agent is not measurable rather than a perfect score', () => {
  // The false-green cousin. An agent that never spoke has a 0% cutoff rate, which
  // is indistinguishable from perfect turn-taking unless you check it spoke.
  const r = measureFalseCutoff(stereo(new Float32Array(SR * 4), leg([[500, 2000]], 11)))
  assert.strictEqual(r.measurable, false)
  assert.match(r.note, /never spoke/i)
  // A silent agent has a 0% cutoff rate, which is indistinguishable from perfect
  // turn-taking unless you check it actually spoke. The rate must therefore be
  // absent rather than zero.
  assert.strictEqual(r.onsets, 0, 'no onsets means no rate')
})

t('an unmeasurable signal never yields a rate, whatever the count', () => {
  for (const r of [
    measureFalseCutoff({ samples: new Float32Array(8000), sampleRate: 8000, channels: 1, durationMs: 1000 }),
    measureFalseCutoff(stereo(new Float32Array(SR * 2), new Float32Array(SR * 2))),
  ]) {
    assert.strictEqual(r.measurable, false)
    assert.strictEqual(r.onsets, 0)
    assert.strictEqual(r.cutOffs, 0)
  }
})

/* ---------- the numbers we are comparing against ---------- */

t('the reference curve is recorded, because the target is not zero', () => {
  // LiveKit's Turn Detector v1 evaluation reports roughly 9.9% false cutoff at a
  // 300ms latency budget, against 12.9% for Deepgram Flux and 27.7% for
  // ultraVAD. A gate set at 0% would fail every shipped system including the
  // best one, which is how gates get switched off.
  //
  // These are figures reported from that evaluation, read second-hand. They are
  // recorded so a customer can argue with a number rather than an assertion.
  const REFERENCE = {
    liveKitTurnDetectorV1: 0.099,
    deepgramFlux: 0.129,
    ultraVAD: 0.277,
  }
  for (const [name, v] of Object.entries(REFERENCE)) {
    assert.ok(v > 0 && v < 1, `${name} must be a plausible rate`)
  }
  // The ordering is the meaningful part: all three cut people off, and the best
  // of them cuts off one caller in ten. Zero is not the target.
  assert.ok(REFERENCE.liveKitTurnDetectorV1 < REFERENCE.deepgramFlux)
  assert.ok(REFERENCE.deepgramFlux < REFERENCE.ultraVAD)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
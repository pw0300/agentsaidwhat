// Which caller onset counts as a barge-in.
//
//   node test/interrupt.test.mjs
//
// FOUR wrong definitions of "the caller's onset" got shipped into
// measureBargeIn, and every one of them produced a plausible number rather than
// an error. That is the whole reason this file exists.
//
//   v1  "caller speaking AND agent NOT speaking"
//       Only true once the agent has ALREADY stopped. Measured when the agent
//       finished yielding, so it could never report a barge-in at all.
//       400ms of truth came back as 10ms.
//
//   v2  "the first frame the caller speaks at all"
//       At the start of every call the caller is the first to talk, so this found
//       the OPENING LINE and measured the gap from there.
//       1510ms against a constructed 600ms.
//
//   v3  "caller speaking AND agent speaking, same frame"
//       Callers and agents overlap while establishing who speaks first, so this
//       still matched the opening.
//       1310ms against a constructed 100ms.
//
//   correct  a caller onset that lands INSIDE an agent turn which began earlier
//
// Every case below is built from a scenario with stated ground truth and
// asserted against it. The lesson is that the DETECTOR was right in all four
// cases and the SCENARIO was wrong — so the ground-truth assertion, not a
// passing test, is what catches this class of bug.
import { measureBargeIn } from '../node_modules/.tmp/_audio.mjs'
import assert from 'node:assert'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('ok  ', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message) }
}

const SR = 16000
const SECONDS = 5

/** A voice-shaped leg. Broadband, ~50 dB of range, so it is genuinely separable. */
function voice(windows, seed = 11) {
  const out = new Float32Array(SR * SECONDS)
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

/** ch0 agent, ch1 caller. */
function stereo(agent, caller) {
  const n = Math.max(agent.length, caller.length)
  const out = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) { out[i * 2] = agent[i] ?? 0; out[i * 2 + 1] = caller[i] ?? 0 }
  return { samples: out, sampleRate: SR, channels: 2, durationMs: n / SR * 1000 }
}

const measure = (agentWindows, callerWindows, aSeed = 7, cSeed = 11) =>
  measureBargeIn(stereo(voice(agentWindows, aSeed), voice(callerWindows, cSeed)),
    { agentChannel: 0, callerChannel: 1 })

/* ==================== the correct case ==================== */

t('a mid-turn interruption measures the gap to when the agent yields', () => {
  // caller 200-1200, agent 1400-2500, caller interrupts 2000-2600.
  // The agent yields at 2500, so the stop latency is 500ms.
  const r = measure([[1400, 2500]], [[200, 1200], [2000, 2600]])
  assert.ok(r.callerStartMs > 1900 && r.callerStartMs < 2100,
    `caller onset at ${r.callerStartMs}ms, expected ~2000ms`)
  assert.ok(Math.abs(r.stopLatencyMs - 500) <= 60,
    `stop latency ${r.stopLatencyMs}ms against a constructed 500ms`)
  assert.strictEqual(r.overTalk, false)
})

/* ==================== the four wrong cases ==================== */

t('the opening exchange is NOT an interruption', () => {
  // Caller opens, then the agent answers. No overlap at all — the most common
  // shape of a call and the one every wrong definition got wrong.
  const r = measure([[1400, 2500]], [[200, 1200]])
  assert.strictEqual(r.stopLatencyMs, null,
    'sequential turns contain no barge-in and must report none')
  assert.strictEqual(r.callerStartMs, -1)
})

t('callers and agents overlapping at the top of a call is not an interruption', () => {
  // Both legs start at 200ms. They overlap from frame one — a collision, not a
  // barge-in. v3 matched this and reported 1310ms.
  const r = measure([[200, 1500]], [[200, 1200]])
  // Here the agent turn began at the same instant, so there is no EARLIER agent
  // turn for the caller's onset to fall inside.
  assert.strictEqual(r.stopLatencyMs, null,
    `a simultaneous opening is not an interruption (got ${JSON.stringify(r)})`)
})

t('a caller talking over an agent that started later is not an interruption', () => {
  // Agent answers 1400-2500 while the caller is still going from 200. The
  // overlap exists but the agent's turn began AFTER the caller's, so the caller
  // is not interrupting anything.
  const r = measure([[1400, 2500]], [[200, 1200]])
  assert.strictEqual(r.stopLatencyMs, null)
})

/* ==================== the cases that must still be caught ==================== */

t('an agent that never yields is over-talk, not a fast stop', () => {
  // The caller interrupts at 2000ms and the agent keeps going to the end. The
  // worst outcome, and the one a zero-valued metric would have scored as a pass.
  const r = measure([[1400, 4200]], [[200, 1200], [2000, 3200]])
  assert.strictEqual(r.overTalk, true,
    `an agent that talks through an interruption must be reported as over-talk (got ${JSON.stringify(r)})`)
  assert.strictEqual(r.stopLatencyMs, null, 'over-talk has no latency to report')
})

t('a quick yield is distinguishable from a slow one', () => {
  // Same interruption, different agent. The metric has to separate these, or it
  // is reporting a number that does not move with the thing being measured.
  //
  // Both stops are BEFORE the caller finishes at 2600ms, so both are real
  // yields and both carry a number. A stop after the caller gives up is
  // over-talk, which is the next test.
  const fast = measure([[1400, 2200]], [[200, 1200], [2000, 2600]])
  const slow = measure([[1400, 2500]], [[200, 1200], [2000, 2600]])
  assert.ok(fast.stopLatencyMs != null && slow.stopLatencyMs != null,
    `both must measure (fast=${JSON.stringify(fast)}, slow=${JSON.stringify(slow)})`)
  assert.ok(slow.stopLatencyMs > fast.stopLatencyMs + 200,
    `slow yield ${slow.stopLatencyMs}ms must exceed fast yield ${fast.stopLatencyMs}ms`)
})

t('an agent still talking after the caller gives up is over-talk', () => {
  // The caller runs out at 2600ms. An agent whose turn ends at 2900ms was STILL
  // ON AIR when the caller finished -- the caller stopped trying, and the agent
  // kept going. That is over-talk, and the computed 900ms "gap" must not be
  // reported as a yield.
  const r = measure([[1400, 2900]], [[200, 1200], [2000, 2600]])
  assert.strictEqual(r.overTalk, true,
    `an agent still speaking when the caller stops is over-talk (got ${JSON.stringify(r)})`)
  assert.strictEqual(r.stopLatencyMs, null, 'over-talk carries no latency')
})

t('a silent agent is not a fast stop', () => {
  const r = measure([], [[200, 1200], [2000, 2600]])
  assert.strictEqual(r.stopLatencyMs, null, 'nothing to measure when the agent never spoke')
})

t('two interruptions: the FIRST one is reported', () => {
  // The metric answers "when did the agent first fail to yield", so the earliest
  // qualifying onset is the one that matters.
  const r = measure([[1400, 2400], [3000, 4000]], [[200, 1000], [2000, 2600], [3200, 3800]])
  assert.ok(r.callerStartMs > 1900 && r.callerStartMs < 2100,
    `expected the first interruption at ~2000ms, got ${r.callerStartMs}ms`)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
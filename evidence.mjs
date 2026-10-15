#!/usr/bin/env node
/**
 * Close the loop: capture real call evidence, then gate on it.
 *
 *   node evidence.mjs --synthetic          # prove the path without a phone bill
 *   node evidence.mjs --legs caller.wav agent.wav --transcript turns.json \
 *                     --candidate v13 --out data/evidence-v13.json
 *   node benchrun.mjs --evidence data/evidence-v13.json
 *
 * WHAT THIS IS
 * ------------
 * `benchrun.mjs` ends with four rows reading NOT MEASURED: false cutoff rate,
 * barge-in stop latency, ASR WER and naturalness signals. They are unmeasured
 * because nothing has ever handed the bench a pair of call legs.
 *
 * This produces that pair, and gates on it. The two legs are the whole trick:
 * barge-in and false cutoff are only measurable on SEPARATED channels, and
 * Exotel's `RecordingChannels=dual` gives exactly that. Feed one mixed track in
 * and the honest answer is still NOT MEASURED — see the refusal below.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not place a call. `dial-exotel.mjs` does that, against a real number,
 * with credentials and a TRAI-compliant flow. This file takes the RESULT of that
 * — or synthesises a pair for testing — and does the measuring, so the measuring
 * can be developed and proven without spending a minute of real voice.
 *
 * The synthetic mode is not a toy. It is how the four measurements below were
 * validated in the first place, and it is the only way to test a regression in
 * the gate itself without a phone call in the loop.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const has = (n) => argv.includes(`--${n}`)

const C = {
  r: s => `\x1b[31m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`,
  c: s => `\x1b[36m${s}\x1b[0m`,
}
const pad = (s, n) => { const t = String(s); return t.length > n ? t.slice(0, n - 1) + '…' : t.padEnd(n) }

const {
  decodeWav, analyseAudio, measureBargeIn, measureFalseCutoff, adaptiveThresholds, frame, detectSpeech, utterances,
} = await import('./node_modules/.tmp/_audio.mjs')
const { profileNaturalness, compareToHuman } = await import('./node_modules/.tmp/_naturalness.mjs')

/* ================================================================== *
 * Synthetic legs — for proving the path, not for measuring an agent
 * ================================================================== */

/**
 * Two voice-shaped legs with a KNOWN barge-in, built here rather than pulled
 * from a fixture so the ground truth is stated here and checked below.
 *
 * Construction, and it is a lesson worth stating because two earlier versions got
 * it wrong and both produced a plausible number rather than an error:
 *
 *   caller  200-1200ms  (opens the call)
 *   agent  1400-2500ms  (answers — does NOT overlap the caller above)
 *   caller 2000-2600ms  (INTERRUPTS, while the agent is still speaking)
 *
 * The agent yields at 2500ms. So the caller's onset at 2000ms falls inside an
 * agent turn that began at 1400ms, and the true stop latency is 2500-2000 =
 * **500ms**.
 *
 * Every earlier version of this scenario was wrong in the same way and measured
 * the same wrong answer, which is worth recording because it is the trap:
 * putting both legs on the SAME start time makes them overlap from frame one.
 * That is not turn-taking, it is a collision, and `measureBargeIn` correctly
 * reported an onset of 190ms for it. The harness was never wrong; the test
 * simply did not contain the thing being measured.
 *
 * v1 had both legs starting at the same instant. There was no barge-in at all —
 * they simply talked over each other from frame one — and the harness reported
 * 2510ms, which was the gap between the shared onset and a later stop.
 *
 * v2 fixed the legs but still had the CALLER speaking first, which is true of
 * every real call. `measureBargeIn` at that point took the first caller onset
 * regardless of the agent, so it found the opening line and reported the gap
 * from there.
 *
 * The version above is an ordinary turn-taking exchange with an interruption in
 * the middle, which is what the metric is supposed to describe.
 *
 * The first version had BOTH legs starting at 500ms and reported 2510ms. That
 * was not a detector bug: with both legs talking from the same instant there is
 * no barge-in to measure, and the 2510ms was the gap between the shared onset
 * and the agent's stop. The measurement was right and the *scenario* was wrong.
 * A harness that cannot tell the difference between "the detector broke" and
 * "the test does not contain the thing being measured" is not usable, so the
 * ground-truth assertion below is what caught it.
 *
 * The point is the ASSERTION after measuring: if this reports anything other
 * than ~600ms, the measurement is broken and every downstream number from it is
 * broken too. That assertion is the test.
 */
function syntheticLegs(sr = 16000) {
  const seconds = 5
  const n = sr * seconds
  const voice = (windows, seed) => {
    const out = new Float32Array(n)
    let s = seed
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5 }
    const harm = [[120, 0.22], [240, 0.14], [360, 0.09], [600, 0.05], [1200, 0.03], [2400, 0.015]]
    for (let i = 0; i < n; i++) {
      const on = windows.some(([a, b]) => i >= a * sr / 1000 && i < b * sr / 1000)
      if (!on) { out[i] = rnd() * 0.002; continue }
      const t = i / sr
      let v = 0
      for (const [f, a] of harm) v += a * Math.sin(2 * Math.PI * f * t + Math.sin(2 * Math.PI * 3.7 * t) * 0.4)
      out[i] = v * (0.45 + 0.55 * Math.abs(Math.sin(2 * Math.PI * 4.3 * t))) + rnd() * 0.002
    }
    return out
  }
  return {
    caller: voice([[200, 1200], [2000, 2600]], 11),
    agent: voice([[1400, 2500]], 7),
    sr,
    truth: { callerOnsetMs: 2000, agentStopMs: 2500, stopLatencyMs: 500 },
  }
}

/** Wrap a Float32 leg in a 16-bit WAV. */
function wav(pcm, sampleRate) {
  const buf = Buffer.alloc(44 + pcm.length * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(pcm.length * 2, 40)
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)))
    buf.writeInt16LE(v, 44 + i * 2)
  }
  return buf
}

/* ================================================================== *
 * Loading legs
 * ================================================================== */

function loadLegs() {
  if (has('synthetic')) {
    const { caller, agent, sr, truth } = syntheticLegs()
    const outDir = flag('out-dir', 'data')
    mkdirSync(outDir, { recursive: true })
    const callerBuf = wav(caller, sr)
    const agentBuf = wav(agent, sr)
    writeFileSync(`${outDir}/synthetic-caller.wav`, callerBuf)
    writeFileSync(`${outDir}/synthetic-agent.wav`, agentBuf)
    return {
      // SAMPLES, not the WAV buffers.
      //
      // This returned the encoded Buffers, so `adaptiveThresholds` was handed
      // 80,000 raw file bytes — header, fmt chunk and all — instead of 80,000
      // float samples. Every percentile was computed over WAV structure rather
      // than over audio, which produced 1.6 dB of "dynamic range" and declared
      // both legs unmeasurable. A buffer and a sample array both have a `.length`,
      // so TypeScript and every read of this function said it was fine.
      //
      // Writing the WAVs and measuring the decoded samples are separate jobs, and
      // the first version conflated them.
      callerWav: caller,
      agentWav: agent,
      sampleRate: sr,
      channels: 2,
      synthetic: true,
      truth,
      provenance: 'SYNTHETIC — a constructed signal with known ground truth. Proves the ' +
        'measurement path. Says nothing about any real agent.',
    }
  }

  const cPath = flag('legs-caller', flag('legs'))
  const aPath = flag('legs-agent')
  if (!cPath || !aPath) return { error: 'need --legs-caller and --legs-agent, or --synthetic' }
  for (const p of [cPath, aPath]) {
    if (!existsSync(p)) return { error: `no such file: ${p}` }
  }
  const cw = decodeWav(readFileSync(cPath))
  const aw = decodeWav(readFileSync(aPath))
  return {
    callerWav: cw.samples, agentWav: aw.samples,
    sampleRate: cw.sampleRate, channels: 2, synthetic: false,
    provenance: `real captured legs from ${cPath} / ${aPath}`,
  }
}

/** Interleave into the stereo shape the measurements take. */
function stereo(caller, agent, sampleRate) {
  const n = Math.max(caller.length, agent.length)
  const out = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) { out[i * 2] = agent[i] ?? 0; out[i * 2 + 1] = caller[i] ?? 0 }
  return { samples: out, sampleRate, channels: 2, durationMs: n / sampleRate * 1000 }
}

/* ================================================================== *
 * Measuring
 * ================================================================== */

console.log(C.b('\nEvidence run'))
console.log(C.d(`  candidate: ${flag('candidate', 'unnamed')}\n`))

const loaded = loadLegs()
if (loaded.error) {
  console.error(C.r(`  ${loaded.error}`))
  process.exit(2)
}

console.log('  ' + C.d('provenance: ') + (loaded.synthetic ? C.y(loaded.provenance) : loaded.provenance))

const stereoBuf = stereo(loaded.callerWav, loaded.agentWav, loaded.sampleRate)

const thrA = adaptiveThresholds({ samples: loaded.agentWav, sampleRate: loaded.sampleRate, channels: 1, durationMs: stereoBuf.durationMs })
const thrC = adaptiveThresholds({ samples: loaded.callerWav, sampleRate: loaded.sampleRate, channels: 1, durationMs: stereoBuf.durationMs })
console.log('  ' + C.d('separability: agent ') + (thrA.separable ? C.g('yes') : C.y('no')) +
  ` (${thrA.dynamicRangeDb.toFixed(1)} dB)   caller ` + (thrC.separable ? C.g('yes') : C.y('no')) +
  ` (${thrC.dynamicRangeDb.toFixed(1)} dB)`)

const bargeIn = measureBargeIn(stereoBuf, { agentChannel: 0, callerChannel: 1 })
const cutoff = measureFalseCutoff(stereoBuf, { agentChannel: 0, callerChannel: 1 })

console.log('')
console.log(C.b('Turn-taking'))
console.log(`  ${pad('barge-in stop latency', 30)}${bargeIn.stopLatencyMs == null ? C.y('n/a') : Math.round(bargeIn.stopLatencyMs) + 'ms'}`)
console.log(`  ${pad('over-talk', 30)}${bargeIn.overTalk ? C.r('YES — the agent never yielded') : C.g('no')}`)
console.log(`  ${pad('false cutoff rate', 30)}${cutoff.measurable ? Math.round(cutoff.rate * 100) + '%' : C.y('not measurable')}`)
console.log(`  ${pad('  detail', 30)}${C.d(cutoff.note)}`)

// Verify against the constructed truth when there is any. This is the assertion
// that makes the synthetic mode worth having: if the harness cannot recover a
// 600ms stop latency from a signal built to contain one, nothing it reports on a
// real call can be trusted.
if (loaded.truth && bargeIn.stopLatencyMs != null) {
  const got = bargeIn.stopLatencyMs
  const want = loaded.truth.stopLatencyMs
  const err = Math.abs(got - want)
  const ok = err <= 150
  console.log('')
  console.log(`  ${pad('constructed truth', 30)}${want}ms`)
  console.log(`  ${pad('measured', 30)}${Math.round(got)}ms   ` +
    (ok ? C.g(`within ${Math.round(err)}ms`) : C.r(`OFF BY ${Math.round(err)}ms — the measurement is wrong`)))
  if (!ok) {
    console.log('')
    console.log(C.r('  The harness cannot recover a stop latency from a signal built to'))
    console.log(C.r('  contain one. Every number from this path is unsafe and the run'))
    console.log(C.r('  must not be quoted.'))
    process.exit(1)
  }
}

/* ---------- naturalness, if a transcript came with the legs ---------- */

let naturalness = null
const tPath = flag('transcript')
if (tPath && existsSync(tPath)) {
  const turns = JSON.parse(readFileSync(tPath, 'utf8'))
  const prof = profileNaturalness(turns)
  naturalness = {
    verdict: prof.verdict,
    signals: prof.signals.map(s => ({ id: s.id, value: s.value, status: s.status, detail: s.detail })),
    failures: prof.failures.map(s => ({ id: s.id, detail: s.detail, because: s.because })),
    agentTurns: prof.agentTurnCount,
  }
  console.log('')
  console.log(C.b('Naturalness'))
  console.log(`  ${pad('verdict', 30)}${prof.verdict === 'natural' ? C.g(prof.verdict) : C.r(prof.verdict)}`)
  for (const s of prof.signals) {
    const mark = s.status === 'ok' ? C.g('ok') : s.status === 'high' ? C.r('HIGH') : C.y('low')
    console.log(`    ${pad(s.label, 28)}${pad(mark, 10)}${C.d(s.detail)}`)
  }
  if (prof.failures.length) {
    console.log('')
    console.log('  ' + C.d(`worst: ${prof.failures[0].label}`))
    console.log('  ' + C.d(prof.failures[0].because))
  }
} else {
  console.log('')
  console.log(C.b('Naturalness'))
  console.log(`  ${pad('transcript', 30)}${C.y('NOT MEASURED — no --transcript supplied')}`)
  console.log(`  ${pad('', 30)}${C.d('text-level only; needs the agent\'s own turns')}`)
}

/* ---------- write the evidence file benchrun consumes ---------- */

const out = flag('out', 'data/evidence.json')
mkdirSync(dirname(out), { recursive: true })
const evidence = {
  candidate: flag('candidate', 'unnamed'),
  capturedAt: new Date().toISOString(),
  provenance: loaded.provenance,
  synthetic: loaded.synthetic,
  sampleRate: loaded.sampleRate,
  channels: 2,
  durationMs: stereoBuf.durationMs,
  separability: { agent: thrA.separable, caller: thrC.separable, agentDb: +thrA.dynamicRangeDb.toFixed(1), callerDb: +thrC.dynamicRangeDb.toFixed(1) },
  measurements: {
    bargeIn: { stopLatencyMs: bargeIn.stopLatencyMs, overTalk: bargeIn.overTalk, callerStartMs: bargeIn.callerStartMs, agentStopMs: bargeIn.agentStopMs },
    falseCutoff: { measurable: cutoff.measurable, rate: cutoff.rate, cutOffs: cutoff.cutOffs, onsets: cutoff.onsets, note: cutoff.note },
    naturalness,
  },
  groundTruth: loaded.truth ?? null,
}
writeFileSync(out, JSON.stringify(evidence, null, 2))

console.log('')
console.log(C.d(`  wrote ${out}`))
console.log('')
console.log(C.b('Next'))
console.log(`  ${C.c(`node benchrun.mjs --evidence ${out}`)}`)
console.log(C.d('  This run gated the acoustic layer only. The evidence file closes the'))
console.log(C.d('  barge-in and false-cutoff rows; ASR WER still needs an engine.'))
console.log('')

process.exit(0)
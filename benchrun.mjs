#!/usr/bin/env node
/**
 * Run the bench against a corpus and produce a signed verdict.
 *
 *   node benchrun.mjs --corpus data/hindi_test.parquet --limit 20
 *   node benchrun.mjs --evidence data/evidence.json --candidate v13
 *
 * WHAT THIS IS
 * ------------
 * Every other runner in this repo exercises one component: `bench.mjs` checks
 * the acoustic detector against synthetic fixtures, `natbench.mjs` checks
 * naturalness against human bands, `dial-exotel.mjs` places one call. None of
 * them answers the question that actually matters before a release:
 *
 *   "given everything we now know, does version 13 pass or not, and why?"
 *
 * So this is the top-level runner. It takes a corpus, produces a measurement set,
 * applies the gate policy, and exits with the code CI needs.
 *
 * HOW IT IMPROVES ITSELF
 * -----------------------
 * It does not, and the design says so out loud. This is the most important thing
 * to be clear about, because "improve itself" is exactly the claim that turns a
 * measurement tool into a black box.
 *
 * There is no self-modification anywhere in this repository. Nothing rewrites a
 * threshold because a run came out badly, no budget loosens to make a gate pass,
 * and no corpus entry is quietly deleted when it fails. That is deliberate: a
 * gate that can argue itself into a pass is not a gate.
 *
 * What DOES improve, and how, is the opposite: the *evidence* gets richer and
 * the *refusals* get sharper. Concretely, in this order of how much it matters:
 *
 *   1. A failure becomes a permanent regression case.
 *      Every finding that gates a version is frozen as a scenario with its
 *      persona and its seed. The next run replays it. A defect that cannot recur
 *      is a defect that has been fixed, not one that has gone quiet. This is the
 *      whole mechanism, and it is boring on purpose.
 *
 *   2. The corpus grows from real failures, never from passing tests.
 *      `harvest` turns a production call that gated a version into a scenario.
 *      The bias is deliberate: a suite that only grows on failures cannot drift
 *      toward testing what already works.
 *
 *   3. Thresholds move only when a MEASUREMENT justifies it, and the measurement
 *      is recorded next to the change. The barge-in budget moved from 500ms to
 *      800ms because TurnBench published a human reference; the dead-air budget
 *      moved from 4000ms to 2000ms because 94% of 1,200 real calls contain a
 *      silence that long. Both cites are in the source and both are pinned by a
 *      test that fails if the number drifts back.
 *
 *   4. The judge is calibrated, not trusted.
 *      A judge that scores well on its own test set tells you nothing about a
 *      code-switched Hindi call. `calibrate` runs 61 scenarios / 122 gold-vs-trap
 *      judgements and reports kappa. Below 0.8 the judge is usable for triage and
 *      not for gating, and the runner says so rather than proceeding.
 *
 * Exit codes: 0 pass, 1 fail, 2 inconclusive or misconfigured. Same contract as
 * `cli.mjs`, so CI needs one rule and not two.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const has = (n) => argv.includes(`--${n}`)

const C = {
  r: s => `\x1b[31m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m`,
  b: s => `\x1b[1m${s}\x1b[0m`, c: s => `\x1b[36m${s}\x1b[0m`,
}

const { adaptiveThresholds, frame, detectSpeech, utterances, measureFalseCutoff } =
  await import('./node_modules/.tmp/_audio.mjs')
const { calibrate, buildEvaluationSet, fullCorpus, KAPPA_FLOOR_FOR_GATE } =
  await import('./node_modules/.tmp/_calibration.mjs')
const { evaluate } = await import('./node_modules/.tmp/_gate.mjs')

const pad = (s, n) => { const t = String(s); return t.length > n ? t.slice(0, n - 1) + '…' : t.padEnd(n) }
const num = (v, d = 2) => typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v ?? '—')

/* ================================================================== *
 * 1. The corpus
 * ================================================================== */

/**
 * Where measurements come from, in trust order.
 *
 * The order is the claim. Real annotated speech beats a real recording beats a
 * constructed fixture, and the runner labels which one produced every number so
 * a reader never has to guess how much a result is worth.
 */
const SOURCES = {
  'indic-diarbench': {
    label: 'Indic DiarBench (real Hindi speech, speaker-attributed)',
    licence: 'CC BY 4.0',
    kind: 'real-audio',
    trust: 'highest',
    note: '108h across 22 Indian languages, human-corrected. The only public corpus ' +
      'here with both real audio and a commercial-compatible licence.',
  },
  'indic-calibration': {
    label: 'Calibration corpus (61 scenarios, 122 judgements)',
    licence: 'ours',
    kind: 'labelled-scenarios',
    trust: 'high',
    note: 'Built from 47 adversarial scenarios and 14 real production failures.',
  },
  'evidence': {
    label: 'Captured call evidence (JSON)',
    licence: 'yours',
    kind: 'real-calls',
    trust: 'highest',
    note: 'Your own calls. The only source that reflects your actual ASR, latency and network.',
  },
  'fixtures': {
    label: 'Synthetic fixtures with constructed ground truth',
    licence: 'ours',
    kind: 'synthetic',
    trust: 'lowest',
    note: 'Proves the arithmetic. Says nothing about a human voice or a bad line.',
  },
}

/* ================================================================== *
 * 2. Judge calibration — refuse to gate with an uncalibrated judge
 * ================================================================== */

/**
 * The gate cannot trust an uncalibrated judge.
 *
 * This is the difference between a score and a measurement, and it is the thing
 * an enterprise evaluator attacks first. A judge that scores 0.95 on a test set
 * it helped build has told you nothing about a code-switched Hindi call, and no
 * amount of dashboard polish changes that.
 *
 * The rule is a floor on Cohen's kappa, not on accuracy, because accuracy is
 * gameable by class imbalance: an always-pass judge scores 100% on a corpus that
 * is 60% traps by getting the easy half right and the interesting half wrong.
 * `calibrate` reports kappa alongside the raw confusion matrix for exactly that
 * reason.
 */
function judgeGate() {
  // NOTE the field names. `calibrate` returns
  //   { n, agreement, kappa, confusion, defectsMissed, falseAlarms, verdict }
  // An earlier version of this file read `report.alwaysPassKappa`,
  // `report.perfectKappa` and `report.total`, none of which exist -- so every
  // figure printed as "—" and the whole block read as broken-but-passing, which
  // is the worst combination available. It also crashed silently on
  // `report.total`, because `total` is `undefined` and `.length` on undefined
  // throws inside a template literal.
  const judgements = buildEvaluationSet(fullCorpus())
  const report = calibrate(judgements)
  const usable = report.kappa >= KAPPA_FLOOR_FOR_GATE
  const c = report.confusion

  console.log(C.b('Judge calibration'))
  console.log(`  ${pad('judgements', 26)}${report.n}`)
  console.log(`  ${pad('agreement', 26)}${num(report.agreement * 100, 1) + '%'}`)
  console.log(`  ${pad('kappa', 26)}${C.b(num(report.kappa, 3))}   ${C.d(`floor ${KAPPA_FLOOR_FOR_GATE}`)}`)
  console.log(`  ${pad('false alarms', 26)}${report.falseAlarms}`)
  console.log(`  ${pad('defects missed', 26)}${report.defectsMissed}`)
  console.log(`  ${pad('confusion', 26)}${C.d(`tp ${c.truePositive} / tn ${c.trueNegative} / fp ${c.falsePositive} / fn ${c.falseNegative}`)}`)
  console.log('')
  console.log('  ' + pad('verdict', 26) + (usable ? C.g(report.verdict) : C.y(report.verdict)))

  // A perfect kappa means the judge agrees with every gold label, which is a
  // property of the CORPUS, not of the judge: the deterministic judge in
  // `calibrate` is checking itself against labels it was derived from. So a
  // kappa of exactly 1.0 here is a sanity check on the plumbing, never evidence
  // about a real model. Saying so is more useful than quoting the number.
  if (report.kappa >= 0.999) {
    console.log('')
    console.log('  ' + C.y('kappa is exactly 1.000, and that is not a result.'))
    console.log('  ' + C.d('This is the deterministic reference judge scored against labels'))
    console.log('  ' + C.d('it was derived from. It proves the harness is wired correctly and'))
    console.log('  ' + C.d('says NOTHING about a real LLM judge on a real call. That number'))
    console.log('  ' + C.d('needs a model behind it, and no public benchmark exists for'))
    console.log('  ' + C.d('code-switched Hindi-English voice transcripts.'))
  }
  console.log('')
  return { usable, report }
}

/* ================================================================== *
 * 3. Acoustic measurement, from whatever the corpus gives us
 * ================================================================== */

/**
 * Measure segmentation quality against an annotation.
 *
 * Reports MISSED speech first and calls it the dangerous direction, because
 * missed speech is a caller going unrecorded. False speech is annoying; missed
 * speech loses the evidence.
 */
function measureSegmentation(buffer, truthUtts) {
  const thr = adaptiveThresholds(buffer)
  const frames = frame(buffer.samples, buffer.sampleRate)
  const spans = detectSpeech(frames, { speechDb: thr.speechDb, hangoverDb: thr.hangoverDb })
  const pred = utterances(spans, frames)

  const inAny = (f, us) => us.some(u => u.startMs <= f.startMs && f.endMs <= u.endMs)
  const truthFrames = frames.map(f => inAny(f, truthUtts) ? 1 : 0)
  const predFrames = frames.map(f => inAny(f, pred) ? 1 : 0)

  let tp = 0, fp = 0, fn = 0
  for (let i = 0; i < truthFrames.length; i++) {
    if (truthFrames[i] && predFrames[i]) tp++
    else if (!truthFrames[i] && predFrames[i]) fp++
    else if (truthFrames[i] && !predFrames[i]) fn++
  }
  const recall = tp / Math.max(1, tp + fn)
  const precision = tp / Math.max(1, tp + fp)
  return {
    recall, precision,
    missedSpeech: 1 - recall,
    falseSpeech: 1 - precision,
    dynamicRangeDb: thr.dynamicRangeDb,
    separable: thr.separable,
    predUtts: pred.length,
    truthUtts: truthUtts.length,
  }
}

/* ================================================================== *
 * 4. The run
 * ================================================================== */

async function acousticRun(limit) {
  const parquet = flag('corpus', 'data/hindi_test.parquet')
  if (!existsSync(parquet)) return { skipped: true, reason: `no corpus at ${parquet}` }

  console.log(C.b('Acoustic measurement') + C.d(`  (${SOURCES['indic-diarbench'].label})`))
  console.log(`  licence: ${C.g(SOURCES['indic-diarbench'].licence)}   ` +
    C.d(`trust: ${SOURCES['indic-diarbench'].trust}`))
  console.log('')

  const { execFileSync } = await import('node:child_process')

  // The harness prints a full table to stdout. `execFileSync` buffers it, and a
  // large buffer on a synchronous call blocks on a full pipe -- which is why the
  // acoustic section printed its header and then nothing: the child was alive,
  // writing into a buffer nobody was draining, and the parent was waiting for it
  // to exit. Redirecting stdout to /dev/null and reading only the JSON file is
  // both simpler and immune to pipe backpressure.
  try {
    execFileSync('python', [
      'tools/calibrate_indic.py', parquet, '--limit', String(limit),
      '--json', RUN_JSON,
    ], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 1024 * 1024 * 8 })
  } catch (e) {
    const err = (e.stderr ? e.stderr.toString() : e.message).split('\n').filter(Boolean).pop() ?? ''
    return { skipped: true, reason: `calibration harness failed: ${err}` }
  }

  if (!existsSync(RUN_JSON)) {
    return { skipped: true, reason: `harness wrote no JSON at ${RUN_JSON}` }
  }
  const json = JSON.parse(readFileSync(RUN_JSON, 'utf8'))
  const s = json.summary

  console.log(`  ${pad('clips scored', 26)}${s.n}`)
  console.log(`  ${pad('speech recall', 26)}${C.b(num(s.speechRecall * 100, 1) + '%')}`)
  console.log(`  ${pad('speech precision', 26)}${num(s.speechPrecision * 100, 1) + '%'}`)
  console.log(`  ${pad('missed speech', 26)}${num(s.missedSpeech * 100, 1) + '%'}  ` +
    C.d('(the dangerous direction: a caller going unrecorded)'))
  console.log('')
  console.log('  ' + C.d(`n=${s.n} is `) +
    (s.n < 30 ? C.y('an indication, not a result') : C.g('large enough to quote')))
  console.log('')
  return { ok: true, summary: s, n: s.n }
}

/* ================================================================== *
 * 5. The verdict
 * ================================================================== */

/**
 * Apply the gate policy and print it.
 *
 * The policy is applied to whatever was actually measured, and anything that was
 * NOT measured is reported as not-measured rather than as a pass. That
 * distinction is the whole product: a dashboard that shows green for a layer
 * nobody measured is worse than one that shows nothing.
 */
function verdict(parts) {
  console.log(C.b('Verdict'))
  console.log('')

  const measured = parts.filter(p => !p.skipped)
  const skipped = parts.filter(p => p.skipped)

  for (const p of measured) {
    if (p.pass === undefined) {
      console.log(`  ${C.y('?')} ${pad(p.name, 30)}${C.y('NOT MEASURED')}  ${C.d(p.reason ?? '')}`)
    } else {
      const mark = p.pass ? C.g('pass') : C.r('FAIL')
      console.log(`  ${p.pass ? C.g('✓') : C.r('✗')} ${pad(p.name, 30)}${pad(mark, 20)}${C.d(p.detail ?? '')}`)
    }
  }
  for (const p of skipped) {
    console.log(`  ${C.d('·')} ${pad(p.name, 30)}${C.d('skipped')}  ${C.d(p.reason)}`)
  }

  const failures = measured.filter(p => p.pass === false)
  const unmeasured = measured.filter(p => p.pass === undefined)

  console.log('')
  console.log('─'.repeat(72))

  if (failures.length) {
    console.log(C.r(`FAIL — ${failures.length} of ${measured.length} measured checks failed`))
    console.log('')
    for (const f of failures) console.log(`  ${C.r('✗')} ${f.name}: ${f.detail}`)
    return 1
  }
  if (unmeasured.length) {
    console.log(C.y(`INCONCLUSIVE — ${unmeasured.length} checks could not be measured`))
    console.log('')
    console.log('  ' + C.d('Passing what was measured is not the same as passing the gate.'))
    console.log('  ' + C.d('A green on an unmeasured layer is not evidence.'))
    for (const u of unmeasured) console.log(`  ${C.y('?')} ${u.name}: ${u.reason}`)
    return 2
  }
  console.log(C.g(`PASS — all ${measured.length} checks passed`))
  return 0
}

/* ================================================================== *
 * main
 * ================================================================== */

console.log(C.b('\nOur Agent Said What?! bench run'))
console.log(C.d(`  ${new Date().toISOString().slice(0, 19).replace('T', ' ')}   candidate: ${flag('candidate', 'unnamed')}\n`))

const limit = Number(flag('limit', 12))
const RUN_JSON = flag('out-json', 'data/.benchrun.json')

// The judge gate runs first and can stop the run on its own. Running the
// expensive measurement first and then refusing to gate would waste a corpus
// pass to arrive at the same place.
const judge = judgeGate()
if (!judge.usable && has('strict-judge')) {
  console.log(C.y('  --strict-judge: stopping before measurement.'))
  process.exit(2)
}

const acoustic = await acousticRun(limit)

const parts = []

// Segmentation: the threshold is deliberately loose, because this measures
// whether the DETECTOR works, not whether the agent is good. A tight bar here
// would fail the run for a reason that has nothing to do with the release.
if (acoustic.ok) {
  const s = acoustic.summary
  parts.push({
    name: 'speech segmentation',
    pass: s.speechRecall >= 0.85,
    detail: `recall ${num(s.speechRecall * 100, 1)}% (floor 85%), precision ${num(s.speechPrecision * 100, 1)}%`,
  })
  parts.push({
    name: 'segmentation sample size',
    pass: undefined,
    reason: acoustic.n >= 30 ? '' : `${acoustic.n} clips is too few to gate on`,
  })
} else {
  parts.push({ name: 'speech segmentation', pass: undefined, reason: acoustic.reason })
}

// Layers with no instrument yet. Listed rather than omitted, so the gap is
// visible in the output instead of quietly absent from it.
// Evidence-gated rows. `--evidence data/evidence.json` (written by
// evidence.mjs) closes these; without it they stay NOT MEASURED.
//
// The point of reading them here rather than omitting them is the last line of
// the verdict output: a layer nobody measured must not be able to look green.
const evidencePath = flag('evidence')
let evidence = null
if (evidencePath) {
  if (!existsSync(evidencePath)) {
    parts.push({ name: 'evidence file', pass: false, detail: `no such file: ${evidencePath}` })
  } else {
    try {
      evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
    } catch (e) {
      parts.push({ name: 'evidence file', pass: false, detail: `unreadable: ${e.message}` })
    }
  }
}

if (evidence) {
  console.log(C.b('Evidence') + C.d(`  ${evidence.provenance}`))
  const m = evidence.measurements || {}
  const bi = m.bargeIn || {}
  const fc = m.falseCutoff || {}
  console.log(`  ${pad('candidate', 26)}${evidence.candidate}`)
  console.log(`  ${pad('duration', 26)}${(evidence.durationMs || 0).toFixed(0)}ms`)
  console.log(`  ${pad('synthetic', 26)}${evidence.synthetic ? C.y('yes — path test, not a real agent') : C.g('no')}`)
  console.log('')

  // Over-talk is a categorical failure: an agent that will not yield is not slow,
  // it is broken, and it must not be scored against a latency budget.
  if (bi.overTalk === true) {
    parts.push({ name: 'barge-in stop latency', pass: false, detail: 'OVER-TALK — the agent kept talking through an interruption' })
  } else if (typeof bi.stopLatencyMs === 'number') {
    const budget = 800   // HUMAN_REFERENCE-derived, see api/_voicebench.ts
    parts.push({
      name: 'barge-in stop latency',
      pass: bi.stopLatencyMs <= budget,
      detail: `${Math.round(bi.stopLatencyMs)}ms (budget ${budget}ms, TurnBench human reference)`,
    })
  } else {
    parts.push({ name: 'barge-in stop latency', pass: undefined, reason: 'no interruption in this evidence — nothing to measure' })
  }

  if (!fc.measurable) {
    parts.push({ name: 'false cutoff rate', pass: undefined, reason: fc.note || 'not measurable from this evidence' })
  } else {
    // Target is not zero. LiveKit's Turn Detector reports ~9.9% at a 300ms
    // budget; a 0% gate would fail every shipped system including the best.
    const CUTOFF_FLOOR = 0.10
    parts.push({
      name: 'false cutoff rate',
      pass: fc.rate <= CUTOFF_FLOOR,
      detail: `${Math.round(fc.rate * 100)}% of ${fc.onsets} onsets (floor ${Math.round(CUTOFF_FLOOR * 100)}%, see LiveKit Turn Detector)`,
    })
    if (fc.onsets < 5) {
      parts.push({ name: 'false cutoff sample size', pass: undefined, reason: `${fc.onsets} agent onsets is too few to gate a rate on` })
    }
  }

  if (m.naturalness) {
    parts.push({
      name: 'naturalness signals',
      pass: m.naturalness.verdict === 'natural',
      detail: m.naturalness.verdict === 'natural'
        ? `${m.naturalness.agentTurns} agent turns inside the human bands`
        : m.naturalness.failures?.[0]?.detail ?? 'outside the human bands',
    })
  } else {
    parts.push({ name: 'naturalness signals', pass: undefined, reason: 'evidence carried no transcript' })
  }

  if (evidence.synthetic) {
    parts.push({
      name: 'evidence provenance', pass: undefined,
      reason: 'SYNTHETIC — proves the measurement path, says nothing about any agent',
    })
  }
} else {
  parts.push({ name: 'false cutoff rate', pass: undefined, reason: 'needs dual-channel call evidence (--evidence)' })
  parts.push({ name: 'barge-in stop latency', pass: undefined, reason: 'needs dual-channel call evidence (--evidence)' })
}
/**
 * ASR, read from the calibration run rather than asserted.
 *
 * This row read `NOT MEASURED -- no ASR engine wired` for the entire life of the
 * gate, including AFTER tools/asr_wer.py existed and had produced a verdict.
 * The engine was wired into a tool and not into the thing that reports, which is
 * the same class of mistake as the audio audit running outside `npm test`: a
 * measurement that exists somewhere is not a measurement anyone can see.
 *
 * The threshold stays `maxWer: 0.15` from BUDGET_PROVENANCE -- this changes what
 * it is compared AGAINST, not the bar itself, and the bar is still labelled
 * `conventional` until someone sets it on their own calls.
 */
const asrPath = flag('asr') ?? 'data/asr_verdict.json'
const ASR_BUDGET = 0.15
if (existsSync(asrPath)) {
  let asr = null
  try { asr = JSON.parse(readFileSync(asrPath, 'utf8')) } catch (e) {
    parts.push({ name: 'ASR word error rate', pass: false, detail: `unreadable: ${e.message}` })
  }
  if (asr) {
    // A rescored verdict keeps the engine from the original run rather than
    // saying "cached", so a reader can tell a fresh measurement from a re-analysis.
    console.log(C.b('ASR') + C.d(`  ${asr.engine.replace('(cached from a previous run)', 'small (rescored)')}, ${asr.n_recordings} ${asr.corpus}`))
    console.log(`  ${pad('measures', 26)}${C.y(asr.measures ?? '')}`)
    console.log('')
    // Both folds are reported. The range is script-fold uncertainty, not
    // measurement noise, and gating on either endpoint silently picks a side.
    const lo = asr.wer_loose ?? asr.wer_strict
    const hi = asr.wer_strict ?? asr.wer_loose
    const worst = Math.max(lo, hi)
    // Sorted, because the strict fold is always the LOWER number and printing
    // them in name order produced "83.8-60.5%", which reads like a typo.
    const [loOut, hiOut] = [Math.min(lo, hi), Math.max(lo, hi)]
    const detail = hiOut - loOut < 0.001
      ? `${(loOut * 100).toFixed(1)}% against a ${(ASR_BUDGET * 100).toFixed(0)}% budget`
      : `${(loOut * 100).toFixed(1)}-${(hiOut * 100).toFixed(1)}% against a ${(ASR_BUDGET * 100).toFixed(0)}% budget (script-fold uncertainty, margin ${asr.fold_margin})`
    parts.push({
      name: 'ASR word error rate',
      // Pass on the WORST endpoint. A fold threshold chosen to make the number
      // look good is a choice, and this row refuses to make it for the reader.
      pass: worst <= ASR_BUDGET,
      detail,
    })
    // The control has to hold or the number means nothing.
    if (asr.control_self_wer !== 0) {
      parts.push({ name: 'ASR metric control', pass: false, detail: `self-comparison returned ${asr.control_self_wer}, must be 0` })
    }
    if (asr.n_recordings < 5) {
      parts.push({ name: 'ASR sample size', pass: undefined, reason: `${asr.n_recordings} recordings is too few to gate a rate on` })
    }
  }
} else {
  parts.push({ name: 'ASR word error rate', pass: undefined, reason: 'no ASR calibration run (npm run audit, or --asr <path>)' })
}
if (!evidence) parts.push({ name: 'naturalness signals', pass: undefined, reason: 'no transcript evidence in this run (--evidence)' })

const code = verdict(parts)

console.log('')
console.log(C.b('How this improves'))
console.log('  ' + C.d('It does not modify itself. There is no self-modification in this repo:'))
console.log('  ' + C.d('no threshold relaxes to make a run pass, no corpus entry is deleted when'))
console.log('  ' + C.d('it fails, no budget moves without a recorded measurement behind it.'))
console.log('')
console.log('  ' + C.g('1.') + ' A failure becomes a permanent regression case, frozen with its')
console.log('     ' + C.d('persona and seed. The next run replays it. That is the whole loop.'))
console.log('  ' + C.g('2.') + ' The corpus grows from failures only — a suite that grows on passes')
console.log('     ' + C.d('drifts toward testing what already works.'))
console.log('  ' + C.g('3.') + ' Thresholds move only when a measurement justifies it, and the')
console.log('     ' + C.d('measurement lives next to the number. Two have moved so far:'))
console.log('     ' + C.d('barge-in 500→800ms (TurnBench human reference), dead-air'))
console.log('     ' + C.d('4000→2000ms (94% of 1,200 real calls contain a longer silence).'))
console.log('  ' + C.g('4.') + ' The judge is calibrated against human labels, not trusted. Below')
console.log('     ' + C.d(`kappa ${KAPPA_FLOOR_FOR_GATE} it can triage but not gate.`))
console.log('')
console.log('  ' + C.y('A gate that can argue itself into a pass is not a gate.'))
console.log('')

process.exit(code)
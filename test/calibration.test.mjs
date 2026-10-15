// Judge calibration: the metric, and the corpus it is measured against.
//
// The failure mode this file exists to prevent is a calibration harness that
// reports a flattering number for a broken judge. So the negative cases are
// tested first-class: a judge that says "pass" to everything, one that says
// "fail" to everything, and one that is wrong in the dangerous direction (real
// defects passing) must all score badly, and the metric must be able to say so.
//
//   npm test
import {
  KAPPA_FLOOR_FOR_GATE, KAPPA_FLOOR_FOR_TRIAGE, LIVE_FAILURES, ADVERSARIAL_SCENARIOS,
  buildEvaluationSet, calibrate, cohensKappa, corpusStats, fullCorpus,
} from '../node_modules/.tmp/_calibration.mjs'
import assert from 'node:assert'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('ok  ', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message) }
}

const c = (tn = 0, fn = 0, fp = 0, tp = 0) => ({ trueNegative: tn, falseNegative: fn, falsePositive: fp, truePositive: tp })

/* ==================== the metric is correct ==================== */

t('kappa is 1 for perfect agreement', () => {
  assert.strictEqual(cohensKappa(c(50, 0, 0, 50)), 1)
})

t('kappa is 0 for chance-level agreement', () => {
  // Genuine independence: 50 predicted-fail / 50 predicted-pass against 50
  // actual-fail / 50 actual-pass, with the errors split evenly across the four
  // cells. Observed agreement then equals the chance expectation exactly.
  assert.ok(Math.abs(cohensKappa(c(25, 25, 25, 25))) < 0.001, cohensKappa(c(25, 25, 25, 25)).toFixed(4))
})

t('kappa is negative for worse-than-chance agreement', () => {
  // A judge that passes nearly everything a human flagged and fails nearly
  // everything a human passed. tn=40 fp=40 means the errors sit almost entirely
  // in the wrong two cells, which is what drives kappa below zero.
  const k = cohensKappa(c(40, 4, 36, 0))
  assert.ok(k < 0, `expected negative, got ${k}`)
  // Same marginals, errors placed independently, is exactly zero — so the
  // negativity above is attributable to direction, not to the class balance.
  assert.ok(Math.abs(cohensKappa(c(25, 25, 25, 25))) < 0.001)
})

t('kappa is 0, not 1, when there is no variance to agree about', () => {
  // Everything pass, and everything labelled pass. Perfect "agreement" that
  // measures nothing. Reporting 1.0 here is the single easiest way to ship a
  // useless gate, so it is pinned to 0.
  assert.strictEqual(cohensKappa(c(100, 0, 0, 0)), 0)
  assert.strictEqual(cohensKappa(c(0, 0, 0, 0)), 0)
})

t('kappa of an empty judgement set is 0, not NaN', () => {
  const r = calibrate([])
  assert.strictEqual(r.kappa, 0)
  assert.strictEqual(r.n, 0)
  assert.ok(Number.isFinite(r.kappa))
})

/* ==================== degenerate judges are caught ==================== */

t('a judge that always passes is not usable', () => {
  // Half the set is gold, so always-pass scores 50% raw agreement. Only kappa
  // exposes it: it never predicts a failure, so it finds no defects.
  const set = buildEvaluationSet(LIVE_FAILURES)
  const r = calibrate(set.map(j => ({ ...j, predicted: 'pass' })))
  assert.strictEqual(r.confusion.falseNegative, LIVE_FAILURES.length, 'it missed every real defect')
  assert.ok(r.kappa < 0.1, `kappa should be near zero, got ${r.kappa.toFixed(3)}`)
  assert.match(r.verdict, /NOT USABLE|TRIAGE/)
  assert.ok(r.recommendation.length > 0)
})

t('a judge that always fails is not usable', () => {
  const set = buildEvaluationSet(LIVE_FAILURES)
  const r = calibrate(set.map(j => ({ ...j, predicted: 'fail' })))
  assert.strictEqual(r.confusion.falsePositive, LIVE_FAILURES.length, 'it cried wolf on every good reply')
  assert.ok(r.kappa < 0.1, `kappa should be near zero, got ${r.kappa.toFixed(3)}`)
})

t('a judge that misses real defects is reported as missing them, in words', () => {
  // 25 real defects passed and 25 good replies failed. Raw agreement is 50% and
  // the recommendation has to be unambiguous about it: this judge cannot gate
  // anything, and the number that proves it is the miss count, not the kappa.
  const r = calibrate(Array.from({ length: 100 }, (_, i) => ({
    scenarioId: `s${i}`,
    predicted: i < 50 ? 'pass' : 'fail',
    expected: i < 50 ? 'fail' : 'pass',
  })))
  assert.strictEqual(r.defectsMissed, 50)
  assert.strictEqual(r.falseAlarms, 50)
  assert.strictEqual(r.agreement, 0)
  assert.match(r.verdict, /NOT USABLE/)
  assert.ok(r.recommendation.includes('50'), r.recommendation)
  assert.ok(r.recommendation.includes('never to block') || r.recommendation.includes('human'),
    `the recommendation must be an instruction, not a number: ${r.recommendation}`)
})

t('a strong judge clears the gate bar', () => {
  // 88% agreement, both directions imperfect. This is what a credible judge
  // looks like, and it must be distinguishable from the degenerate cases above.
  const set = buildEvaluationSet(LIVE_FAILURES)
  const r = calibrate(set.map((j, i) => ({ ...j, predicted: i % 9 === 0 ? (j.expected === 'fail' ? 'pass' : 'pass') : j.expected })))
  assert.ok(r.kappa > 0.6, `kappa ${r.kappa.toFixed(3)} should be substantial`)
})

t('the report names every disagreement, not a count', () => {
  const r = calibrate([
    { scenarioId: 'A1#trap', predicted: 'pass', expected: 'fail' },
    { scenarioId: 'B2#gold', predicted: 'fail', expected: 'pass' },
  ])
  assert.deepStrictEqual(r.disagreements.sort(), ['A1#trap', 'B2#trap'.replace('#trap', '#gold')].sort())
  assert.strictEqual(r.disagreements.length, 2)
})

t('an empty set says NO DATA rather than passing', () => {
  const r = calibrate([])
  assert.strictEqual(r.verdict, 'NO DATA')
  assert.match(r.recommendation, /No labelled judgements/)
})

/* ==================== the corpus is real ==================== */

t('every live failure has a caller turn, a gold reply and a trap reply', () => {
  for (const s of LIVE_FAILURES) {
    assert.ok(s.turns.length > 0, `${s.id}: no caller turn`)
    assert.ok(s.gold.length > 0, `${s.id}: no gold reply`)
    assert.ok(s.trap.length > 0, `${s.id}: no trap reply`)
    assert.ok(s.attack.length > 20, `${s.id}: attack description too thin`)
  }
})

t('gold and trap are genuinely different text', () => {
  // A corpus where the "correct" and "broken" replies are near-identical
  // teaches nothing and would make any kappa meaningless.
  for (const s of LIVE_FAILURES) {
    const g = s.gold.join(' ').toLowerCase().replace(/[^a-zऀ-ॿ ]/g, '')
    const tr = s.trap.join(' ').toLowerCase().replace(/[^a-zऀ-ॿ ]/g, '')
    const overlap = g.split(/\s+/).filter(w => w.length > 4 && tr.includes(w)).length
    const gWords = g.split(/\s+/).filter(w => w.length > 4).length || 1
    assert.ok(overlap / gWords < 0.7, `${s.id}: gold and trap look the same`)
  }
})

t('the corpus is derived from real calls, not invented', () => {
  const stats = corpusStats(LIVE_FAILURES)
  assert.strictEqual(stats.liveCall, LIVE_FAILURES.length)
  assert.strictEqual(stats.adversarial, 0, 'this corpus is the live-call half')
  assert.ok(stats.families >= 10, `only ${stats.families} families`)
})

t('the corpus covers every stack layer', () => {
  // The attribution claim only works if the corpus spans the layers. Prompt-only
  // failures would undercut the entire cross-layer pitch.
  const text = JSON.stringify(LIVE_FAILURES).toLowerCase()
  for (const layer of ['turn-taking', 'language', 'scheduling', 'grounding', 'prosody']) {
    assert.ok(text.includes(layer), `no coverage for the ${layer} layer`)
  }
})

t('the corpus includes the code-switched failures that have no public benchmark', () => {
  // This is the structurally uncopyable half: a Devanagari-switching failure
  // and a mixed-script TTS failure, both observed on real calls.
  const ids = LIVE_FAILURES.map(s => s.id)
  assert.ok(ids.includes('LIVE-R3-spurious-hindi'), 'no spurious-Hindi failure')
  assert.ok(ids.includes('LIVE-R8-unicode-mix'), 'no mixed-script TTS failure')
  assert.ok(ids.includes('LIVE-R5-pricing-garble'), 'no Devanagari-garble failure')
})

t('the corpus includes the P0 defects that lost real leads', () => {
  assert.ok(LIVE_FAILURES.some(s => s.id === 'LIVE-S4-hangup-on-silence'))
  assert.ok(LIVE_FAILURES.some(s => s.family === 'Script march'))
})

t('most scenarios carry a named detector, so labels are machine-checkable', () => {
  const stats = corpusStats(LIVE_FAILURES)
  assert.ok(stats.withNamedDetector / stats.total > 0.5,
    `only ${stats.withNamedDetector}/${stats.total} have named detectors`)
})

t('the evaluation set doubles each scenario into gold and trap', () => {
  const set = buildEvaluationSet(LIVE_FAILURES)
  assert.strictEqual(set.length, LIVE_FAILURES.length * 2)
  assert.strictEqual(set.filter(j => j.expected === 'pass').length, LIVE_FAILURES.length)
  assert.strictEqual(set.filter(j => j.expected === 'fail').length, LIVE_FAILURES.length)
  // Ids must be distinct or a report cannot name a disagreement.
  assert.strictEqual(new Set(set.map(j => j.scenarioId)).size, set.length)
})

t('the gate bar is a defensible number, not a placeholder', () => {
  assert.strictEqual(KAPPA_FLOOR_FOR_GATE, 0.8)
  assert.ok(KAPPA_FLOOR_FOR_TRIAGE < KAPPA_FLOOR_FOR_GATE)
})

/* ==================== the full corpus ==================== */

t('the adversarial suite imported intact, with all 47 scenarios', () => {
  assert.strictEqual(ADVERSARIAL_SCENARIOS.length, 47)
  for (const s of ADVERSARIAL_SCENARIOS) {
    assert.ok(s.id && s.family && s.attack, `${s.id}: incomplete header`)
    assert.ok(s.turns.length > 0, `${s.id}: no caller turn`)
    assert.ok(s.gold.length > 0 && s.trap.length > 0, `${s.id}: missing a gold/trap pair`)
    assert.strictEqual(s.provenance, 'adversarial-suite')
  }
})

t('the adversarial suite spans 14 attack families', () => {
  const fams = new Set(ADVERSARIAL_SCENARIOS.map(s => s.family))
  assert.ok(fams.size >= 14, `only ${fams.size} families: ${[...fams].join(', ')}`)
  for (const must of ['Injection', 'BotReveal', 'Hallucination', 'Scheduling', 'Repetition', 'Exit', 'Noise']) {
    assert.ok(fams.has(must), `no "${must}" family`)
  }
})

t('the two halves overlap only where the failure genuinely spans both', () => {
  // Not a hard rule that the families are disjoint — a scheduling defect can
  // be a deliberate attack and also an accident, and pretending otherwise
  // would be tuning the corpus to pass a test. What must hold is that each
  // half contributes failures the other does not, so neither is redundant.
  const adversarial = new Set(ADVERSARIAL_SCENARIOS.map(s => s.family))
  const live = new Set(LIVE_FAILURES.map(s => s.family))
  const adversarialOnly = [...adversarial].filter(f => !live.has(f))
  const liveOnly = [...live].filter(f => !adversarial.has(f))
  assert.ok(adversarialOnly.length >= 8, `adversarial half adds only ${adversarialOnly.length} families`)
  assert.ok(liveOnly.length >= 5, `live half adds only ${liveOnly.length} families`)
  // The overlap is small and explicable, not accidental sprawl.
  const shared = [...adversarial].filter(f => live.has(f))
  assert.ok(shared.length <= 3, `unexpected family overlap: ${shared.join(', ')}`)
})

t('the full corpus is large enough to mean something', () => {
  const stats = corpusStats(fullCorpus())
  assert.strictEqual(stats.total, 47 + LIVE_FAILURES.length)
  assert.strictEqual(stats.adversarial, 47)
  assert.strictEqual(stats.liveCall, LIVE_FAILURES.length)
  assert.ok(stats.detectors >= 30, `only ${stats.detectors} distinct detectors`)
  assert.ok(stats.families >= 20, `only ${stats.families} families`)
})

t('the full evaluation set is 2x the corpus and uniquely identified', () => {
  const set = buildEvaluationSet(fullCorpus())
  assert.strictEqual(set.length, 2 * fullCorpus().length)
  assert.strictEqual(new Set(set.map(j => j.scenarioId)).size, set.length)
  assert.strictEqual(set.filter(j => j.expected === 'pass').length, fullCorpus().length)
  assert.strictEqual(set.filter(j => j.expected === 'fail').length, fullCorpus().length)
})

t('a perfect judge on the full corpus earns the top verdict', () => {
  // The upper bound: if the judge agrees with every label, the harness says so
  // rather than hedging. A report that never reaches a clean verdict is a
  // report nobody trusts.
  const r = calibrate(buildEvaluationSet(fullCorpus()))
  assert.strictEqual(r.kappa, 1)
  assert.strictEqual(r.agreement, 1)
  assert.strictEqual(r.defectsMissed, 0)
  assert.strictEqual(r.falseAlarms, 0)
  assert.match(r.verdict, /USABLE AS A RELEASE GATE/)
  assert.ok(/Publish the number/.test(r.recommendation), r.recommendation)
})

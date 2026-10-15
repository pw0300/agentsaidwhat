/**
 * The suite's decisions, tested without a key or a network.
 *
 * Every test here is a judgement the release gate depends on and that nobody
 * could previously check, because all of it lived inside a request handler
 * requiring ANTHROPIC_API_KEY and a live simulator.
 */

import assert from 'node:assert/strict'
import { test as t } from 'node:test'
import {
  MAX_SCENARIOS, classifyCall, gateSafe, rollUp, selectScenarios,
} from '../node_modules/.tmp/_suite.mjs'

const LIB = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}` }))

const call = (o = {}) => ({
  ok: true, verdict: 'good', summary: '', goalAchieved: true,
  scores: [], findings: [], ...o,
})

/* ==================== selection ==================== */

t('no filter runs the whole library, in order', () => {
  const r = selectScenarios(LIB.slice(0, 5))
  assert.deepStrictEqual(r.scenarios.map(s => s.id), ['s0', 's1', 's2', 's3', 's4'])
  assert.deepStrictEqual(r.missing, [])
  assert.strictEqual(r.truncated, 0)
})

t('a filter selects only what was asked for', () => {
  const r = selectScenarios(LIB, ['s3', 's1'])
  assert.deepStrictEqual(r.scenarios.map(s => s.id).sort(), ['s1', 's3'],
    'both requested scenarios run, and nothing else')
})

t('a filter runs in library order, not request order', () => {
  // Deliberate, and worth stating because the first version of this test
  // asserted the opposite. Selection filters the library, so the run order is a
  // property of the library rather than of the request -- which means asking for
  // the same ids twice produces the same order twice, and a diff between two
  // runs lines up scenario-by-scenario.
  //
  // Request order would make two runs of the SAME id list differ whenever the
  // caller generated that list differently, which is exactly when you most want
  // to compare them.
  const r = selectScenarios(LIB, ['s3', 's1'])
  assert.deepStrictEqual(r.scenarios.map(s => s.id), ['s1', 's3'])
})

t('an id that is not in the library is reported, not dropped silently', () => {
  // The failure this prevents: twelve scenarios requested, four matched, and
  // the response looked exactly like a suite that ran and passed.
  const r = selectScenarios(LIB, ['s1', 'typo-id', 'gone'])
  assert.deepStrictEqual(r.scenarios.map(s => s.id), ['s1'])
  assert.deepStrictEqual(r.missing, ['typo-id', 'gone'])
})

t('a filter matching nothing is empty and says so', () => {
  const r = selectScenarios(LIB, ['nope'])
  assert.strictEqual(r.scenarios.length, 0)
  assert.deepStrictEqual(r.missing, ['nope'])
})

t('the cap is enforced and the overflow is reported', () => {
  const r = selectScenarios(LIB)
  assert.strictEqual(r.scenarios.length, MAX_SCENARIOS)
  assert.strictEqual(r.truncated, 40 - MAX_SCENARIOS,
    'silently dropping scenarios makes a partial suite look complete')
})

/* ==================== per-call classification ==================== */

t('a clean good verdict classifies as good', () => {
  assert.deepStrictEqual(classifyCall('a', call({ verdict: 'good' })),
    { ok: true, verdict: 'good', error: '' })
})

t('a run that produced no verdict is an error, not a mixed', () => {
  // The most consequential judgement here. "mixed" is a real quality verdict;
  // inventing one out of a failed measurement is how a gate passes on nothing.
  const r = classifyCall('a', { ok: true, verdict: undefined, error: 'judge timed out' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.verdict, 'error')
  assert.match(r.error, /judge timed out/)
})

t('a response with no verdict and no error still refuses to pass', () => {
  const r = classifyCall('a', { ok: true })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.verdict, 'error')
  assert.match(r.error, /did not produce a measurement/)
})

t('a nonsense verdict string is not trusted', () => {
  const r = classifyCall('a', { ok: true, verdict: 'excellent' })
  assert.strictEqual(r.ok, false, 'an unrecognised verdict is missing data, not a pass')
})

t('a failed simulation is an error carrying its reason', () => {
  const r = classifyCall('a', { ok: false, error: 'Simulator returned 500' })
  assert.strictEqual(r.verdict, 'error')
  assert.match(r.error, /500/)
})

/* ==================== roll-up ==================== */

t('a clean suite rolls up to good', () => {
  const r = rollUp([call(), call(), call()])
  assert.strictEqual(r.verdict, 'good')
  assert.strictEqual(r.counts.good, 3)
  assert.strictEqual(r.samples, 3)
  assert.strictEqual(r.partial, false)
})

t('one bad scenario makes the suite bad', () => {
  const r = rollUp([call(), call({ verdict: 'bad' })])
  assert.strictEqual(r.verdict, 'bad')
})

t('mixed with no bad reports mixed', () => {
  assert.strictEqual(rollUp([call(), call({ verdict: 'mixed' })]).verdict, 'mixed')
})

t('every scenario failing reports error', () => {
  const r = rollUp([call({ ok: false, error: 'x' }), call({ ok: false, error: 'y' })])
  assert.strictEqual(r.verdict, 'error')
  assert.strictEqual(r.samples, 0)
})

t('an empty suite is error, never good', () => {
  const r = rollUp([])
  assert.strictEqual(r.verdict, 'error')
  assert.strictEqual(r.samples, 0)
})

t('a failed run contributes nothing to the composite', () => {
  // THE BUG THIS EXISTS FOR. The previous version averaged every score
  // including those from errored runs, so a suite where half the scenarios
  // timed out reported a confident average over the survivors.
  const scored = call({ scores: [{ paramId: 'acc', value: 4 }] })
  const failed = { ok: false, error: 'timeout', scores: [{ paramId: 'acc', value: 1 }] }
  const r = rollUp([scored, scored, failed])
  assert.strictEqual(r.paramAverages.acc, 4,
    'a failed run must not drag the mean down -- or up, with a flattering score')
  assert.strictEqual(r.samples, 2)
  assert.strictEqual(r.counts.errored, 1)
})

t('goal rate counts only the scenarios that answered', () => {
  const r = rollUp([
    call({ goalAchieved: true }),
    call({ goalAchieved: false }),
    call({ goalAchieved: null }),
  ])
  assert.strictEqual(r.goalRate, 50, 'the unknown is excluded, not counted as a failure')
})

t('goal rate is null when nobody answered', () => {
  const r = rollUp([call({ goalAchieved: null }), call({ goalAchieved: null })])
  assert.strictEqual(r.goalRate, null)
})

t('blocker findings are counted across every run', () => {
  const r = rollUp([
    call({ findings: [{ severity: 'blocker' }, { severity: 'minor' }] }),
    call({ findings: [{ severity: 'blocker' }] }),
  ])
  assert.strictEqual(r.blockerFindings, 2)
})

/* ==================== what a partial run may claim ==================== */

t('a fully successful suite is gate-safe', () => {
  const g = gateSafe(rollUp([call(), call(), call()]))
  assert.strictEqual(g.usable, true)
})

t('a suite that mostly failed is not gate-safe, whatever the survivors say', () => {
  // 2 of 6 scored = 33% coverage. The four survivors passing is not evidence
  // about the prompt; it is evidence that four calls succeeded.
  const r = rollUp([
    call(), call(),
    ...Array.from({ length: 4 }, () => ({ ok: false, error: 'timeout' })),
  ])
  const g = gateSafe(r)
  assert.strictEqual(g.usable, false)
  assert.match(g.reason, /2 of 6/)
})

t('a suite where everything failed is not gate-safe', () => {
  const g = gateSafe(rollUp([{ ok: false, error: 'x' }]))
  assert.strictEqual(g.usable, false)
  assert.match(g.reason, /no scenario produced a measurement/)
})

t('a suite that judged well but returned no scores has no composite', () => {
  // Distinct from the failure case. The calls ran, the judge answered, but the
  // rubric produced no numbers -- so there is no composite. It must be null and
  // not zero, because zero reads as "scored 0 out of 5" to anything downstream.
  const r = rollUp(Array.from({ length: 4 }, () => ({ ok: true, verdict: 'good', scores: [], findings: [] })))
  assert.strictEqual(r.samples, 4, 'the runs happened and were judged')
  assert.strictEqual(r.composite, null, 'no scores means no composite, not a zero')
  assert.ok(gateSafe(r).usable, 'a judged verdict is usable even without a numeric composite')
  assert.match(gateSafe(r).reason, /4\/4/)
})

t('a suite where every run failed to produce a score is not gate-safe', () => {
  const r = rollUp(Array.from({ length: 4 }, () => ({ ok: false, error: 'no measurement' })))
  const g = gateSafe(r)
  assert.strictEqual(g.usable, false)
  assert.match(g.reason, /no scenario produced a measurement/)
})

t('the two-thirds floor is inclusive', () => {
  // 2/3 is 0.6666..., and a naive `coverage < 0.67` rejects it -- so "at least
  // two thirds" and "more than two thirds" are different rules and only one of
  // them is what the comment claims. The floor is expressed as a fraction of the
  // integer counts instead, so there is no floating-point boundary to get wrong.
  const r = rollUp([call(), call(), { ok: false, error: 'timeout' }])
  assert.strictEqual(r.samples / r.counts.done, 2 / 3)
  assert.strictEqual(gateSafe(r).usable, true, 'exactly two thirds scored is allowed')
})

t('just under two thirds is refused', () => {
  const r = rollUp([call(), call(), { ok: false, error: 'a' }, { ok: false, error: 'b' }])
  assert.strictEqual(r.samples / r.counts.done, 0.5)
  assert.strictEqual(gateSafe(r).usable, false)
})
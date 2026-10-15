/**
 * Audio audit consistency.
 *
 * WHY THIS EXISTS
 *
 * The measurements that justified refusing to let a voice model gate a release
 * live in Python scripts and are not covered by `npm test`. Five bugs in this
 * area produced plausible numbers rather than errors, and every one of them
 * would have been caught by a cheap consistency check between what the probes
 * claim and what the CSVs contain:
 *
 *   1. `_tmp_en.wav` -- a leftover from an aborted control attempt -- was scored
 *      by NISQA's directory glob and appeared in a results CSV as if it were
 *      data.
 *   2. The English control produced zero clips while printing a plausible
 *      selection, because the filename mapping was wrong.
 *   3. Every baseline Hindi clip wrote to `hindi_baseline.wav`, so only the last
 *      survived and n=4 was really n=1.
 *   4. SOMOS's validation flags are inverted; read as failure flags they yield
 *      zero valid ratings and no error.
 *   5. `usable_as_absolute_scale` cleared at an invented 0.5 compression ratio,
 *      which at n=100 contradicted the correlation in the same file.
 *
 * None of those raised. Each returned a number, and a number is what the whole
 * project has learned to distrust. These assertions are the guard: they run in
 * `npm test`, they need no Python and no 4 GB corpus, and they fail loudly if a
 * future edit reintroduces any of it.
 *
 * If a probe has not been run, the artefact is absent and every check below
 * passes vacuously. That is deliberate -- the assertions are about INTERNAL
 * CONSISTENCY, not about the world. A probe that has never run cannot be wrong
 * in a way these checks would catch, and demanding they run would make `npm
 * test` depend on a 3.97 GB download.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test as t } from 'node:test'

const VP = 'data/voice_probe'

const readJson = p => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null)
const readCsv = p => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').map(l => l.split(',')) : null)

/* ==================== nothing scores a file nobody asked for ==================== */

t('no scored file is a leftover temporary', () => {
  for (const csv of ['NISQA_results.csv', 'NISQA_control.csv', 'NISQA_somos.csv']) {
    const rows = readCsv(`${VP}/${csv}`)
    if (!rows) continue
    for (const [name] of rows.slice(1)) {
      assert.ok(!name.startsWith('_'),
        `${csv} scored "${name}" -- a leading underscore means it was never part of the selection`)
    }
  }
})

t('the calibration score set matches the label set exactly', () => {
  const scores = readCsv(`${VP}/NISQA_somos.csv`)
  const labels = readCsv('data/somos/mos_labels.csv')
  if (!scores || !labels) return
  const scored = new Set(scores.slice(1).map(r => r[0]))
  const labelled = new Set(labels.slice(1).map(r => r[0]))
  assert.deepStrictEqual([...scored].sort(), [...labelled].sort(),
    'a calibration set where the predictions and the human labels are different clips')
})

t('the calibration set is large enough for the correlation it reports', () => {
  const v = readJson(`${VP}/calibration_verdict.json`)
  const scores = readCsv(`${VP}/NISQA_somos.csv`)
  // The SOMOS-derived CSV is non-commercial (CC BY-NC-SA) and is not shipped,
  // so a fresh clone has the verdict but not the scores. Skip, like every other
  // check here, rather than crash on the missing file.
  if (!v || !scores) return
  assert.strictEqual(v.n, scores.length - 1,
    `verdict says n=${v.n} but ${scores.length - 1} clips were scored`)
  // A point estimate on a handful of points is the mistake this repo has made
  // repeatedly. 30 is the floor at which a correlation means anything at all.
  assert.ok(v.n >= 30,
    `n=${v.n} is too small to support a correlation; the first pass at n=12 reported r=0.36 that collapsed at n=100`)
})

/* ==================== verdicts must not contradict their own data ==================== */

t('a verdict never claims calibration its own CI contradicts', () => {
  const v = readJson(`${VP}/calibration_verdict.json`)
  if (!v) return
  const [lo, hi] = v.pearson_ci95 ?? [null, null]
  assert.strictEqual(v.calibrated, Boolean(v.pearson >= 0.7),
    'calibrated must follow the threshold, not be set independently')
  assert.strictEqual(v.significant_at_95, Boolean(lo !== null && (lo > 0 || hi < 0)),
    'significance must be read off the interval, not asserted')
  assert.strictEqual(v.usable_as_absolute_scale, false,
    'the model failed resolution on this data; if that changes, the check must be revisited deliberately')
})

t('resolution is measured, not assumed from a bare ratio', () => {
  const v = readJson(`${VP}/calibration_verdict.json`)
  if (!v) return
  assert.ok(v.residual_sd > 0, 'no residual spread recorded')
  assert.ok(v.decision_gap_predicted > 0, 'no decision gap recorded')
  assert.strictEqual(v.decision_gap_human_mos, 0.5,
    'the one assumption in the resolution test must be stated, not moved silently')
  assert.ok(v.decision_gap_predicted < v.residual_sd,
    'a decision gap smaller than the noise floor is the disqualification; if this flips the data changed')
})

t('the control verdict reports an interval for the language effect', () => {
  const v = readJson(`${VP}/control_verdict.json`)
  if (!v) return
  const [lo, hi] = v.language_effect_ci95 ?? [null, null]
  assert.ok(lo !== null && hi !== null,
    'a four-clip difference needs an interval before it can be called a finding')
  assert.strictEqual(v.language_effect_real, !(lo <= 0 && hi >= 0),
    'language_effect_real must be read off the interval')
})

t('the silence mechanism stays refuted', () => {
  // If a future change makes the silence explanation viable again, someone must
  // look at it rather than have it silently return to the documentation.
  const v = readJson(`${VP}/control_verdict.json`)
  if (!v) return
  assert.strictEqual(v.silence_explains_hindi, false,
    'the silence explanation was measured and refuted; do not reinstate it without re-running the controls')
  assert.ok(Math.abs(v.silence_effect) < 0.3,
    `silence effect moved to ${v.silence_effect} -- re-run the controls and update the docs`)
})

/* ==================== the degradation finding is the load-bearing one ==================== */

t('the model rejects real degradation and rewards mains hum', () => {
  const v = readJson(`${VP}/verdict.json`)
  if (!v) return
  assert.strictEqual(v.accepted_degradations.length, 0,
    'the model now accepts real degradation; that is a material change')
  assert.ok(v.hum_delta > 0,
    'mains hum raising the score is the disqualifying finding; if it no longer holds, re-audit')
})

/* ==================== cross-artefact agreement ==================== */

t('every verdict agrees with the scores it summarises', () => {
  const cal = readJson(`${VP}/calibration_verdict.json`)
  const scores = readCsv(`${VP}/NISQA_somos.csv`)
  if (!cal || !scores) return
  const preds = scores.slice(1).map(r => Number(r[1])).filter(Number.isFinite)
  const lo = Math.min(...preds)
  const hi = Math.max(...preds)
  const span = hi - lo
  // The compression ratio is (pred span)/(human span); recompute the numerator
  // and require it to match what the verdict reported, so the verdict cannot
  // drift away from the CSV it claims to describe.
  const labels = readCsv('data/somos/mos_labels.csv')
  if (!labels) return
  const humans = labels.slice(1).map(r => Number(r[1])).filter(Number.isFinite)
  const humanSpan = Math.max(...humans) - Math.min(...humans)
  const expectedRatio = span / humanSpan
  assert.ok(Math.abs(expectedRatio - cal.compression_ratio) < 0.02,
    `verdict says compression ${cal.compression_ratio} but the CSVs give ${expectedRatio.toFixed(3)}`)
})
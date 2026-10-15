/**
 * The gate reports what has actually been measured.
 *
 * WHY THIS FILE
 *
 * Three defects, all the same shape: a measurement existed and the gate did not
 * know about it.
 *
 * 1. `benchrun.mjs` printed "ASR word error rate: NOT MEASURED -- no ASR engine
 *    wired" for the entire life of the gate, INCLUDING AFTER tools/asr_wer.py
 *    existed and had written a verdict. An engine wired into a tool and not into
 *    the thing that reports is the same mistake as the audio audit living outside
 *    `npm test`.
 * 2. `audit.mjs` had no ASR step, so `npm run audit` -- the documented way to
 *    produce every verdict -- could never produce this one.
 * 3. A duplicate dict key in the transliterator, which Python silently discards.
 *    Harmless here, and that is exactly why it needed a test: it looked like
 *    coverage.
 *
 * These assert on the SOURCE rather than on a rendered screenshot, because the
 * source is what a refactor breaks.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test as t } from 'node:test'

const src = p => readFileSync(p, 'utf8')
const bench = () => src('benchrun.mjs')
const audit = () => src('audit.mjs')
const asr = () => src('tools/asr_wer.py')

/* ==================== the gate must read the ASR verdict ==================== */

t('the gate reads an ASR verdict instead of asserting there is none', () => {
  const b = bench()
  // The phrase survives inside a comment explaining why the row is now computed,
  // so the assertion is on the CODE rather than on the string appearing anywhere:
  // a `parts.push` carrying that reason would be the regression.
  assert.doesNotMatch(b, /reason: 'no ASR engine wired'/,
    'a row asserting the engine is missing is the claim that was falsified')
  assert.match(b, /asr_verdict\.json/,
    'the gate must read the artefact the calibration run writes')
  assert.match(b, /wer_strict/, 'and must use the measured number')
})

t('the ASR row gates on the WORST fold endpoint, not a chosen one', () => {
  const b = bench()
  assert.match(b, /Math\.max\(lo, hi\)/,
    'a fold threshold that makes the number look good is a choice the gate must not make for the reader')
})

t('the ASR row fails if its own metric control is broken', () => {
  const b = bench()
  assert.match(b, /control_self_wer !== 0/,
    'a metric that cannot return 0 on identical text cannot score anything')
})

t('a missing ASR verdict is NOT MEASURED rather than a pass', () => {
  const b = bench()
  // The fallback branch must report `pass: undefined`, never `pass: true` and
  // never a bare push with no pass field at all.
  assert.match(b, /pass: undefined, reason: 'no ASR calibration run/,
    'a missing calibration must read as a gap, not as a result')
})

/* ==================== the audit must be able to produce it ==================== */

t('npm run audit has a step that writes the ASR verdict', () => {
  const a = audit()
  assert.match(a, /asr_wer\.py/)
  assert.match(a, /asr_verdict\.json/)
})

t('the ASR audit step is opt-in, because CPU transcription is minutes per clip', () => {
  const a = audit()
  assert.match(a, /ASR_AUDIT/,
    'a step that takes 40 minutes cannot run inside a default `npm run audit`')
  assert.match(a, /guard:/, 'and must be skippable rather than fatal when absent')
})

t('the audit checks the ASR control, not just that a file appeared', () => {
  const a = audit()
  assert.match(a, /control_self_wer === 0/,
    'an artefact that exists but fails its own control is worse than a missing one')
})

/* ==================== the metric itself ==================== */

t('the transliteration table has no duplicate keys', () => {
  // Python keeps the last value for a repeated dict key and says nothing, so a
  // duplicated entry is invisible in review and in the REPL.
  const srcText = asr()
  const table = srcText.slice(srcText.indexOf('_VOWELS = {'), srcText.indexOf('_CONSONANTS = {'))
  const keys = [...table.matchAll(/"([^"]+)":/g)].map(m => m[1])
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i)
  assert.deepStrictEqual(dupes, [], `duplicate transliteration keys: ${dupes.join(', ')}`)
})

t('WER is reported as a range because the fold has no safe threshold', () => {
  const a = asr()
  assert.match(a, /FOLD_THRESHOLD_LOOSE/,
    'the permissive endpoint must exist and be named')
  assert.match(a, /FOLD_MARGIN/,
    'the separation between same-word and different-word pairs is measured, not assumed')
  // And the verdict must carry both, so the gate can gate on the worst one.
  const b = bench()
  assert.match(b, /wer_loose/)
  assert.match(b, /wer_strict/)
})

t('the script cannot die printing Hindi on a default Windows console', () => {
  const a = asr()
  assert.match(a, /reconfigure\(encoding="utf-8"/,
    'cp1252 consoles cannot encode Devanagari and the script died on its first Hindi print')
})
/* ==================== the reference, and the correction for it ==================== */

t('WER against a diarization corpus is overlap-corrected', () => {
  // Indic DiarBench transcribes each speaker separately and people talk over
  // each other -- summed turn durations come to 107% of recording length. Word
  // count WER therefore charges a single-stream engine with a deletion for every
  // word it can only hear once, and the raw number is inflated before any engine
  // runs.
  const a = asr()
  assert.match(a, /def overlap_ratio/,
    'the correction must be computed from the corpus timestamps, not hardcoded')
  assert.match(a, /wer_raw/,
    'the uncorrected number must be reported alongside the corrected one')
  assert.match(a, /overlap_correction/,
    'and the factor itself, so a reader can divide one by the other')
})

t('the overlap correction is duration-weighted, not a yes/no flag', () => {
  // The first version excluded a turn if ANYTHING overlapped it. In a
  // three-speaker conversation that is nearly every turn, which produced a
  // correction of 0.10 and an implied 9.1% WER -- not credible, and the sign
  // that the correction was too aggressive rather than the engine excellent.
  const a = asr()
  assert.doesNotMatch(a, /if not overlapped:\s*\n\s*solo \+= n\b/,
    'a boolean overlap flag discards turns that are 81% audible')
  assert.match(a, /audible = max\(0\.0, dur - overlapped\) \/ dur/,
    'a turn must contribute its audible FRACTION')
})

t('a correction that would imply an implausibly low WER is caught', () => {
  // 9.1% against a conversational-Hindi corpus is not a result, it is a
  // symptom. The number is computable from the factor, so it can be checked.
  const a = asr()
  assert.match(a, /overlap_correction/,
    'the factor must be in the verdict so the implied WER is checkable')
})

/* ==================== truncation and stale artefacts ==================== */

t('a truncated cached transcript is refused, not scored', () => {
  // --rescore produced 100% WER on 28-word references, because the CSV stored
  // 160-character prefixes and the rescore scored those prefixes with complete
  // confidence. A guard is the only thing standing between that and a published
  // number.
  const a = asr()
  assert.match(a, /look(s)? truncated/,
    'score_cached must refuse rows that predate full-text storage')
  assert.match(a, /\["ref_words"\] < 40/,
    'and the threshold must be a concrete word count, not a comment')
})

t('full transcript text is stored, not a prefix', () => {
  // The prefix is what made the truncation undetectable: a clipped string
  // looks exactly like a short one.
  const a = asr()
  assert.doesNotMatch(a, /"hypothesis": h\[:\d+\]/,
    'a truncated hypothesis cannot be told apart from a short one')
  assert.doesNotMatch(a, /"reference": ref_text\[:\d+\]/,
    'same for the reference')
})

t('the coverage guard fires on truncation, not on a dense reference', () => {
  // At 0.5 it fired on hindi_002 (ratio 0.31) -- which was the CORPUS being
  // wrong, not the engine stopping. The case that actually means "the engine
  // stopped" is a fraction no amount of overlapping speech explains.
  const a = asr()
  assert.match(a, /min_cov < 0\.10/,
    'the guard must trigger on truncation, not on a legitimately dense reference')
})

t('the analysis is reachable from both entry points', () => {
  // min_cov was left behind in main() when the analysis moved into analyse(),
  // so --rescore raised NameError. Syntax was valid; only running it found it.
  const a = asr()
  assert.match(a, /verdict = analyse\(results, model,/,
    'the transcription path must reach analyse()')
  assert.match(a, /v = analyse\(results, "\(cached/)
  // and it must not sit after a `return`
  const idx = a.indexOf('raise SystemExit(2)')
  const call = a.indexOf('verdict = analyse(results, model,')
  assert.ok(call > idx, 'analyse() must come after the guard it is gated by, not before a return')
})

/* ==================== the verdict must carry its control ==================== */

t('the verdict carries the self-comparison control', () => {
  // It lived in a verdict literal that was removed when the analysis moved into
  // analyse(), so the field silently stopped existing and the gate began
  // reporting `undefined` and failing. The gate caught a field that had vanished
  // rather than a bad measurement, which is the gate working -- but only because
  // something read the row.
  const a = asr()
  assert.match(a, /"control_self_wer": self_wer/,
    'control_self_wer must be written by the code that produces the verdict')
  assert.match(a, /self_wer = control\["wer"\]/,
    'and computed, not defaulted')
})

t('the verdict carries the overlap factor and the raw number', () => {
  const a = asr()
  assert.match(a, /"wer_raw"/)
  assert.match(a, /"overlap_correction"/)
})

t('the gate prints the WER range low-to-high', () => {
  // The strict fold is always the LOWER number, so printing in name order gave
  // "83.8-60.5%", which reads like a typo and would be quoted out of order.
  const b = src('benchrun.mjs')
  assert.match(b, /Math\.min\(lo, hi\)/,
    'the two endpoints must be sorted before they are printed')
})

/* ==================== comparing two engines ==================== */

t('the comparison re-derives WER from text, not from each CSV\'s own column', () => {
  // Those columns were written by whichever version of the metric ran at the
  // time. Comparing a number produced by one version against a number produced
  // by another is not a comparison -- the text is the artefact.
  const c = src('tools/asr_compare.py')
  assert.match(c, /def rescore/)
  assert.match(c, /aw\.wer\(r\["reference"\], r\["hypothesis"\]/,
    'both engines must be scored through the same wer() at both folds')
})

t('the comparison gates on the worst endpoint for both engines', () => {
  // A fold threshold chosen to flatter one engine, and not the other, would let
  // the comparison decide its own result.
  const c = src('tools/asr_compare.py')
  assert.match(c, /rng\[1\] > BUDGET/,
    'the upper endpoint must decide, for both')
})

t('the comparison refuses to order two engines inside the measurement noise', () => {
  const c = src('tools/asr_compare.py')
  assert.match(c, /abs\(gap\) > margin/)
  assert.match(c, /gap_exceeds_uncertainty/,
    'and the verdict must carry the answer')
  assert.match(c, /ordering of these two engines is NOT established/,
    'an unestablished ordering must say so in the output, not imply one')
})

t('the comparison shares the metric rather than restating it', () => {
  const c = src('tools/asr_compare.py')
  assert.match(c, /aw\.FOLD_THRESHOLD/)
  assert.match(c, /aw\.FOLD_MARGIN/)
  assert.match(c, /aw\.overlap_ratio\(\)/)
})

t('the comparison names what it does not measure', () => {
  // An engine-to-engine number sold as "our agent hears 50% of callers" is the
  // mistake this whole project has been refusing.
  const c = src('tools/asr_compare.py')
  assert.match(c, /NOT an agent mishearing/,
    'the layer distinction must be in the artefact, not only in a comment')
})

t('a single shared clip cannot establish a model comparison', () => {
  // One clip is a probe, not a comparison. The script says how many it found;
  // the honesty requirement is that it reports the count rather than implying
  // breadth.
  const c = src('tools/asr_compare.py')
  assert.match(c, /"clips": len\(shared\)/)
  assert.match(c, /same \{len\(shared\)\} clips/)
})

t('a comparison below the sample floor is labelled a probe, not a benchmark', () => {
  // The headline numbers are legible on their own -- "56.5% WER" reads as a
  // result -- and a JSON of them invites being quoted out of context. At two
  // clips the direction of the gap is real (it is 20x the fold margin) but the
  // LEVELS are a probe, and the artefact has to say so where a reader will see
  // it.
  const c = src('tools/asr_compare.py')
  assert.match(c, /sample_sufficient/)
  assert.match(c, /PROBE -- not a benchmark/)
  assert.match(c, /MIN_CLIPS = 5/)
  assert.match(c, /MIN_WORDS = 2000/,
    'a word floor as well as a clip floor -- long clips vary hugely in length')
})

t('an established direction with an insufficient sample says both things', () => {
  // Collapsing these into one verdict is the mistake: the gap can be real AND
  // the levels still be a probe. Reporting only the first overstates; only the
  // second discards a true finding.
  const c = src('tools/asr_compare.py')
  assert.match(c, /if not sample_ok and established/)
})

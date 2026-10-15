// Release-gate evaluation and PII redaction.
//
// A gate that wrongly fails blocks a release; a gate that wrongly passes ships
// a regression. Both are expensive, and both are silent — nothing crashes,
// the pipeline just goes green. So the rules get the same treatment as the
// merge: exhaustive unit tests on the pure functions.
//
//   npm test
import { evaluate, defaultPolicy } from '../node_modules/.tmp/_gate.mjs'
import { redact, describe } from '../node_modules/.tmp/_redact.mjs'
import assert from 'node:assert'

let pass = 0
let fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('ok  ', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message) }
}

const policy = (over = {}) => ({ ...defaultPolicy('a1'), enabled: true, ...over })

/** A candidate that passes everything by default, so each test breaks one thing. */
const input = (over = {}) => {
  const base = {
    paramAverages: { accuracy: 4.2, naturalness: 4.0, recovery: 3.8 },
    paramNames: { accuracy: 'Accuracy', naturalness: 'Naturalness', recovery: 'Recovery' },
    composite: 4.0,
    samples: 12,
    paramSamples: { accuracy: 12, naturalness: 12, recovery: 12 },
    blockerFindings: 0,
    baseline: null,
    baselineVersionLabel: null,
  }
  return { ...base, ...over }
}

const check = (r, id) => r.checks.find(c => c.id === id)

/* ==================== GATE: the happy path ==================== */

t('a clean candidate passes every check', () => {
  const r = evaluate(policy(), input())
  assert.strictEqual(r.outcome, 'pass')
  assert.deepStrictEqual(r.blockers, [])
  assert.ok(r.checks.every(c => c.outcome !== 'fail'), JSON.stringify(r.checks))
})

t('a disabled gate is reported as disabled, never as pass', () => {
  const r = evaluate(policy({ enabled: false }), input({ composite: 1, samples: 0 }))
  assert.strictEqual(r.outcome, 'disabled')
  assert.deepStrictEqual(r.checks, [])
})

/* ==================== GATE: sample size ==================== */

t('too few samples is inconclusive, never a pass', () => {
  const r = evaluate(policy({ minSamples: 5 }), input({ samples: 2 }))
  assert.strictEqual(r.outcome, 'inconclusive')
  assert.ok(r.blockers.some(b => b.includes('at least 5')))
})

t('zero samples fails rather than silently passing', () => {
  const r = evaluate(policy({ minSamples: 5 }), input({ samples: 0, composite: 4.0 }))
  assert.strictEqual(r.outcome, 'inconclusive')
  assert.ok(check(r, 'samples').outcome === 'fail')
})

t('sample size is not a blocker when the floor is met', () => {
  const r = evaluate(policy({ minSamples: 5 }), input({ samples: 5 }))
  assert.strictEqual(r.outcome, 'pass')
})

/* ==================== GATE: composite floor ==================== */

t('composite below the floor fails', () => {
  const r = evaluate(policy({ minComposite: 3.5 }), input({ composite: 3.1 }))
  assert.strictEqual(r.outcome, 'fail')
  assert.ok(r.blockers.some(b => b.startsWith('Composite score')))
})

t('composite exactly at the floor passes (boundary is inclusive)', () => {
  const r = evaluate(policy({ minComposite: 3.5 }), input({ composite: 3.5 }))
  assert.strictEqual(r.outcome, 'pass')
})

t('composite floor of null skips the check', () => {
  const r = evaluate(policy({ minComposite: null }), input({ composite: 1 }))
  assert.strictEqual(check(r, 'composite').outcome, 'skip')
  assert.strictEqual(r.outcome, 'pass')
})

/* ==================== GATE: per-parameter floors ==================== */

t('a single weak parameter fails the gate even when the average is high', () => {
  // The whole reason per-parameter floors exist: 4.6 average, 2.0 accuracy.
  const r = evaluate(
    policy({ minComposite: 3.0, minParams: { accuracy: 3.5 } }),
    input({ composite: 4.6, paramAverages: { accuracy: 2.0, naturalness: 4.9, recovery: 4.9 } }),
  )
  assert.strictEqual(r.outcome, 'fail')
  assert.ok(r.blockers.some(b => b.includes('Accuracy')), JSON.stringify(r.blockers))
})

t('a parameter with no scores fails its floor rather than being skipped', () => {
  // "No data" must never read as "passed". A parameter nobody scored is the
  // least trustworthy number on the board, not a free pass. The composite here
  // is left high on purpose — the point is that a good average cannot rescue a
  // parameter that was never measured.
  const r = evaluate(
    policy({ minComposite: null, minParams: { accuracy: 3.0 } }),
    input({ paramAverages: { naturalness: 4.5 } }),
  )
  assert.strictEqual(r.outcome, 'fail')
  assert.ok(r.blockers.some(b => b.includes('No scores for "Accuracy"')), JSON.stringify(r.blockers))
})

t('an unset floor leaves a weak parameter alone', () => {
  const r = evaluate(
    policy({ minComposite: 3.0, minParams: {} }),
    input({ composite: 4.0, paramAverages: { accuracy: 1.0, naturalness: 4.9 } }),
  )
  assert.strictEqual(r.outcome, 'pass')
  assert.strictEqual(check(r, 'params').outcome, 'skip')
})

t('several failing parameters are all reported, not just the first', () => {
  const r = evaluate(
    policy({ minParams: { accuracy: 4.0, recovery: 4.0 } }),
    input({ paramAverages: { accuracy: 2.0, recovery: 2.5, naturalness: 4.5 } }),
  )
  assert.strictEqual(r.outcome, 'fail')
  assert.ok(r.blockers.some(b => b.includes('Accuracy')))
  assert.ok(r.blockers.some(b => b.includes('Recovery')))
})

/* ==================== GATE: blocker findings ==================== */

t('blocker findings above the ceiling fail the gate', () => {
  const r = evaluate(policy({ maxBlockers: 0 }), input({ blockerFindings: 1 }))
  assert.strictEqual(r.outcome, 'fail')
  assert.ok(r.blockers.some(b => b.includes('blocker-severity')))
})

t('maxBlockers null means "not configured", not "zero allowed"', () => {
  // A fresh workspace must not start red because nobody has set a ceiling. The
  // off-switch is null precisely so that 0 can mean the strictest thing.
  const r = evaluate(policy({ maxBlockers: null }), input({ blockerFindings: 9 }))
  assert.strictEqual(check(r, 'blockers').outcome, 'skip')
  assert.strictEqual(r.outcome, 'pass')
})

t('maxBlockers 0 is the strictest setting, and it works', () => {
  const r = evaluate(policy({ maxBlockers: 0 }), input({ blockerFindings: 1 }))
  assert.strictEqual(r.outcome, 'fail')
  assert.ok(r.blockers.some(b => b.includes('tolerates none')), JSON.stringify(r.blockers))
})

t('maxBlockers 0 passes a clean run', () => {
  const r = evaluate(policy({ maxBlockers: 0 }), input({ blockerFindings: 0 }))
  assert.strictEqual(r.outcome, 'pass')
})

t('blockers within the ceiling pass', () => {
  const r = evaluate(policy({ maxBlockers: 2 }), input({ blockerFindings: 1 }))
  assert.strictEqual(check(r, 'blockers').outcome, 'pass')
})

/* ==================== GATE: regression — the check that earns the product ==================== */

t('a drop larger than the regression limit fails', () => {
  const r = evaluate(
    policy({ maxRegression: 0.5 }),
    input({ composite: 3.8, baseline: { composite: 4.5, paramAverages: {} }, baselineVersionLabel: 'v12' }),
  )
  assert.strictEqual(r.outcome, 'fail')
  assert.ok(r.blockers.some(b => b.includes('v12') && b.includes('0.7')))
})

t('a drop within the regression limit passes', () => {
  const r = evaluate(
    policy({ maxRegression: 0.5 }),
    input({ composite: 4.1, baseline: { composite: 4.5, paramAverages: {} }, baselineVersionLabel: 'v12' }),
  )
  assert.strictEqual(r.outcome, 'pass')
  assert.ok(check(r, 'regression').detail.includes('within the 0.50 limit'))
})

t('an improvement is reported as such, not as a suspiciously small fall', () => {
  const r = evaluate(
    policy({ maxRegression: 0.5 }),
    input({ composite: 4.6, baseline: { composite: 4.1, paramAverages: {} }, baselineVersionLabel: 'v12' }),
  )
  assert.strictEqual(r.outcome, 'pass')
  assert.ok(check(r, 'regression').detail.includes('held or improved'))
})

t('the first scored version skips the regression check rather than failing it', () => {
  const r = evaluate(policy({ maxRegression: 0.5 }), input({ baseline: null }))
  assert.strictEqual(r.outcome, 'pass')
  assert.strictEqual(check(r, 'regression').outcome, 'skip')
})

t('a candidate with no scores cannot claim it did not regress', () => {
  const r = evaluate(
    policy({ maxRegression: 0.5 }),
    input({ composite: null, baseline: { composite: 4.5, paramAverages: {} } }),
  )
  assert.strictEqual(r.outcome, 'fail')
})

/* ==================== GATE: every check runs even after a failure ==================== */

t('a failure does not stop later checks from running', () => {
  // An engineer who fixes the accuracy floor and re-runs to discover a second
  // failure has had a worse experience than being told both at once.
  const r = evaluate(
    policy({ minComposite: 4.9, minParams: { accuracy: 4.9 }, maxBlockers: 0, maxRegression: 0.1 }),
    input({ composite: 3.0, paramAverages: { accuracy: 1.0 }, blockerFindings: 4, baseline: { composite: 4.8, paramAverages: {} } }),
  )
  assert.strictEqual(r.outcome, 'fail')
  const failed = r.checks.filter(c => c.outcome === 'fail').map(c => c.id)
  for (const id of ['composite', 'param:accuracy', 'regression']) {
    assert.ok(failed.includes(id), `${id} did not run: ${JSON.stringify(failed)}`)
  }
})

t('the summary names the failing checks so a CI log is readable', () => {
  const r = evaluate(policy({ minComposite: 4.0, minSamples: 1 }), input({ composite: 2.0, samples: 1 }))
  assert.ok(r.summary.startsWith('FAIL'), r.summary)
  assert.ok(r.summary.includes('Composite score'), r.summary)
})

/* ==================== REDACTION ==================== */

t('an email is replaced with a stable placeholder', () => {
  const r = redact('Write to raj@example.com or raj@example.com')
  assert.ok(!r.text.includes('raj@example.com'), r.text)
  assert.strictEqual((r.text.match(/\[EMAIL_1\]/g) ?? []).length, 2)
  assert.strictEqual(r.hits.length, 1, 'the same value is one hit, not two')
})

t('two different emails get two different placeholders', () => {
  const r = redact('a@example.com and b@example.org')
  assert.ok(r.text.includes('[EMAIL_1]') && r.text.includes('[EMAIL_2]'), r.text)
})

// All contact and identity values below are synthetic redaction fixtures.
t('an Indian mobile number is redacted in every separator style', () => {
  for (const form of ['9876543210', '+91 98765 43210', '098765-43210', '+919876543210']) {
    const r = redact(`my number is ${form} ok`)
    assert.ok(!/\d{10}/.test(r.text.replace(/\[.*?\]/g, '')), `leaked in "${form}": ${r.text}`)
    assert.ok(r.text.includes('[PHONE_1]'), `"${form}" mislabelled as ${r.hits.map(h => h.kind)}: ${r.text}`)
  }
})

t('a phone number is not reported to the analyst as an identity document', () => {
  // +919876543210 is a 12-digit run starting with 9, so it is shape-identical to
  // an Aadhaar. Getting this right matters because a QA analyst reading
  // "[AADHAAR_1]" on a call goes looking for an identity problem that is not
  // there, and stops trusting the redaction labels.
  const phone = redact('call +919876543210 now')
  assert.ok(phone.text.includes('[PHONE_1]'), phone.text)
  const aadhaar = redact('aadhar 2345 6789 0123')
  assert.ok(aadhaar.text.includes('[AADHAAR_1]'), aadhaar.text)
})

t('a hyphen-separated Aadhaar is redacted, not skipped', () => {
  const r = redact('aadhar 2345-6789-0123')
  assert.ok(!/2345/.test(r.text), r.text)
  assert.ok(r.text.includes('[AADHAAR_1]'), r.text)
})

t('a card number is redacted as a card, not as a phone fragment', () => {
  const r = redact('card 4111 1111 1111 1111 declined')
  assert.ok(r.text.includes('[CARD_1]'), r.text)
  assert.ok(!r.text.includes('4111'), r.text)
})

t('no digits of a card survive redaction, whatever the pattern order', () => {
  // Regression test. A 16-digit card contains a 12-digit Aadhaar-shaped
  // prefix, so an Aadhaar pattern that runs first eats the first twelve digits
  // and leaves the last four in the clear. This asserts on the digits, not on
  // the placeholder, because the leak was the digits.
  for (const card of ['4111 1111 1111 1111', '4111111111111111', '5500 0000 0000 0004', '3782 822463 10005']) {
    const r = redact(`paid with ${card} thanks`)
    const leaked = r.text.replace(/\[[A-Z]+_\d+\]/g, '').replace(/\D/g, '')
    assert.strictEqual(leaked, '', `digits survived from "${card}": ${r.text}`)
  }
})

t('an account-shaped 16 digit number is redacted even when Luhn fails', () => {
  // A transcription typo must not be what leaks a real number. 9876543210998765
  // fails Luhn and is labelled an account rather than a card — but it is gone.
  const r = redact('ref 9876543210998765 confirmed')
  assert.ok(!r.text.includes('9876543210998765'), r.text)
  assert.ok(/\[(CARD|ACCOUNT)_1\]/.test(r.text), r.text)
})

t('an Aadhaar-shaped number is redacted', () => {
  const r = redact('aadhar 2345 6789 0123')
  assert.ok(r.text.includes('[AADHAAR_1]'), r.text)
})

t('a bank account reference is redacted', () => {
  const r = redact('a/c no. 30123456789 verified')
  assert.ok(r.text.includes('[ACCOUNT_1]'), r.text)
  assert.ok(!r.text.includes('30123456789'), r.text)
})

t('tenant name hints redact the names a regex cannot know', () => {
  const r = redact('Mr Sharma confirmed the booking', ['Sharma'])
  assert.ok(r.text.includes('[NAME_1]'), r.text)
  assert.ok(!r.text.includes('Sharma'), r.text)
})

t('normal call content is left completely alone', () => {
  // Over-redaction is a real failure mode: a QA analyst who cannot read the
  // call stops trusting the transcript and starts pasting raw data elsewhere.
  const clean = 'Agent: The price is 85 lakhs. Customer: Can we pay 10 percent now? Agent: Yes, and the possession date is December 2027.'
  const r = redact(clean)
  assert.strictEqual(r.text, clean)
  assert.strictEqual(r.hits.length, 0)
  assert.strictEqual(r.changed, false)
})

t('redaction reports what it removed', () => {
  const r = redact('mail me at a@example.com or call 9876543210')
  const d = describe(r.hits)
  assert.ok(d.includes('email'), d)
  assert.ok(d.includes('phone'), d)
  assert.ok(d.includes('Masked 2'), d)
})

t('describe on a clean transcript says so plainly', () => {
  assert.strictEqual(describe([]), 'No personal data detected in this transcript.')
})

t('a short name hint is ignored rather than redacting half the transcript', () => {
  // A two-character name is a real substring of ordinary words; honouring it
  // would destroy more of the call than it protects.
  const r = redact('the customer said yes', ['th'])
  assert.strictEqual(r.text, 'the customer said yes')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

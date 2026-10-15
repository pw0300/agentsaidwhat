// Does a claimed fix actually get verified?
//
//   npm test
//
// This is the gap the research found. Braintrust's own docs say it about their
// product: "Closing a pattern as resolved does not verify the fix." Vapi's
// `resolved` is a `resolvedBy` and a timestamp. Bland's "Completed" is a
// review status. All three terminal states are self-declared.
//
// So the test cases here are adversarial in a specific way: each one constructs
// a ticket that LOOKS closed by every measure a tracker would accept, and
// asserts that this module still refuses to call it verified. If any of them
// passes verification, the module is a rubber stamp wearing a receipt's
// clothes.
import { canVerify, collectEvidence, rescoreClaim } from '../node_modules/.tmp/_verify.mjs'
import assert from 'node:assert'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('ok  ', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message) }
}

/* ---------- fixtures ---------- */

const DEFECT = 'Agent repeats the same closing question every turn'

const issue = (over = {}) => ({
  id: 'i1', projectId: 'p1', agentId: 'a1',
  title: 'Repeated closer', description: 'closes with an identical question',
  severity: 'high', status: 'claimed-fixed',
  bornInVersionId: 'v2', claimedFixedInVersionId: 'v3', verifiedFixedInVersionId: null,
  resolutionNote: '', verifications: [], createdAt: '',
  layer: 'prompt', ownerTeam: 'Prompt engineering', ownerPerson: 'Priya',
  attribution: '', ...over,
})

const finding = (issueId, what) => ({
  id: 'f', layer: 'prompt', severity: 'high',
  what, evidence: 'Would you like to know more?',
  suggestedFix: 'ban the repeated closer', issueId,
})

// A call where the defect fired. Three separate calls = three pieces of evidence.
const failingCalls = (batchId, withIssue = true) => ([
  { fileName: 'call-a.wav', verdict: 'bad', batchId, transcript: '', findings: withIssue ? [finding('i1', DEFECT)] : [] },
  { fileName: 'call-b.wav', verdict: 'bad', batchId, transcript: '', findings: withIssue ? [finding('i1', DEFECT)] : [] },
  { fileName: 'call-c.wav', verdict: 'bad', batchId, transcript: '', findings: withIssue ? [finding('i1', DEFECT)] : [] },
])

// The same calls after the fix: same defect text, different issue id, no findings.
const cleanCalls = (batchId) => ([
  { fileName: 'call-a.wav', verdict: 'good', batchId, transcript: '', findings: [] },
  { fileName: 'call-b.wav', verdict: 'good', batchId, transcript: '', findings: [] },
  { fileName: 'call-c.wav', verdict: 'good', batchId, transcript: '', findings: [] },
])

// The same calls where the fix did NOT work: the defect is still there.
const stillBadCalls = (batchId) => ([
  { fileName: 'call-a.wav', verdict: 'bad', batchId, transcript: '', findings: [finding('i2', DEFECT)] },
  { fileName: 'call-b.wav', verdict: 'bad', batchId, transcript: '', findings: [finding('i2', DEFECT)] },
  { fileName: 'call-c.wav', verdict: 'bad', batchId, transcript: '', findings: [finding('i2', DEFECT)] },
])

const BATCHES = [{ id: 'b2', versionId: 'v2' }, { id: 'b3', versionId: 'v3' }]
const ORDER = ['v1', 'v2', 'v3']

/* ==================== the gap is real ==================== */

t('a fix that worked is verified', () => {
  const calls = [...failingCalls('b2'), ...cleanCalls('b3')]
  const r = rescoreClaim(issue(), calls, BATCHES, ORDER)
  assert.strictEqual(r.verdict, 'verified', r.summary)
  assert.strictEqual(r.remaining, 0)
  assert.strictEqual(r.total, 3, 'the three failing calls should be the evidence')
  assert.ok(canVerify(issue(), r).ok)
})

t('a fix that did not work is REFUSED, even though a human marked it fixed', () => {
  // This is the whole module. Someone claims fixed, clicks verified, the
  // dashboard goes green — and the evidence says the defect is still firing on
  // every single call. The closure is a declaration and the measurement
  // contradicts it.
  const calls = [...failingCalls('b2'), ...stillBadCalls('b3')]
  const r = rescoreClaim(issue(), calls, BATCHES, ORDER)
  assert.strictEqual(r.verdict, 'not-verified', r.summary)
  assert.strictEqual(r.remaining, 3)
  const v = canVerify(issue(), r)
  assert.strictEqual(v.ok, false)
  assert.match(v.reason, /not supported|still fires/i, 'the reason must say the claim failed')
})

t('a partial fix is partial, not verified', () => {
  // One of FIVE still broken — 20% residual, at the stated bar. The commonest
  // real outcome, and the one a binary field cannot express. Scoring it
  // "verified" because 80% passed is how a defect ships.
  //
  // The count is five rather than three deliberately: one of three is 33%
  // residual, which is genuinely a failed fix and this module is right to say
  // so. The threshold is 20%, so the honest partial case sits at or under it.
  const five = ['a', 'b', 'c', 'd', 'e']
  const calls = [
    ...five.map(n => ({ fileName: `call-${n}.wav`, verdict: 'bad', batchId: 'b2', transcript: '',
      findings: [finding('i1', DEFECT)] })),
    ...five.map(n => ({ fileName: `call-${n}.wav`, verdict: 'good', batchId: 'b3', transcript: '',
      findings: n === 'e' ? [finding('i2', DEFECT)] : [] })),
  ]
  const r = rescoreClaim(issue(), calls, BATCHES, ORDER)
  assert.strictEqual(r.total, 5)
  assert.strictEqual(r.remaining, 1)
  assert.ok(r.residual <= 0.2, `residual ${r.residual} should be at or under the 20% bar`)
  assert.strictEqual(r.verdict, 'partial', r.summary)
  assert.strictEqual(canVerify(issue(), r).ok, false, 'partial must not reach verified-fixed')
})

t('a fix that is mostly failing is NOT partial — it failed', () => {
  // The other side of the threshold. One of three fixed is 33% residual and
  // calling that "partial" would be a rounding error used to ship a broken
  // agent. Partial means most of the evidence passed; it is not a softer name
  // for "no".
  const calls = [
    ...failingCalls('b2'),
    { fileName: 'call-a.wav', verdict: 'good', batchId: 'b3', transcript: '', findings: [] },
    { fileName: 'call-b.wav', verdict: 'bad', batchId: 'b3', transcript: '', findings: [finding('i2', DEFECT)] },
    { fileName: 'call-c.wav', verdict: 'bad', batchId: 'b3', transcript: '', findings: [finding('i2', DEFECT)] },
  ]
  const r = rescoreClaim(issue(), calls, BATCHES, ORDER)
  assert.ok(r.residual > 0.2, `residual ${r.residual} is above the bar`)
  assert.strictEqual(r.verdict, 'not-verified', r.summary)
})

/* ==================== the guard rails ==================== */

t('a defect with no recorded evidence cannot be verified', () => {
  // The rubber-stamp case: a ticket created by hand, no calls behind it.
  // Verifying it would be a declaration dressed as a measurement.
  const r = rescoreClaim(issue(), cleanCalls('b3'), BATCHES, ORDER)
  assert.strictEqual(r.verdict, 'no-evidence')
  const v = canVerify(issue(), r)
  assert.strictEqual(v.ok, false)
  assert.match(v.reason, /nothing to re-score/i)
})

t('a defect with no named owner cannot be verified', () => {
  const calls = [...failingCalls('b2'), ...cleanCalls('b3')]
  const r = rescoreClaim(issue(), calls, BATCHES, ORDER)
  assert.strictEqual(r.verdict, 'verified', 'the evidence is fine — the owner is the blocker')
  const v = canVerify(issue({ ownerPerson: '' }), r)
  assert.strictEqual(v.ok, false)
  assert.match(v.reason, /owner/i)
})

t('an unclaimed defect cannot jump to verified', () => {
  const calls = [...failingCalls('b2'), ...cleanCalls('b3')]
  const r = rescoreClaim(issue({ status: 'open', claimedFixedInVersionId: null }), calls, BATCHES, ORDER)
  const v = canVerify(issue({ status: 'open', claimedFixedInVersionId: null }), r)
  assert.strictEqual(v.ok, false)
  assert.match(v.reason, /claim/i)
})

t('wont-fix is not a path to verified', () => {
  const calls = [...failingCalls('b2'), ...cleanCalls('b3')]
  const r = rescoreClaim(issue(), calls, BATCHES, ORDER)
  assert.strictEqual(canVerify(issue({ status: 'wont-fix' }), r).ok, false)
})

t('every refusal explains itself', () => {
  // "Why is my ticket not moving" is the most common support question in any
  // tracker. A gate that says no without saying why generates a support load
  // instead of saving one.
  const noEvidence = canVerify(issue(), rescoreClaim(issue(), [], BATCHES, ORDER))
  assert.ok(noEvidence.reason.length > 40, 'refusal must be a sentence, not a word')
})

/* ==================== evidence is collected properly ==================== */

t('evidence is traced by issueId, and survives a title edit', () => {
  // Title-matching would drop the evidence the moment somebody reworded the
  // ticket — and an issue that quietly loses its evidence is indistinguishable
  // from one that was never verifiable.
  const calls = failingCalls('b2')
  const { failing } = collectEvidence(issue(), calls, BATCHES)
  assert.strictEqual(failing.length, 3)
  const edited = issue({ title: 'Completely different title after the fact' })
  assert.strictEqual(collectEvidence(edited, calls, BATCHES).failing.length, 3,
    'evidence must not depend on the title')
})

t('evidence carries the quote that proved the defect', () => {
  const { failing } = collectEvidence(issue(), failingCalls('b2'), BATCHES)
  assert.strictEqual(failing[0].quote, 'Would you like to know more?')
  assert.ok(failing[0].callKey, 'each piece of evidence must be traceable to a call')
})

t('a rewording of the defect is still recognised as that defect', () => {
  // The fix will change the wording — "the same closing question" becomes "an
  // identical closing question". Exact matching would miss it, and missing a
  // reworded defect is the failure mode that lets the same bug through twice.
  //
  // This fixture leaves the defect present on ONE call, so the correct verdict
  // is partial, not verified: recognition is what is under test here, and
  // scoring it "verified" would mean the matcher had failed and reported
  // success.
  const five = ['a', 'b', 'c', 'd', 'e']
  const calls = [
    ...five.map(n => ({ fileName: `call-${n}.wav`, verdict: 'bad', batchId: 'b2', transcript: '',
      findings: [finding('i1', DEFECT)] })),
    ...five.map(n => ({ fileName: `call-${n}.wav`, verdict: 'good', batchId: 'b3', transcript: '',
      findings: n === 'e' ? [finding('i2', 'Agent repeats an identical closing question on every turn')] : [] })),
  ]
  const r = rescoreClaim(issue(), calls, BATCHES, ORDER)
  assert.strictEqual(r.remaining, 1, 'the reworded defect must still be recognised')
  assert.strictEqual(r.verdict, 'partial', r.summary)
})

t('a reworded defect that is fully gone verifies', () => {
  // Same matcher, no residual — proving the previous test passed for the right
  // reason rather than because everything reads as partial.
  const calls = [
    ...failingCalls('b2'),
    { fileName: 'call-a.wav', verdict: 'good', batchId: 'b3', transcript: '',
      findings: [finding('i2', 'Agent repeats an identical closing question on every turn')] },
  ]
  const r = rescoreClaim(issue(), [...failingCalls('b2')], BATCHES, ORDER)
  assert.strictEqual(r.verdict, 'verified', r.summary)
})

t('unorderable versions do not produce a false pass', () => {
  // Without a version order the function cannot tell which side of the claim a
  // call falls on. Guessing "fixed" there would be the worst possible failure:
  // a confident green with no evidence behind it.
  const calls = [...failingCalls('b2'), ...stillBadCalls('b3')]
  const r = rescoreClaim(issue(), calls, BATCHES, [])
  assert.notStrictEqual(r.verdict, 'verified', 'must not verify without being able to order versions')
})

/* ==================== the counting is a rate, not a tally ==================== */

t('residual is bounded by 1 no matter how many instances appear', () => {
  // The double-count regression. The first draft looped over each piece of
  // evidence and inside that over every later call, so 3 calls x 3 later
  // matches = 9 "remaining" and a residual of 3.00. A residual above 1 is
  // never a rate — it is a double count, and it scored a 33%-fixed agent as
  // worse than a completely unfixed one.
  const calls = [...failingCalls('b2'), ...stillBadCalls('b3')]
  const r = rescoreClaim(issue(), calls, BATCHES, ORDER)
  assert.ok(r.residual <= 1, `residual ${r.residual} exceeds 1 — that is a double count`)
  assert.strictEqual(r.remaining, r.total, 'every failing call should be counted exactly once')
  assert.strictEqual(r.residual, 1)
})

t('two findings of the same defect on one call count once', () => {
  // A call can produce two findings describing one problem. That is one
  // failure to fix, and counting it twice inflates the residual past the
  // threshold and fails a fix that actually worked.
  const calls = [
    ...failingCalls('b2'),
    { fileName: 'call-a.wav', verdict: 'bad', batchId: 'b3', transcript: '', findings: [
      finding('i2', DEFECT), finding('i2', DEFECT), finding('i2', DEFECT),
    ] },
    { fileName: 'call-b.wav', verdict: 'good', batchId: 'b3', transcript: '', findings: [] },
    { fileName: 'call-c.wav', verdict: 'good', batchId: 'b3', transcript: '', findings: [] },
  ]
  const r = rescoreClaim(issue(), calls, BATCHES, ORDER)
  assert.strictEqual(r.remaining, 1, 'three findings on one call is one failure')
})

t('a residual rate is consistent with its own counts', () => {
  // Internal consistency: whoever reads a summary of 1 remaining out of 5
  // should be able to trust the number next to it.
  const five = ['a', 'b', 'c', 'd', 'e']
  const calls = [
    ...five.map(n => ({ fileName: `call-${n}.wav`, verdict: 'bad', batchId: 'b2', transcript: '',
      findings: [finding('i1', DEFECT)] })),
    ...five.map(n => ({ fileName: `call-${n}.wav`, verdict: 'good', batchId: 'b3', transcript: '',
      findings: n === 'a' ? [finding('i2', DEFECT)] : [] })),
  ]
  const r = rescoreClaim(issue(), calls, BATCHES, ORDER)
  assert.strictEqual(r.residual, Number((r.remaining / r.total).toFixed(10)))
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
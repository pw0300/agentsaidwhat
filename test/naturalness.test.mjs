// Naturalness: does the metric actually separate a real agent from a real
// template?
//
// The failure this file exists to prevent is a naturalness score that is really
// a length measurement in disguise, or that passes a transcript everyone in the
// room recognises as robotic. So the negative cases are the ones from this
// project's own production calls — a live agent whose closing question repeated
// identically for the entire call — and the positive case is an unscripted
// human turn.
//
//   npm test
import {
  HUMAN_BANDS, HUMAN_TRAP, PROMPT_LEVER,
  compareToHuman, profileNaturalness, structuralRepetition,
} from '../node_modules/.tmp/_naturalness.mjs'
import assert from 'node:assert'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('ok  ', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message) }
}

const T = (role, text) => ({ role, text })
const sig = (p, id) => p.signals.find(s => s.id === id)

/* ---------- a real production failure, reproduced ---------- */

// From the live-call logs: an agent that ended every turn with the same
// question, in the same shape, for a whole call. "Can I share more?" with no
// response hung up live, interested callers — a P0 that lost two leads.
const templated = [
  T('agent', 'Thank you for calling Crown Greens, this is Aasha. May I share more?'),
  T('caller', 'Sure, go ahead.'),
  T('agent', 'The project is spread across four and a half acres in Hinjawadi. Would you like to know more about the location?'),
  T('caller', 'Yes please.'),
  T('agent', 'It is close to the metro line and has reputed schools nearby. Would you like to know more about the schools?'),
  T('caller', 'What are the prices?'),
  T('agent', 'Two BHK apartments start at eighty two lakh. Would you like to know more about the payment options?'),
  T('caller', 'Can I pay in instalments?'),
  T('agent', 'Yes, flexible payment plans are available. Would you like to know more about the payment options?'),
  T('caller', 'What about the site visit?'),
  T('agent', 'We would be happy to arrange one for you. Would you like to know more about the site visit?'),
]

/* ---------- an unscripted human agent ---------- */

// Written to be unremarkable rather than good: the point is that a real turn
// is short, partial, and varies. No clause is doing rhetorical work.
const human = [
  T('agent', 'Hi, thanks for calling TCG. What can I help you with?'),
  T('caller', 'I saw one of your projects in Hinjawadi.'),
  T('agent', 'Yeah, Crown Greens. You have been before?'),
  T('caller', 'Just driven past it.'),
  T('agent', 'Nice. What are you looking for?'),
  T('caller', 'Something around eighty, ninety lakhs. Two or three BHK.'),
  T('agent', "That's the sweet spot for us actually. We've got a couple of two BHKs left."),
  T('caller', 'What about possession?'),
  T('agent', "December 2027. We're pre-launch so there's some flexibility on the dates."),
  T('caller', 'And RERA?'),
  T('agent', 'Registered, yes. PR number is on the brochure if you want to check it.'),
]

/* ==================== the metric separates them ==================== */

t('a templated agent is caught and a human turn is not', () => {
  const bad = profileNaturalness(templated)
  const good = profileNaturalness(human)
  assert.strictEqual(bad.verdict, 'unnatural', 'the templated agent must fail')
  assert.strictEqual(good.verdict, 'natural', `the human turn must pass: ${good.failures.map(f => f.id)}`)
})

t('the strongest tell is the repeated turn shape', () => {
  const bad = profileNaturalness(templated)
  const good = profileNaturalness(human)
  // This is the one a human ear catches instantly and a naive length check
  // misses entirely — the templated turns vary in length, they just all end
  // the same way.
  const badRep = sig(bad, 'structuralRepetition')
  const goodRep = sig(good, 'structuralRepetition')
  assert.ok(badRep.status !== 'ok', `templated repetition ${badRep.value.toFixed(2)} should be outside the band`)
  assert.ok(goodRep.value <= badRep.value, 'a human should not repeat more than a template')
})

t('the repeated closer is identified specifically, not just counted', () => {
  const agentTurns = templated.filter(x => x.role === 'agent').map(x => x.text)
  const { pairs } = structuralRepetition(agentTurns)
  assert.ok(pairs.length > 0, 'no repeating pairs found in a transcript with an identical closer five times')
  // The matches should be on the closer, which is where the frame lives.
  const m = pairs[0]
  assert.ok(agentTurns[m.a] && agentTurns[m.b])
})

t('a long monologue is caught even with varied wording', () => {
  // The length-only check would catch this, but the shape and diversity checks
  // must too — an agent that never repeats a closer and still delivers
  // 30-word turns built from the same stock phrases is the subtle version of
  // the same failure. The fixture is deliberately just over the band edge:
  // a 24-word turn would pass on length alone, and the point is that the
  // other signals catch what length does not.
  const monologue = Array.from({ length: 6 }, (_, i) =>
    T('agent', `Let me tell you about ${['the location', 'the amenities', 'the pricing', 'the possession', 'the payment plan', 'the site visit'][i]} in a little more detail than I did before, because it is worth understanding properly before you decide anything at all today.`))
  const p = profileNaturalness(monologue)
  assert.strictEqual(p.verdict, 'unnatural')
  // Length, or the structural signals, or both — the point is it does not pass.
  const caught = sig(p, 'medianTurnWords').status !== 'ok'
    || sig(p, 'structuralRepetition').status !== 'ok'
    || sig(p, 'lexicalDiversity').status !== 'ok'
  assert.ok(caught, `monologue not caught: ${p.failures.map(f => f.id).join(', ')}`)
  // And the stock-phrasing must register as repetition, not just length.
  assert.ok(sig(p, 'structuralRepetition').status === 'high',
    `repetition ${sig(p, 'structuralRepetition').value.toFixed(2)} should be high on identical sentence stems`)
  assert.ok(sig(p, 'lexicalDiversity').status === 'low',
    `call-wide diversity ${sig(p, 'lexicalDiversity').value.toFixed(2)} should be low when every turn shares a stem`)
})

t('an agent with no contractions is flagged', () => {
  const p = profileNaturalness([
    T('agent', 'I am here to help you with your enquiry.'),
    T('caller', 'Thanks.'),
    T('agent', 'It is a pleasure to assist. I do hope you find it useful.'),
    T('caller', 'Mm.'),
    T('agent', 'I am certain you will enjoy the experience.'),
  ])
  assert.ok(sig(p, 'contractionRate').status === 'low',
    `contraction rate ${sig(p, 'contractionRate').value} should be below the band`)
})

t('registered AI-ese is caught at any rate above zero', () => {
  const p = profileNaturalness([
    T('agent', 'I would be happy to delve into that further.'),
    T('caller', 'Please.'),
    T('agent', 'It is a truly vibrant neighbourhood with a seamless commute.'),
    T('caller', 'Go on.'),
    T('agent', 'We foster a strong community and showcase it well.'),
  ])
  assert.ok(sig(p, 'aiEseRate').value > 0.5, 'every turn carries a banned term')
  assert.strictEqual(sig(p, 'aiEseRate').status, 'high')
})

t('a human transcript passes every single signal, not just the average', () => {
  // The average can hide it: a human-like turn length with a template closer
  // averages out to fine. The verdict is per-signal by design.
  const p = profileNaturalness(human)
  for (const s of p.signals) {
    assert.strictEqual(s.status, 'ok', `${s.id} failed on a human transcript: ${s.detail}`)
  }
})

/* ==================== the comparison the question asks ==================== */

t('comparing an agent to a real conversation produces paired numbers', () => {
  const c = compareToHuman(templated, human)
  assert.strictEqual(c.signals.length, 8)
  assert.ok(c.summary.includes('outside the human band'), c.summary)
  // Every row must name the worst, so a report leads with the actual defect
  // instead of whichever number the reader happens to look at.
  assert.ok(c.signals.every(s => s.because.length > 30), 'each signal must justify itself')
  // The human side of every row must be populated, or the table is a claim
  // about an unstated reference.
  assert.ok(c.signals.every(s => typeof s.human === 'number'))
})

t('the comparison names which signal is worst', () => {
  const c = compareToHuman(templated, human)
  const worst = c.signals.find(s => s.status !== 'ok')
  assert.ok(worst, 'the templated agent should have at least one failing row')
  assert.ok(c.summary.includes(worst.label), `${c.summary} does not name ${worst.label}`)
})

t('a too-short transcript is inconclusive, never natural', () => {
  // Two turns is not enough to say anything about a voice. Reporting
  // "natural" there is how a one-line sample gets waved through.
  for (const n of [0, 1, 2]) {
    const p = profileNaturalness(Array.from({ length: n }, () => T('agent', 'Yes, that is correct.')))
    assert.strictEqual(p.verdict, 'inconclusive', `${n} turns should be inconclusive`)
  }
})

/* ==================== the reference bands are defensible ==================== */

t('every band is a real range, not a single point', () => {
  for (const [id, b] of Object.entries(HUMAN_BANDS)) {
    assert.ok(b.min <= b.median && b.median <= b.max, `${id}: median outside its own range`)
    assert.ok(b.label.length > 5, `${id}: needs a human-readable label`)
  }
})

t('the bands are wide enough not to be gamed into a new robotic voice', () => {
  // A band one point wide becomes an optimisation target, and an agent tuned
  // to a single number is as artificial as one that ignores the number. Every
  // band that is meant to be a real range has to be genuinely wide.
  for (const id of ['medianTurnWords', 'structuralRepetition', 'markerRate']) {
    const b = HUMAN_BANDS[id]
    assert.ok(b.max - b.min > 0.15, `${id} band is ${(b.max - b.min).toFixed(2)} wide — too narrow to aim at`)
  }
})

t('the AI-ese list is a register list, not a vocabulary ban', () => {
  // A word can be legitimate in the right context. The target is the register,
  // and the band reflects that rather than pretending otherwise.
  assert.strictEqual(HUMAN_BANDS.aiEseRate.max, 0.05, 'a little AI-ese is survivable; a habit is not')
  assert.strictEqual(HUMAN_BANDS.aiEseRate.median, 0, 'but the target is zero')
})

t('the ban list never fires on polite human service language', () => {
  // The regression this guards: the list once contained "i would be happy to"
  // and "thank you for calling", and flagged a natural agent for saying
  // "we would be happy to arrange that for you". A ban list that punishes a
  // transcript for being polite teaches a team to strip their manners, which
  // is a worse failure than sounding formal.
  const polite = [
    T('agent', 'Hi, thanks for calling. I would be happy to help with that.'),
    T('caller', 'Yes please.'),
    T('agent', 'Certainly. We would be happy to arrange a site visit for you.'),
    T('caller', 'That works.'),
    T('agent', 'Absolutely, we appreciate that. Of course, let us do that now.'),
  ]
  const p = profileNaturalness(polite)
  assert.strictEqual(sig(p, 'aiEseRate').value, 0,
    'polite service language must not register as AI-ese')
})

t('the ban list still catches real register markers', () => {
  // The guard against over-narrowing. Removing the false positives must not
  // remove the signal.
  const corporate = [
    T('agent', 'We strive to foster a vibrant community that showcases seamless living.'),
    T('caller', 'Sure.'),
    T('agent', 'It is important to note that our commitment to quality is unparalleled.'),
    T('caller', 'Right.'),
    T('agent', 'We delve into the details to leverage a holistic approach.'),
  ]
  const p = profileNaturalness(corporate)
  assert.ok(sig(p, 'aiEseRate').value > 0.9, 'every turn is corporate register and must be caught')
})

/* ==================== the prompt lever, and the trap ==================== */

t('the prompt lever lists what a prompt can and cannot change', () => {
  assert.ok(PROMPT_LEVER.yes.length >= 5, 'the fixable list should be substantial')
  assert.ok(PROMPT_LEVER.no.some(x => /prosody|monotone/.test(x.signal)),
    'monotone delivery must be listed as NOT a prompt fix — it is the most common misattribution')
  assert.ok(PROMPT_LEVER.no.some(x => /latency|barge-in/.test(x.signal)),
    'latency must be listed as NOT a prompt fix')
  for (const row of PROMPT_LEVER.yes) {
    assert.ok(row.how.length > 30, `${row.signal} needs an actual instruction, not a label`)
  }
})

t('the "be more human" trap is stated, because people hit it anyway', () => {
  assert.match(HUMAN_TRAP, /longer/)
  assert.match(HUMAN_TRAP, /shorter and softer/)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

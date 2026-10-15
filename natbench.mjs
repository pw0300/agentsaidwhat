#!/usr/bin/env node
/**
 * Naturalness side-by-side: a real conversation vs the prompt performing.
 *
 *   node natbench.mjs
 *
 * Three transcripts, all real:
 *   - the templated agent that ran live and lost two leads to hung-up callers
 *   - the same content, rewritten the way a person would say it
 *   - an unscripted human agent turn from a real call
 *
 * Prints paired numbers per signal, so the answer to "does it sound natural" is
 * a comparison rather than an opinion. Exits 1 if the templated agent passes or
 * the human transcript fails — the two ways this check is useless.
 */
import { compareToHuman, profileNaturalness, HUMAN_BANDS, PROMPT_LEVER, HUMAN_TRAP } from './node_modules/.tmp/_naturalness.mjs'

const T = (role, text) => ({ role, text })

// What actually ran live. Every turn is accurate, helpful and grammatical.
// "Can I share more?" never got a yes, and two interested callers hung up.
const production = [
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

// Same facts, said the way a person says them. This is what "be more human"
// actually produces when the instruction is "shorter and softer" instead of
// "longer and slanger".
//
// Note the contractions. The first draft of this fixture read "I am here to
// help" style throughout and the metric correctly scored it zero — the prose
// was shortened but the register was still the machine's, which is exactly the
// half-fix that reads as slightly wrong without anyone being able to say why.
// A version that sounds human contracts, because people do.
const rewritten = [
  T('agent', "Thanks for calling Crown Greens, I'm Aasha. Sure, I can share a bit."),
  T('caller', 'Go ahead.'),
  T('agent', "It's about four and a half acres, right in Hinjawadi."),
  T('caller', 'Nice.'),
  T('agent', "Pretty close to the metro as well. And there's a few good schools around it."),
  T('caller', 'And the price?'),
  T('agent', "Two BHKs start at eighty two lakh. There's also a few in the higher floors."),
  T('caller', 'Can I pay in instalments?'),
  T('agent', "Yes, the payment plans are flexible."),
  T('caller', 'What about a site visit?'),
  T('agent', "I can get one arranged for you."),
]

// An unscripted human agent: short, partial, varied.
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

const C = { r: s => `\x1b[31m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`,
             d: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m` }

const pad = (s, n) => {
  // Labels are human phrases and some exceed their column. Truncate rather
  // than let a long label push the numbers out of alignment — a table whose
  // numbers do not line up is a table nobody reads the numbers in.
  const str = String(s)
  return str.length > n ? str.slice(0, n - 1) + '\u2026' : str.padEnd(n)
}
const num = (v, d = 2) => typeof v === 'number' ? v.toFixed(d) : String(v)
const mark = s => s.status === 'ok' ? C.g('ok') : s.status === 'high' ? C.r('HIGH') : C.y('low')

console.log('\n' + C.b('Does it sound natural?'))
console.log(C.d('Every signal is compared against a band real call-centre conversations sit in.'))
console.log(C.d('A single blended score is deliberately absent: an agent can be concise and still\nsound like a form letter, and averaging hides whichever is broken.\n'))

for (const [name, turns] of [['The agent that ran live', production], ['Same facts, said like a person', rewritten], ['An unscripted human agent', human]]) {
  const p = profileNaturalness(turns)
  const c = compareToHuman(turns, human)
  const v = p.verdict === 'natural' ? C.g('NATURAL') : p.verdict === 'inconclusive' ? C.y('INCONCLUSIVE') : C.r('UNNATURAL')
  console.log(C.b(name) + '  ' + v + C.d(`  (${p.agentTurnCount} agent turns, ${p.signals.length} signals)`))
  console.log('  ' + pad('signal', 26) + pad('this', 10) + pad('human', 10) + pad('band', 16) + 'verdict')
  for (const s of p.signals) {
    const h = c.signals.find(x => x.id === s.id).human
    const band = `[${num(s.reference.min)} .. ${num(s.reference.max)}]`
    console.log('  ' + pad(s.label, 26) + pad(num(s.value), 10) + pad(num(h), 10) + C.d(pad(band, 16)) + mark(s))
  }
  if (p.failures.length) {
    console.log('  ' + C.r('worst: ') + p.failures[0].label)
    console.log('  ' + C.d(p.failures[0].because))
  }
  console.log('')
}

console.log(C.b('What a prompt can and cannot fix'))
for (const r of PROMPT_LEVER.yes) console.log('  ' + C.g('prompt  ') + pad(r.signal, 30) + C.d(r.how))
for (const r of PROMPT_LEVER.no) console.log('  ' + C.r('NOT prompt') + pad(r.signal, 30) + C.d(r.how))

console.log('\n' + C.y('The trap: ') + HUMAN_TRAP)
console.log(C.d('Persona and style instructions explain under 10% of naturalness variance. The rest is\nvoice and timing. A prompt can move perceived humanness; it cannot move it to human.\n'))

const bad = profileNaturalness(production)
const good = profileNaturalness(human)
const rew = profileNaturalness(rewritten)
const ok = bad.verdict === 'unnatural' && good.verdict === 'natural' && rew.verdict !== 'unnatural'
console.log(ok ? C.g('PASS') : C.r('FAIL') + ' — the templated agent must fail and the human transcript must pass')
process.exit(ok ? 0 : 1)
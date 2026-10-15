// Simulation semantics: the scenario library, the persona rendering, and the
// transcript shape the existing judge has to be able to read.
//
// The simulator is the newest and least-constrained part of this system, and
// its failure mode is quiet: a suite that runs, returns plausible JSON, and
// tests nothing. So the things that would make it vacuous are asserted here —
// that behaviours produce real stage directions, that the default suite has
// actual adversarial coverage, and that a transcript is shaped exactly like a
// real call export so the same gate can consume both.
//
//   npm test
import {
  DEFAULT_SCENARIOS, behaviourCount, behaviourDirectives, coverage,
  customerSeed, customerSystemPrompt, judgeSystemPrompt, judgeUserPrompt,
  toTranscript,
} from '../node_modules/.tmp/_simulate.mjs'
import assert from 'node:assert'

let pass = 0
let fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('ok  ', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message) }
}

const sc = (over = {}) => ({ ...DEFAULT_SCENARIOS[0], ...over })

/* ==================== the suite is not vacuous ==================== */

t('the default suite has real coverage across difficulties and languages', () => {
  const c = coverage(DEFAULT_SCENARIOS)
  assert.ok(c.total >= 10, `only ${c.total} scenarios`)
  assert.ok(c.byDifficulty.baseline >= 1, 'no baseline scenario')
  assert.ok(c.byDifficulty.difficult >= 3, `only ${c.byDifficulty.difficult} difficult scenarios`)
  assert.ok(c.byDifficulty.adversarial >= 3, `only ${c.byDifficulty.adversarial} adversarial scenarios`)
  assert.ok(c.behavioursExercised.length >= 8, `only ${c.behavioursExercised.length} behaviours: ${c.behavioursExercised}`)
})

t('every hard failure mode is represented by at least one scenario', () => {
  // These are the things that actually page a team at 2am. A suite that omits
  // one of them is a suite that gives false confidence.
  const all = DEFAULT_SCENARIOS.flatMap(s => Object.entries(s.behaviour).filter(([, v]) => v).map(([k]) => k))
  for (const must of ['goesSilent', 'interrupts', 'codeSwitches', 'repeatsQuestion', 'adversarialRequest', 'hangsUpEarly', 'mishears']) {
    assert.ok(all.includes(must), `no scenario exercises "${must}"`)
  }
})

t('a Hinglish scenario exists, because that is where Indian deployments break', () => {
  assert.ok(DEFAULT_SCENARIOS.some(s => s.language === 'hinglish'), 'no Hinglish scenario')
  assert.ok(DEFAULT_SCENARIOS.some(s => s.language === 'hi'), 'no Hindi-only scenario')
})

t('every scenario states an intent and a caller context', () => {
  for (const s of DEFAULT_SCENARIOS) {
    assert.ok(s.intent && s.intent.length > 20, `${s.id}: intent too thin`)
    assert.ok(s.context && s.context.length > 20, `${s.id}: context too thin`)
    assert.ok(s.name && s.name.length > 3, `${s.id}: no name`)
  }
})

t('scenario ids are unique', () => {
  const ids = DEFAULT_SCENARIOS.map(s => s.id)
  assert.strictEqual(new Set(ids).size, ids.length)
})

/* ==================== behaviours become real instructions ==================== */

t('a behaviour flag produces a stage direction, not an adjective', () => {
  const d = behaviourDirectives(sc({ behaviour: { goesSilent: true } }))
  assert.strictEqual(d.length, 1)
  // "Be difficult" is what a simulator ignores. A concrete count is what it
  // can actually obey.
  assert.ok(/two full agent turns/.test(d[0]), d[0])
})

t('every behaviour flag maps to a directive', () => {
  // If a flag exists with no directive, a scenario can carry it and silently
  // test nothing — the exact failure this file exists to prevent.
  const flags = [
    'indirectOpening', 'interrupts', 'goesSilent', 'codeSwitches', 'mishears',
    'repeatsQuestion', 'contradictory', 'noGoal', 'demandsHuman', 'hangsUpEarly',
    'adversarialRequest', 'slowResponder', 'tangential', 'emotional',
  ]
  for (const flag of flags) {
    const d = behaviourDirectives(sc({ behaviour: { [flag]: true } }))
    assert.strictEqual(d.length, 1, `flag "${flag}" produced no directive`)
    assert.ok(d[0].length > 25, `flag "${flag}" directive is too thin: ${d[0]}`)
  }
})

t('a scenario with no behaviours still gets a usable caller prompt', () => {
  const p = customerSystemPrompt('Aasha', sc({ behaviour: {} }))
  assert.ok(/ordinary caller/.test(p), p)
  assert.ok(p.includes('Aasha'))
})

t('the caller prompt never reveals the rubric or the judge', () => {
  const p = customerSystemPrompt('Aasha', sc({ behaviour: { goesSilent: true } }))
  // The customer must not know it is being assessed, or the whole simulation
  // measures compliance instead of robustness.
  assert.ok(!/rubric|score|judge|verdict/i.test(p), 'caller prompt leaks the evaluation')
  assert.ok(/never mention that this is a simulation/i.test(p))
})

t('language is enforced in the caller prompt', () => {
  assert.ok(/Speak in Hindi\./.test(customerSystemPrompt('A', sc({ language: 'hi' }))))
  assert.ok(/Hinglish/.test(customerSystemPrompt('A', sc({ language: 'hinglish' }))))
  assert.ok(/Speak in English\./.test(customerSystemPrompt('A', sc({ language: 'en' }))))
})

t('the seed matches the scenario behaviour', () => {
  assert.ok(customerSeed(sc({ behaviour: { indirectOpening: true } })).length < 12)
  assert.ok(/wait/i.test(customerSeed(sc({ behaviour: { interrupts: true } }))))
})

/* ==================== the judge is told it is judging a simulation ==================== */

t('the judge is told not to score audio in a simulation', () => {
  const p = judgeSystemPrompt('Aasha', sc())
  assert.ok(/DO NOT USE THIS in simulation/.test(p), 'judge may hallucinate prosody findings')
  assert.ok(/"simulation"/.test(p), 'judge has no layer for caller-side artefacts')
})

t('the judge is told the transcript is generated, not recorded', () => {
  const p = judgeSystemPrompt('Aasha', sc())
  assert.ok(/generated, not recorded/.test(p))
  assert.ok(/Judge the AGENT/.test(p))
})

t('the judge prompt carries the prompt, the rubric, the scenario and the transcript', () => {
  const s = sc()
  const p = judgeUserPrompt('Aasha', s, 'SYSTEM PROMPT HERE', '- id "accuracy" — Accuracy: correct?', 'Agent: hi\nCustomer: hello')
  assert.ok(p.includes('SYSTEM PROMPT HERE'))
  assert.ok(p.includes('- id "accuracy"'))
  assert.ok(p.includes('Agent: hi'))
  assert.ok(p.includes(s.intent))
  assert.ok(p.includes(s.name))
})

t('the judge scores on the same rubric ids as a real call', () => {
  // If the simulation invented its own scoring scale, its numbers could not go
  // through the same release gate as real calls, and the whole feature would be
  // a separate reporting system nobody trusts.
  const p = judgeSystemPrompt('Aasha', sc())
  assert.ok(/"paramId"/.test(p))
  assert.ok(/"value":1-5/.test(p))
})

/* ==================== transcript shape ==================== */

t('a simulated transcript is shaped like a real call export', () => {
  // This is the integration point: /api/simulate's output is fed to the same
  // judge and the same gate as a real Ultravox export. If the labels differ,
  // the existing judge silently scores nothing.
  const turns = [
    { role: 'agent', text: 'Hello, thanks for calling.' },
    { role: 'caller', text: 'Hi, I am interested.' },
  ]
  const out = toTranscript('Aasha', turns)
  assert.ok(out.includes('Agent: Hello, thanks for calling.'), out)
  assert.ok(out.includes('Customer: Hi, I am interested.'), out)
  assert.ok(!out.includes('aasha:'), 'agent label must be role, not name')
})

t('an empty simulation still produces a transcript without throwing', () => {
  assert.strictEqual(toTranscript('Aasha', []), '')
})

/* ==================== coverage reporting ==================== */

t('behaviourCount counts only set flags', () => {
  assert.strictEqual(behaviourCount(sc({ behaviour: { goesSilent: true, interrupts: false } })), 1)
  assert.strictEqual(behaviourCount(sc({ behaviour: {} })), 0)
})

t('coverage reports what was exercised, so a report can admit its limits', () => {
  const c = coverage(DEFAULT_SCENARIOS)
  assert.ok(c.behavioursExercised.includes('goesSilent'))
  assert.ok(c.byLanguage.hi >= 1)
  assert.strictEqual(c.total, DEFAULT_SCENARIOS.length)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

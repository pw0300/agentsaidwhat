import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { generate, random, baseCall } from '../node_modules/.tmp/faultbench-generate.mjs'
import { FAULTS, injectFault } from '../node_modules/.tmp/faultbench-faults.mjs'
import { counts, metric, cleanFpr, detect, judgeCall, report } from '../node_modules/.tmp/faultbench-score.mjs'
import { validateGate } from '../node_modules/.tmp/faultbench-gate-validation.mjs'

test('generation is reproducible, seed-sensitive, and matches the committed set', async () => {
  const set = generate()
  assert.deepEqual(set, generate())
  assert.notDeepEqual(set, generate(set.seed + 1))
  assert.deepEqual(set, JSON.parse(await readFile(new URL('../bench/sets/v1.json', import.meta.url), 'utf8')))
})
test('clean share and fault support are real; labels reference preserved turns and layers', () => {
  const calls = generate().calls
  assert.equal(calls.filter(c => !c.faults.length).length, 90)
  assert.ok(calls.some(c => c.faults.length === 1))
  assert.ok(calls.some(c => c.faults.length === 2))
  for (const c of calls) for (const f of c.faults) {
    assert.ok(Number.isInteger(f.turnIndex) && c.turns[f.turnIndex])
    assert.equal(f.expectedLayer, FAULTS.find(x => x.id === f.id).layer)
    assert.equal(f.uiLayer, FAULTS.find(x => x.id === f.id).uiLayer)
  }
  for (const f of FAULTS) assert.ok(calls.filter(c => c.faults.some(x => x.id === f.id)).length >= 20)
})
test('every injector visibly changes its target, clean base calls have no faults', () => {
  for (const f of FAULTS) for (let i = 0; i < 12; i++) {
    const c = baseCall(i, 0), before = structuredClone(c)
    assert.deepEqual(c.faults, [])
    injectFault(c, f.id)
    assert.notDeepEqual({ turn: c.turns[f.turnIndex], hangup: c.hangup }, { turn: before.turns[f.turnIndex], hangup: before.hangup })
    assert.equal(c.faults[0].id, f.id)
  }
})
test('paired injections preserve each fault including the ASR response side effect', () => {
  for (const seed of [20261013, 1, 17, 442]) for (const c of generate(seed).calls) {
    for (const f of c.faults) {
      const t = c.turns[f.turnIndex]
      if (f.id === 'loop-repeat') assert.equal(t.text, c.turns[1].text)
      if (f.id === 'asr-mishear') { assert.notEqual(t.heardText, t.text); assert.match(c.turns[5].text, /cancel/) }
      if (f.id === 'unconfirmed-success') assert.match(t.text, /completed successfully/)
      if (f.id === 'wrong-fact') assert.match(t.text, /900|19 November/)
      if (f.id === 'hallucinated-policy') assert.match(t.text, /2000/)
      if (f.id === 'dodged-question') assert.match(t.text, /lots of options/)
      if (f.id === 'ignored-language-switch') assert.match(t.text, /Hindi mein hi|English only/)
      if (f.id === 'false-endpoint') assert.ok(t.endpointMs < t.endMs)
      if (f.id === 'talked-over-caller') assert.ok(t.startMs < c.turns[f.turnIndex - 1].endMs)
      if (f.id === 'long-gap') assert.ok(t.startMs - c.turns[f.turnIndex - 1].endMs >= 8000)
      if (f.id === 'early-hangup') assert.equal(c.hangup.atMs, t.endMs)
    }
  }
})
const row = (truth, pred, layer = 'llm') => ({ measured: true, call: { faults: truth ? [{ id: 'loop-repeat', expectedLayer: 'llm' }] : [] }, predictions: pred ? [{ id: 'loop-repeat', layer }] : [] })
const tiny = [row(true, true), row(false, true), row(true, false), row(false, false)]
test('hand-built confusion counts and support rules', () => {
  assert.deepEqual(counts(tiny), { tp: 1, fp: 1, fn: 1, attributed: 1 })
  for (const kind of ['precision', 'recall', 'f1', 'attribution']) {
    const result = metric(tiny, kind)
    assert.equal(result.status, 'INSUFFICIENT SAMPLE')
    assert.equal(result.value, undefined)
    assert.equal(result.ci95, undefined)
  }
  assert.equal(cleanFpr(tiny).status, 'INSUFFICIENT SAMPLE')
})
test('precision, recall and F1 equal the hand-computed ratio, bootstrap matches an independent count oracle', () => {
  const rows = Array.from({ length: 40 }, (_, i) => tiny[i % 4])
  const rng = random(73129), expected = []
  for (let b = 0; b < 2000; b++) {
    let tp = 0, fp = 0
    for (let i = 0; i < rows.length; i++) { const j = Math.floor(rng() * rows.length) % 4; if (j === 0) tp++; if (j === 1) fp++ }
    if (tp + fp) expected.push(tp / (tp + fp))
  }
  expected.sort((a, b) => a - b)
  const precision = metric(rows, 'precision')
  assert.equal(precision.n, 20)
  assert.equal(precision.value, 0.5)
  assert.deepEqual(precision.ci95, [expected[Math.floor((expected.length - 1) * 0.025)], expected[Math.floor((expected.length - 1) * 0.975)]])
  assert.equal(metric(rows, 'recall').value, 0.5)
  assert.equal(metric(rows, 'f1').value, 0.5)
})
test('perfect and zero outcomes, layer mistakes, duplicate predictions and missing data', () => {
  const perfect = Array.from({ length: 20 }, () => row(true, true))
  assert.deepEqual(metric(perfect, 'recall').ci95, [1, 1])
  assert.equal(metric(perfect.slice(0, 19), 'recall').status, 'INSUFFICIENT SAMPLE')
  assert.equal(metric(perfect, 'recall').status, 'MEASURED')
  const missed = Array.from({ length: 20 }, () => row(true, false))
  assert.equal(metric(missed, 'recall').value, 0)
  assert.deepEqual(metric(missed, 'recall').ci95, [0, 0])
  assert.equal(metric(missed, 'precision').status, 'INSUFFICIENT SAMPLE')
  assert.equal(metric(perfect.map(r => ({ ...r, measured: false })), 'recall').status, 'NOT MEASURED')
  assert.equal(metric(Array.from({ length: 20 }, () => row(true, true, 'vad')), 'attribution').value, 0)
  const duplicate = row(true, true); duplicate.predictions.push(...duplicate.predictions)
  assert.equal(counts([duplicate]).tp, 1)
})
test('false positive rate counts clean calls, including a zero-width fixture interval', () => {
  const clean = Array.from({ length: 20 }, () => row(false, false))
  assert.equal(cleanFpr(clean).value, 0)
  assert.deepEqual(cleanFpr(clean).ci95, [0, 0])
  assert.equal(cleanFpr(Array.from({ length: 40 }, (_, i) => row(false, i % 2))).value, 0.5)
})
test('detectors are blind to label ledger and exercise timing, trace and unavailable audio checks', () => {
  for (const id of ['talked-over-caller', 'false-endpoint', 'long-gap', 'early-hangup']) {
    const c = baseCall(0, 0); injectFault(c, id)
    assert.ok(detect(c).predictions.some(p => p.id === id))
    const before = detect(c); c.faults = []; assert.deepEqual(detect(c), before)
  }
  const clean = detect(baseCall(0, 0))
  assert.ok(clean.checks.filter(c => ['wer', 'pronunciation', 'firstAudio', 'clip', 'falseInterrupts', 'mishears'].includes(c.id)).every(c => c.outcome === 'no-data'))
})
test('no keys and disabled judges produce NOT MEASURED, without network calls', async () => {
  const request = () => { throw new Error('Network must not run') }
  const c = baseCall(0, 0)
  for (const mode of ['none', 'panel']) {
    const j = await judgeCall(c, mode, {}, request)
    assert.equal(j.status, 'NOT MEASURED')
    assert.equal(j.panel.decision, null)
    const summary = report([{ call: c, predictions: j.predictions, measured: false }])
    for (const f of Object.values(summary.faults)) assert.equal(f.recall.status, 'NOT MEASURED')
    assert.equal(summary.cleanFalsePositiveRate.status, 'NOT MEASURED')
    assert.ok(!JSON.stringify(summary).includes('PASS'))
  }
})
test('judge errors, invalid findings and split opinions cannot become measured results', async () => {
  const env = { OPENAI_API_KEY: 'x'.repeat(30), ANTHROPIC_API_KEY: 'y'.repeat(30) }
  const c = baseCall(0, 0)
  assert.equal((await judgeCall(c, 'panel', env, async () => { throw new Error('offline') })).status, 'NOT MEASURED')
  const response = body => ({ ok: true, json: async () => body })
  const split = await judgeCall(c, 'panel', env, async url => {
    const content = JSON.stringify(url.includes('openai') ? { verdict: 'good', faults: [] } : { verdict: 'bad', faults: [{ id: 'loop-repeat', layer: 'llm', evidence: 'repeat' }] })
    return response(url.includes('openai') ? { choices: [{ message: { content } }] } : { content: [{ type: 'text', text: content }] })
  })
  assert.equal(split.panel.agreement, 'split')
  assert.equal(split.status, 'NOT MEASURED')
  const invalid = await judgeCall(c, 'panel', { OPENAI_API_KEY: env.OPENAI_API_KEY }, async () => response({ choices: [{ message: { content: JSON.stringify({ verdict: 'bad', faults: [{ id: 'invented', layer: 'llm', evidence: 'x' }] }) } }] }))
  assert.equal(invalid.status, 'NOT MEASURED')
})
test('gate catches exactly accuracy while aggregate improves', () => {
  const r = validateGate()
  assert.equal(r.before.outcome, 'pass')
  assert.equal(r.after.outcome, 'fail')
  assert.ok(r.candidate.composite > r.baseline.composite)
  assert.deepEqual(r.after.checks.filter(c => c.outcome === 'fail').map(c => c.id), ['param:accuracy'])
})

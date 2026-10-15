// The judge panel.
//
// The parse tests are most of this file because that is where models actually
// break. Every one of the shapes below is something a provider has returned in
// the wild; none of them is hypothetical. A verdict that fails to parse becomes
// an abstention, and an abstention silently shrinks the panel until one judge is
// left alone with the decision -- so a parse bug is a correctness bug, not a
// cosmetic one.

import assert from 'node:assert/strict'
import { test as t } from 'node:test'
import {
  MIN_PANEL, PROVIDERS, PROVIDER_IDS, buildRequest, configuredProviders,
  extractText, isRefusal, judgeOne, parseVerdict, reducePanel,
} from '../node_modules/.tmp/_judge.mjs'

const PASS = { provider: 'anthropic', model: 'm', verdict: 'pass', reason: 'ok', layer: 'prompt', flags: [] }
const FAIL = { ...PASS, provider: 'openai', verdict: 'fail', reason: 'cut off', layer: 'tts' }

/* ==================== parsing what providers actually return ==================== */

t('a bare JSON verdict parses', () => {
  const v = parseVerdict('{"verdict":"fail","reason":"interrupted","layer":"vad","flags":["over-talk"]}')
  assert.strictEqual(v.verdict, 'fail')
  assert.strictEqual(v.layer, 'vad')
  assert.deepStrictEqual(v.flags, ['over-talk'])
})

t('a fenced verdict parses, because half the providers fence', () => {
  const v = parseVerdict('```json\n{"verdict":"pass","reason":"fine","layer":"prompt"}\n```')
  assert.strictEqual(v.verdict, 'pass')
  assert.strictEqual(v.layer, 'prompt')
})

t('a verdict wrapped in preamble still parses', () => {
  // Gemini in particular narrates before answering.
  const v = parseVerdict('Sure! Here is my assessment of this call:\n{"verdict":"fail","reason":"dead air","layer":"tts"}')
  assert.strictEqual(v.verdict, 'fail')
  assert.strictEqual(v.reason, 'dead air')
})

t('a verdict trailed by an offer to help further still parses', () => {
  // DeepSeek appends this constantly. A regex matching to the last brace would
  // swallow it and fail the whole call.
  const v = parseVerdict('{"verdict":"pass","reason":"ok","layer":"prompt"}\n\nLet me know if you would like me to look at anything else!')
  assert.strictEqual(v.verdict, 'pass')
  assert.strictEqual(v.reason, 'ok')
})

t('a nested result object parses', () => {
  const v = parseVerdict('{"result":{"verdict":"fail","reason":"misheard","layer":"asr"}}')
  assert.strictEqual(v.verdict, 'fail')
  assert.strictEqual(v.layer, 'asr')
})

t('verdict labels are normalised, not matched literally', () => {
  for (const raw of ['PASS', ' Pass ', 'pass.', 'VERDICT: pass']) {
    const v = parseVerdict(`{"verdict":"${raw}","reason":"r","layer":"l"}`)
    assert.ok(v, `"${raw}" must parse`)
    assert.strictEqual(v.verdict, 'pass', `"${raw}" must normalise to pass`)
  }
})

t('prose with no verdict object returns null and never invents a pass', () => {
  // The single most important property of this function. A judge that answered
  // but not usefully must abstain, not default to pass.
  for (const text of ['', 'The call seemed fine to me overall.', 'I think the agent did well there.',
                      '```json\n{"score": 4}\n```', 'sorry, cannot help with that']) {
    assert.strictEqual(parseVerdict(text), null, `"${text}" must not parse into a verdict`)
  }
})

t('an object without a verdict field returns null', () => {
  assert.strictEqual(parseVerdict('{"reason":"ok","layer":"prompt"}'), null)
})

t('a near-miss label is not a verdict', () => {
  // Loose matching is how a judge panel starts rubber-stamping. "passable" is
  // not a pass and "failed" in prose is not a fail verdict; only the exact words
  // count, and only when the other word is absent.
  for (const raw of ['passable', 'unacceptable', 'failed', 'partially pass', 'not sure', '']) {
    assert.strictEqual(parseVerdict(`{"verdict":"${raw}","reason":"r","layer":"l"}`), null,
      `"${raw}" must not parse into a verdict`)
  }
})

t('a label word is stripped but a qualifier is not', () => {
  // The distinction that matters: "VERDICT: pass" is a pass, "partially pass" is
  // not a verdict. Both contain the word "pass"; only the second has content
  // beyond a label token.
  assert.strictEqual(parseVerdict('{"verdict":"VERDICT: pass","reason":"r","layer":"l"}').verdict, 'pass')
  assert.strictEqual(parseVerdict('{"verdict":"overall: fail","reason":"r","layer":"l"}').verdict, 'fail')
  assert.strictEqual(parseVerdict('{"verdict":"final judgement: pass","reason":"r","layer":"l"}').verdict, 'pass')
  for (const hedge of ['partially pass', 'mostly fail', 'would pass', 'borderline fail', 'pass overall good']) {
    assert.strictEqual(parseVerdict(`{"verdict":"${hedge}","reason":"r","layer":"l"}`), null,
      `"${hedge}" is a sentence, not a machine verdict`)
  }
})

t('both words present is ambiguous and abstains rather than guessing', () => {
  // "pass/fail" or "failed, did not pass" -- the panel must send this to a human
  // instead of picking one.
  for (const raw of ['pass or fail', 'fail, so no pass', 'pass/fail']) {
    assert.strictEqual(parseVerdict(`{"verdict":"${raw}","reason":"r","layer":"l"}`), null,
      `"${raw}" is ambiguous and must abstain`)
  }
})

t('a refusal is detected and is not a verdict', () => {
  for (const r of ["I can't evaluate this call.", "I cannot help with that.",
                   "I'm not able to assess this.", "As an AI, I don't have opinions on audio."]) {
    assert.ok(isRefusal(r), `"${r}" must read as a refusal`)
  }
  assert.ok(!isRefusal('The agent should not have interrupted. verdict: fail'))
})

t('a stray brace in prose does not break brace matching', () => {
  // Real sentence, then the object. Depth goes negative on the "}" in "{...}"
  // if the model writes "use the {format} below".
  const v = parseVerdict('Use the {format} shown. {"verdict":"pass","reason":"r","layer":"l"}')
  assert.strictEqual(v.verdict, 'pass')
})

t('flags survive as strings only', () => {
  const v = parseVerdict('{"verdict":"fail","reason":"r","layer":"l","flags":["a", 3, null, "b"]}')
  assert.deepStrictEqual(v.flags, ['a', 'b'])
})

/* ==================== the panel is the product ==================== */

t('unanimous pass is agreed-pass', () => {
  const o = reducePanel([PASS, { ...PASS, provider: 'gemini' }])
  assert.strictEqual(o.agreement, 'agreed-pass')
  assert.strictEqual(o.underpowered, false)
  assert.strictEqual(o.verdicts.length, 2)
})

t('unanimous fail is agreed-fail', () => {
  const o = reducePanel([FAIL, { ...FAIL, provider: 'gemini' }])
  assert.strictEqual(o.agreement, 'agreed-fail')
  assert.ok(o.sides === undefined, 'agreement carries verdicts, not sides')
})

t('a disagreement is a split and is NOT averaged', () => {
  const o = reducePanel([PASS, FAIL])
  assert.strictEqual(o.agreement, 'split')
  assert.strictEqual(o.underpowered, false)
  assert.deepStrictEqual(o.sides.pass, ['anthropic'])
  assert.deepStrictEqual(o.sides.fail, ['openai'])
  assert.match(o.reason, /unresolved/i)
  assert.strictEqual(o.verdicts, undefined, 'a split must not present a single verdict list')
})

t('one answering judge is underpowered, even among three configured providers', () => {
  // The most important rule in the file. One judge that happened to finish
  // first has confirmed nothing, and a single-judge product would have reported
  // its verdict as the answer.
  const o = reducePanel([
    PASS,
    { provider: 'gemini', kind: 'http', detail: '503' },
    { provider: 'deepseek', kind: 'unparseable', detail: 'prose' },
  ])
  assert.strictEqual(o.underpowered, true)
  assert.strictEqual(o.agreement, 'split')
  assert.strictEqual(o.sides, undefined, 'underpowered panels report no sides')
  assert.strictEqual(o.abstentions.length, 2)
})

t('abstentions are reported rather than dropped', () => {
  // Dropping them would shrink the panel invisibly and make a two-of-four result
  // look like a clean two-of-two.
  const o = reducePanel([PASS, FAIL, { provider: 'gemini', kind: 'http', detail: '429' }])
  assert.strictEqual(o.agreement, 'split')
  assert.strictEqual(o.abstentions.length, 1)
  assert.strictEqual(o.abstentions[0].provider, 'gemini')
})

t('every abstention kind is distinct from a fail', () => {
  const kinds = ['unconfigured', 'http', 'unparseable', 'refused']
  for (const kind of kinds) {
    const o = reducePanel([PASS, { provider: 'gemini', kind, detail: 'x' }])
    assert.strictEqual(o.underpowered, true, `${kind} must not count as a second opinion`)
    assert.strictEqual(o.abstentions[0].kind, kind)
  }
})

t('an empty panel is underpowered, not a pass', () => {
  const o = reducePanel([])
  assert.strictEqual(o.underpowered, true)
  assert.strictEqual(o.agreement, 'split')
})

t('a three-way split with two against one is still a split', () => {
  const o = reducePanel([PASS, FAIL, { ...FAIL, provider: 'gemini' }])
  assert.strictEqual(o.agreement, 'split')
  assert.strictEqual(o.sides.fail.length, 2)
})

/* ==================== configuration is a fact, not a preference ==================== */

t('a provider with no key is unconfigured, and the key length is checked', () => {
  assert.deepStrictEqual(configuredProviders({}), [])
  assert.deepStrictEqual(configuredProviders({ ANTHROPIC_API_KEY: 'sk-ant-short' }), [],
    'a truncated or placeholder key must not count as configured')
})

t('configured providers are detected from env alone', () => {
  const env = {
    ANTHROPIC_API_KEY: 'sk-ant-' + 'x'.repeat(40),
    OPENAI_API_KEY: 'sk-' + 'y'.repeat(40),
    DEEPSEEK_API_KEY: 'sk-' + 'z'.repeat(40),
  }
  assert.deepStrictEqual(configuredProviders(env).sort(), ['anthropic', 'deepseek', 'openai'])
})

t('all four providers are available as targets', () => {
  assert.deepStrictEqual(PROVIDER_IDS.sort(), ['anthropic', 'deepseek', 'gemini', 'openai'])
})

t('an unconfigured provider abstains instead of calling out', () => {
  const saved = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  return judgeOne('openai', 'sys', 'user').then(r => {
    if (saved) process.env.OPENAI_API_KEY = saved
    assert.strictEqual(r.kind, 'unconfigured')
    assert.match(r.detail, /OPENAI_API_KEY/)
  })
})

/* ==================== request shaping is not interchangeable ==================== */

t('each provider gets its own auth header and its own body shape', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-' + 'x'.repeat(40)
  process.env.OPENAI_API_KEY = 'sk-' + 'x'.repeat(40)
  process.env.GOOGLE_API_KEY = 'AIza' + 'x'.repeat(40)
  process.env.DEEPSEEK_API_KEY = 'sk-' + 'x'.repeat(40)

  const a = buildRequest('anthropic', 'S', 'U', 100)
  assert.ok(a.headers['x-api-key'], 'Anthropic uses x-api-key')
  assert.strictEqual(a.headers['anthropic-version'], '2023-06-01')
  assert.strictEqual(a.body.system, 'S', 'Anthropic takes system at the top level')
  assert.strictEqual(a.body.messages.length, 1)

  const o = buildRequest('openai', 'S', 'U', 100)
  assert.ok(o.headers.authorization.startsWith('Bearer '), 'OpenAI uses bearer')
  assert.strictEqual(o.body.messages.length, 2, 'OpenAI takes system as a message')
  assert.strictEqual(o.body.messages[0].role, 'system')

  const g = buildRequest('gemini', 'S', 'U', 100)
  assert.ok(g.headers['x-goog-api-key'], 'Gemini uses x-goog-api-key')
  assert.match(g.url, /:generateContent$/, 'Gemini puts the action in the path')
  assert.ok(g.body.systemInstruction, 'Gemini names it systemInstruction')
  assert.ok(g.body.contents[0].parts[0].text === 'U')

  const d = buildRequest('deepseek', 'S', 'U', 100)
  assert.ok(d.headers.authorization.startsWith('Bearer '), 'DeepSeek is OpenAI-shaped')
  assert.strictEqual(d.body.messages.length, 2)
})

t('max tokens is honoured on every provider, under each provider\'s own name', () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-' + 'x'.repeat(40)
  process.env.OPENAI_API_KEY = 'sk-' + 'x'.repeat(40)
  process.env.GOOGLE_API_KEY = 'AIza' + 'x'.repeat(40)
  for (const p of PROVIDER_IDS) {
    const r = buildRequest(p, 'S', 'U', 512)
    const mt = r.body.max_tokens ?? r.body.generationConfig?.maxOutputTokens
    assert.strictEqual(mt, 512, `${p} must carry the token cap`)
  }
})

t('the model id is pinned per provider and cannot be caller-supplied', () => {
  for (const p of PROVIDER_IDS) assert.ok(PROVIDERS[p].model, `${p} has a pinned model`)
  // There is no parameter through which a caller could name a model, because a
  // model id is a behavioural variable and a stored rubric is only valid against
  // the judge that produced it.
  const r = buildRequest('gemini', 'S', 'U', 10)
  assert.ok(r.url.includes(encodeURIComponent(PROVIDERS.gemini.model)),
    'the path carries the pinned model')
})

/* ==================== text extraction ==================== */

t('text is pulled out of each provider\'s response envelope', () => {
  assert.strictEqual(extractText('anthropic', { content: [{ type: 'text', text: 'hello' }] }), 'hello')
  assert.strictEqual(extractText('anthropic', { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'ab')
  assert.strictEqual(extractText('openai', { choices: [{ message: { content: 'hi' } }] }), 'hi')
  assert.strictEqual(extractText('gemini', { candidates: [{ content: { parts: [{ text: 'yo' }] } }] }), 'yo')
  assert.strictEqual(extractText('deepseek', { choices: [{ message: { content: 'ok' } }] }), 'ok')
})

t('a malformed envelope yields an empty string, never a crash', () => {
  for (const p of PROVIDER_IDS) {
    for (const bad of [{}, null, { content: 'a string, not blocks' }, { choices: [] }, 42]) {
      assert.doesNotThrow(() => extractText(p, bad), `${p} must not throw on ${JSON.stringify(bad)}`)
    }
  }
})

t('an empty extraction cannot become a pass', () => {
  const empty = extractText('gemini', { candidates: [] })
  assert.strictEqual(parseVerdict(empty), null)
  assert.ok(!isRefusal(empty) || parseVerdict(empty) === null)
})
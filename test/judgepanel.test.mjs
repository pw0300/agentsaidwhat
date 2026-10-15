/**
 * The judge panel, wired into the simulation suite.
 *
 * A split is the valuable state. Two judges disagreeing means one of them is
 * wrong, and a single-judge design cannot notice which -- which is the whole
 * reason this file exists rather than just calling one model.
 */

import assert from 'node:assert/strict'
import { test as t } from 'node:test'
import {
  JUDGE_ORDER, judgeWithPanel, selectJudges, suiteVerdictFor,
} from '../node_modules/.tmp/_judgepanel.mjs'

const op = (provider, o = {}) => ({
  provider, ok: true, verdict: 'good', summary: '', goalAchieved: true,
  scores: [], findings: [], error: '', ...o,
})
const KEY = c => c.repeat(40)

/* ==================== agreement ==================== */

t('unanimous judges agree and the first becomes the decision', () => {
  const p = judgeWithPanel([op('openai'), op('gemini', { verdict: 'good' })])
  assert.strictEqual(p.agreement, 'agreed')
  assert.strictEqual(p.answered, 2)
  assert.strictEqual(p.decision.verdict, 'good')
  assert.match(p.reason, /2 judges agreed/)
})

t('unanimous bad is agreed too', () => {
  const p = judgeWithPanel([op('openai', { verdict: 'bad' }), op('gemini', { verdict: 'bad' })])
  assert.strictEqual(p.agreement, 'agreed')
  assert.strictEqual(p.decision.verdict, 'bad')
})

t('a split produces NO decision', () => {
  // The single most important assertion in the file. A disagreement must not
  // become an averaged verdict, because "the middle of good and bad" describes
  // nothing about the prompt.
  const p = judgeWithPanel([op('openai', { verdict: 'good' }), op('gemini', { verdict: 'bad' })])
  assert.strictEqual(p.agreement, 'split')
  assert.strictEqual(p.decision, null, 'a contested measurement has no decision')
  assert.match(p.reason, /disagreed/)
  assert.match(p.reason, /contested/)
})

t('a three-way split with two against one is still a split', () => {
  const p = judgeWithPanel([
    op('openai', { verdict: 'good' }), op('gemini', { verdict: 'bad' }), op('deepseek', { verdict: 'bad' }),
  ])
  assert.strictEqual(p.agreement, 'split')
  assert.strictEqual(p.decision, null)
  assert.strictEqual(p.answered, 3, 'all three opinions are kept, not just the majority')
})

/* ==================== abstention is not agreement ==================== */

t('one answering judge out of two is not agreement', () => {
  // One judge that finished is not a confirmation. It is reported as `single`,
  // and the suite still proceeds -- a product that refused to judge without two
  // providers would be unusable on a single-key deployment.
  const p = judgeWithPanel([op('openai'), op('gemini', { ok: false, error: '429 rate limited' })])
  assert.strictEqual(p.agreement, 'single')
  assert.strictEqual(p.decision.provider, 'openai')
  assert.match(p.reason, /single judge cannot detect its own blind spot/)
})

t('a judge with no verdict abstains rather than agreeing', () => {
  const p = judgeWithPanel([op('openai'), op('gemini', { verdict: undefined })])
  assert.strictEqual(p.agreement, 'single')
})

t('abstentions are kept in the opinion list', () => {
  // Dropping them would hide that the panel was mostly unavailable while the
  // verdict still read 'agreed'.
  const p = judgeWithPanel([
    op('openai'), op('gemini', { verdict: 'bad' }),
    op('deepseek', { ok: false, error: 'timeout' }),
  ])
  assert.strictEqual(p.opinions.length, 3)
  assert.strictEqual(p.answered, 2)
  assert.strictEqual(p.configured, 3)
})

t('no judge answering yields no decision and says why', () => {
  const p = judgeWithPanel([
    op('openai', { ok: false, error: '503' }),
    op('gemini', { ok: false, error: 'timeout' }),
  ])
  assert.strictEqual(p.agreement, 'single')
  assert.strictEqual(p.decision, null)
  assert.match(p.reason, /503.*timeout/s)
})

t('an empty panel is not agreement', () => {
  const p = judgeWithPanel([])
  assert.strictEqual(p.decision, null)
  assert.match(p.reason, /No judge provider/)
  assert.match(p.reason, /OPENAI_API_KEY/)
  assert.match(p.reason, /Manual logging/)
})

/* ==================== what the suite reports ==================== */

t('a split is contested, and never reported as mixed or as an error-without-reason', () => {
  const p = judgeWithPanel([op('openai', { verdict: 'good' }), op('gemini', { verdict: 'bad' })])
  const s = suiteVerdictFor(p)
  assert.strictEqual(s.contested, true)
  assert.strictEqual(s.ok, false, 'a contested measurement cannot score the prompt')
  assert.notStrictEqual(s.verdict, 'mixed', "'mixed' is a quality verdict; a dispute is not one")
  assert.match(s.note, /contested/)
})

t('an agreed panel reports the decision and is not contested', () => {
  const s = suiteVerdictFor(judgeWithPanel([op('openai', { verdict: 'good' }), op('gemini')]))
  assert.strictEqual(s.ok, true)
  assert.strictEqual(s.verdict, 'good')
  assert.strictEqual(s.contested, false)
  assert.match(s.note, /agreed/)
})

t('a single judge is usable but is never described as agreeing', () => {
  const s = suiteVerdictFor(judgeWithPanel([op('openai', { verdict: 'mixed' })]))
  assert.strictEqual(s.ok, true)
  assert.strictEqual(s.verdict, 'mixed')
  assert.match(s.note, /single judge/)
  assert.doesNotMatch(s.note, /agreed/)
})

t('nothing answered is an error and is not contested', () => {
  // Distinct from a split: nobody measured, rather than two people disagreeing.
  const s = suiteVerdictFor(judgeWithPanel([op('openai', { ok: false, error: 'down' })]))
  assert.strictEqual(s.contested, false)
  assert.strictEqual(s.ok, false)
  assert.match(s.note, /down/)
})

/* ==================== provider selection ==================== */

t('an independent family is preferred over the simulator family', () => {
  const chosen = selectJudges({
    ANTHROPIC_API_KEY: `sk-ant-${KEY('x')}`,
    OPENAI_API_KEY: `sk-${KEY('y')}`,
  })
  assert.deepStrictEqual(chosen, ['openai', 'anthropic'],
    'the simulator runs on Anthropic, so it must not be the first opinion on its own work')
})

t('anthropic alone still judges, because it is the only guaranteed key', () => {
  assert.deepStrictEqual(selectJudges({ ANTHROPIC_API_KEY: `sk-ant-${KEY('x')}` }), ['anthropic'])
})

t('no keys means no judges rather than a crash', () => {
  assert.deepStrictEqual(selectJudges({}), [])
  assert.deepStrictEqual(selectJudges({ OPENAI_API_KEY: 'too-short' }), [])
})

t('all four providers can be in play', () => {
  const chosen = selectJudges({
    OPENAI_API_KEY: `sk-${KEY('a')}`, GOOGLE_API_KEY: `AIza${KEY('b')}`,
    DEEPSEEK_API_KEY: `sk-${KEY('c')}`, ANTHROPIC_API_KEY: `sk-ant-${KEY('d')}`,
  })
  assert.deepStrictEqual(chosen, ['openai', 'gemini', 'deepseek', 'anthropic'])
  assert.deepStrictEqual([...chosen], [...JUDGE_ORDER])
})

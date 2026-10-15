/**
 * The logging model: what counts as a problem, which parameters an agent is
 * scored on, how old use cases become scenarios, and that the sample workspace
 * demonstrates what it claims to and removes cleanly.
 */
import assert from 'node:assert/strict'
import { test as t } from 'node:test'
import { isProblem, paramsFor, scenariosFor, untriagedCount } from '../node_modules/.tmp/_notes.mjs'
import { demoState, withoutDemo, isDemo } from '../node_modules/.tmp/_demo.mjs'
import { migrateScenarios, defaultRubric } from '../node_modules/.tmp/_data.mjs'
import { mergeState } from '../node_modules/.tmp/_merge.mjs'
import { measureGate } from '../node_modules/.tmp/_measure.mjs'

const empty = () => ({ projects: [], agents: [], versions: [], sessions: [], issues: [], rubric: defaultRubric, testers: [], batches: [], calls: [], scenarios: [] })

t('a note without a kind is a problem, because every old note was one', () => {
  assert.equal(isProblem({ kind: undefined }), true)
  assert.equal(isProblem({ kind: 'went-wrong' }), true)
  assert.equal(isProblem({ kind: 'went-well' }), false)
})

t('"went well" notes never reach the triage queue', () => {
  const s = empty()
  s.agents.push({ id: 'a', projectId: 'p', name: 'A', type: 'voice', direction: 'outbound', useCases: [] })
  s.sessions.push({ id: 's', agentId: 'a', observations: [
    { id: '1', kind: 'went-well', triage: 'untriaged' },
    { id: '2', kind: 'went-wrong', triage: 'untriaged' },
    { id: '3', triage: 'untriaged' },
  ] })
  assert.equal(untriagedCount(s), 2)
})

t('an agent with no chosen parameters is scored on every one for its type', () => {
  const s = empty()
  const voice = { id: 'a', type: 'voice' }
  const chat = { id: 'b', type: 'chatbot' }
  assert.equal(paramsFor(s, voice).length, defaultRubric.filter(p => p.appliesTo.includes('voice')).length)
  assert.ok(!paramsFor(s, chat).some(p => p.id === 'interruptions'), 'chatbots are not scored on interruptions')
})

t('an agent with chosen parameters is scored on exactly those, in rubric order', () => {
  const s = empty()
  const a = { id: 'a', type: 'voice', paramIds: ['interruptions', 'accuracy'] }
  assert.deepEqual(paramsFor(s, a).map(p => p.id), ['accuracy', 'interruptions'])
})

t('a chosen parameter that does not apply to the agent type is ignored', () => {
  const a = { id: 'b', type: 'chatbot', paramIds: ['interruptions', 'memory'] }
  assert.deepEqual(paramsFor(empty(), a).map(p => p.id), ['memory'])
})

t('old use cases migrate into scenarios with stable ids', () => {
  const one = empty(), two = empty()
  for (const s of [one, two]) s.agents.push({ id: 'a', projectId: 'p', name: 'A', type: 'voice', direction: 'outbound', useCases: ['Price objection', 'Caller switches to Hindi'] })
  migrateScenarios(one); migrateScenarios(two)
  assert.equal(one.scenarios.length, 2)
  // Two browsers migrating the same workspace must produce the same ids, or the
  // merge would see two copies of every scenario.
  assert.deepEqual(one.scenarios.map(s => s.id), two.scenarios.map(s => s.id))
  const merged = mergeState({}, one, two)
  assert.equal(merged.scenarios.length, 2)
})

t('migration runs once: a second pass adds nothing', () => {
  const s = empty()
  s.agents.push({ id: 'a', projectId: 'p', name: 'A', type: 'voice', direction: 'outbound', useCases: ['X'] })
  assert.equal(migrateScenarios(s), true)
  assert.equal(migrateScenarios(s), false)
  assert.equal(s.scenarios.length, 1)
})

t('a tester sees approved scenarios plus their own proposals, not other people\'s', () => {
  const s = empty()
  const sc = (id, status, by) => ({ id, agentId: 'a', name: id, status, proposedBy: by })
  s.scenarios.push(sc('approved', 'approved', ''), sc('mine', 'proposed', 'Asha'), sc('theirs', 'proposed', 'Ravi'), sc('old', 'archived', ''))
  assert.deepEqual(scenariosFor(s, 'a', 'Asha').map(x => x.id), ['approved', 'mine'])
})

t('the sample workspace shows the regression it was built to show', () => {
  const s = demoState(empty())
  const g = measureGate(s, 'demo-agent', 'demo-v2')
  assert.ok(!('error' in g))
  const v1 = s.sessions.filter(x => x.versionId === 'demo-v1')
  const v2 = s.sessions.filter(x => x.versionId === 'demo-v2')
  const mean = (rows, id) => { const v = rows.flatMap(r => r.scores).filter(x => x.paramId === id).map(x => x.value); return v.reduce((a, b) => a + b, 0) / v.length }
  assert.ok(mean(v2, 'helpfulness') > mean(v1, 'helpfulness'), 'v2 fixes the discount answer')
  assert.ok(mean(v2, 'interruptions') < mean(v1, 'interruptions') - 1, 'and breaks interruption handling by more than a point')
})

t('every sample record is labelled as sample', () => {
  const s = demoState(empty())
  assert.ok(isDemo(s))
  assert.match(s.projects[0].name, /sample/i)
  assert.ok(s.sessions.every(x => x.tester === 'Sample tester'))
})

t('removing sample data leaves the user\'s own records untouched', () => {
  const mine = empty()
  mine.projects.push({ id: 'p', name: 'Mine' })
  mine.agents.push({ id: 'a', projectId: 'p', name: 'Real', type: 'voice', direction: 'outbound', useCases: [] })
  mine.testers.push('Asha')
  const cleaned = withoutDemo(demoState(mine))
  assert.ok(!isDemo(cleaned))
  assert.deepEqual(cleaned.projects, mine.projects)
  assert.deepEqual(cleaned.agents, mine.agents)
  assert.deepEqual(cleaned.testers, ['Asha'])
  assert.equal(cleaned.sessions.length, 0)
})

t('loading sample data twice does not duplicate it', () => {
  const s = demoState(demoState(empty()))
  assert.equal(s.sessions.length, 10)
  assert.equal(s.projects.length, 1)
})

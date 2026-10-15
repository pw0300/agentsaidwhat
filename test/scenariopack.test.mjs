import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadScenarioPack } from '../node_modules/.tmp/_scenariopack.mjs'

const names = ['hinglish-support', 'interrupter', 'noisy-line']
for (const name of names) {
  test(`${name}: valid pack loads`, () => {
    const file = `${name}.yaml`
    const pack = loadScenarioPack(readFileSync(new URL(`../scenarios/${file}`, import.meta.url), 'utf8'), file)
    assert.equal(pack.id, name)
    assert.equal(pack.scenarios.length, 1)
    assert.ok(pack.scenarios[0].successCriteria.length)
  })
}
const valid = loadScenarioPack(readFileSync(new URL('../scenarios/hinglish-support.yaml', import.meta.url), 'utf8'), 'fixture.yaml')
for (const field of ['id', 'name', 'persona', 'goal', 'successCriteria', 'language', 'tags']) {
  test(`missing ${field} names the field and file`, () => {
    const pack = structuredClone(valid)
    delete pack.scenarios[0][field]
    assert.throws(() => loadScenarioPack(JSON.stringify(pack), 'missing.yaml'), error =>
      error.message.includes('missing.yaml') && error.message.includes(`scenarios[0].${field}`))
  })
}
test('invalid YAML names the file and format', () => {
  assert.throws(() => loadScenarioPack('id: [broken', 'invalid.yaml'), /invalid.yaml: document.*YAML/)
})
test('empty criteria cannot produce an untestable scenario', () => {
  const pack = structuredClone(valid)
  pack.scenarios[0].successCriteria = []
  assert.throws(() => loadScenarioPack(JSON.stringify(pack), 'empty.yaml'), /empty.yaml: scenarios\[0\].successCriteria/)
})
test('duplicate scenario ids are rejected', () => {
  const pack = structuredClone(valid)
  pack.scenarios.push(structuredClone(pack.scenarios[0]))
  assert.throws(() => loadScenarioPack(JSON.stringify(pack), 'duplicate.yaml'), /duplicate.yaml: scenarios\[1\].id duplicates/)
})
test('incorrect field types are rejected', () => {
  const pack = structuredClone(valid)
  pack.scenarios[0].tags = [42]
  assert.throws(() => loadScenarioPack(JSON.stringify(pack), 'types.yaml'), /types.yaml: scenarios\[0\].tags\[0\]/)
})
test('pack metadata and scenarios are required', () => {
  for (const field of ['id', 'name', 'scenarios']) {
    const pack = structuredClone(valid)
    delete pack[field]
    assert.throws(() => loadScenarioPack(JSON.stringify(pack), 'pack.yaml'), error =>
      error.message.includes(`pack.yaml: ${field}`))
  }
})

test('version is required and unknown versions are rejected', () => {
  for (const version of [undefined, 2, '1']) assert.throws(() => loadScenarioPack(JSON.stringify({...valid, version}), 'version.yaml'), /version.yaml: version.*1/)
})
test('callerTurns is optional and validates each turn', () => {
  const pack = structuredClone(valid)
  assert.ok(pack.scenarios[0].callerTurns.length)
  delete pack.scenarios[0].callerTurns
  assert.equal(loadScenarioPack(JSON.stringify(pack), 'optional.yaml').scenarios[0].callerTurns, undefined)
  pack.scenarios[0].callerTurns = [42]
  assert.throws(() => loadScenarioPack(JSON.stringify(pack), 'turns.yaml'), /turns.yaml: scenarios\[0\].callerTurns\[0\]/)
})
test('comments, block scalars and duplicate keys', () => {
  const text = '# comment\n' + readFileSync(new URL('../scenarios/hinglish-support.yaml', import.meta.url), 'utf8').replace('version: 1', 'version: 1')
  assert.equal(loadScenarioPack(text, 'readable.yaml').version, 1)
  assert.throws(() => loadScenarioPack(text + '\nversion: 1', 'duplicate-key.yaml'), /duplicate-key.yaml: document/)
})

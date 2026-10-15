import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_FILTERS, readCallFilters, writeCallFilters, filterCalls } from '../node_modules/.tmp/_callFilters.mjs'

const a = { id: 'a', agentId: 'agent', versionId: 'v1', tester: 'Alice', useCase: 'Price & billing', createdAt: '2026-10-01T12:00:00Z', transcript: 'hello', comments: '', observations: [{ kind: 'went-wrong', whatHappened: 'Price wrong', quote: '' }], scores: [{ value: 2 }], audioId: 'audio' }
const b = { ...a, id: 'b', versionId: 'v2', tester: 'Bob', createdAt: '2026-10-02T12:00:00Z', observations: [{ kind: 'went-well', whatHappened: 'Good', quote: '' }], scores: [{ value: 5 }], audioId: undefined }
const filter = patch => filterCalls([a, b, { ...a, id: 'outside', agentId: 'other' }], { ...DEFAULT_FILTERS, ...patch }, { agent: 'Sales' }).map(s => s.id)
test('call filter hash round trips escaped values and preserves unrelated keys', () => {
  const f = { ...DEFAULT_FILTERS, scenario: 'Price & billing', tester: 'Alice', from: '2026-10-01', recording: '1', problems: '1', direction: 'asc' }
  const hash = writeCallFilters(f, '#unrelated=keep&calls.q=old')
  assert.deepEqual(readCallFilters(hash), f)
  assert.match(hash, /unrelated=keep/)
  assert.doesNotMatch(hash, /calls.q/)
  assert.equal(readCallFilters('#calls.sort=bad&calls.direction=bad').sort, 'date')
  assert.equal(readCallFilters('#calls.direction=bad').direction, 'desc')
})
test('call filters intersect including recording, problems and inclusive dates', () => {
  assert.deepEqual(filter({}), ['b', 'a'])
  assert.deepEqual(filter({ problems: '1', recording: '1', from: '2026-10-01', to: '2026-10-01' }), ['a'])
  assert.deepEqual(filter({ version: 'v2', tester: 'Bob', q: 'hello' }), ['b'])
  assert.deepEqual(filter({ agent: 'other' }), [])
  assert.deepEqual(filter({ scenario: 'missing' }), [])
  assert.deepEqual(filter({ q: 'price wrong' }), ['a'])
})
test('call sorting handles numeric columns, text columns and stable ties without mutating input', () => {
  for (const sort of ['score', 'notes', 'recording', 'tester', 'agent', 'scenario']) assert.deepEqual(filter({ sort, direction: 'asc' }), sort === 'recording' ? ['b', 'a'] : ['a', 'b'])
  assert.deepEqual(filter({ sort: 'score', direction: 'desc' }), ['b', 'a'])
  assert.equal(a.id, 'a')
})

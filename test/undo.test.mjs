import { test } from 'node:test'
import assert from 'node:assert/strict'
import { undoMutation } from '../node_modules/.tmp/_undo.mjs'
const state = patch => ({ projects: [], agents: [], versions: [], sessions: [], issues: [], rubric: [], testers: [], batches: [], calls: [], scenarios: [], ...patch })
test('undo removes a saved call and leaves subsequent calls intact', () => {
  const before = state({ sessions: [{ id: 'old' }] })
  const after = state({ sessions: [{ id: 'old' }, { id: 'saved' }] })
  const current = state({ sessions: [...after.sessions, { id: 'later' }] })
  assert.deepEqual(undoMutation(before, after, current).sessions, [{ id: 'old' }, { id: 'later' }])
  assert.equal(current.sessions.length, 3)
})
test('undo restores deleted records, changed fields and tester entries', () => {
  const before = state({ issues: [{ id: 'i', status: 'open' }], sessions: [{ id: 'deleted' }], testers: ['Alice'] })
  const after = state({ issues: [{ id: 'i', status: 'wont-fix' }], testers: ['Alice', 'Bob'] })
  assert.deepEqual(undoMutation(before, after, after), before)
})
test('undo preserves a record modified remotely after the original action', () => {
  const before = state({ issues: [{ id: 'i', status: 'open' }] })
  const after = state({ issues: [{ id: 'i', status: 'wont-fix' }] })
  const current = state({ issues: [{ id: 'i', status: 'reopened' }] })
  assert.deepEqual(undoMutation(before, after, current), current)
})
test('undo supports missing optional collections in old data', () => {
  const before = state(); delete before.scenarios
  const after = { ...before, scenarios: [{ id: 'new' }] }
  assert.deepEqual(undoMutation(before, after, after).scenarios, [])
})

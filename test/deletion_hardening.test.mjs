import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeState } from '../dist-server/lib.mjs'

test('deleted sessions stay deleted when stale tabs lack the id in their base', () => {
  const row = { id: 'private-call', transcript: 'Sensitive evidence' }
  const original = { sessions: [row] }
  const deleted = mergeState(original, { sessions: [] }, original)
  assert.deepEqual(deleted.sessions, [])
  const stale = mergeState({ sessions: [] }, original, deleted)
  assert.deepEqual(stale.sessions, [])
  const editedStale = mergeState(original, { sessions: [{ ...row, comments: 'late edit' }] }, stale)
  assert.deepEqual(editedStale.sessions, [])
  const fresh = mergeState({}, { sessions: [{ id: 'new-call' }] }, editedStale)
  assert.deepEqual(fresh.sessions.map(r => r.id), ['new-call'])
})

test('deletion wins against a concurrent edit and tombstones survive further syncs', () => {
  const original = { sessions: [{ id: 's', comments: 'before' }] }
  const deleted = mergeState(original, { sessions: [] }, { sessions: [{ id: 's', comments: 'edited' }] })
  assert.deepEqual(deleted.sessions, [])
  const roundtrip = mergeState({}, { sessions: [], calls: [{ id: 'c' }] }, JSON.parse(JSON.stringify(deleted)))
  assert.deepEqual(mergeState({}, original, roundtrip).sessions, [])
  assert.equal(roundtrip.calls.length, 1)
})

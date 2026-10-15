// An edit made while the first sync is in flight must survive that sync's reply.
// Found by clicking "Look around with sample data" in the first second of a fresh
// workspace: the reply carried the empty server copy and overwrote the sample data.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const src = readFileSync('src/store.tsx', 'utf8')

test('a sync reply does not overwrite edits made while it was in flight', () => {
  assert.match(src, /const sent = stateRef\.current/)
  assert.match(src, /if \(stateRef\.current !== sent\)/, 'must compare against the state that was sent')
  assert.match(src, /dirtyAfterFlight\.current = true/, 'must schedule another push for the newer edit')
})

test('an edit during an in-flight sync is queued, not dropped', () => {
  assert.match(src, /if \(inFlight\.current\) \{ dirtyAfterFlight\.current = true; return \}/)
  assert.match(src, /if \(dirtyAfterFlight\.current\) \{ dirtyAfterFlight\.current = false; void doPush\(\) \}/)
})

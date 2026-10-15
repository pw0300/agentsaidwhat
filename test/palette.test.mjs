import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fuzzyScore, searchCommands } from '../node_modules/.tmp/_palette.mjs'

test('palette matches case, whitespace and ordered characters', () => {
  assert.ok(fuzzyScore('  LC ', 'Log a call') >= 0)
  assert.equal(fuzzyScore('zx', 'Log a call'), -1)
  assert.equal(fuzzyScore('', 'Calls'), 0)
  assert.ok(fuzzyScore('call', 'Calls') > fuzzyScore('call', 'Customer asks a little later'))
})
test('palette searches record details, preserves ties and omits misses', () => {
  const commands = [{ id: 'a', label: 'Billing', detail: 'Call Alice 2026-10-07' }, { id: 'b', label: 'Billing', detail: 'Scenario' }]
  assert.deepEqual(searchCommands(commands, 'alice').map(c => c.id), ['a'])
  assert.deepEqual(searchCommands(commands, '').map(c => c.id), ['a', 'b'])
  assert.deepEqual(searchCommands(commands, 'missing'), [])
})

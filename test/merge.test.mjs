// Merge rules for the shared store. This is the only code in the app where a
// bug silently destroys someone else's work rather than showing an error, so it
// is the one part that gets tests.
//
//   npm test   (compiles api/_merge.ts through esbuild first)
import { mergeState } from '../node_modules/.tmp/_merge.mjs'
import assert from 'node:assert'

const S = (id, tester, comments = '') => ({ id, tester, comments })
let pass = 0
const t = (name, fn) => { try { fn(); pass++; console.log('ok  ', name) } catch (e) { console.log('FAIL', name, '-', e.message) } }

// Two testers each add a session the other has never seen. Both must survive —
// this is the exact failure localStorage produced.
t('concurrent adds both survive', () => {
  const base = { sessions: [] }
  const local = { sessions: [S('a', 'Neha')] }
  const server = { sessions: [S('b', 'Arjun')] }
  const out = mergeState(base, local, server)
  assert.deepStrictEqual(out.sessions.map(s => s.id).sort(), ['a', 'b'])
})

t('remote edit adopted when local untouched', () => {
  const base = { sessions: [S('a', 'Neha')] }
  const local = { sessions: [S('a', 'Neha')] }
  const server = { sessions: [S('a', 'Neha', 'edited elsewhere')] }
  assert.strictEqual(mergeState(base, local, server).sessions[0].comments, 'edited elsewhere')
})

t('local edit kept when remote untouched', () => {
  const base = { sessions: [S('a', 'Neha')] }
  const local = { sessions: [S('a', 'Neha', 'mine')] }
  const server = { sessions: [S('a', 'Neha')] }
  assert.strictEqual(mergeState(base, local, server).sessions[0].comments, 'mine')
})

t('both edited -> pusher wins', () => {
  const base = { sessions: [S('a', 'Neha')] }
  const local = { sessions: [S('a', 'Neha', 'mine')] }
  const server = { sessions: [S('a', 'Neha', 'theirs')] }
  assert.strictEqual(mergeState(base, local, server).sessions[0].comments, 'mine')
})

t('local delete sticks, is not resurrected', () => {
  const base = { sessions: [S('a', 'Neha')] }
  const local = { sessions: [] }
  const server = { sessions: [S('a', 'Neha')] }
  assert.deepStrictEqual(mergeState(base, local, server).sessions, [])
})

t('remote delete sticks', () => {
  const base = { sessions: [S('a', 'Neha')] }
  const local = { sessions: [S('a', 'Neha')] }
  const server = { sessions: [] }
  assert.deepStrictEqual(mergeState(base, local, server).sessions, [])
})

t('delete wins over a concurrent edit of the same record', () => {
  const base = { sessions: [S('a', 'Neha')] }
  const local = { sessions: [] }
  const server = { sessions: [S('a', 'Neha', 'still working on it')] }
  assert.strictEqual(mergeState(base, local, server).sessions.length, 0)
})

t('testers union, minus deliberate removals', () => {
  const out = mergeState({ testers: ['Asha', 'Neha'] }, { testers: ['Asha'] }, { testers: ['Asha', 'Neha', 'Arjun'] })
  assert.deepStrictEqual(out.testers.sort(), ['Arjun', 'Asha'])
})

t('apiKey never round-trips', () => {
  const out = mergeState({}, { apiKey: 'sk-ant-leak', sessions: [] }, { apiKey: 'sk-ant-leak', sessions: [] })
  assert.strictEqual('apiKey' in out, false)
})

t('empty server (first ever write) keeps everything local', () => {
  const local = { sessions: [S('a', 'Neha')], issues: [{ id: 'i1' }], testers: ['Neha'] }
  const out = mergeState({}, local, local)
  assert.strictEqual(out.sessions.length, 1)
  assert.strictEqual(out.issues.length, 1)
  assert.deepStrictEqual(out.testers, ['Neha'])
})

t('missing collections do not produce undefined entries', () => {
  const out = mergeState({}, { sessions: [S('a', 'Neha')] }, {})
  assert.ok(out.calls.every(x => x !== undefined))
  assert.deepStrictEqual(out.batches, [])
})

console.log(`\n${pass}/11 passed`)
process.exit(pass === 11 ? 0 : 1)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adjacentIssue } from '../node_modules/.tmp/_issueNavigation.mjs'
test('issue column navigation skips empty columns and keeps selection at edges', () => {
  const issues = [{ id: 'a', status: 'open' }, { id: 'b', status: 'verified-fixed' }, { id: 'c', status: 'verified-fixed' }]
  const columns = ['open', 'claimed-fixed', 'verified-fixed', 'reopened']
  assert.equal(adjacentIssue(issues, 'a', 1, columns), 'b')
  assert.equal(adjacentIssue(issues, 'c', -1, columns), 'a')
  assert.equal(adjacentIssue(issues, 'a', -1, columns), 'a')
  assert.equal(adjacentIssue(issues, 'b', 1, columns), 'b')
  assert.equal(adjacentIssue(issues, 'missing', 1, columns), 'a')
  assert.equal(adjacentIssue([], '', 1, columns), '')
})

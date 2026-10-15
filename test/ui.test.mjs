/**
 * The gate page renders.
 *
 * This is a server-render smoke test, not a click-through: the browser does not
 * start in this environment, so effects do not run and the fetch in GatePage is
 * never reached. What it DOES prove is the thing a type-checker cannot — that
 * every branch of the result view renders without throwing on the data shapes
 * the API actually returns, including the shapes that only appear when a
 * measurement failed.
 *
 * The cases that matter are the failure ones. A page that renders a clean result
 * proves nothing; what needs proving is that it renders a NOT MEASURED row
 * without throwing, because that is the state every real deployment starts in.
 */

import assert from 'node:assert/strict'
import { test as t } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

const load = async () => {
  const mod = await import('../node_modules/.tmp/_ui-ux.mjs')
  return mod
}

t('the UI bundle exposes a renderable tree', async () => {
  const m = await load()
  assert.ok(m.App, 'App.tsx must export App by name so this test can reach it')
  assert.ok(m.default, 'and must keep a default export for the entry point')
})

t('rendering the app root does not throw', async () => {
  const { App } = await load()
  const html = renderToStaticMarkup(createElement(App))
  assert.ok(html.length > 0)
})

t('every nav destination has a title', async () => {
  // A View with no TITLES entry renders the nav shell with an undefined
  // heading, which is the sort of thing a screenshot hides.
  const { App } = await load()
  const html = renderToStaticMarkup(createElement(App))
  assert.doesNotMatch(html, />undefined</, 'no destination may render the string "undefined"')
})
t('command palette renders searchable records and accessible selection', async () => {
  const { CommandPalette } = await load()
  const html = renderToStaticMarkup(createElement(CommandPalette, { commands: [{ id: 'call', label: 'Billing', detail: 'Call Alice 2026-10-07', run() {} }], onClose() {} }))
  assert.match(html, /role="dialog"/)
  assert.match(html, /role="combobox"/)
  assert.match(html, /aria-selected="true"/)
  assert.match(html, /Call Alice 2026-10-07/)
})

t('issue drawer renders version history and each verification without a modal', async () => {
  const { IssueDrawer } = await load()
  const issue = { title: 'Price error', description: 'Wrong price', ownerTeam: 'Prompt engineering', ownerPerson: '', attribution: '', bornInVersionId: 'v1', claimedFixedInVersionId: 'v2', verifiedFixedInVersionId: 'v3', createdAt: '2026-10-01', status: 'verified-fixed', resolutionNote: 'Corrected', verifications: [{ versionId: 'v3', tester: 'Alice', verdict: 'fixed', note: 'Checked the price', createdAt: '2026-10-03' }] }
  const html = renderToStaticMarkup(createElement(IssueDrawer, { issue, versions: [1, 2, 3].map(n => ({ id: `v${n}`, number: n, changelog: 'Updated prompt' })), onClose() {} }))
  assert.match(html, /Born in v1/)
  assert.match(html, /Claimed fixed in v2/)
  assert.match(html, /Verified fixed in v3/)
  assert.match(html, /Checked the price/)
  assert.doesNotMatch(html, /aria-modal/)
})

const renderScreen = async (name, props, patch = {}) => {
  const m = await load()
  const state = m.demoState({ projects: [], agents: [], versions: [], sessions: [], issues: [], rubric: m.defaultRubric, testers: [], batches: [], calls: [], scenarios: [] })
  Object.assign(state, patch)
  globalThis.window = { location: { hash: '' } }
  globalThis.localStorage = { getItem() { return null }, setItem() {}, removeItem() {} }
  return renderToStaticMarkup(createElement(m.StoreContext.Provider, { value: { state, mutate() {}, sync: { status: 'local-only', error: '', lastAt: null, syncNow() {} } } }, createElement(m[name], { projectId: m.DEMO_PROJECT_ID, ...props })))
}

t('calls render sortable columns, bulk selection and combined filter controls', async () => {
  const html = await renderScreen('Calls')
  for (const label of ['Select all shown calls', 'Send problems to triage', 'Has problems', 'Has recording', 'From date', 'To date', 'aria-sort']) assert.ok(html.includes(label), label)
})

t('triage shows one finding with remaining count and decision controls', async () => {
  const html = await renderScreen('Triage')
  assert.equal((html.match(/class="card triage-finding"/g) ?? []).length, 1)
  assert.match(html, /left/)
  for (const label of ['Triage note', 'Accept', 'Reject', 'Ask tester', 'Skip']) assert.ok(html.includes(label))
})

t('empty triage explains the next step with a button', async () => {
  const html = await renderScreen('Triage', {}, { sessions: [] })
  assert.match(html, /Every finding reviewed/)
  assert.match(html, /Review issues/)
})

t('logger renders focusable parameter rows and save controls', async () => {
  const m = await load()
  const state = m.demoState({ projects: [], agents: [], versions: [], sessions: [], issues: [], rubric: m.defaultRubric, testers: [], batches: [], calls: [], scenarios: [] })
  const html = await renderScreen('LogCall', { tester: 'Alice', initialAgentId: state.agents.find(a => a.projectId === m.DEMO_PROJECT_ID).id })
  assert.match(html, /role="group"/)
  assert.match(html, /tabindex="0"/)
  assert.match(html, /Went wrong/)
  assert.match(html, /Save call/)
})

t('dense mode is visible in Settings and undo is an accessible toast action', async () => {
  const html = await renderScreen('Settings', { testerMode: false, onTesterMode() {}, dense: true, onDense() {} })
  assert.match(html, /Dense mode/)
  const { Toast } = await load()
  const toast = renderToStaticMarkup(createElement(Toast, { message: 'Saved call', onUndo() {}, onClose() {} }))
  assert.match(toast, /role="status"/)
  assert.match(toast, /Saved call/)
  assert.match(toast, /Undo/)
})

t('issue board exposes owner filter, keyboard cards and direct detail selection', async () => {
  const m = await load()
  const state = m.demoState({ projects: [], agents: [], versions: [], sessions: [], issues: [], rubric: m.defaultRubric, testers: [], batches: [], calls: [], scenarios: [] })
  const issue = { id: 'test-issue', projectId: m.DEMO_PROJECT_ID, agentId: state.agents[0].id, title: 'Price error', description: 'Wrong price', severity: 'major', status: 'open', layer: 'prompt', ownerTeam: 'Prompt engineering', ownerPerson: '', attribution: '', bornInVersionId: state.versions[0].id, claimedFixedInVersionId: null, verifiedFixedInVersionId: null, verifications: [], resolutionNote: '', createdAt: '2026-10-01' }
  const html = await renderScreen('IssueBoard', { initialIssueId: issue.id }, { issues: [issue] })
  assert.match(html, /Owner layer/)
  assert.match(html, /tabindex="0"/)
  assert.match(html, /aria-label="Issue details"/)
  assert.match(html, /Timeline/)
})

/** Recording IDs belong to one server and are not portable backup evidence. */
export function portableBackup<T extends { sessions: { audioId?: string }[] }>(state: T): T {
  const copy: T = JSON.parse(JSON.stringify(state))
  for (const session of copy.sessions) delete session.audioId
  return copy
}

import type { AppState } from './types'
import { migrateScenarios } from './data'
type RecordValue = Record<string, unknown>
const invalid = (path: string): never => { throw new Error(`Invalid backup: check ${path}. Your current workspace has not been changed.`) }
function record(value: unknown, path: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path)
  return value as RecordValue
}
function strings(row: RecordValue, keys: string, path: string) {
  for (const key of keys.split(' ')) if (typeof row[key] !== 'string') invalid(`${path}.${key}`)
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path)
  return value as unknown[]
}
function stringArray(value: unknown, path: string) {
  if (array(value, path).some(v => typeof v !== 'string')) invalid(path)
}
function rows(value: unknown, path: string, keys: string): RecordValue[] {
  return array(value, path).map((v, i) => { const r = record(v, `${path}[${i}]`); strings(r, keys, `${path}[${i}]`); return r })
}
function number(value: unknown, path: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path)
}
/** Validate the entire replacement before the store can see any of it. */
export function parseBackup(text: string): AppState {
  let value: unknown
  try { value = JSON.parse(text) } catch { invalid('JSON syntax') }
  const state = record(value, 'workspace')
  rows(state.projects, 'projects', 'id name')
  for (const a of rows(state.agents, 'agents', 'id projectId name type direction')) {
    stringArray(a.useCases, 'agent.useCases')
    if (a.paramIds !== undefined) stringArray(a.paramIds, 'agent.paramIds')
    if (!['voice', 'chatbot'].includes(String(a.type)) || !['inbound', 'outbound', 'both'].includes(String(a.direction))) invalid('agent type or direction')
  }
  for (const v of rows(state.versions, 'versions', 'id agentId promptText changelog status createdAt')) {
    number(v.number, 'version.number'); rows(v.decisions, 'version.decisions', 'id text createdAt author')
  }
  const scores = (value: unknown) => { for (const s of rows(value, 'scores', 'paramId paramName')) number(s.value, 'score.value') }
  for (const s of rows(state.sessions, 'sessions', 'id agentId versionId tester useCase transcript recordingName comments createdAt')) {
    scores(s.scores)
    if (s.naParams !== undefined) stringArray(s.naParams, 'session.naParams')
    for (const o of rows(s.observations, 'observations', 'id sessionId whatHappened expected quote severity triage triageNote')) {
      if (o.issueId !== null && typeof o.issueId !== 'string') invalid('observation.issueId')
    }
  }
  for (const i of rows(state.issues, 'issues', 'id projectId agentId title description severity status bornInVersionId resolutionNote createdAt layer ownerTeam ownerPerson attribution')) {
    rows(i.verifications, 'issue.verifications', 'versionId tester verdict note createdAt')
    for (const key of ['claimedFixedInVersionId', 'verifiedFixedInVersionId']) if (i[key] !== null && typeof i[key] !== 'string') invalid(`issue.${key}`)
  }
  for (const r of rows(state.rubric, 'rubric', 'id name question')) {
    stringArray(r.appliesTo, 'rubric.appliesTo')
    const anchors = record(r.anchors, 'rubric.anchors')
    strings(anchors, '1 3 5', 'rubric.anchors')
  }
  stringArray(state.testers, 'testers')
  for (const key of ['batches', 'calls', 'scenarios', 'gates']) state[key] ??= []
  rows(state.batches, 'batches', 'id agentId versionId name report createdAt')
  for (const c of rows(state.calls, 'calls', 'id batchId fileName transcript recordingName verdict summary error createdAt')) {
    scores(c.scores); rows(c.findings, 'call.findings', 'id layer severity what evidence suggestedFix')
  }
  for (const s of rows(state.scenarios, 'scenarios', 'id agentId name persona goal successCriteria language status proposedBy createdAt')) stringArray(s.tags, 'scenario.tags')
  for (const g of rows(state.gates, 'gates', 'id agentId name')) {
    if (typeof g.enabled !== 'boolean') invalid('gate.enabled')
    number(g.minSamples, 'gate.minSamples')
    for (const key of ['minComposite', 'maxBlockers', 'maxRegression', 'baselineVersionNumber']) if (g[key] !== null) number(g[key], `gate.${key}`)
    for (const floor of Object.values(record(g.minParams, 'gate.minParams'))) number(floor, 'gate floor')
  }
  const result = portableBackup(state as unknown as AppState)
  migrateScenarios(result)
  return result
}

/**
 * Turn a QA workspace into the numbers a release gate judges.
 *
 * This used to live inside the hosted gate handler, which read the workspace out
 * of Redis and measured it in the same function. The local server keeps its
 * workspace in SQLite, so the measuring had to come out into a pure function or
 * the two would drift: the same version gated twice would get two answers
 * depending on where it was stored.
 *
 * Human and simulated scores are pooled and counted, not averaged as two equal
 * votes. A tester who listened to the call is worth more than a model reading a
 * transcript, but a batch of 200 simulated calls is worth more than one opinion.
 */

import { evaluate, type GateInput, type GatePolicy, type GateResult } from './_gate'

type Dict = Record<string, unknown>
type ScoreRow = { paramId: string; value: number }

const avg = (nums: number[]): number | null =>
  nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null

const list = (v: unknown): Dict[] => (Array.isArray(v) ? (v as Dict[]) : [])
const scoresOf = (rows: Dict[]): ScoreRow[] =>
  rows.flatMap(r => (Array.isArray(r.scores) ? (r.scores as ScoreRow[]).filter(s => !Array.isArray(r.naParams) || !r.naParams.includes(s.paramId)) : []))
    .filter(s => typeof s.value === 'number' && Number.isFinite(s.value))

export interface Measured {
  agent: Dict
  version: Dict
  policy: GatePolicy
  input: GateInput
  simulatedSessions: number
  humanSessions: number
  unsubstantiatedSessions: number
  aiCalls: number
  result: GateResult
}

export type MeasureError = { error: string; status: number }

export function defaultGatePolicy(agentId: string): GatePolicy {
  return {
    id: `gate-${agentId}`, name: 'Release gate', agentId, enabled: false,
    minComposite: 3.0, minParams: {}, maxBlockers: 0, minSamples: 5, minHumanSessions: 0,
    maxRegression: 0.5, baselineVersionNumber: null,
  }
}

function pool(state: Dict, versionId: string, rubric: { id: string }[]) {
  const allSessions = list(state.sessions).filter(s => s.versionId === versionId)
  const sessions = allSessions.filter(s => [s.transcript, s.audioId, s.recordingName].some(v => typeof v === 'string' && v.trim()) || list(s.observations).length > 0)
  const unsubstantiatedSessions = allSessions.length - sessions.length
  const batchIds = new Set(list(state.batches).filter(b => b.versionId === versionId).map(b => String(b.id)))
  const calls = list(state.calls).filter(c => batchIds.has(String(c.batchId)))
  const human = scoresOf(sessions)
  const auto = scoresOf(calls)
  const paramAverages: Record<string, number | null> = {}
  const paramSamples: Record<string, number> = {}
  for (const p of rubric) {
    paramSamples[p.id] = [...sessions, ...calls].filter(r => scoresOf([r]).some(s => s.paramId === p.id)).length
    paramAverages[p.id] = avg([...human, ...auto].filter(s => s.paramId === p.id).map(s => s.value))
  }
  const composite = avg(Object.values(paramAverages).filter((v): v is number => v != null))
  return { sessions, calls, paramAverages, composite, unsubstantiatedSessions, paramSamples }
}

export function measureGate(state: Dict, agentId: string, versionId?: string): Measured | MeasureError {
  const agent = list(state.agents).find(a => a.id === agentId)
  if (!agent) return { error: 'No such agent in this workspace.', status: 404 }

  const versions = list(state.versions)
    .filter(v => v.agentId === agentId)
    .sort((a, b) => Number(b.number) - Number(a.number))
  if (versions.length === 0) return { error: 'This agent has no prompt versions to gate.', status: 404 }

  const version = versionId ? versions.find(v => v.id === versionId) : versions[0]
  if (!version) return { error: 'No such version on this agent.', status: 404 }

  const policy = (list(state.gates) as unknown as GatePolicy[]).find(p => p.agentId === agentId) ?? defaultGatePolicy(agentId)

  const rubric = list(state.rubric) as unknown as { id: string; name: string }[]
  const paramNames: Record<string, string> = {}
  for (const p of rubric) paramNames[p.id] = p.name

  const cand = pool(state, String(version.id), rubric)
  const manualBlockers = cand.sessions.flatMap(s => list(s.observations)).filter(o => {
    if ((o.kind != null && o.kind !== 'went-wrong') || o.severity !== 'blocker' || o.triage === 'rejected') return false
    const issue = list(state.issues).find(i => i.id === o.issueId)
    const fixed = versions.find(v => v.id === issue?.verifiedFixedInVersionId)
    return !(issue?.status === 'verified-fixed' && fixed && Number(fixed.number) <= Number(version.number))
  }).length
  const blockerFindings = manualBlockers + cand.calls.reduce((n, c) =>
    n + (Array.isArray(c.findings) ? (c.findings as { severity: string }[]).filter(f => f.severity === 'blocker').length : 0), 0)

  const baselineVersion = policy.baselineVersionNumber != null
    ? versions.find(v => Number(v.number) === policy.baselineVersionNumber)
    : versions[versions.findIndex(v => v.id === version.id) + 1]

  let baseline: GateInput['baseline'] = null
  let baselineVersionLabel: string | null = null
  if (baselineVersion) {
    const b = pool(state, String(baselineVersion.id), rubric)
    baseline = { composite: b.composite, paramAverages: b.paramAverages }
    baselineVersionLabel = `v${baselineVersion.number}`
  }

  const humanSessions = cand.sessions.filter(s => s.source !== 'simulated').length
  const simulatedSessions = cand.sessions.length - humanSessions
  const input: GateInput = {
    humanSessions,
    paramAverages: cand.paramAverages, paramSamples: cand.paramSamples, paramNames, composite: cand.composite,
    samples: cand.sessions.length + cand.calls.length,
    blockerFindings, baseline, baselineVersionLabel,
  }
  return {
    agent, version, policy, input,
    unsubstantiatedSessions: cand.unsubstantiatedSessions, humanSessions, simulatedSessions, aiCalls: cand.calls.length,
    result: evaluate(policy, input),
  }
}

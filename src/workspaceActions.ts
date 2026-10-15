import type { AppState, Agent, RubricParam, Observation } from './types'
export function replyToClarification(note: Observation, reply: string): boolean {
  if (note.triage !== 'needs-clarification' || !reply.trim()) return false
  note.triageNote += `\nReply: ${reply.trim()}`
  note.triage = 'untriaged'
  return true
}
export function toggleParameter(agent: Agent, rubric: RubricParam[], id: string): boolean {
  const all = rubric.filter(r => r.appliesTo.includes(agent.type)).map(r => r.id)
  const current = agent.paramIds?.length ? agent.paramIds : all
  const next = current.includes(id) ? current.filter(x => x !== id) : [...current, id]
  if (!next.length) return false
  agent.paramIds = next.length === all.length ? undefined : next
  return true
}
export function deleteScenario(state: AppState, id: string) {
  const scenario = state.scenarios.find(s => s.id === id)
  if (!scenario) return
  const agent = state.agents.find(a => a.id === scenario.agentId)
  if (agent) agent.useCases = agent.useCases.filter(n => n !== scenario.name)
  state.scenarios = state.scenarios.filter(s => s.id !== id)
}
export function deleteProject(state: AppState, id: string) {
  const agents = new Set(state.agents.filter(a => a.projectId === id).map(a => a.id))
  const batches = new Set((state.batches ?? []).filter(b => agents.has(b.agentId)).map(b => b.id))
  state.projects = state.projects.filter(p => p.id !== id)
  state.agents = state.agents.filter(a => !agents.has(a.id))
  state.versions = state.versions.filter(v => !agents.has(v.agentId))
  state.sessions = state.sessions.filter(s => !agents.has(s.agentId))
  state.issues = state.issues.filter(i => i.projectId !== id)
  state.scenarios = (state.scenarios ?? []).filter(s => !agents.has(s.agentId))
  state.batches = (state.batches ?? []).filter(b => !agents.has(b.agentId))
  state.calls = (state.calls ?? []).filter(c => !batches.has(c.batchId))
  state.gates = (state.gates ?? []).filter(g => !agents.has(g.agentId))
}

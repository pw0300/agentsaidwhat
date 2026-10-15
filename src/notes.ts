import type { AppState, Agent, Observation, RubricParam, Scenario } from './types'

/**
 * A note that should be triaged. Notes logged before `kind` existed were all
 * problems, so a missing kind counts as one. "Went well" notes are evidence,
 * not defects, and never enter the triage queue.
 */
export const isProblem = (o: Observation): boolean => o.kind !== 'went-well'

/** The parameters this agent is scored on: its own list, or every one for its type. */
export function paramsFor(state: AppState, agent: Agent): RubricParam[] {
  const forType = state.rubric.filter(p => p.appliesTo.includes(agent.type))
  if (!agent.paramIds?.length) return forType
  const chosen = new Set(agent.paramIds)
  return forType.filter(p => chosen.has(p.id))
}

/** Scenarios a tester can pick for this agent: approved first, then their own proposals. */
export function scenariosFor(state: AppState, agentId: string, tester?: string): Scenario[] {
  return (state.scenarios ?? [])
    .filter(s => s.agentId === agentId && (s.status === 'approved' || (s.status === 'proposed' && (!tester || s.proposedBy === tester))))
    .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'approved' ? -1 : 1))
}

export const untriagedCount = (state: AppState, agentIds?: Set<string>): number =>
  state.sessions
    .filter(s => !agentIds || agentIds.has(s.agentId))
    .flatMap(s => s.observations)
    .filter(o => isProblem(o) && o.triage === 'untriaged').length

import { capabilityCheck, type AgentAdapter, type Check } from './_adapter'
import { driveCaller, type DrivenScenario, type DrivenTurn } from './_caller-driver'
import { judgeOne, isVerdict, type ProviderId } from './_judge'
import { selectJudges } from './_judgepanel'

export function timingCheck(adapter: AgentAdapter, turns: DrivenTurn[]): Check {
  return capabilityCheck(adapter, ['timing'], 'Timing', () => {
    const agents = turns.filter(t => t.role === 'agent')
    if (!agents.length || agents.some(t => t.startMs === undefined || t.endMs === undefined || t.firstByteMs === undefined)) return { name: 'Timing', outcome: 'NOT MEASURED', detail: 'Complete turn timing evidence is missing.' }
    return { name: 'Timing', outcome: 'PASS', detail: `${agents.length} turns have timing evidence. This checks evidence completeness, not voice latency quality.` }
  })
}
export async function scoreCall(adapter: AgentAdapter, scenario: DrivenScenario, turns: DrivenTurn[], transcript: string): Promise<Check[]> {
  const replies = turns.filter(t => t.role === 'agent')
  const checks: Check[] = [{ name: 'Responses', outcome: replies.length && replies.every(t => t.text.trim()) ? 'PASS' : 'FAIL', detail: `${replies.length} agent replies; checks non-empty text only.` }, timingCheck(adapter, turns)]
  const responseText = replies.map(t => t.text).join('\n').toLowerCase()
  const deterministic = scenario.successCriteria.filter(c => /^(contains|notContains):\s*\S/i.test(c))
  for (const criterion of deterministic) {
    const [kind, ...rest] = criterion.split(':')
    const found = responseText.includes(rest.join(':').trim().toLowerCase())
    checks.push({ name: criterion, outcome: (kind.toLowerCase() === 'contains' ? found : !found) ? 'PASS' : 'FAIL', detail: 'Literal text assertion on agent replies only.' })
  }
  if (deterministic.length === scenario.successCriteria.length) {
    checks.push({ name: 'Goal and criteria', outcome: checks.some(c => c.outcome === 'FAIL') ? 'FAIL' : 'PASS', detail: 'All criteria are explicit literal assertions. Does not establish semantic goal achievement.' })
    return checks
  }
  const providers = selectJudges() as ProviderId[]
  if (!providers.length) checks.push({ name: 'Goal and criteria', outcome: 'NOT MEASURED', detail: 'No LLM judge key is configured.' })
  else {
    const panel = await Promise.all(providers.map(p => judgeOne(p,
      'Judge only the agent transcript against the goal and success criteria. Do not infer audio quality or timing. Return JSON: {"verdict":"pass|fail","reason":"evidence and explanation","layer":"prompt","flags":[]}.',
      `Persona: ${scenario.persona}\nGoal: ${scenario.goal}\nCriteria: ${scenario.successCriteria.join('\n')}\nTranscript:\n${transcript}`)))
    const votes = panel.filter(isVerdict)
    const complete = votes.length === providers.length
    const same = new Set(votes.map(v => v.verdict)).size === 1
    checks.push({ name: 'Goal and criteria', outcome: complete && same ? votes[0].verdict === 'pass' ? 'PASS' : 'FAIL' : 'NOT MEASURED', detail: votes.map(v => `${v.provider}: ${v.reason}`).join('; ') || 'No judge returned a usable verdict.' })
  }
  return checks
}
export async function runScenario(adapter: AgentAdapter, scenario: DrivenScenario, version: string, mode: 'scripted' | 'simulated', notice: (s: string) => void) {
  const call = await driveCaller(adapter, scenario, version, mode, 12, notice)
  const checks = await scoreCall(adapter, scenario, call.turns, call.transcript)
  if (call.hitTurnLimit) checks.push({ name: 'Turn budget', outcome: 'NOT MEASURED', detail: 'Simulated caller reached the turn limit before completing.' })
  // Optional voice metrics do not prevent a text run passing, but the goal
  // must be measured before the overall call can pass.
  const outcome = checks.some(c => c.outcome === 'FAIL') ? 'fail' : checks.some(c => c.name !== 'Timing' && c.outcome === 'NOT MEASURED') ? 'inconclusive' : 'pass'
  return { scenarioId: scenario.id, name: scenario.name, adapter: { ...adapter.metadata, capabilities: [...adapter.capabilities] }, ...call, checks, outcome }
}

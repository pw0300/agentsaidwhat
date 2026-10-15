import { loadScenarioPack, type PackScenario, type ScenarioPack } from './_scenariopack'
import { buildRequest, extractText, type ProviderId } from './_judge'
import { selectJudges } from './_judgepanel'
import { customerSystemPrompt, toTranscript, type Scenario } from './_simulate'
import { redact } from './_redact'
import type { AgentAdapter, AgentTurn } from './_adapter'

export type DrivenScenario = PackScenario & { callerTurns?: string[] }
/** The pack loader owns parsing and validation. This compatibility bridge
 * retains optional JSON extension fields until the shared loader retains them.
 * It is not a YAML parser; YAML callers use the loader's returned extensions.
 */
export function loadDrivenPack(text: string, file: string): ScenarioPack & { scenarios: DrivenScenario[] } {
  const pack = loadScenarioPack(text, file)
  let extensions: { scenarios?: DrivenScenario[] } = {}
  try { extensions = JSON.parse(text) } catch { /* Shared loader handles YAML. */ }
  return { ...pack, scenarios: pack.scenarios.map(s => {
    const turns = (s as DrivenScenario).callerTurns ?? extensions.scenarios?.find(x => x.id === s.id)?.callerTurns
    if (turns !== undefined && (!Array.isArray(turns) || !turns.length || turns.some(t => typeof t !== 'string' || !t.trim()))) {
      throw new Error(`${file}: ${s.id}.callerTurns must be a non-empty array of strings.`)
    }
    return { ...s, callerTurns: turns }
  }) }
}

export interface DrivenTurn extends AgentTurn { role: 'caller' | 'agent' }
export function simulationScenario(s: DrivenScenario): Scenario {
  return { id: s.id, name: s.name, intent: s.successCriteria.join('\n'), context: `${s.persona}\nGoal: ${s.goal}`, behaviour: {}, difficulty: 'baseline', language: s.language === 'hi' || s.language === 'hinglish' ? s.language : 'en' }
}
async function caller(provider: ProviderId, s: DrivenScenario, turns: DrivenTurn[]): Promise<string> {
  const request = buildRequest(provider, customerSystemPrompt('agent under test', simulationScenario(s)) + '\nReturn only your next spoken turn. Return [DONE] when the goal is complete.', redact(toTranscript('agent', turns) || 'Begin the call.').text, 400)
  const response = await fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Caller model request failed (${response.status}).`)
  const text = extractText(provider, await response.json()).trim().replace(/^(caller|customer):\s*/i, '')
  if (!text) throw new Error('Caller model returned no text.')
  return text
}
export async function driveCaller(adapter: AgentAdapter, scenario: DrivenScenario, version: string, mode: 'scripted' | 'simulated', maxTurns = 12, notice: (text: string) => void = () => {}) {
  const provider = selectJudges()[0] as ProviderId | undefined
  if (mode === 'simulated' && !provider) {
    notice('No LLM key is configured; using scripted caller turns when available.')
    mode = 'scripted'
  }
  if (mode === 'scripted' && !scenario.callerTurns?.length) throw new Error(`${scenario.name}: no callerTurns and no usable simulated caller. Add callerTurns or set a supported LLM key.`)
  const turns: DrivenTurn[] = []
  let hitTurnLimit = false
  try {
    await adapter.open({ id: crypto.randomUUID(), scenarioId: scenario.id, version })
    const count = mode === 'scripted' ? scenario.callerTurns!.length : maxTurns
    for (let i = 0; i < count; i++) {
      const text = mode === 'scripted' ? scenario.callerTurns![i] : await caller(provider!, scenario, turns)
      if (text === '[DONE]' && mode === 'simulated') break
      turns.push({ role: 'caller', text })
      turns.push({ role: 'agent', ...await adapter.send({ text }) })
      if (mode === 'simulated' && i === count - 1) hitTurnLimit = true
    }
  } finally { await adapter.close() }
  return { turns, transcript: toTranscript('agent', turns), hitTurnLimit, mode }
}

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { openStore } from './local.mjs'
import { loadDrivenPack, runScenario, wsAdapter, httpAdapter, vapiAdapter, retellAdapter } from '../dist-server/lib.mjs'

// AGENT_QA_* variables and agent-qa-data remain stable for existing runner setups.
export async function runPack({ file, agent, version, mode = 'scripted', home = process.env.AGENT_QA_HOME ?? resolve('agent-qa-data'), notice = console.error }) {
  if (!file || !agent || !version || !/^v[1-9]\d*$/.test(version)) throw new Error('Use run <pack> --agent <url> --version v<number>.')
  if (!['scripted', 'simulated'].includes(mode)) throw new Error('--mode must be scripted or simulated.')
  const url = new URL(agent)
  if (url.username || url.password) throw new Error('Credentials must come from environment variables, never the agent URL.')
  let createAdapter = ['ws:', 'wss:'].includes(url.protocol) ? wsAdapter : ['http:', 'https:'].includes(url.protocol) ? httpAdapter : null
  if (url.protocol === 'vapi:') createAdapter = () => vapiAdapter(url.hostname)
  if (url.protocol === 'retell:') createAdapter = () => retellAdapter(url.hostname)
  if (['pipecat:', 'livekit:'].includes(url.protocol)) {
    if (!process.env.AGENT_QA_ADAPTER_MODULE) throw new Error('Set AGENT_QA_ADAPTER_MODULE to an SDK bridge module exporting createAdapter(url).')
    const bridge = await import(pathToFileURL(resolve(process.env.AGENT_QA_ADAPTER_MODULE)).href)
    createAdapter = bridge.createAdapter
  }
  if (typeof createAdapter !== 'function') throw new Error('Unsupported agent URL or missing adapter factory.')
  const pack = loadDrivenPack(await readFile(file, 'utf8'), file)
  const results = []
  let warned = false
  for (const scenario of pack.scenarios) {
    try {
      results.push(await runScenario(createAdapter(agent), scenario, version, mode, text => { if (!warned) { notice(text); warned = true } }))
    } catch {
      results.push({ scenarioId: scenario.id, name: scenario.name, outcome: 'inconclusive', transcript: '', checks: [{ name: 'Call', outcome: 'NOT MEASURED', detail: scenario.callerTurns?.length ? 'Call could not complete. Check the agent protocol, availability and model configuration.' : 'No callerTurns are available. Use simulated mode with a supported LLM key or add callerTurns.' }] })
    }
  }
  const store = openStore(home)
  try {
    const { state, rev } = store.read()
    for (const k of ['projects', 'agents', 'versions', 'sessions', 'issues', 'rubric', 'testers', 'batches', 'calls', 'scenarios']) state[k] ??= []
    const agentId = `adapter-${createHash('sha256').update(agent).digest('hex').slice(0, 16)}`
    const versionId = `${agentId}-${version}`
    const createdAt = new Date().toISOString()
    if (!state.projects.some(p => p.id === 'adapter-project')) state.projects.push({ id: 'adapter-project', name: 'Connected agents' })
    if (!state.agents.some(a => a.id === agentId)) state.agents.push({ id: agentId, projectId: 'adapter-project', name: agent, type: 'voice', direction: 'inbound', useCases: [] })
    if (!state.versions.some(v => v.id === versionId)) state.versions.push({ id: versionId, agentId, number: Number(version.slice(1)), promptText: '', changelog: 'External agent adapter run', status: 'testing', createdAt, decisions: [] })
    const parameters = [{ id: 'adapter-responses', name: 'Response presence', question: 'Did every caller turn receive non-empty text?' }, { id: 'adapter-goal', name: 'Scenario goal', question: 'Did the judge confirm the scenario goal and criteria?' }]
    for (const p of parameters) if (!state.rubric.some(r => r.id === p.id)) state.rubric.push({ ...p, appliesTo: ['voice', 'chatbot'], anchors: { 1: 'Failed', 3: 'Partial', 5: 'Passed' } })
    for (const result of results) {
      const scenario = pack.scenarios.find(s => s.id === result.scenarioId)
      const scenarioId = `${agentId}-${pack.id}-${scenario.id}`
      if (!state.scenarios.some(s => s.id === scenarioId)) state.scenarios.push({ ...scenario, id: scenarioId, agentId, successCriteria: scenario.successCriteria.join('\n'), status: 'approved', proposedBy: 'saidwhat run', createdAt })
      const scores = [['Responses', parameters[0]], ['Goal and criteria', parameters[1]]].flatMap(([name, p]) => {
        const check = result.checks.find(c => c.name === name)
        return check && check.outcome !== 'NOT MEASURED' ? [{ paramId: p.id, paramName: p.name, value: check.outcome === 'PASS' ? 5 : 1 }] : []
      })
      state.sessions.push({ id: randomUUID(), agentId, versionId, tester: 'Simulated caller (saidwhat run)', useCase: result.name, scenarioId, transcript: result.transcript, recordingName: '', scores, comments: result.checks.map(c => `${c.name}: ${c.outcome}. ${c.detail}`).join('\n'), createdAt, observations: [], source: 'simulated', adapterResult: result })
    }
    if (store.write(state, rev) === null) throw new Error('Workspace changed while saving. Retry the run.')
    store.audit('adapter-run', versionId, { pack: pack.id, count: results.length })
    return { pack: pack.id, agentId, versionId, results, outcome: results.some(r => r.outcome === 'fail') ? 'fail' : results.some(r => r.outcome === 'inconclusive') ? 'inconclusive' : 'pass' }
  } finally { store.db.close() }
}

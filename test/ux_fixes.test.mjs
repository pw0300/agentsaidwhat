import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { startReferenceAgent } from '../examples/reference-agent/server.mjs'
import { build } from 'esbuild'
const source = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8')
async function moduleAt(file) {
  const result = await build({ entryPoints: [file], bundle: true, write: false, format: 'esm', platform: 'node' })
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
}
test('H1 drawer records all verification verdicts, note and tested version', async () => {
  const text = source('src/IssueDrawer.tsx')
  for (const label of ['Version tested', 'Verification note', 'Record verification']) assert.ok(text.includes(label), label)
  const { recordVerification } = await moduleAt('src/issueActions.ts')
  for (const verdict of ['fixed', 'not-fixed', 'partial']) {
    const issue = { status: 'claimed-fixed', verifications: [], verifiedFixedInVersionId: null }
    recordVerification(issue, { versionId: 'v2', tester: 'Alice', verdict, note: 'Replayed call', createdAt: '2026-10-14' })
    assert.equal(issue.status, verdict === 'fixed' ? 'verified-fixed' : 'reopened')
    assert.equal(issue.verifiedFixedInVersionId, verdict === 'fixed' ? 'v2' : null)
    assert.equal(issue.verifications[0].note, 'Replayed call')
  }
})
test('H2 H6 ownership is editable and all promised layers route to server owners', async () => {
  const { LAYER_TEAM, LAYER_FIRST_CHECK, toFailureLayer } = await moduleAt('src/types.ts')
  const { LAYER_OWNER } = await moduleAt('api/_voicebench.ts')
  for (const layer of ['asr', 'llm', 'vad', 'telecom']) {
    assert.equal(LAYER_TEAM[layer], LAYER_OWNER[layer])
    assert.ok(LAYER_FIRST_CHECK[layer])
    assert.equal(toFailureLayer(layer), layer)
  }
  assert.equal(LAYER_TEAM['voice-tts'], LAYER_OWNER.tts)
  assert.equal(toFailureLayer('platform'), 'telecom')
  assert.equal(toFailureLayer('speech recognition'), 'asr')
  for (const label of ['Owner team', 'Owner person', 'Failure layer']) assert.ok(source('src/IssueDrawer.tsx').includes(label))
})
test('H3 ship7 gate measures the workspace and bundles committed evidence', async () => {
  const page = source('src/GatePage.tsx')
  assert.match(page, /measureGate\(/)
  for (const label of ['Choose agent', 'Choose version', 'Minimum samples', 'Maximum blockers', 'Maximum regression', 'Minimum composite']) assert.ok(page.includes(label), label)
  assert.doesNotMatch(page, /get\('\/data\//)
  assert.match(source('src/gateArtifacts.ts'), /asr_verdict.json/)
  const { measureGate, defaultGatePolicy } = await moduleAt('api/_measure.ts')
  const state = { agents: [{id:'a'}], versions: [{id:'v',agentId:'a',number:1}], rubric:[{id:'r',name:'Quality'}], sessions:[], gates:[{...defaultGatePolicy('a'),enabled:true}] }
  assert.equal(measureGate(state,'a','v').result.outcome, 'inconclusive')
  // Each session carries a transcript: ratings with no evidence are unsubstantiated and never count toward a pass.
  state.sessions = Array.from({length:5}, (_, i) => ({id:`s${i}`,versionId:'v',transcript:'Agent: hello\nCaller: hi',scores:[{paramId:'r',value:4}]}))
  assert.equal(measureGate(state,'a','v').result.outcome, 'pass')
  state.gates[0].minComposite = 5
  assert.equal(measureGate(state,'a','v').result.outcome, 'fail')
})

test('H4 backup keeps metadata but removes nonportable audio references and offers recording downloads', async () => {
  const { portableBackup } = await moduleAt('src/backup.ts')
  const original = { sessions: [{id:'s', audioId:'old-server', recordingName:'call.wav'}] }
  const exported = portableBackup(original)
  assert.equal(exported.sessions[0].audioId, undefined)
  assert.equal(exported.sessions[0].recordingName, 'call.wav')
  assert.equal(original.sessions[0].audioId, 'old-server')
  assert.match(source('src/Settings.tsx'), /Export recordings separately/)
  assert.match(source('src/Settings.tsx'), /Recordings are not included/)
})

test('H5 invalid backups fail before mutation and legacy arrays are normalized', async () => {
  const { parseBackup } = await moduleAt('src/backup.ts')
  for (const bad of [null, [], {projects:{},rubric:[]}, {projects:[],rubric:[]}, {projects:[],agents:[null],versions:[],sessions:[],issues:[],rubric:[],testers:[]}]) {
    assert.throws(() => parseBackup(JSON.stringify(bad)), /Invalid backup/)
  }
  const old = {projects:[],agents:[],versions:[],sessions:[],issues:[],rubric:[],testers:[]}
  assert.deepEqual(parseBackup(JSON.stringify(old)).scenarios, [])
  for (const patch of [{sessions:[{id:'s'}]}, {rubric:[{id:'r',name:'Rating',question:'q',appliesTo:null,anchors:{}}]}, {gates:[{id:'g'}]}]) {
    assert.throws(() => parseBackup(JSON.stringify({...old,...patch})), /Invalid backup/)
  }
  assert.match(source('src/Settings.tsx'), /parseBackup\(txt\)/)
})

test('M1 clarification replies return the finding to triage with review history', async () => {
  const { replyToClarification } = await moduleAt('src/workspaceActions.ts')
  const note = {triage:'needs-clarification',triageNote:'Which phrase?',whatHappened:'Wrong answer'}
  assert.equal(replyToClarification(note, '  '), false)
  assert.equal(replyToClarification(note, 'The price quote'), true)
  assert.equal(note.triage, 'untriaged')
  assert.match(note.triageNote, /Which phrase.*Reply: The price quote/s)
  assert.match(source('src/Calls.tsx'), /Reply and return to triage/)
})
test('M2 last rubric parameter cannot be unticked', async () => {
  const { toggleParameter } = await moduleAt('src/workspaceActions.ts')
  const agent = {type:'voice',paramIds:['a']}
  const rubric = [{id:'a',appliesTo:['voice']},{id:'b',appliesTo:['voice']}]
  assert.equal(toggleParameter(agent,rubric,'a'), false)
  assert.deepEqual(agent.paramIds,['a'])
  assert.equal(toggleParameter(agent,rubric,'b'), true)
  assert.equal(agent.paramIds,undefined)
  assert.match(source('src/Settings.tsx'), /Keep at least one rubric parameter/)
})
test('M3 deleted starting scenario remains deleted after migration', async () => {
  const { migrateScenarios } = await moduleAt('src/data.ts')
  const { deleteScenario } = await moduleAt('src/workspaceActions.ts')
  const state = {agents:[{id:'a',useCases:['Original']}],scenarios:[]}
  migrateScenarios(state)
  deleteScenario(state,state.scenarios[0].id)
  migrateScenarios(state)
  assert.deepEqual(state.scenarios,[])
})
test('M4 non-Latin starting scenario IDs are distinct and deterministic', async () => {
  const { migrateScenarios } = await moduleAt('src/data.ts')
  const state = {agents:[{id:'a',useCases:['\u0928\u092e\u0938\u094d\u0924\u0947','\u0936\u0941\u0915\u094d\u0930\u093f\u092f\u093e']}],scenarios:[]}
  const other = structuredClone(state)
  migrateScenarios(state); migrateScenarios(other)
  assert.equal(state.scenarios.length,2)
  assert.equal(new Set(state.scenarios.map(s=>s.id)).size,2)
  assert.deepEqual(state.scenarios.map(s=>s.id),other.scenarios.map(s=>s.id))
})
test('M5 deleting a project removes its scenarios and automated evidence only', async () => {
  const { deleteProject } = await moduleAt('src/workspaceActions.ts')
  const state = {projects:[{id:'p'},{id:'q'}],agents:[{id:'a',projectId:'p'},{id:'b',projectId:'q'}],scenarios:[{agentId:'a'},{agentId:'b'}],versions:[],sessions:[],issues:[],batches:[{id:'batch',agentId:'a'}],calls:[{batchId:'batch'}],gates:[{agentId:'a'}]}
  deleteProject(state,'p')
  assert.deepEqual(state.scenarios,[{agentId:'b'}])
  assert.deepEqual(state.calls,[])
  assert.deepEqual(state.gates,[])
})

const cliFile = fileURLToPath(new URL('../cli.mjs', import.meta.url))
function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliFile, ...args], {cwd, env:{...process.env,AGENT_QA_HOME:join(cwd,'home')}})
    let stdout='', stderr=''
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c)
    child.on('error', reject); child.on('close', code => resolve({code,stdout,stderr}))
  })
}
test('ship6 CLI finds bundled packs from an empty consumer cwd and honors cwd files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'saidwhat-bundled-'))
  const agent = await startReferenceAgent(0)
  try {
    const args = ['run','examples/reference-agent/scenarios.yaml','--agent',`http://127.0.0.1:${agent.port}/turn`,'--version','v3','--json']
    const bundled = await runCli(args, cwd)
    assert.equal(bundled.code,0,bundled.stderr)
    assert.equal(JSON.parse(bundled.stdout).pack,'reference-smoke')
    const hinglish = await runCli(['run','scenarios/hinglish-support.yaml','--agent',`http://127.0.0.1:${agent.port}/turn`,'--version','v3','--json'],cwd)
    assert.equal(hinglish.code,2,hinglish.stderr)
    assert.equal(JSON.parse(hinglish.stdout).pack,'hinglish-support')
    const localPack = join(cwd,'examples','reference-agent')
    await mkdir(localPack,{recursive:true})
    const override = source('examples/reference-agent/scenarios.yaml').replace('id: reference-smoke','id: consumer-override')
    await writeFile(join(localPack,'scenarios.yaml'),override)
    const preferred = await runCli(args,cwd)
    assert.equal(preferred.code,0,preferred.stderr)
    assert.equal(JSON.parse(preferred.stdout).pack,'consumer-override')
    const missing = await runCli(['run','scenarios/missing.yaml','--agent',`http://127.0.0.1:${agent.port}/turn`,'--version','v3'],cwd)
    assert.equal(missing.code,2)
    await writeFile(join(cwd,'custom.yaml'), 'version: 1\nid: own\nname: Own\nscenarios: []')
    const custom = await runCli(['run','custom.yaml','--agent',`http://127.0.0.1:${agent.port}/turn`,'--version','v3'],cwd)
    assert.doesNotMatch(custom.stderr,/ENOENT/)
    assert.match(source('README.md'), /relative to the installed package/)
  } finally { await agent.close(); await rm(cwd,{recursive:true,force:true}) }
})

test('ship10 ship12 guides describe shipped YAML adapters and demo copy limits text evidence', () => {
  const guide = source('docs/AUTOMATED-RUNS.md')
  assert.match(guide,/\]\(ADAPTERS.md\)/)
  assert.doesNotMatch(guide,/placeholder|not implemented|intentionally pending/)
  assert.match(source('docs/ADAPTERS.md'),/native YAML and JSON/)
  assert.doesNotMatch(source('docs/ADAPTERS.md'),/does not implement YAML parsing/)
  const demo = source('src/SimulationBench.tsx')
  assert.doesNotMatch(demo,/Tests barge-in handling|single most common cause|highest-frequency real failure|survives production/)
  assert.match(demo,/Audio, interruption timing and production reliability are NOT MEASURED/)
})

test('adapters Vapi Retell Pipecat and LiveKit are explicitly experimental in docs and UI labels', async () => {
  const { adapterLabel } = await moduleAt('src/adapters.ts')
  for (const platform of ['Vapi','Retell','Pipecat','LiveKit']) {
    assert.match(adapterLabel(`${platform.toLowerCase()}://agent`), /experimental/)
    assert.ok(source('docs/ADAPTERS.md').includes(`| ${platform} (experimental) |`))
  }
  assert.equal(adapterLabel('My own agent'),'My own agent')
  assert.match(source('README.md'),/Vapi, Retell, Pipecat and LiveKit adapters are experimental/)
  assert.match(source('src/Settings.tsx'),/adapterLabel\(a.name\)/)
})

test('H5 current demo workspace survives a validated JSON backup round trip', async () => {
  const { parseBackup, portableBackup } = await moduleAt('src/backup.ts')
  const { demoState } = await moduleAt('src/demo.ts')
  const { defaultRubric } = await moduleAt('src/data.ts')
  const state = demoState({projects:[],agents:[],versions:[],sessions:[],issues:[],rubric:defaultRubric,testers:[],batches:[],calls:[],scenarios:[]})
  const restored = parseBackup(JSON.stringify(portableBackup(state)))
  assert.equal(restored.sessions.length,state.sessions.length)
  assert.equal(restored.agents.length,state.agents.length)
})
test('H3 release page renders a workspace decision alongside bundled artifact provenance', async () => {
  const outfile = fileURLToPath(new URL('../node_modules/.tmp/ux-fixes-render.mjs',import.meta.url))
  await build({stdin:{contents:`import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import GatePage from './src/GatePage'; import {StoreContext} from './src/store'; export function render(state) { return renderToStaticMarkup(React.createElement(StoreContext.Provider,{value:{state,mutate:()=>{},sync:{status:'local-only'}}},React.createElement(GatePage))); }`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,format:'esm',platform:'node',packages:'external',outfile})
  const {render} = await import(new URL('../node_modules/.tmp/ux-fixes-render.mjs',import.meta.url))
  const { defaultGatePolicy } = await moduleAt('api/_measure.ts')
  const state = {projects:[],agents:[{id:'a',name:'Agent'}],versions:[{id:'v',agentId:'a',number:1}],rubric:[{id:'r',name:'Quality'}],sessions:[],gates:[{...defaultGatePolicy('a'),enabled:true}]}
  const html = render(state)
  assert.match(html,/INCONCLUSIVE/)
  assert.match(html,/faster-whisper large-v3/)
  assert.match(html,/6 Indic DiarBench recordings/)
  assert.match(html,/100 SOMOS clips/)
  assert.doesNotMatch(html,/Nothing has been measured yet/)
})

test('H3 optional audit evidence is included when present at build time', async () => {
  const { build: viteBuild } = await import('vite')
  const fixture = await mkdtemp(join(tmpdir(),'qa-artifact-build-'))
  try {
    await mkdir(join(fixture,'src'),{recursive:true})
    await mkdir(join(fixture,'data','voice_probe'),{recursive:true})
    await writeFile(join(fixture,'src','gateArtifacts.ts'),source('src/gateArtifacts.ts'))
    await writeFile(join(fixture,'data','asr_verdict.json'),source('data/asr_verdict.json'))
    await writeFile(join(fixture,'data','voice_probe','calibration_verdict.json'),source('data/voice_probe/calibration_verdict.json'))
    await writeFile(join(fixture,'data','evidence.json'),JSON.stringify({candidate:'audit-evidence-regression-marker',measurements:{bargeIn:{stopLatencyMs:120}}}))
    const output = await viteBuild({configFile:false,root:fixture,logLevel:'silent',build:{write:false,lib:{entry:join(fixture,'src','gateArtifacts.ts'),formats:['es']}}})
    assert.match((Array.isArray(output) ? output : [output]).flatMap(r=>r.output).map(c=>c.code??'').join(''),/audit-evidence-regression-marker/)
  } finally { await rm(fixture,{recursive:true,force:true}) }
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { start } from '../server/local.mjs'
const schema = JSON.parse(readFileSync(new URL('../docs/schemas/gate-result.v1.json', import.meta.url)))
function validate(s, v, path = '$') {
  if (s.type) {
    const kinds = Array.isArray(s.type) ? s.type : [s.type]
    assert.ok(kinds.some(k => k === 'null' ? v === null : k === 'array' ? Array.isArray(v) : k === 'integer' ? Number.isInteger(v) : k === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : typeof v === k), path)
  }
  if (s.enum) assert.ok(s.enum.includes(v), path)
  if ('const' in s) assert.equal(v, s.const, path)
  if (s.minimum !== undefined) assert.ok(v >= s.minimum, path)
  if (s.pattern) assert.match(v, new RegExp(s.pattern), path)
  if (s.format === 'date-time') assert.ok(Number.isFinite(Date.parse(v)), path)
  for (const key of s.required ?? []) assert.ok(Object.hasOwn(v, key), `${path}.${key}`)
  for (const [key, value] of Object.entries(v ?? {})) {
    if (s.properties?.[key]) validate(s.properties[key], value, `${path}.${key}`)
    else if (s.additionalProperties && typeof s.additionalProperties === 'object') validate(s.additionalProperties, value, `${path}.${key}`)
  }
  if (s.items) v.forEach((x, i) => validate(s.items, x, `${path}[${i}]`))
  if (s.anyOf) assert.ok(s.anyOf.some(branch => { try { validate(branch, v, path); return true } catch { return false } }), path)
}
const state = {
  agents: [{id:'a', name:'Fixture', type:'voice'}],
  versions: [{id:'v',agentId:'a',number:1,promptText:'Hello',changelog:''}],
  sessions: [
    { id:'human',versionId:'v',transcript:'human evidence',scores:[{paramId:'accuracy',value:5}],observations:[{kind:'went-wrong',severity:'blocker',triage:'untriaged'}] },
    { id:'simulated',versionId:'v',source:'simulated',transcript:'simulated evidence',scores:[],observations:[] },
    { id:'empty',versionId:'v',transcript:'',scores:[{paramId:'accuracy',value:1}],observations:[] },
  ], calls: [], batches: [], issues: [], rubric: [{id:'accuracy',name:'Accuracy'}],
}
function cli(base) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['cli.mjs', 'gate', '--agent', 'a', '--json'], {env:{...process.env, QA_URL:base, QA_TOKEN:'fixture'}})
    let stdout='',stderr='';child.stdout.on('data', x => stdout+=x);child.stderr.on('data', x => stderr+=x)
    child.on('error', reject);child.on('exit', code => { try { assert.equal(code,2,stderr);resolve(JSON.parse(stdout)) } catch(e) { reject(e) } })
  })
}
test('real local HTTP and CLI gate output conform to v1', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gate-contract-'))
  const srv = await start({port:0,home,quiet:true})
  const base=`http://127.0.0.1:${srv.port}`
  try {
    await fetch(base+'/api/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({base:{},local:state})})
    const result=await (await fetch(base+'/api/gate?agent=a')).json()
    validate(schema,result);validate(schema,await cli(base))
    assert.deepEqual(result.receipt.measured,{composite:5,samples:2,paramSamples:{accuracy:1},unsubstantiatedSessions:1,humanSessions:1,simulatedSessions:1,aiCalls:0,blockerFindings:1})
    assert.throws(()=>validate(schema,{...result,outcome:'unknown'}))
    assert.throws(()=>validate(schema,{...result,receipt:{...result.receipt,measured:{samples:-1}}}))
  } finally { await srv.close();rmSync(home,{recursive:true,force:true}) }
})
test('real hosted handler receipt conforms to v1', async () => {
  await build({stdin:{contents:"export { default as handler } from './api/gate.ts'; export { signClaims } from './api/_crypto.ts'",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile:'node_modules/.tmp/_gatecontract.mjs'})
  const {handler,signClaims}=await import('../node_modules/.tmp/_gatecontract.mjs')
  const vars=['KV_REST_API_URL','KV_REST_API_TOKEN','QA_SESSION_SECRET','QA_ACCESS_CODE','QA_ALLOWED_IPS'];const old=Object.fromEntries(vars.map(k=>[k,process.env[k]]));const original=globalThis.fetch
  Object.assign(process.env,{KV_REST_API_URL:'https://store.example.com',KV_REST_API_TOKEN:'fixture',QA_SESSION_SECRET:'fixture-secret',QA_ACCESS_CODE:'',QA_ALLOWED_IPS:''})
  const exp=Math.floor(Date.now()/1000)+3600
  globalThis.fetch=async (_url,init)=>{const [command,key]=JSON.parse(init.body);return Response.json({result:command==='GET' ? key==='aq:sessions' ? JSON.stringify({s:{userId:'u',tenantId:'t',email:'qa@example.com',name:'QA',role:'builder',exp}}) : key==='aq:t_t:state' ? JSON.stringify(state) : null : 1})}
  try {
    const token=await signClaims({sid:'s',tid:'t',uid:'u',iat:exp-3600,role:'builder',exp},process.env.QA_SESSION_SECRET)
    const response=await handler(new Request('https://qa.example.com/api/gate?agent=a',{headers:{authorization:`Bearer ${token}`}}))
    const result=await response.json();validate(schema,result);assert.ok(result.receipt.signature)
    assert.deepEqual(result.receipt.measured,{composite:5,samples:2,paramSamples:{accuracy:1},unsubstantiatedSessions:1,humanSessions:1,simulatedSessions:1,aiCalls:0,blockerFindings:1})
  } finally {globalThis.fetch=original;for(const k of vars) { if(old[k]===undefined) delete process.env[k];else process.env[k]=old[k] }}
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'

test('missing model keys name the variable and offline features without making a request', async () => {
  await build({stdin:{contents:"export { default as analyze } from './api/anthropic.ts'; export { default as simulate } from './api/simulate.ts'; export { default as suite } from './api/simulate-suite.ts'; export { judgeOne } from './api/_judge.ts'",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile:'node_modules/.tmp/_firstRunKeys.mjs'})
  const {analyze,simulate,suite,judgeOne}=await import('../node_modules/.tmp/_firstRunKeys.mjs')
  const keys=['ANTHROPIC_API_KEY','OPENAI_API_KEY','GOOGLE_API_KEY','DEEPSEEK_API_KEY','QA_ACCESS_CODE']
  const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));const fetch=globalThis.fetch
  for(const key of keys) delete process.env[key]
  globalThis.fetch=()=>{throw Error('Missing key must not contact a provider')}
  try {
    for(const handler of [analyze,simulate,suite]) {
      const res=await handler(new Request('http://localhost/api',{method:'POST',body:'{}'}))
      assert.equal(res.status,503)
      const {error}=await res.json();assert.match(error,/Set ANTHROPIC_API_KEY/);assert.match(error,/Manual logging, scoring, triage and gates/)
    }
    for(const [provider,key] of [['anthropic','ANTHROPIC_API_KEY'],['openai','OPENAI_API_KEY'],['gemini','GOOGLE_API_KEY'],['deepseek','DEEPSEEK_API_KEY']]) {
      const result=await judgeOne(provider,'fixture','fixture')
      assert.equal(result.kind,'unconfigured');assert.ok(result.detail.includes(key));assert.match(result.detail,/still work without/)
    }
  } finally {globalThis.fetch=fetch;for(const key of keys) {if(saved[key]===undefined) delete process.env[key];else process.env[key]=saved[key]}}
})

test('CLI help explains server key setup and features available without keys', () => {
  const res=spawnSync(process.execPath,['cli.mjs','help'],{encoding:'utf8'})
  assert.equal(res.status,0);assert.match(res.stdout,/ANTHROPIC_API_KEY/);assert.match(res.stdout,/Manual logging, scoring, triage and gates/)
})

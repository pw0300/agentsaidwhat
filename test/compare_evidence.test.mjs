import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
await build({entryPoints:['src/Compare.tsx'],bundle:true,platform:'node',format:'esm',outfile:'node_modules/.tmp/_compare-evidence.mjs',external:['react','react-dom']})
const {measure}=await import('../node_modules/.tmp/_compare-evidence.mjs')
const state = sessions => ({sessions,batches:[],calls:[]})
test('Compare labels CLI sessions as simulated and keeps human scenarios human', () => {
 const m=measure(state([{versionId:'v',source:'simulated',useCase:'CLI',scores:[],observations:[]}]),'v',[])
 assert.equal(m.humanSessions,0);assert.equal(m.simulatedSessions,1);assert.deepEqual(m.byScenario,{})
})
test('n/a sessions never weight the scenario mean', () => {
 const sessions=[5,null,1].map(value=>({versionId:'v',useCase:'Support',scores:value==null?[]:[{paramId:'accuracy',value}],observations:[]}))
 const m=measure(state(sessions),'v',['accuracy']);assert.equal(m.byScenario.Support.mean,3);assert.equal(m.byScenario.Support.n,2)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

test('demo boots sample data, ignores edits and blocks network features', async () => {
  await build({stdin:{contents:"export { StoreProvider, useStore } from './src/store.tsx'; export { apiHealth, callAnthropic } from './src/api.ts'; export { uploadAudio } from './src/audio.ts'; export { SimulationBench } from './src/SimulationBench.tsx'",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',jsx:'automatic',define:{__DEMO_MODE__:'true'},external:['react','react-dom'],outfile:'node_modules/.tmp/_demomode.mjs'})
  const {StoreProvider,useStore,apiHealth,callAnthropic,uploadAudio,SimulationBench}=await import('../node_modules/.tmp/_demomode.mjs')
  let store
  function Probe(){ store=useStore();return React.createElement(SimulationBench,{projectId:store.state.projects[0].id}) }
  const original=globalThis.fetch
  globalThis.fetch=()=>{throw new Error('Demo must not contact a server')}
  try {
    const html=renderToStaticMarkup(React.createElement(StoreProvider,null,React.createElement(Probe)))
    assert.match(html,/Demo with sample data\. Install locally to log your own calls\./)
    assert.equal(store.state.sessions.length,10)
    assert.match(html,/disabled=""/)
    assert.match(html,/Install locally to upload files/)
    store.mutate(s=>{s.sessions=[]})
    assert.equal(store.state.sessions.length,10)
    assert.equal((await apiHealth()).store,false)
    await assert.rejects(()=>callAnthropic({}),/Install locally/)
    assert.equal((await uploadAudio({name:'fixture.wav'})).ok,false)
  } finally {globalThis.fetch=original}
})

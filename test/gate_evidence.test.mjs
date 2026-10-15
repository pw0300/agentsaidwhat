import assert from 'node:assert/strict'
import { test } from 'node:test'
import { measureGate } from '../node_modules/.tmp/_measure.mjs'
export const fixture = () => ({ agents:[{id:'a'}], versions:[{id:'v',agentId:'a',number:2},{id:'old',agentId:'a',number:1},{id:'future',agentId:'a',number:3}], rubric:[{id:'accuracy',name:'Accuracy'}], gates:[{id:'g',agentId:'a',name:'Strict',enabled:true,minSamples:1,minComposite:4,minParams:{accuracy:4},maxBlockers:0,maxRegression:null}], sessions:[{id:'s',versionId:'v',transcript:'Call evidence',observations:[],scores:[{paramId:'accuracy',value:5}]}],calls:[],batches:[],issues:[] })
test('manual blockers count unless rejected or verified fixed by the gated version', () => {
 const s=fixture(), o={kind:'went-wrong',severity:'blocker',triage:'untriaged',issueId:'i'}
 s.sessions[0].observations=[o]
 assert.equal(measureGate(s,'a','v').result.outcome,'fail')
 o.triage='rejected'; assert.equal(measureGate(s,'a','v').input.blockerFindings,0)
 o.triage='accepted'
 s.issues=[{id:'i',status:'verified-fixed',verifiedFixedInVersionId:'old'}]
 assert.equal(measureGate(s,'a','v').input.blockerFindings,0)
 s.issues[0].verifiedFixedInVersionId='v';assert.equal(measureGate(s,'a','v').input.blockerFindings,0)
 s.issues[0].verifiedFixedInVersionId='future';assert.equal(measureGate(s,'a','v').input.blockerFindings,1)
 s.issues[0].status='claimed-fixed';assert.equal(measureGate(s,'a','v').input.blockerFindings,1)
 o.kind='went-right';assert.equal(measureGate(s,'a','v').input.blockerFindings,0)
 delete o.kind;assert.equal(measureGate(s,'a','v').input.blockerFindings,1)
})
test('unsubstantiated sessions cannot contribute samples or averages', () => {
 const s=fixture();s.sessions[0].transcript=' '
 const m=measureGate(s,'a','v');assert.equal(m.input.samples,0);assert.equal(m.input.composite,null);assert.equal(m.unsubstantiatedSessions,1);assert.equal(m.result.outcome,'inconclusive')
 for (const evidence of [{transcript:'text'},{audioId:'audio'},{recordingName:'call.wav'},{observations:[{kind:'went-right'}]}]) {
  Object.assign(s.sessions[0],{transcript:'',audioId:'',recordingName:'',observations:[]},evidence)
  assert.equal(measureGate(s,'a','v').input.samples,1)
 }
})
test('parameter floors require measured samples and respect n/a', () => {
 const s=fixture();s.gates[0].minSamples=5
 s.sessions=Array.from({length:5},(_,i)=>({...s.sessions[0],id:`s${i}`,scores:i ? [] : s.sessions[0].scores,naParams:i ? ['accuracy']:[]}))
 const m=measureGate(s,'a','v');assert.equal(m.result.outcome,'inconclusive');assert.deepEqual(m.input.paramSamples,{accuracy:1});assert.equal(m.input.samples,5)
 s.sessions[0].naParams=['accuracy'];assert.equal(measureGate(s,'a','v').input.paramAverages.accuracy,null)
})
test('simulated sessions stay simulated and cannot satisfy a human minimum', () => {
 const s=fixture();s.sessions[0].source='simulated'
 let m=measureGate(s,'a','v');assert.equal(m.humanSessions,0);assert.equal(m.simulatedSessions,1);assert.equal(m.result.outcome,'pass')
 s.gates[0].minHumanSessions=1;assert.equal(measureGate(s,'a','v').result.outcome,'inconclusive')
 delete s.sessions[0].source;assert.equal(measureGate(s,'a','v').result.outcome,'pass')
})

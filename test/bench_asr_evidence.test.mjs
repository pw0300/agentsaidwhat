import {test} from 'node:test'
import assert from 'node:assert/strict'
import {generate} from '../node_modules/.tmp/faultbench-generate.mjs'
import {detect,report} from '../node_modules/.tmp/faultbench-score.mjs'
test('generated ASR trace is not recognition evidence or part of benchmark rates',()=>{
 const rows=generate().calls.map(call=>({call,predictions:detect(call).predictions,measured:true}))
 const r=report(rows);assert.equal(r.faults['asr-mishear'].recall.status,'NOT MEASURED');assert.match(r.faults['asr-mishear'].reason,/heardText.*circular/)
 assert.ok(rows.every(row=>row.predictions.every(p=>p.id!=='asr-mishear')))
 assert.equal(r.overall.recall.n,291)
})

import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
async function invoke(body,args=['gate','--agent','a','--json'],status=200,token='fixture') {
 const server=createServer((req,res)=>{res.writeHead(status,{'content-type':'application/json'});res.end(typeof body==='string'?body:JSON.stringify(body))})
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 try{return await new Promise((resolve,reject)=>{
  const p=spawn(process.execPath,['cli.mjs',...args],{env:{...process.env,QA_URL:`http://127.0.0.1:${server.address().port}`,QA_TOKEN:token}});let out='',err=''
  p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('exit',code=>resolve({code,out,err}))
 })}finally{await new Promise(resolve=>server.close(resolve))}
}
const result=outcome=>({outcome,summary:'Fixture',checks:[],blockers:[]})
test('gate exit follows a validated outcome, never HTTP success alone',async()=>{
 for(const [body,status,code] of [[result('fail'),200,1],[{},200,2],[result('unknown'),200,2],[null,200,2],['{',200,2],[{outcome:'pass',checks:'broken'},200,2],[result('pass'),409,0]]){
  const r=await invoke(body,undefined,status);assert.equal(r.code,code,JSON.stringify(body));if(code===2) assert.equal(r.err.trim().split('\n').length,1)
 }
})
test('human readable gate output accepts unsigned local receipts',async()=>{
 const r=await invoke({...result('pass'),receipt:{signed:false,evaluatedAt:'2026-10-14'}},['gate','--agent','a']);assert.equal(r.code,0,r.err);assert.match(r.out,/unsigned \(local mode\)/)
})

test('ready JSON has the same exit as text, and local privacy commands explain hosted requirement',async()=>{
 for(const ready of [true,false]) {
  const body={ready,store:true,anthropic:false,sessionSecret:false,mode:'local'}
  const json=await invoke(body,['ready','--json']);assert.deepEqual(JSON.parse(json.out),body);assert.equal(json.code,ready?0:2)
  const text=await invoke(body,['ready']);assert.equal(json.code,text.code)
 }
 for(const command of ['export','inventory']){
  const r=await invoke({mode:'local',ready:true},[command],200,'');assert.equal(r.code,2);assert.match(r.err,/hosted mode/)
 }
})

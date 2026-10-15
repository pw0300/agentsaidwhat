import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
test('aggregate runner counts a crashed file and prints the error tail',()=>{
 const home=mkdtempSync(join(tmpdir(),'qa-runner-'));mkdirSync(join(home,'test'))
 try{
  copyFileSync('test/run_all.mjs',join(home,'test/run_all.mjs'))
  writeFileSync(join(home,'test/crash.test.mjs'),"throw new Error('regression crash sentinel')")
  const r=spawnSync(process.execPath,[join(home,'test/run_all.mjs')],{encoding:'utf8'})
  assert.equal(r.status,1);assert.match(r.stdout,/1 failing/);assert.match(r.stdout+r.stderr,/regression crash sentinel/)
 }finally{rmSync(home,{recursive:true,force:true})}
})

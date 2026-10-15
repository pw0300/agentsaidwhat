import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'

test('CLI without a command serves the local app without credentials', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aq-cli-'))
  const child = spawn(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url))], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', AGENT_QA_HOME: home,
      QA_URL: '', QA_TOKEN: '', ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  try {
    const base = await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('Local CLI did not start')), 20000)
      child.stdout.on('data', chunk => {
        output += chunk
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/)
        if (match) { clearTimeout(timer); resolve(match[0]) }
      })
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`Local CLI exited ${code}`)) })
    })
    const health = await (await fetch(`${base}/api/health`)).json()
    assert.equal(health.mode, 'local')
    assert.equal(health.ready, true)
    const ui = await fetch(base)
    assert.equal(ui.status, 200)
    assert.match(await ui.text(), /id="root"/)
  } finally {
    child.kill()
    await exited
    rmSync(home, { recursive: true, force: true })
  }
})

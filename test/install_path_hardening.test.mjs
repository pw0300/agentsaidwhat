import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

test('local server starts from an installation path containing a hash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aq-install-'))
  const install = join(root, 'path#test')
  mkdirSync(join(install, 'server'), { recursive: true })
  mkdirSync(join(install, 'dist-server'))
  copyFileSync('server/local.mjs', join(install, 'server', 'local.mjs'))
  copyFileSync('dist-server/lib.mjs', join(install, 'dist-server', 'lib.mjs'))
  cpSync('node_modules/yaml', join(install, 'node_modules', 'yaml'), { recursive: true })
  try {
    const moduleUrl = pathToFileURL(join(install, 'server', 'local.mjs')).href
    const script = `const { start } = await import(${JSON.stringify(moduleUrl)}); const server = await start({ port: 0, home: ${JSON.stringify(join(root, 'data'))}, quiet: true }); const response = await fetch('http://127.0.0.1:' + server.port + '/api/health'); console.log(JSON.stringify({ status: response.status, body: await response.json() })); await server.close()`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 0, result.stderr)
    const response = JSON.parse(result.stdout)
    assert.equal(response.status, 200)
    assert.equal(response.body.mode, 'local')
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
})

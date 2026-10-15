import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

for (const [outcome, status, expected] of [
  ['pass', 200, 0], ['fail', 409, 1], ['inconclusive', 409, 2], ['disabled', 200, 2],
]) {
  test(`gate CLI exits ${expected} for ${outcome}`, async () => {
    let requested
    const server = createServer((req, res) => {
      requested = { url: req.url, authorization: req.headers.authorization }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ outcome, summary: 'Synthetic gate response', checks: [] }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)),
          'gate', '--agent', 'agent / synthetic', '--version', 'version ? synthetic', '--json'], {
          env: { ...process.env, QA_URL: `http://127.0.0.1:${server.address().port}`, QA_TOKEN: 'synthetic-session' },
          stdio: 'ignore',
        })
        child.on('error', reject)
        child.on('exit', resolve)
      })
      assert.equal(code, expected)
      assert.equal(requested.authorization, 'Bearer synthetic-session')
      const url = new URL(requested.url, 'http://localhost')
      assert.equal(url.pathname, '/api/gate')
      assert.equal(url.searchParams.get('agent'), 'agent / synthetic')
      assert.equal(url.searchParams.get('version'), 'version ? synthetic')
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
}

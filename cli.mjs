#!/usr/bin/env node
/**
 * saidwhat — the release gate, for a terminal and for CI.
 *
 *   saidwhat gate   --agent <id> [--version <id>]
 *   saidwhat ready
 *   saidwhat export > backup.json
 *
 * Exits 0 on pass, 1 on fail, 2 on inconclusive or a configuration problem.
 * The three are separate because a pipeline that cannot tell "your agent
 * regressed" from "the gate is misconfigured" will be turned off by whoever
 * owns it after the first false alarm.
 *
 * Credentials come from the environment, never a flag, because a flag ends up
 * in shell history and CI logs:
 *
 *   export QA_URL=https://qa.example.com
 *   export QA_TOKEN=...            # a session token, same one the browser holds
 *
 * The token is the session this tool authenticates as. It is a real account
 * with a real role, so the gate runs with exactly the permissions a person
 * would have — there is no god-mode service credential, which is a deliberate
 * constraint: a release gate that can read production is not a control.
 */

const args = process.argv.slice(2)
const command = args[0] ?? 'local'

const flag = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = args[i + 1]
  return v && !v.startsWith('--') ? v : 'true'
}
const has = (name) => args.includes(`--${name}`)

// QA_URL and QA_TOKEN remain stable for existing CI integrations.
const URL_BASE = (process.env.QA_URL ?? '').replace(/\/$/, '')
const TOKEN = process.env.QA_TOKEN ?? ''

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
}
const paint = (c, s) => (has('no-color') || !process.stdout.isTTY ? s : `${c}${s}${C.reset}`)

function die(msg, code = 2) {
  console.error(paint(C.red, msg))
  process.exit(code)
}

/** Credentials are checked per command, not up front, so `--help` works
 *  before anyone has exported anything. */
function requireEnv(allowTokenless = false) {
  if (!URL_BASE) die('QA_URL is not set. Point it at your deployment, e.g. https://qa.example.com')
  if (!TOKEN && !allowTokenless) die('QA_TOKEN is not set. Use a session token for an account with at least builder access.')
}

async function api(path) {
  const res = await fetch(`${URL_BASE}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch {
    die(`Unreadable response from ${path} (HTTP ${res.status}). Is QA_URL correct and the deployment up?`)
  }
  if (!res.ok && res.status !== 409) die(data.error ?? `Request failed (${res.status})`)
  return { status: res.status, data }
}

const COMMANDS = {
  async run() {
    const { runPack } = await import('./server/run.mjs')
    const { existsSync } = await import('node:fs')
    const { resolve, relative, isAbsolute, sep } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    let file = args[1]
    if (file && !isAbsolute(file) && !existsSync(file)) {
      const packageRoot = fileURLToPath(new URL('.', import.meta.url))
      const bundled = resolve(packageRoot, file)
      const within = relative(packageRoot, bundled)
      if (within && !within.startsWith(`..${sep}`) && within !== '..' && !isAbsolute(within) && existsSync(bundled)) file = bundled
    }
    const result = await runPack({ file, agent: flag('agent'), version: flag('version'), mode: flag('mode', 'scripted') })
    if (has('json')) console.log(JSON.stringify(result, null, 2))
    else {
      console.log('Scenario                         Result')
      for (const row of result.results) console.log(`${row.name.padEnd(32)} ${row.outcome}`)
      console.log(`Saved ${result.results.length} simulated sessions to ${result.versionId}.`)
      for (const row of result.results) for (const check of row.checks) if (check.outcome === 'NOT MEASURED') console.log(`${row.name}: ${check.name} NOT MEASURED. ${check.detail}`)
    }
    process.exitCode = result.outcome === 'pass' ? 0 : result.outcome === 'fail' ? 1 : 2
  },
  async local() {
    const { start } = await import('./server/local.mjs')
    await start()
  },
  /* ---------- gate: the one a pipeline calls ---------- */
  async gate() {
    requireEnv()
    const agent = flag('agent')
    if (!agent) die('--agent is required.')
    const version = flag('version')
    const q = `/api/gate?agent=${encodeURIComponent(agent)}${version ? `&version=${encodeURIComponent(version)}` : ''}`

    const { data } = await api(q)
    if (!data || typeof data !== 'object' || !['pass', 'fail', 'disabled', 'inconclusive'].includes(data.outcome)) die('Invalid gate response: missing or unknown outcome.')
    if (typeof data.summary !== 'string' || !Array.isArray(data.checks) || data.checks.some(c => !c || typeof c.label !== 'string' || typeof c.detail !== 'string' || !['pass', 'fail', 'skip'].includes(c.outcome)) || (data.blockers !== undefined && (!Array.isArray(data.blockers) || data.blockers.some(b => typeof b !== 'string')))) die('Invalid gate response: malformed evaluation.')
    if (has('json')) {
      console.log(JSON.stringify(data, null, 2))
    } else {
      const icon = data.outcome === 'pass' ? paint(C.green, '✓') : data.outcome === 'mixed' ? paint(C.yellow, '!') : paint(C.red, '✗')
      console.log(`${icon} ${data.summary ?? 'No summary returned.'}`)
      for (const c of data.checks ?? []) {
        const mark = c.outcome === 'pass' ? paint(C.green, '✓') : c.outcome === 'skip' ? paint(C.dim, '·') : paint(C.red, '✗')
        console.log(`   ${mark} ${c.label.padEnd(22)} ${paint(C.dim, c.detail)}`)
      }
      if (data.receipt) {
        console.log(paint(C.dim, typeof data.receipt.hash === 'string' ? `   receipt ${data.receipt.hash.slice(0, 16)}... signed for ${data.receipt.evaluatedAt}` : '   receipt unsigned (local mode)'))
      }
    }

    if (data.outcome === 'disabled') { console.error(paint(C.yellow, 'Gate is disabled — nothing was checked.')); process.exit(2) }
    if (data.outcome === 'inconclusive') {
      console.error(paint(C.yellow, `Inconclusive: ${(data.blockers ?? []).join('; ') || 'not enough data to judge.'}`))
      process.exit(2)
    }
    process.exit(data.outcome === 'pass' ? 0 : 1)
  },

  /* ---------- ready: is this deployment usable at all ---------- */
  async ready() {
    requireEnv(true)
    const { data } = await api('/api/health')
    if (has('json')) { console.log(JSON.stringify(data, null, 2)); process.exit(data.ready ? 0 : 2) }
    const rows = [
      ['store', data.store], ['model key', data.anthropic], ['session secret', data.sessionSecret],
    ]
    for (const [k, v] of rows) {
      console.log(`${v ? paint(C.green, '✓') : paint(C.red, '✗')} ${k}`)
    }
    if (!data.ready) {
      console.error(paint(C.red, 'Deployment is not ready. See README → Deployment checklist.'))
      process.exit(2)
    }
    console.log(paint(C.green, 'Ready.'))
  },

  /* ---------- export: your data out, for a privacy request ---------- */
  async export() {
    requireEnv(true)
    const health = await api('/api/health')
    if (health.data?.mode === 'local') die('export requires hosted mode. Local workspace backups are available in Settings.')
    requireEnv()
    const { data } = await api('/api/privacy?action=export')
    process.stdout.write(JSON.stringify(data, null, 2))
  },

  /* ---------- inventory: what is stored, sized, no content ---------- */
  async inventory() {
    requireEnv(true)
    const health = await api('/api/health')
    if (health.data?.mode === 'local') die('inventory requires hosted mode. Local workspace backups are available in Settings.')
    requireEnv()
    const { data } = await api('/api/privacy?action=inventory')
    console.log(JSON.stringify(data, null, 2))
  },
}

if (command === 'help' || has('help')) {
  const { readFileSync } = await import('node:fs')
  const packageName = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name
  console.log(`
${C.bold}Our Agent Said What?!${C.reset}
An agentic QA testbench for voice agents. Catch it before your customers do.

Usage: saidwhat <command> [options]

  ${C.bold}local${C.reset} (default)
      Start the local app with SQLite and recordings on disk.

  run <pack> --agent <ws/http URL> --version v<number> [--mode scripted|simulated] [--json]
      Run a scenario pack and save simulated sessions to the local workspace.
      Paths use the current directory first, then bundled packs in this package.

  ${C.bold}gate${C.reset} --agent <id> [--version <id>] [--json]
      Evaluate the gate. Exit 0 pass · 1 fail · 2 inconclusive or disabled.

  ${C.bold}ready${C.reset}
      Check the deployment is wired up. Exit 0 ready · 2 not.

  ${C.bold}export${C.reset}
      Full workspace export (data + audit trail) as JSON on stdout.

  ${C.bold}inventory${C.reset}
      What is stored, sized, with no content.

${C.bold}Environment${C.reset}
  QA_URL      deployment base URL      ${C.dim}(required for CI commands)${C.reset}
  QA_TOKEN    session token            ${C.dim}(required for CI commands)${C.reset}
  ANTHROPIC_API_KEY  server key for AI analysis and simulation (optional)
  OPENAI_API_KEY / GOOGLE_API_KEY / DEEPSEEK_API_KEY  optional judge panel keys

  Set model keys in the server environment, then restart or redeploy.
  Manual logging, scoring, triage and gates over saved evidence work without them.

${C.bold}Example : a GitHub Actions step${C.reset}
  - name: Agent release gate
    run: npx ${packageName} gate --agent "$AGENT_ID" --version "$PROMPT_VERSION"
    env:
      QA_URL: $US/vars/QA_URL
      QA_TOKEN: $US/secrets/QA_TOKEN

${C.dim}In a workflow file, write the two as \${{ vars.QA_URL }} and \${{ secrets.QA_TOKEN }}.${C.reset}
`)
  process.exit(0)
}

const fn = COMMANDS[command]
if (!fn) die(`Unknown command "${command}". Try: local, run, gate, ready, export, inventory.`)

fn().catch(e => die(e instanceof Error ? e.message : String(e)))

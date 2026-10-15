/**
 * Run every test file and print an honest total.
 *
 * WHY THIS EXISTS
 *
 * The old test command chained files with `&&`, stopping at the first failure, and
 * the last file's reporter is the only summary anyone sees. Every test count in
 * this project's commit messages was read off a regex that matched two
 * reporters out of four, and it reported 115 for a suite that actually contains
 * 323 tests.
 *
 * That is the exact failure this project has spent its time on: a number that
 * looks fine and means something narrower than it appears. A test count quoted
 * in a writeup is a claim about coverage, and a claim you cannot reproduce is
 * worse than no claim.
 *
 * It runs every file regardless of what the others did, so one broken file does
 * not hide the state of the rest -- which is what `&&` does.
 *
 *   node test/run_all.mjs
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve against this file, not process.cwd(). `npm run` and a bare `node
// test/run_all.mjs` from a subdirectory are different working directories, and
// every test imports ../node_modules/.tmp -- so with the wrong cwd the children
// fail to resolve their imports and print nothing at all. Zero tests reported,
// zero failures, exit 0: the worst possible reporting outcome.
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DIR = join(ROOT, 'test')
if (!existsSync(DIR)) {
  console.error(`cannot find ${DIR}`)
  process.exit(1)
}
const files = readdirSync(DIR).filter(f => f.endsWith('.test.mjs')).sort()

// Each reporter prints a differently-formatted line per assertion. Counting all
// four patterns is what makes the total comparable across files.
const OK = /^\s*(?:ok|✔|✓)\s+\S/gm
const BAD = /^\s*(?:not ok|✖|✗)\s+\S/gm

const rows = []
let totalOk = 0
let totalBad = 0

for (const f of files) {
  // ownership.test.mjs imports TypeScript directly and needs type stripping.
  const args = f.includes('ownership')
    ? ['--experimental-strip-types', join(DIR, f)]
    : [join(DIR, f)]
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT })
  const out = r.stdout ?? ''
  if (!out.trim() && r.status === 0) {
    console.error(`  ${f} produced NO OUTPUT and exited 0 -- treating as a failure, not a pass`)
    rows.push({ f, ok: 0, bad: 1, exit: 1 })
    totalBad += 1
    continue
  }
  const ok = (out.match(OK) ?? []).length
  const reportedBad = (out.match(BAD) ?? []).length
  const crashed = r.status !== 0 || r.error || r.signal
  const bad = reportedBad + (crashed && reportedBad === 0 ? 1 : 0)
  if (crashed) {
    const tail = [out, r.stderr ?? '', r.error ? String(r.error) : ''].filter(Boolean).join('\n').trim().split('\n').slice(-20).join('\n')
    console.error(`  ${f} failed (exit ${r.status}${r.signal ? `, signal ${r.signal}` : ''}):\n${tail}`)
  }
  totalOk += ok
  totalBad += bad
  rows.push({ f, ok, bad, exit: r.status })
}

const w = Math.max(...rows.map(r => r.f.length))
for (const r of rows) {
  const mark = r.bad > 0 || r.exit !== 0 ? '\x1b[31m✖\x1b[0m' : '\x1b[32m✔\x1b[0m'
  console.log(`  ${mark} ${r.f.padEnd(w)}  ${String(r.ok).padStart(3)} passing${r.bad ? `  ${r.bad} FAILING` : ''}`)
}
console.log(`\n  ${rows.length} files, \x1b[1m${totalOk} passing\x1b[0m, ${totalBad} failing`)
console.log('  reported by test/run_all.mjs -- aggregate across all discovered test files\n')

process.exit(totalBad > 0 || rows.some(r => r.exit !== 0) ? 1 : 0)

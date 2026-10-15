import { writeFile, mkdir } from 'node:fs/promises'
import { load } from './build.mjs'
const { validateGate } = await load('gate-validation')
const result = validateGate()
await mkdir(new URL('./results/', import.meta.url), { recursive: true })
await writeFile(new URL('./results/gate-validation.json', import.meta.url), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ source: 'bench/results/gate-validation.json', samples: result.candidate.samples, baseline: result.baseline.composite, candidate: result.candidate.composite, outcome: result.after.outcome, failed: result.after.checks.filter(c => c.outcome === 'fail').map(c => c.id) }, null, 2))

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { load } from './build.mjs'
const args = process.argv.slice(2)
let set = 'v1', judge = 'none'
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--set') set = args[++i]
  else if (args[i] === '--judge') judge = args[++i]
  else throw new Error(`Unknown argument: ${args[i]}`)
}
if (!/^[a-zA-Z0-9_-]+$/.test(set) || !['none', 'panel'].includes(judge)) throw new Error('Usage: node bench/run.mjs [--set v1] [--judge none|panel]')
const raw = await readFile(new URL(`./sets/${set}.json`, import.meta.url), 'utf8')
const data = JSON.parse(raw)
const { detect, judgeCall, report, SUPPORTED } = await load('score')
const deterministic = [], judged = [], evidence = [], judgeEvidence = []
for (const call of data.calls) {
  const result = detect({ turns: call.turns, hangup: call.hangup })
  deterministic.push({ call, predictions: result.predictions, measured: true })
  evidence.push({ callId: call.id, ...result })
  const j = await judgeCall(call, judge)
  judged.push({ call, predictions: j.predictions, measured: j.status === 'MEASURED' })
  judgeEvidence.push({ callId: call.id, ...j })
  if (judge === 'panel') console.log(`${call.id}: judge ${j.status}`)
}
const common = { source: `bench/sets/${set}.json`, sourceSha256: createHash('sha256').update(raw).digest('hex'), calls: data.calls.length,
  scoringUnit: 'Binary call/fault presence, micro-averaged overall. Multiple faults are separate events. Turn localization is not scored. Layer accuracy is conditional on matched fault ids.',
  bootstrap: { iterations: 2000, confidence: 0.95, method: 'Seeded percentile bootstrap resampling whole calls, preserving paired faults. Undefined replicate ratios are omitted. Precision n is predictions, recall n is injected faults, F1 n is union events, attribution n is matched events. Values withheld below n=20.' },
  limits: 'Constructed transcript and timing fixtures only. Repeated template families are not independent production callers. No acoustic quality, real ASR, live latency or real fault prevalence is measured.' }
await mkdir(new URL('./results/', import.meta.url), { recursive: true })
for (const [name, rows, details, measures] of [
  ['deterministic', deterministic, evidence, `Existing api/_naturalness.ts repetition and api/_voicebench.ts timing/trace budget checks; bench endpoint comparison. ASR mishear is NOT MEASURED because comparing generated heardText to generated truth is circular; ASR events are excluded from overall rates. Timing faults are measured on exact synthetic timings and are easier than real calls. Supported fault mappings: ${SUPPORTED.join(', ')}. Other fault recall is measured against no predictions; no semantic detector exists for those faults. api/_audio.ts probes need audio; api/_measure.ts and api/_suite.ts aggregate scores, not fault predictions.`],
  ['panel', judged, judgeEvidence, 'api/_judgepanel.ts provider selection and verdict reduction on blinded call inputs via existing provider request builders. Missing keys, disabled judges, errors and contested verdicts are NOT MEASURED. No judge calibration result without usable replies.'],
]) {
  const output = { ...common, detector: name, measures, ...report(rows), evidence: details }
  await writeFile(new URL(`./results/${set}-${name}.json`, import.meta.url), JSON.stringify(output, null, 2) + '\n')
  console.log(JSON.stringify({ detector: name, overall: output.overall, cleanFalsePositiveRate: output.cleanFalsePositiveRate, faults: output.faults }, null, 2))
}

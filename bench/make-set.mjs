import { mkdir, writeFile } from 'node:fs/promises'
import { load } from './build.mjs'
const { generate } = await load('generate')
const { FAULTS } = await load('faults')
const set = generate()
const counts = Object.fromEntries(FAULTS.map(f => [f.id, set.calls.filter(c => c.faults.some(x => x.id === f.id)).length]))
const clean = set.calls.filter(c => !c.faults.length).length
const distribution = { calls: set.calls.length, clean, seed: set.seed, faults: counts,
  domains: Object.fromEntries([...new Set(set.calls.map(c => c.domain))].map(d => [d, set.calls.filter(c => c.domain === d).length])),
  languages: Object.fromEntries([...new Set(set.calls.map(c => c.language))].map(l => [l, set.calls.filter(c => c.language === l).length])) }
const dir = new URL('./sets/', import.meta.url)
await mkdir(dir, { recursive: true })
await writeFile(new URL('v1.json', dir), JSON.stringify(set, null, 2) + '\n')
await writeFile(new URL('v1.distribution.json', dir), JSON.stringify(distribution, null, 2) + '\n')
const table = FAULTS.map(f => `| ${f.id} | ${f.layer} | ${f.input} | ${counts[f.id]} |`).join('\n')
await writeFile(new URL('v1.card.md', dir), `# Constructed call set v1\n\nSource: v1.json and v1.distribution.json, written by bench/make-set.mjs.\n\n${set.calls.length} calls, seed ${set.seed}; ${clean} clean calls (${100 * clean / set.calls.length}%). Handwritten templates cover real estate sales, bank support, food delivery and telecom support, with English and two Hinglish script forms. Callers explicitly switch language. Fault counts include both labels in paired calls. Seeded selection never targets the same turn twice. Timings are constructed telemetry, not recorded audio.\n\n| Fault | Expected engine layer | Input | Calls |\n| --- | --- | --- | --- |\n${table}\n\nThe engine layers come from api/_voicebench.ts, with prompt from src/types.ts. Each label also stores the existing UI mapping. ASR maps to platform; LLM maps to prompt; TTS maps to voice-tts; VAD maps to vad; telephony maps to platform.\n\nThis measures detector and judge behavior on known injected faults, not real-world fault prevalence, acoustic quality, real ASR behavior on audio, or human-rated voice quality. Synthetic transcripts are easier than real calls. The template family is small and repeated; intervals describe this constructed set, not unseen production callers. The set is public and is not a blind holdout. Caller reference versus recognition text is a constructed substitution, not an ASR engine evaluation.\n`)
console.log(JSON.stringify(distribution, null, 2))

/**
 * One entry point for the voice audit.
 *
 * WHY THIS IS NOT A SCRIPT YOU RUN BY HAND
 *
 * The five bugs in this area all produced numbers instead of errors: a leftover
 * `_tmp_en.wav` scored as data, an English control that extracted zero clips
 * while printing a plausible selection, four baseline clips written to one
 * filename so n=4 was really n=1, inverted validation flags that silently
 * yielded zero ratings, and an invented 0.5 compression threshold that
 * contradicted the correlation in its own file.
 *
 * Each was invisible from the outside. The only reason any of them surfaced is
 * that someone later compared a claim against the data behind it.
 *
 * So this runs the steps in order, and between each one it checks that the
 * artefact exists, is non-trivial, and agrees with the previous step. A run that
 * produces a plausible CSV from a step that did nothing is exactly the failure
 * mode worth catching, and it is caught by asking "did the thing that was
 * supposed to happen actually happen" after each step rather than at the end.
 *
 * Exit codes: 0 all steps ran and agree, 1 a step failed or the artefacts
 * disagree. Anything less than a full green is not a partial success worth
 * quoting.
 *
 *   node audit.mjs              # score what is already built
 *   node audit.mjs --build      # rebuild the clips first
 *   node audit.mjs --list       # show what would run and why
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'

const VP = 'data/voice_probe'
const PY = '.venv-nisqa/Scripts/python.exe'
const WEIGHTS = 'models/nisqa_tts.tar'

// Hermes leaks PYTHONPATH/PYTHONHOME into every venv it spawns, so without -E
// the venv loads the host numpy 2.4 and torch 2.2.1 dies on import -- which
// looks exactly like a broken package rather than a leaked environment.
const PY_ENV = { ...process.env, VIRTUAL_ENV: '', PYTHONPATH: '', PYTHONHOME: '' }
const py = (args) => spawnSync(PY, ['-E', ...args], { env: PY_ENV, encoding: 'utf8' })

const C = { b: s => `\x1b[1m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m` }
const flag = (n) => process.argv.includes(`--${n}`)

/* ------------------------------------------------------------------ */
/* Preconditions                                                       */
/* ------------------------------------------------------------------ */

function preconditions() {
  const missing = []
  if (!existsSync(PY)) missing.push(`${PY} (python 3.11 venv -- see docs/VOICE-SCORING.md)`)
  if (!existsSync(WEIGHTS)) missing.push(`${WEIGHTS} (NISQA weights)`)
  if (!existsSync('data/somos.zip') && !existsSync(`${VP}/NISQA_control.csv`))
    missing.push('data/somos.zip (4 GB) or an existing control score')
  return missing
}

/* ------------------------------------------------------------------ */
/* Steps                                                               */
/* ------------------------------------------------------------------ */

const STEPS = [
  {
    name: 'build degraded Hindi variants',
    cmd: ['tools/voice_probe.py'],
    pyOnly: false,
    produces: `${VP}/manifest.json`,
    // Six variants x 4 recordings. Fewer means the clip generator half-ran.
    expect: (p) => JSON.parse(readFileSync(p, 'utf8')).length >= 24,
    why: 'every recording is degraded six ways so only the signal changes',
  },
  {
    // Runs in the venv, NOT the host interpreter: it decodes LibriSpeech's FLAC
    // through soundfile, which is installed only in the 3.11 environment. On the
    // host it exits 0 having built the Hindi half and silently skipped the
    // English half -- which is precisely the half that separates "harsh model"
    // from "language penalty". The step-level check now catches that.
    name: 'build controls (English, Hindi speech-only)',
    cmd: ['tools/voice_control.py'],
    pyOnly: true,
    produces: `${VP}/controls.json`,
    // One English control, one speech-only and one baseline per Hindi clip.
    expect: (p) => {
      const c = JSON.parse(readFileSync(p, 'utf8'))
      const kinds = new Set(c.map(x => x.variant))
      return c.length >= 8 && kinds.has('english') && kinds.has('hindi_baseline')
    },
    why: 'separates "harsh model" from "silence structure" from "language"',
  },
  {
    name: 'score degradation + controls',
    cmd: ['tools/nisqa_score.py', `${VP}/NISQA_results.csv`,
      `${VP}/hindi_*.wav`, `${VP}/english_clean*.wav`],
    pyOnly: true,
    produces: `${VP}/NISQA_results.csv`,
    expect: (p) => csv(p).length >= 24 && !csv(p).some(r => r[0].startsWith('_')),
    why: 'a directory glob once scored a leftover temp file as data',
  },
  {
    name: 'score controls explicitly',
    cmd: ['tools/nisqa_score.py', `${VP}/NISQA_control.csv`,
      `${VP}/english_clean*.wav`, `${VP}/hindi_baseline*.wav`, `${VP}/hindi_speechonly*.wav`],
    pyOnly: true,
    produces: `${VP}/NISQA_control.csv`,
    expect: (p) => {
      const rows = csv(p)
      return rows.length >= 8 && !rows.some(r => r[0].startsWith('_'))
    },
    why: 'the control set must not inherit the degradation set\'s stray files',
  },
  {
    name: 'read the degradation verdict',
    cmd: ['tools/voice_verdict.py'],
    pyOnly: false,
    produces: `${VP}/verdict.json`,
    expect: (p) => JSON.parse(readFileSync(p, 'utf8')).rejected_degradations.length === 4,
    why: 'the model must reject noise and clipping',
  },
  {
    name: 'read the control verdict',
    cmd: ['tools/voice_control_verdict.py'],
    pyOnly: false,
    produces: `${VP}/control_verdict.json`,
    expect: (p) => {
      const v = JSON.parse(readFileSync(p, 'utf8'))
      return Array.isArray(v.language_effect_ci95)
    },
    why: 'a four-clip difference needs an interval, not a point estimate',
  },
]

const OPTIONAL = [
  {
    // Slow: ~5 minutes per recording on CPU. It is here rather than inline so
    // `npm run audit` produces the ASR row on a machine that can afford it, and
    // skips it cleanly on one that cannot -- which is the same contract the other
    // optional steps have.
    name: 'measure WER on real Hindi (slow)',
    cmd: ['tools/asr_wer.py'],
    pyOnly: true,
    guard: () => existsSync('data/hindi_test.parquet') && !!process.env.ASR_AUDIT,
    produces: 'data/asr_verdict.json',
    expect: (p) => {
      const v = JSON.parse(readFileSync(p, 'utf8'))
      // The self-comparison control is the whole point: a metric that cannot
      // return 0 on identical text cannot be used to score anything.
      return v.control_self_wer === 0 && typeof v.wer_strict === 'number'
    },
    why: 'needs data/hindi_test.parquet and ASR_AUDIT=1 -- CPU transcription is minutes per clip',
  },
  {
    name: 'score the SOMOS calibration set',
    cmd: ['tools/somos_extract.py'],
    pyOnly: false,
    produces: 'data/somos/mos_labels.csv',
    guard: () => existsSync('data/somos.zip'),
    why: 'needs the 3.97 GB CC BY-NC-SA corpus; skipped when absent',
  },
  {
    name: 'score SOMOS against human MOS',
    cmd: ['tools/nisqa_score.py', `${VP}/NISQA_somos.csv`, `${VP}/somos_*.wav`],
    pyOnly: true,
    guard: () => existsSync('data/somos/mos_labels.csv'),
    produces: `${VP}/NISQA_somos.csv`,
    expect: (p) => csv(p).length >= 30,
    why: 'n=12 reported r=0.36 that collapsed to 0.12 at n=100',
  },
  {
    name: 'read the calibration verdict',
    cmd: ['tools/voice_calibration.py'],
    pyOnly: false,
    guard: () => existsSync(`${VP}/NISQA_somos.csv`),
    produces: `${VP}/calibration_verdict.json`,
    expect: (p) => {
      const v = JSON.parse(readFileSync(p, 'utf8'))
      return v.n >= 30 && Array.isArray(v.pearson_ci95)
    },
    why: 'the correlation needs an interval to mean anything',
  },
]

const csv = (p) => {
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').trim().split('\n').slice(1).map(l => l.split(','))
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

function run(step) {
  const skipped = step.guard && !step.guard()

  if (skipped) {
    console.log(`  ${C.y('SKIP')} ${step.name}`)
    console.log(`       ${C.d(step.why)}`)
    return { ok: true, skipped: true }
  }

  const r = step.pyOnly ? py(step.cmd) : spawnSync('python', step.cmd, { encoding: 'utf8' })

  if (r.status !== 0) {
    console.log(`  ${C.r('FAIL')} ${step.name}`)
    const err = (r.stderr || r.stdout || '').trim().split('\n').slice(-4).join('\n       ')
    console.log(`       ${err}`)
    return { ok: false }
  }

  if (!existsSync(step.produces)) {
    console.log(`  ${C.r('FAIL')} ${step.name} -- ${step.produces} was not produced`)
    console.log(`       ${C.d('the step exited 0 having done nothing, which is the failure mode this guards against')}`)
    return { ok: false }
  }

  if (step.expect && !step.expect(step.produces)) {
    console.log(`  ${C.r('FAIL')} ${step.name} -- ${step.produces} exists but does not hold up`)
    console.log(`       ${C.d(step.why)}`)
    return { ok: false }
  }

  const kb = statSync(step.produces).size
  console.log(`  ${C.g('OK  ')} ${step.name} ${C.d(`(${step.produces}, ${kb} B)`)}`)
  return { ok: true }
}

function main() {
  console.log(C.b('\nVoice audit\n'))

  if (flag('list')) {
    // Printed here rather than through run(), which both printed the name twice
    // and omitted the optional steps entirely -- so `--list` did not describe
    // what the run actually does.
    console.log(C.d('  required'))
    for (const s of STEPS) {
      console.log(`  ${C.b(s.name)}`)
      console.log(`    ${C.d(s.cmd.join(' '))}`)
      console.log(`    ${C.d(`checks ${s.produces} -- ${s.why}`)}`)
    }
    console.log(C.d('\n  calibration'))
    for (const s of OPTIONAL) {
      const avail = s.guard ? s.guard() : true
      console.log(`  ${avail ? C.b(s.name) : C.d(s.name + '  [will skip]')}`)
      console.log(`    ${C.d(s.cmd.join(' '))}`)
      console.log(`    ${C.d(`checks ${s.produces} -- ${s.why}`)}`)
    }
    console.log()
    return
  }

  const missing = preconditions()
  if (missing.length) {
    console.log(C.r('  missing prerequisites:'))
    for (const m of missing) console.log(`    - ${m}`)
    console.log(C.d('\n  see docs/VOICE-SCORING.md for the setup steps'))
    process.exit(1)
  }

  if (flag('build')) {
    console.log(C.d('  rebuilding clips'))
    for (const s of STEPS.slice(0, 2)) {
      const r = s.pyOnly ? py(s.cmd) : spawnSync('python', s.cmd, { encoding: 'utf8' })
      if (r.status !== 0) { console.log(`  ${C.r('FAIL')} ${s.name}`); process.exit(1) }
      console.log(`  ${C.g('OK  ')} ${s.name}`)
    }
  }

  console.log(C.d('\n  required'))
  for (const s of STEPS) {
    if (!run(s).ok) {
      console.log(C.r('\n  audit failed -- a later step would be summarising bad data'))
      process.exit(1)
    }
  }

  console.log(C.d('\n  calibration (needs the 3.97 GB SOMOS corpus)'))
  for (const s of OPTIONAL) {
    if (!run(s).ok) {
      console.log(C.r('\n  calibration step failed'))
      process.exit(1)
    }
  }

  console.log(C.g('\n  all steps ran and every artefact agreed'))
  console.log(C.d('  `npm test` now guards these artefacts via test/audio_audit.test.mjs\n'))
}

main()
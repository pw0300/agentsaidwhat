// The noise-floor estimator, tested on the shape of real speech.
//
//   node test/floor.test.mjs
//
// This file exists because of a bug that 26 passing fixture tests could not
// catch.
//
// The estimator used to be "the median of frames more than 20 dB below the
// peak". On the synthetic fixtures that works: they have genuine digital silence
// between segments, so the filter selects a small quiet set.
//
// On real speech it collapses. Measured against Indic DiarBench (Hindi, CC BY
// 4.0), on a 75-second clip where humans speak for 85% of the time, 99.4% of
// frames fell inside that filter — so "the median of the quiet frames" was the
// median of the entire recording. The threshold floated above most of the
// signal and speech recall came back at 35.7%.
//
// The failure mode is worth naming: a filter meant to select the minority picks
// the majority as soon as the majority becomes large enough, and no amount of
// fixture tuning reveals it because fixtures are not speech-dense.
import { adaptiveThresholds, frame, toDb } from '../node_modules/.tmp/_audio.mjs'
import assert from 'node:assert'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('ok  ', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message) }
}

/**
 * Build a clip with a given speech duty cycle and a given silence floor —
 * the two properties that decide whether the estimator works.
 *
 * @param duty     fraction of the clip that is speech (real conversation is 0.75-0.9)
 * @param speechDb level of the speech
 * @param noiseDb  level of the room tone
 */
function makeClip({ duty = 0.85, speechDb = -22, noiseDb = -78, seconds = 6, sr = 16000 } = {}) {
  const n = sr * seconds
  const out = new Float32Array(n)
  // Deterministic noise, so a failure is reproducible.
  let seed = 12345
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5 }
  const speechAmp = Math.pow(10, speechDb / 20)
  const noiseAmp = Math.pow(10, noiseDb / 20)

  // Speech is interleaved in short phrases separated by short pauses, not one
  // contiguous block followed by one block of silence.
  //
  // The first version of this generator emitted all the speech first and all
  // the silence last. That produces a clip where 85% is speech but p50 is
  // still room tone — and the test then measured 44% "detected" and a 0.4 dB
  // bimodal gap, which reads as the estimator being broken when the generator
  // was. Real conversation alternates: someone speaks for a few seconds, there
  // is a pause, someone replies. That structure is also precisely what makes
  // the percentile estimator work, so it has to be here for the test to mean
  // anything.
  const phraseSamples = Math.max(1, Math.floor(sr * 1.2))
  const silenceSamples = Math.max(1, Math.floor(sr * (1.2 * (1 - duty) / Math.max(0.01, duty))))
  const cycle = phraseSamples + silenceSamples
  for (let i = 0; i < n; i++) {
    const inSpeech = (i % cycle) < phraseSamples
    const tone = inSpeech ? Math.sin((2 * Math.PI * 180 * i) / sr) * speechAmp : 0
    out[i] = tone + rnd() * noiseAmp * 2
  }
  return { samples: out, sampleRate: sr }
}

/* ==================== the bug ==================== */

t('dense speech: the floor samples the noise, not the median of the clip', () => {
  // The exact conditions that broke it: 85% speech occupancy, which put 99.4%
  // of frames inside the old "below peak - 20 dB" filter.
  const clip = makeClip({ duty: 0.85 })
  const buf = { samples: clip.samples, sampleRate: clip.sampleRate }
  const t1 = adaptiveThresholds(buf)
  // The room tone is at -78 dBFS. A floor anywhere near the clip's median
  // (about -22 dBFS, i.e. the speech level) means the estimator sampled speech.
  assert.ok(t1.noiseFloorDb < -50,
    `floor ${t1.noiseFloorDb.toFixed(1)} dB is inside the speech, not the noise`)
  assert.ok(t1.noiseFloorDb > -95, 'floor should still be a real measurement, not -Infinity')
})

t('dense speech: the threshold sits below the signal', () => {
  // The property that makes detection possible at all. A threshold above the
  // peak detects nothing, and the fixture suite's own comment calls this "a bug
  // with a name".
  for (const duty of [0.6, 0.75, 0.85, 0.95]) {
    const clip = makeClip({ duty })
    const t1 = adaptiveThresholds({ samples: clip.samples, sampleRate: clip.sampleRate })
    assert.ok(t1.speechDb < t1.peakDb,
      `duty ${duty}: threshold ${t1.speechDb.toFixed(1)} at or above peak ${t1.peakDb.toFixed(1)}`)
  }
})

t('a speech-dense clip still marks most of its speech as speech', () => {
  // The end-to-end consequence, which is the number that actually matters. The
  // old estimator produced 35.7% recall on real audio; the point of this test is
  // that the condition which caused it can never come back silently.
  const clip = makeClip({ duty: 0.85 })
  const frames = frame(clip.samples, clip.sampleRate)
  const t1 = adaptiveThresholds({ samples: clip.samples, sampleRate: clip.sampleRate })
  const above = frames.filter(f => toDb(f.rms) >= t1.speechDb).length
  const ratio = above / frames.length
  // Within 25 points of the true duty cycle. Not "everything is speech" and not
  // "almost nothing" — the mark has to land near the real proportion.
  assert.ok(Math.abs(ratio - 0.85) < 0.25,
    `marked ${(ratio * 100).toFixed(0)}% speech on an 85%-speech clip (want ~85%)`)
})

t('a low duty cycle still finds the speech, not the silence', () => {
  // The opposite end, so the fix is not just "always mark everything as
  // speech". Sparse audio is the easy case for the old estimator; it has to
  // keep working.
  const clip = makeClip({ duty: 0.2 })
  const frames = frame(clip.samples, clip.sampleRate)
  const t1 = adaptiveThresholds({ samples: clip.samples, sampleRate: clip.sampleRate })
  const above = frames.filter(f => toDb(f.rms) >= t1.speechDb).length / frames.length
  assert.ok(above > 0.08, `found ${(above * 100).toFixed(1)}% speech on a 20%-speech clip — too little`)
  assert.ok(above < 0.45, `found ${(above * 100).toFixed(1)}% speech on a 20%-speech clip — too much`)
})

/* ==================== bimodality is why it works ==================== */

t('the frame energy distribution is bimodal, so a low percentile finds the noise mode', () => {
  // The reason the percentile form is correct rather than merely different.
  //
  // The gap between the two modes sits wherever the duty cycle puts it, which
  // is the point: on an 85%-speech clip the gap is between p10 and p15; on a
  // 20%-speech clip it is between p80 and p90. Measured at 56.7 dB and 57.2 dB.
  //
  // The first version of this test looked at p80 - p20, which spans BOTH modes
  // on an 85%-speech clip and therefore measured 0.1 dB — and concluded the
  // distribution was not bimodal. It is; the test was asking it the wrong
  // question. Asserting on a fixed percentile pair is wrong precisely because
  // the pair is a function of the duty cycle.
  const clip = makeClip({ duty: 0.85 })
  const frames = frame(clip.samples, clip.sampleRate)
  const db = frames.map(f => toDb(f.rms)).sort((a, b) => a - b)
  const p = (q) => db[Math.floor(q * (db.length - 1))]

  // Largest gap between neighbouring percentiles, which is the mode boundary
  // wherever it happens to fall.
  const qs = [0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.85, 0.90, 0.95]
  let biggest = 0
  for (let i = 1; i < qs.length; i++) biggest = Math.max(biggest, p(qs[i]) - p(qs[i - 1]))
  assert.ok(biggest > 20, `expected a bimodal gap over 20 dB, got ${biggest.toFixed(1)}`)

  // And the floor has to land in the noise mode, i.e. below the gap.
  const thr = adaptiveThresholds({ samples: clip.samples, sampleRate: clip.sampleRate })
  assert.ok(thr.noiseFloorDb < p(0.20),
    `floor ${thr.noiseFloorDb.toFixed(1)} is above the noise mode`)
})

t('the detected duty cycle tracks the true one', () => {
  // The property that makes the percentile estimator correct at both extremes:
  // the threshold has to land where it separates the modes, whatever the
  // speech proportion. 87.1% detected on an 85% clip and 20.1% on a 20% clip,
  // measured.
  for (const [duty, want] of [[0.85, 0.85], [0.2, 0.2]]) {
    const clip = makeClip({ duty })
    const frames = frame(clip.samples, clip.sampleRate)
    const t1 = adaptiveThresholds({ samples: clip.samples, sampleRate: clip.sampleRate })
    const got = frames.filter(f => toDb(f.rms) >= t1.speechDb).length / frames.length
    assert.ok(Math.abs(got - want) < 0.1,
      `duty ${duty}: detected ${(got * 100).toFixed(1)}%, want ~${(want * 100).toFixed(0)}%`)
  }
})

t('the floor is robust to a single loud transient', () => {
  // p10 rather than the minimum: one click, dropout or burst must not drag the
  // floor far below the line's actual noise and let the threshold through the
  // hiss. A percentile is the standard reason for preferring it to the min.
  const clip = makeClip({ duty: 0.85 })
  const withClick = Float32Array.from(clip.samples)
  const n = withClick.length
  for (let i = 0; i < 40; i++) withClick[Math.floor(n / 3) + i] = 0.99
  const clean = adaptiveThresholds({ samples: clip.samples, sampleRate: clip.sampleRate })
  const clicked = adaptiveThresholds({ samples: withClick, sampleRate: clip.sampleRate })
  assert.ok(Math.abs(clicked.noiseFloorDb - clean.noiseFloorDb) < 12,
    `a 40-sample click moved the floor ${(clicked.noiseFloorDb - clean.noiseFloorDb).toFixed(1)} dB`)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
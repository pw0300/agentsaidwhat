// The voice bench: layer budgets, the no-data rule, and reproducibility.
//
// The rule that matters most here is the one a type-checker cannot see and a
// dashboard always gets wrong: an unmeasured metric is `no-data`, never
// `pass`. A voice bench that silently reports a green light on pronunciation
// it never measured is worse than no bench, because it converts an unknown
// into a false assurance — and that is exactly the failure an enterprise
// buyer discovers in production, at volume, on a channel with no undo.
//
//   npm test
import {
  BUDGET_PROVENANCE, BUDGET_SOURCES, DEFAULT_VOICE_BUDGET, HUMAN_REFERENCE,
  LAYERS, LAYER_OWNER, PERSONA_LIBRARY,
  describeCoverage, evaluateVoice, matrixSize, runFingerprint,
} from '../node_modules/.tmp/_voicebench.mjs'
import assert from 'node:assert'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('ok  ', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message) }
}

/** A healthy run: everything measured, everything inside budget. */
const good = (over = {}) => ({
  personaId: 'p-hinglish-urban', agentId: 'a1', versionId: 'v1', ranAt: '2026-09-30T00:00:00Z',
  asr: { wer: 0.06, criticalMishears: [], turnCountDelta: 0, ...(over.asr ?? {}) },
  tts: { firstAudioLatencyMs: 420, turnGapMs: 700, termPronunciation: 4.5, prosodyNaturalness: 4, clipRate: 0, ...(over.tts ?? {}) },
  vad: { bargeInStopLatencyMs: 240, overTalk: false, falseInterrupts: 0, selfHungUp: false, deadAirMs: 1200, ...(over.vad ?? {}) },
  llm: { verdict: 'good', scores: { accuracy: 5 }, goalAchieved: true, findings: [], ...(over.llm ?? {}) },
})

/* ==================== the healthy baseline ==================== */

t('a healthy run passes every layer', () => {
  const r = evaluateVoice(good())
  assert.strictEqual(r.outcome, 'pass', r.summary)
  assert.deepStrictEqual(r.blockers, [])
})

t('the summary names the layer owner when something fails', () => {
  // A finding with no owner is a complaint. "VAD/turn thresholds" tells a team
  // who to open a ticket; "quality dropped" tells them to argue.
  const r = evaluateVoice(good({ vad: { bargeInStopLatencyMs: 2400 } }))
  assert.strictEqual(r.outcome, 'fail')
  assert.ok(r.summary.includes(LAYER_OWNER.vad), r.summary)
  assert.ok(r.blockers[0].includes('VAD'), r.blockers[0])
})

t('failures are grouped by layer so a fix can be routed', () => {
  const r = evaluateVoice(good({ vad: { bargeInStopLatencyMs: 2400, falseInterrupts: 3 }, tts: { firstAudioLatencyMs: 1800 } }))
  assert.ok(r.byLayer.vad.failed >= 2, JSON.stringify(r.byLayer))
  assert.ok(r.byLayer.tts.failed >= 1, JSON.stringify(r.byLayer))
  assert.ok(r.byLayer.asr.failed === 0)
  assert.ok(r.summaryByLayer.vad.length >= 2)
})

/* ==================== the no-data rule ==================== */

t('an unmeasured metric is no-data, never pass', () => {
  const r = evaluateVoice(good({ tts: { termPronunciation: null } }))
  const c = r.checks.find(x => x.id === 'pronunciation')
  assert.strictEqual(c.outcome, 'no-data')
  assert.ok(c.outcome !== 'pass')
})

t('a run where nothing could be measured is no-data overall, not pass', () => {
  const m = good()
  // Wipe every measurement. This is what a transcript-only run looks like when
  // it is honestly reported, and it must never read as a green light.
  const empty = {
    ...m,
    asr: { wer: null, criticalMishears: [], turnCountDelta: null },
    tts: { firstAudioLatencyMs: null, turnGapMs: null, termPronunciation: null, prosodyNaturalness: null, clipRate: null },
    vad: { bargeInStopLatencyMs: null, overTalk: false, falseInterrupts: 0, selfHungUp: false, deadAirMs: null },
  }
  const r = evaluateVoice(empty)
  assert.strictEqual(r.outcome, 'no-data', r.summary)
  assert.ok(/NO DATA/.test(r.summary), r.summary)
})

t('partial coverage is inconclusive, not pass and not fail', () => {
  const r = evaluateVoice(good({ tts: { firstAudioLatencyMs: null } }))
  assert.strictEqual(r.outcome, 'inconclusive')
  assert.ok(/INCONCLUSIVE/.test(r.summary))
})

t('a real failure outranks an unmeasured metric', () => {
  const r = evaluateVoice(good({ tts: { termPronunciation: null, firstAudioLatencyMs: 5000 } }))
  assert.strictEqual(r.outcome, 'fail')
})

/* ==================== thresholds ==================== */

t('barge-in latency over budget fails', () => {
  const r = evaluateVoice(good({ vad: { bargeInStopLatencyMs: DEFAULT_VOICE_BUDGET.vad.maxBargeInStopLatencyMs + 1 } }))
  assert.strictEqual(r.outcome, 'fail')
  assert.ok(r.summaryByLayer.vad.some(s => s.includes('Barge-in')))
})

t('over-talking is a failure in its own right', () => {
  // No number: the agent simply kept reading its script over the caller. This
  // is the single most-complained-about live voice agent behaviour and it has
  // no latency value to grade.
  const r = evaluateVoice(good({ vad: { overTalk: true } }))
  assert.strictEqual(r.outcome, 'fail')
  assert.ok(r.summaryByLayer.vad.some(s => s.includes('script-marching')), JSON.stringify(r.summaryByLayer.vad))
})

t('a backchannel false interrupt is caught', () => {
  const r = evaluateVoice(good({ vad: { falseInterrupts: 1 } }))
  assert.strictEqual(r.outcome, 'fail')
  assert.ok(r.summaryByLayer.vad.some(s => s.includes('backchannel')))
})

t('self-hanging up on silence is caught', () => {
  const r = evaluateVoice(good({ vad: { selfHungUp: true } }))
  assert.strictEqual(r.outcome, 'fail')
  assert.ok(r.summaryByLayer.vad.some(s => s.includes('ended the call')))
})

t('a self-hangup can be waived by policy', () => {
  // Some deployments genuinely want the agent to hang up on silence. The budget
  // has to be able to say so, or every such customer has to ignore the gate.
  const r = evaluateVoice(good({ vad: { selfHungUp: true } }), { ...DEFAULT_VOICE_BUDGET, vad: { ...DEFAULT_VOICE_BUDGET.vad, noSelfHangup: false } })
  assert.notStrictEqual(r.outcome, 'fail')
})

t('a critical mishear fails even with a good WER', () => {
  // WER is a percentage and it averages away the one thing that matters: the
  // agent heard "PR12610000" as "PR 126 100" and stated a wrong RERA number
  // confidently. The count has to be gated separately.
  const r = evaluateVoice(good({ asr: { wer: 0.04, criticalMishears: ['RERA number PR12610000'] } }))
  assert.strictEqual(r.outcome, 'fail')
  assert.ok(r.summaryByLayer.asr.some(s => s.includes('RERA')))
})

t('a bad behavioural verdict fails the voice gate too', () => {
  // The layers roll up to one outcome. A caller does not experience a blend of
  // "excellent audio, terrible answers" — they experienced a bad call.
  const r = evaluateVoice(good({ llm: { verdict: 'bad' } }))
  assert.strictEqual(r.outcome, 'fail')
})

t('a mixed verdict is surfaced but does not fail the gate on its own', () => {
  const r = evaluateVoice(good({ llm: { verdict: 'mixed' } }))
  assert.notStrictEqual(r.outcome, 'fail')
  assert.ok(r.checks.find(c => c.id === 'llmVerdict').outcome === 'skip')
})

/* ==================== the worst layer wins ==================== */

t('a perfect LLM score cannot offset a three-second barge-in', () => {
  const r = evaluateVoice(good({ vad: { bargeInStopLatencyMs: 3000 } }))
  assert.strictEqual(r.outcome, 'fail')
})

t('every layer is accounted for in the rollup', () => {
  const r = evaluateVoice(good())
  for (const l of LAYERS) {
    assert.ok(r.byLayer[l], `layer ${l} missing from the rollup`)
    assert.ok(typeof r.byLayer[l].total === 'number')
  }
  assert.strictEqual(Object.keys(r.byLayer).length, LAYERS.length)
})

/* ==================== reproducibility ==================== */

t('the same persona and version always give the same fingerprint', () => {
  const p = PERSONA_LIBRARY[0]
  assert.strictEqual(runFingerprint(p, 'v1'), runFingerprint(p, 'v1'))
})

t('a different version gives a different fingerprint', () => {
  const p = PERSONA_LIBRARY[0]
  assert.notStrictEqual(runFingerprint(p, 'v1'), runFingerprint(p, 'v2'))
})

t('a different persona gives a different fingerprint', () => {
  assert.notStrictEqual(runFingerprint(PERSONA_LIBRARY[0], 'v1'), runFingerprint(PERSONA_LIBRARY[1], 'v1'))
})

t('changing a single acoustic knob changes the fingerprint', () => {
  // This is what makes a voice failure reproducible rather than anecdotal: the
  // knobs are the identity, so "the same caller" means the same caller.
  const base = { ...PERSONA_LIBRARY[0] }
  const faster = { ...base, speakingRate: base.speakingRate + 0.01 }
  const noisier = { ...base, noiseFloor: base.noiseFloor + 0.01 }
  const lossier = { ...base, packetLoss: base.packetLoss + 0.01 }
  const f = runFingerprint(base, 'v1')
  assert.notStrictEqual(runFingerprint(faster, 'v1'), f)
  assert.notStrictEqual(runFingerprint(noisier, 'v1'), f)
  assert.notStrictEqual(runFingerprint(lossier, 'v1'), f)
})

/* ==================== the persona library ==================== */

t('the persona library covers the axes that break agents', () => {
  const langs = new Set(PERSONA_LIBRARY.map(p => p.language))
  const regs = new Set(PERSONA_LIBRARY.map(p => p.register))
  assert.ok(langs.has('hinglish'), 'no Hinglish caller')
  assert.ok(langs.has('hi'), 'no Hindi-only caller')
  assert.ok(regs.has('angry'), 'no angry caller')
  assert.ok(regs.has('elderly'), 'no elderly caller')
  assert.ok(PERSONA_LIBRARY.some(p => p.noiseFloor > 0.5), 'no noisy-channel caller')
  assert.ok(PERSONA_LIBRARY.some(p => p.packetLoss > 0.15), 'no lossy-network caller')
})

t('every persona is fully parameterised, with no missing knob', () => {
  for (const p of PERSONA_LIBRARY) {
    for (const k of ['speakingRate', 'noiseFloor', 'backchannelRate', 'interruptionRate', 'silenceRate', 'packetLoss']) {
      assert.strictEqual(typeof p[k], 'number', `${p.id}.${k} is not a number`)
      assert.ok(p[k] >= 0 && p[k] <= 1, `${p.id}.${k} out of range: ${p[k]}`)
    }
    assert.ok(Array.isArray(p.mispronounces), `${p.id} has no mispronunciation list`)
    assert.ok(Array.isArray(p.behaviour), `${p.id} has no behaviour list`)
    assert.ok(p.voiceTag, `${p.id} has no voice tag — pronunciation findings could not be reproduced`)
    assert.ok(Number.isInteger(p.seed), `${p.id} has no seed`)
  }
})

t('persona ids are unique', () => {
  const ids = PERSONA_LIBRARY.map(p => p.id)
  assert.strictEqual(new Set(ids).size, ids.length)
})

/* ==================== budgets have provenance ==================== */

t('the barge-in budget is derived from the human reference, not a round number', () => {
  // TurnBench (arXiv 2608.25218) reports humans beginning a turn transfer a
  // median 151 ms BEFORE the turn ends, and an interrupted speaker taking a
  // median 1.48 s to cede the floor. A stop budget has to sit between those
  // two anchors to be defensible: below the cede figure it fails every
  // human-like agent, above the anticipatory figure it stops grading anything
  // a real deployment would call slow.
  const budget = DEFAULT_VOICE_BUDGET.vad.maxBargeInStopLatencyMs
  assert.ok(budget < HUMAN_REFERENCE.interruptionCedeMs,
    `stop budget ${budget} must be tighter than the human cede time ${HUMAN_REFERENCE.interruptionCedeMs}`)
  assert.ok(budget > Math.abs(HUMAN_REFERENCE.anticipatoryTurnStartMs),
    `stop budget ${budget} must be looser than the anticipatory start ${HUMAN_REFERENCE.anticipatoryTurnStartMs}`)
})

t('the human reference carries a citation', () => {
  // A gate target with no provenance is an opinion with a checkbox. If the
  // source is removed the numbers become unsupportable, so this fails.
  assert.ok(HUMAN_REFERENCE.source.length > 20, 'the reference must name its source')
  assert.match(HUMAN_REFERENCE.source, /TurnBench|arXiv|Stivers/)
})

t('the human reference reports an anticipatory start, not a reactive one', () => {
  // The sign is the finding. Humans start before the turn ends; a positive
  // value here would mean the reference had been silently rewritten to
  // describe a reactive system, which is the opposite of what the paper says.
  assert.ok(HUMAN_REFERENCE.anticipatoryTurnStartMs < 0,
    `expected a negative (anticipatory) offset, got ${HUMAN_REFERENCE.anticipatoryTurnStartMs}`)
  assert.strictEqual(HUMAN_REFERENCE.anticipatoryTurnStartMs, -151)
  assert.strictEqual(HUMAN_REFERENCE.interruptionCedeMs, 1480)
})

t('a default gate is not so tight that a good agent fails it', () => {
  // The failure mode of a strict default: every team is red on day one, the
  // gate gets disabled, and then it protects nothing. The default has to be
  // achievable by a competent agent before it is a useful control.
  const budget = DEFAULT_VOICE_BUDGET.vad.maxBargeInStopLatencyMs
  const competent = 600
  const r = evaluateVoice(good({ vad: { bargeInStopLatencyMs: competent } }))
  assert.notStrictEqual(r.outcome, 'fail', `a ${competent}ms cede should pass a ${budget}ms budget`)
})

t('a default gate still catches the failure the research documents', () => {
  // The in-budget systems on TurnBench run 368-1234 ms. The top of that range
  // must fail, or the gate is not measuring the thing it claims to.
  const r = evaluateVoice(good({ vad: { bargeInStopLatencyMs: 1200 } }))
  assert.strictEqual(r.outcome, 'fail')
})

t('the dead-air budget is below where real calls sit, or it is not a gate', () => {
  // Measured on 400 real call-centre transcripts (CallCenterEN / AIxBlock 92k):
  // 97% contain a silence of 4s or longer, median longest-silence 14.4s, p90
  // 44.4s. Those are think-pauses and hold music, not dead air.
  //
  // A budget of 4000ms therefore fires on almost every real call. The rule gets
  // disabled in week two, and a disabled rule discredits the barge-in and
  // latency rules sitting next to it. So the budget has to sit well under the
  // real distribution — and it measures silence after a completed turn, which
  // is a stricter object than raw silence.
  const budget = DEFAULT_VOICE_BUDGET.vad.maxDeadAirMs
  assert.ok(budget <= 2000,
    `dead-air budget ${budget}ms sits inside the real distribution of natural silences`)

  // And it must still catch a genuine hang: 5s of nothing after the agent
  // stopped talking is a dropped call, not a pause.
  const r = evaluateVoice(good({ vad: { deadAirMs: 5000 } }))
  assert.strictEqual(r.outcome, 'fail', 'a 5s gap after a turn is still a failure')
})

t('a natural pause does not fail the gate', () => {
  // The counterpart. If 800ms of thinking time failed the gate, the gate would
  // be wrong in the other direction — and 800ms is the p90 inter-word silence
  // in real calls, so it is not an unusual amount of silence.
  const r = evaluateVoice(good({ vad: { deadAirMs: 800 } }))
  assert.notStrictEqual(r.outcome, 'fail', 'a normal pause must not fail the gate')
})

/* ==================== provenance is declared, not implied ==================== */

t('every budget parameter is declared measured or conventional', () => {
  // The gate can only report the difference between a measured threshold and an
  // assumed one if the difference is recorded. Missing keys are the failure:
  // an undeclared parameter reads as validated.
  for (const [layer, params] of Object.entries(BUDGET_PROVENANCE)) {
    const actual = Object.keys(DEFAULT_VOICE_BUDGET[layer] ?? {})
    const declared = Object.keys(params)
    assert.deepStrictEqual(declared.sort(), actual.sort(),
      `${layer}: declared provenance does not match the budget's actual keys`)
  }
})

t('a parameter marked measured must cite the measurement', () => {
  for (const [layer, params] of Object.entries(BUDGET_PROVENANCE)) {
    for (const [param, kind] of Object.entries(params)) {
      if (kind !== 'measured') continue
      assert.ok(BUDGET_SOURCES[param], `${param} is marked measured but cites nothing`)
      assert.ok(BUDGET_SOURCES[param].length > 30,
        `${param} needs a real citation, not a placeholder`)
      assert.ok(/\d/.test(BUDGET_SOURCES[param]), `${param}'s citation carries no number`)
    }
  }
})

t('the measured budgets stay pinned to their sources', () => {
  // If either of these numbers moves, the citation has to move with it. This is
  // what stops a threshold being quietly retuned until it stops being annoying.
  assert.strictEqual(DEFAULT_VOICE_BUDGET.vad.maxBargeInStopLatencyMs, 800)
  assert.strictEqual(DEFAULT_VOICE_BUDGET.vad.maxDeadAirMs, 2000)
  assert.match(BUDGET_SOURCES.maxBargeInStopLatencyMs, /151|1\.48/)
  assert.match(BUDGET_SOURCES.maxDeadAirMs, /94%|4s/)
})

t('the conventional budgets are honestly labelled, not presented as measured', () => {
  // Six of the ten are assumptions. That is fine — they are negotiation
  // starting points — but a customer reading a gate report must be able to tell
  // which numbers came from a corpus and which came from judgement.
  const conventional = []
  for (const params of Object.values(BUDGET_PROVENANCE)) {
    for (const [k, v] of Object.entries(params)) if (v === 'conventional') conventional.push(k)
  }
  assert.ok(conventional.length >= 6,
    `expected most budgets to still be conventional, found ${conventional.length}`)
  assert.ok(conventional.includes('maxWer'), 'WER is unmeasured and must say so')
  assert.ok(!conventional.includes('maxBargeInStopLatencyMs'), 'barge-in IS measured')
})

/* ==================== coverage reporting ==================== */

t('coverage is stated in runs, not in vague claims', () => {
  const c = describeCoverage(12)
  assert.strictEqual(c.runs, 12 * PERSONA_LIBRARY.length)
  assert.ok(c.layers.includes('vad'))
  assert.ok(c.languages.includes('hinglish'))
  assert.ok(/without audio/.test(c.note), 'the audio limitation is not disclosed')
})

t('the matrix size is scenarios x personas', () => {
  assert.strictEqual(matrixSize(12), 12 * PERSONA_LIBRARY.length)
  assert.strictEqual(matrixSize(0), 0)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

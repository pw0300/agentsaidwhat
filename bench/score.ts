import { FAULTS, type Call } from './faults'
import { random } from './generate'
import { profileNaturalness } from '../api/_naturalness'
import { evaluateVoice, type VoiceMeasurement } from '../api/_voicebench'
import { selectJudges, judgeWithPanel, type JudgeOpinion } from '../api/_judgepanel'
import { buildRequest, extractText, type ProviderId } from '../api/_judge'

export interface Prediction { id: string; layer: string; evidence: string }
export interface ScoredCall { call: Call; predictions: Prediction[]; measured: boolean }
export const SUPPORTED = ['loop-repeat', 'talked-over-caller', 'false-endpoint', 'long-gap', 'early-hangup']

// Deliberately has no access to the hidden injection ledger, domain or call id.
export function detect(input: Pick<Call, 'turns' | 'hangup'>) {
  const { turns, hangup } = input
  const profile = profileNaturalness(turns)
  const gaps = turns.slice(1).filter(t => t.role === 'agent').map(t => t.startMs - turns[turns.indexOf(t) - 1].endMs)
  const overlap = turns.some((t, i) => t.role === 'agent' && i > 0 && t.startMs < turns[i - 1].endMs)
  const m: VoiceMeasurement = {
    personaId: 'constructed', agentId: 'fixture', versionId: 'fixture', ranAt: '',
    asr: { wer: null, criticalMishears: [], turnCountDelta: null },
    tts: { firstAudioLatencyMs: null, turnGapMs: null, termPronunciation: null, prosodyNaturalness: null, clipRate: null },
    vad: { bargeInStopLatencyMs: null, overTalk: overlap, falseInterrupts: 0,
      selfHungUp: !!hangup && hangup.initiatedBy === 'agent' && turns.at(-1)?.role === 'caller', deadAirMs: gaps.length ? Math.max(0, ...gaps) : null },
    llm: { verdict: null, scores: {}, goalAchieved: null, findings: [] },
  }
  const voice = evaluateVoice(m)
  // Mask boolean checks without evidence. No zero-filled audio measurement is a pass.
  const checks = voice.checks.map(c => ({ ...c, outcome: c.id === 'falseInterrupts' || c.id === 'mishears' || (c.id === 'selfHangup' && !hangup) ? 'no-data' : c.outcome }))
  const mapping: Record<string, string> = { overtalk: 'talked-over-caller', deadAir: 'long-gap', selfHangup: 'early-hangup' }
  const predictions: Prediction[] = checks.filter(c => c.outcome === 'fail' && mapping[c.id]).map(c => ({ id: mapping[c.id], layer: c.layer, evidence: c.detail }))
  const repetition = profile.signals.find(s => s.id === 'structuralRepetition')
  if (repetition?.status === 'high') predictions.push({ id: 'loop-repeat', layer: 'llm', evidence: repetition.detail })
  const cut = turns.find(t => t.role === 'caller' && t.endpointMs !== undefined && t.endpointMs < t.endMs)
  if (cut) predictions.push({ id: 'false-endpoint', layer: 'vad', evidence: `Endpoint ${cut.endpointMs} before caller end ${cut.endMs}` })
  return { predictions, checks, naturalness: profile, measures: 'Existing naturalness repetition band and voice budget checks on constructed transcript/turn telemetry; new endpoint comparison. No audio probe is runnable without audio. ASR is NOT MEASURED: comparing generated heardText to generated truth is circular. Timing faults are measured on exact synthetic timings and are easier than real calls.' }
}

export function counts(rows: ScoredCall[], id?: string) {
  let tp = 0, fp = 0, fn = 0, attributed = 0
  for (const r of rows.filter(r => r.measured)) {
    const truth = r.call.faults.filter(f => !id || f.id === id)
    const pred = [...new Map(r.predictions.filter(p => !id || p.id === id).map(p => [p.id, p])).values()]
    for (const f of truth) { const p = pred.find(p => p.id === f.id); if (p) { tp++; attributed += Number(p.layer === f.expectedLayer) } else fn++ }
    fp += pred.filter(p => !truth.some(f => f.id === p.id)).length
  }
  return { tp, fp, fn, attributed }
}
type Metric = { status: string; n: number; value?: number; ci95?: [number, number] }
const stat = (c: ReturnType<typeof counts>, kind: string): [number, number] => {
  if (kind === 'precision') return [c.tp, c.tp + c.fp]
  if (kind === 'recall') return [c.tp, c.tp + c.fn]
  if (kind === 'attribution') return [c.attributed, c.tp]
  return [2 * c.tp, 2 * c.tp + c.fp + c.fn]
}
export function metric(rows: ScoredCall[], kind: string, id?: string, iterations = 2000): Metric {
  const usable = rows.filter(r => r.measured)
  if (!usable.length) return { status: 'NOT MEASURED', n: 0 }
  const c = counts(usable, id)
  const [num, denominator] = stat(c, kind)
  // F1 support counts unique truth/prediction events, not double-weighted TP.
  const n = kind === 'f1' ? c.tp + c.fp + c.fn : denominator
  if (n < 20) return { status: 'INSUFFICIENT SAMPLE', n }
  const rng = random(73129), samples: number[] = []
  for (let b = 0; b < iterations; b++) {
    const resampled = usable.map(() => usable[Math.floor(rng() * usable.length)])
    const [a, d] = stat(counts(resampled, id), kind)
    if (d) samples.push(a / d)
  }
  samples.sort((a, b) => a - b)
  return { status: 'MEASURED', n, value: num / denominator, ci95: [samples[Math.floor((samples.length - 1) * 0.025)], samples[Math.floor((samples.length - 1) * 0.975)]] }
}
export function cleanFpr(rows: ScoredCall[], iterations = 2000, id?: string): Metric {
  const clean = rows.filter(r => r.measured && !r.call.faults.length)
  if (!clean.length) return { status: rows.some(r => r.measured) ? 'INSUFFICIENT SAMPLE' : 'NOT MEASURED', n: 0 }
  if (clean.length < 20) return { status: 'INSUFFICIENT SAMPLE', n: clean.length }
  const positive = (r: ScoredCall) => r.predictions.some(p => !id || p.id === id)
  const rng = random(912), values: number[] = []
  for (let b = 0; b < iterations; b++) values.push(clean.reduce(sum => sum + Number(positive(clean[Math.floor(rng() * clean.length)])), 0) / clean.length)
  values.sort((a, b) => a - b)
  return { status: 'MEASURED', n: clean.length, value: clean.filter(positive).length / clean.length, ci95: [values[Math.floor((values.length - 1) * 0.025)], values[Math.floor((values.length - 1) * 0.975)]] }
}
export function report(rows: ScoredCall[]) {
  const originalRows = rows
  rows = rows.map(r => ({ ...r, call: { ...r.call, faults: r.call.faults.filter(f => f.id !== 'asr-mishear') }, predictions: r.predictions.filter(p => p.id !== 'asr-mishear') }))
  const asrNotMeasured = { status: 'NOT MEASURED', reason: 'Comparing generated heardText to generated truth is circular; no independent ASR recognition evidence exists.', counts: { tp: 0, fp: 0, fn: 0, attributed: 0 }, precision: { status: 'NOT MEASURED', n: 0 }, recall: { status: 'NOT MEASURED', n: 0 }, f1: { status: 'NOT MEASURED', n: 0 }, layerAccuracy: { status: 'NOT MEASURED', n: 0 }, cleanFalsePositiveRate: { status: 'NOT MEASURED', n: 0 } }

  const summarize = (id?: string) => ({ counts: counts(rows, id), precision: metric(rows, 'precision', id), recall: metric(rows, 'recall', id), f1: metric(rows, 'f1', id), layerAccuracy: metric(rows, 'attribution', id), cleanFalsePositiveRate: cleanFpr(originalRows, 2000, id) })
  const confusion: Record<string, Record<string, number>> = {}
  const add = (truth: string, predicted: string) => { confusion[truth] ??= {}; confusion[truth][predicted] = (confusion[truth][predicted] ?? 0) + 1 }
  for (const r of rows.filter(r => r.measured)) {
    for (const f of r.call.faults) add(f.expectedLayer, r.predictions.find(p => p.id === f.id)?.layer ?? 'MISSED')
    for (const p of r.predictions) if (!r.call.faults.some(f => f.id === p.id)) add('NO FAULT', p.layer)
  }
  return { evaluatedCalls: rows.filter(r => r.measured).length, overall: summarize(), faults: Object.fromEntries(FAULTS.map(f => [f.id, f.id === 'asr-mishear' ? asrNotMeasured : summarize(f.id)])), cleanFalsePositiveRate: cleanFpr(originalRows), layerConfusion: { status: rows.some(r => r.measured) ? 'RAW COUNTS, NOT RATE ESTIMATES' : 'NOT MEASURED', counts: confusion } }
}

export async function judgeCall(call: Call, mode: 'none' | 'panel', env: Record<string, string | undefined> = process.env, request = fetch) {
  const providers = mode === 'panel' ? selectJudges(env) : []
  const opinions: JudgeOpinion[] = []
  const predictionsByProvider = new Map<string, Prediction[]>()
  for (const provider of providers) {
    try {
      const system = `Evaluate the call against its facts and policy. Return JSON {verdict: good|mixed|bad, summary: string, faults: [{id, layer, evidence}]}. Report only supported evidence. Fault ids and definitions: ${JSON.stringify(FAULTS.map(({ id, description, layer }) => ({ id, description, layer })))}. Never infer acoustic faults from text.`
      const user = JSON.stringify({ context: call.context, turns: call.turns, hangup: call.hangup })
      const req = buildRequest(provider as ProviderId, system, user, 2000)
      const response = await request(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(60000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const raw = extractText(provider as ProviderId, await response.json()).trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
      const parsed = JSON.parse(raw)
      if (!['good', 'mixed', 'bad'].includes(parsed.verdict) || !Array.isArray(parsed.faults)) throw new Error('Unusable judge schema')
      const predictions: Prediction[] = parsed.faults
      if (predictions.some(p => !FAULTS.some(f => f.id === p.id) || !['prompt', 'asr', 'llm', 'tts', 'vad', 'telecom'].includes(p.layer) || typeof p.evidence !== 'string' || !p.evidence.trim())) throw new Error('Invalid finding')
      if ((parsed.verdict === 'good') !== (predictions.length === 0)) throw new Error('Verdict and findings disagree')
      predictionsByProvider.set(provider, predictions)
      opinions.push({ provider, ok: true, verdict: parsed.verdict, summary: parsed.summary ?? '', goalAchieved: null, scores: [], findings: [], error: '' })
    } catch (error) { opinions.push({ provider, ok: false, verdict: undefined, summary: '', goalAchieved: null, scores: [], findings: [], error: String(error) }) }
  }
  const panel = judgeWithPanel(opinions)
  const predictions = panel.decision ? predictionsByProvider.get(panel.decision.provider)! : []
  return { status: panel.decision ? 'MEASURED' : 'NOT MEASURED', predictions, panel,
    interpretation: 'Existing panel verdict agreement selects the first answering opinion. Fault-level agreement is not established; a single provider is explicitly single.' }
}

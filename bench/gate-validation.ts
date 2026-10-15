import { evaluate, type GatePolicy } from '../api/_gate'
import { rollUp } from '../api/_suite'
import { generate } from './generate'

export function validateGate() {
  const calls = generate(8821, 30).calls
  const version = (accuracy: number, naturalness: number, recovery: number) => calls.map(c => ({
    callId: c.id, ok: true, verdict: 'good' as const, goalAchieved: true, findings: [], error: '',
    scores: Object.entries({ accuracy, naturalness, recovery }).map(([paramId, value]) => ({ paramId, value })),
  }))
  const v1 = version(4, 3, 3), v2 = version(2, 5, 5)
  const baseline = rollUp(v1), candidate = rollUp(v2)
  const policy: GatePolicy = { id: 'constructed-gate', name: 'Constructed parameter regression', agentId: 'fixture', enabled: true,
    minComposite: 3, minParams: { accuracy: 3.5 }, maxBlockers: 0, minSamples: 20, maxRegression: 0.5, baselineVersionNumber: 1 }
  const input = (r: typeof baseline, previous: typeof baseline | null) => ({ paramAverages: r.paramAverages, paramSamples: { accuracy: r.samples },
    paramNames: { accuracy: 'Accuracy' }, composite: r.composite, samples: r.samples, blockerFindings: r.blockerFindings,
    baseline: previous ? { composite: previous.composite, paramAverages: previous.paramAverages } : null, baselineVersionLabel: previous ? 'v1' : null })
  const before = evaluate(policy, input(baseline, null)), after = evaluate(policy, input(candidate, baseline))
  if (before.outcome !== 'pass' || after.outcome !== 'fail' || !(candidate.composite! > baseline.composite!) || after.checks.filter(c => c.outcome === 'fail').map(c => c.id).join() !== 'param:accuracy') throw new Error('Gate failed to isolate the constructed accuracy regression')
  return { measures: 'Pure release gate and suite aggregation behavior on constructed score inputs. These are not detector or judge quality scores. v2 reduces accuracy while improving the other parameters on the same generated call ids.', source: 'bench/gate-validation.ts', calls, v1, v2, policy, baseline, candidate, before, after }
}

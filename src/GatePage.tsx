import { adapterLabel } from './adapters'
import { DEMO_MODE } from './mode'
import { useState } from 'react'
import { EmptyState } from './nav'
import { useStore } from './store'
import { measureGate, defaultGatePolicy } from '../api/_measure'
import type { GatePolicy } from '../api/_gate'
import { gateArtifacts } from './gateArtifacts'

type Status = 'pass' | 'fail' | 'unknown'

interface Row {
  name: string
  status: Status
  /** The number, when there is one. Absent means there is not a number. */
  value?: string
  /** Where the threshold came from. Absent means it is an assumption. */
  source?: string
  /** Why a row is unmeasured. Required whenever status is 'unknown'. */
  why?: string
}

interface Verdict {
  candidate?: string
  provenance?: string
  synthetic?: boolean
  measurements?: Record<string, any>
}

export default function GatePage() {
  const { state, mutate } = useStore()
  const [agentId, setAgentId] = useState(state.agents[0]?.id ?? '')
  const versions = state.versions.filter(v => v.agentId === agentId)
  const [chosenVersion, setVersion] = useState('')
  const versionId = versions.some(v => v.id === chosenVersion) ? chosenVersion : versions[0]?.id
  const policy = state.gates?.find(p => p.agentId === agentId) ?? defaultGatePolicy(agentId)
  const updatePolicy = (patch: Partial<GatePolicy>) => mutate(d => {
    d.gates ??= []
    const existing = d.gates.find(p => p.agentId === agentId)
    if (existing) Object.assign(existing, patch)
    else d.gates.push({ ...policy, ...patch })
  })
  const measurement = measureGate(state as unknown as Record<string, unknown>, agentId, versionId)
  const verdict: Verdict | null = gateArtifacts.evidence
  const asr = gateArtifacts.asr
  const audio = gateArtifacts.audio

  const m = verdict?.measurements ?? {}
  const bi = m.bargeIn ?? {}
  const fc = m.falseCutoff ?? {}

  const rows: Row[] = [
    bargeInRow(bi),
    cutoffRow(fc),
    asrRow(asr),
    naturalnessRow(m.naturalness),
    ttsQualityRow(audio),
    {
      name: 'ASR as a release gate',
      status: 'unknown',
      why: 'The engine is calibrated against human transcripts, which bounds what the audio costs. It is not an agent mishearing a caller ; that needs a live call.',
    },
    {
      name: 'Audio quality scoring',
      status: 'unknown',
      why: audio
        ? `Measured and rejected: the model correlates ${audio.pearson} with human MOS (CI ${audio.pearson_ci95?.[0]} to ${audio.pearson_ci95?.[1]}, includes zero), and a 0.5-MOS difference arrives below its own noise floor.`
        : 'No audio audit has been run.',
    },
  ]

  const measured = rows.filter(r => r.status !== 'unknown')
  const unknown = rows.filter(r => r.status === 'unknown')
  const failing = measured.filter(r => r.status === 'fail')

  return (
    <div className="page gate-page">
      <header className="page-head">
        <h2>Release gate</h2>
        <p className="muted">
          What this product can actually prove about an agent, and what it cannot.
          Unmeasured rows are listed as loudly as measured ones, because a gate that
          hides its own gaps is how a regression ships.
        </p>
      </header>

      <section className="card">
        <h3>Workspace release decision</h3>
        {DEMO_MODE && <p className="muted">Sample scores are illustrative. Install locally to evaluate your own release.</p>}
        <div className="gate-pickers">
        <label className="field">Choose agent <select value={agentId} onChange={e => { setAgentId(e.target.value); setVersion('') }}>
          {state.agents.map(a => <option key={a.id} value={a.id}>{adapterLabel(a.name)}</option>)}
        </select></label>
        <label className="field">Choose version <select value={versionId ?? ''} onChange={e => setVersion(e.target.value)}>
          {versions.map(v => <option key={v.id} value={v.id}>v{v.number}</option>)}
        </select></label>
        </div>
        {'error' in measurement ? <p role="status">{measurement.error}</p> : <>
          <p className={`gate-verdict ${measurement.result.outcome}`}>{measurement.result.outcome.toUpperCase()}</p>
          <p>{measurement.result.summary.replace(/\u2014/g, ';')}</p>
          <p className="muted">{measurement.humanSessions} human sessions, {measurement.aiCalls} automated calls. Missing evidence cannot pass.</p>
          <ul>{measurement.result.checks.map(c => <li key={c.id}>{c.label}: {c.outcome === 'skip' ? 'NOT MEASURED' : c.outcome.toUpperCase()}. {c.detail}</li>)}</ul>
        </>}
        {agentId && <fieldset disabled={DEMO_MODE}>
          <legend>Gate policy (saved to this workspace)</legend>
          <label><input type="checkbox" checked={policy.enabled} onChange={e => updatePolicy({ enabled: e.target.checked })} /> Enable gate</label>
          <div className="gate-policy-grid">
          {([
            ['Minimum samples', 'minSamples', 1, 1, undefined],
            ['Maximum blockers', 'maxBlockers', 0, 1, undefined],
            ['Maximum regression', 'maxRegression', 0, 0.1, 5],
            ['Minimum composite', 'minComposite', 0, 0.1, 5],
          ] as const).map(([label, key, min, step, max]) => <label className="field" key={key}>{label}
            <input type="number" min={min} max={max} step={step} value={policy[key] ?? ''} onChange={e => {
              const value = e.target.value === '' ? null : Number(e.target.value)
              if (value !== null && (!Number.isFinite(value) || value < min || (max !== undefined && value > max) || (step === 1 && !Number.isInteger(value)))) return
              if (key === 'minSamples' && value === null) return
              updatePolicy({ [key]: value })
            }} />
          </label>)}
          <label className="field">Baseline version <select value={policy.baselineVersionNumber ?? ''} onChange={e => updatePolicy({ baselineVersionNumber: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Previous version</option>{versions.map(v => <option key={v.id} value={v.number}>v{v.number}</option>)}
          </select></label>
          {state.rubric.map(p => <label className="field" key={p.id}>{p.name} minimum
            <input type="number" min={0} max={5} step={0.1} value={policy.minParams[p.id] ?? ''} onChange={e => {
              const floors = { ...policy.minParams }
              if (!e.target.value) delete floors[p.id]
              else { const value = Number(e.target.value); if (!Number.isFinite(value) || value < 0 || value > 5) return; floors[p.id] = value }
              updatePolicy({ minParams: floors })
            }} />
          </label>)}
          </div>
        </fieldset>}
      </section>
      <h3>Committed research measurements</h3>
      <p className="muted">Bundled artifact snapshots describe their own datasets, not the selected agent or version. Rebuild from a checkout to update them. They do not approve this workspace release.</p>

      {verdict?.candidate && (
        <div className="candidate">
          <strong>{verdict.candidate}</strong>
          {verdict.provenance && <span className="muted"> · {verdict.provenance}</span>}
        </div>
      )}

      <section>
        <h3>Measured</h3>
        {measured.length === 0 ? (
          <EmptyState icon="Measurements" title="No measurements yet" body="Set up analysis before reviewing a release." actionLabel="Set up analysis" to="settings" />
        ) : (
          <ul className="rows">
            {measured.map(r => <li key={r.name} className={r.status}> <RowView row={r} /> </li>)}
          </ul>
        )}
      </section>

      <section>
        <h3>
          Not measured
          <span className="badge unknown">{unknown.length}</span>
        </h3>
        <p className="muted small">
          These are reported as gaps on purpose. None of them counts as a pass.
        </p>
        <ul className="rows">
          {unknown.map(r => (
            <li key={r.name} className="unknown">
              <RowView row={r} />
            </li>
          ))}
        </ul>
      </section>

      <section className="verdict-box">
        <h3>Verdict</h3>
        {failing.length > 0 ? (
          <>
            <p className="fail-line">
              {failing.length} measured check{failing.length === 1 ? '' : 's'} failing.
            </p>
            <p className="muted small">
              This is on the measurements that exist. It is not a release approval:
              {unknown.length} layer{unknown.length === 1 ? '' : 's'} are unmeasured, and
              an unmeasured layer cannot be assumed to pass.
            </p>
          </>
        ) : (
          <>
            <p className="unknown-line">
              No verdict. {measured.length} of {rows.length} layers have been measured.
            </p>
            <p className="muted small">
              A green gate on one measured layer is not a release approval. Until
              every layer either passes or fails with a reason, this product
              reports what it knows and stops.
            </p>
          </>
        )}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Row construction ; every row states its own provenance              */
/* ------------------------------------------------------------------ */

function bargeInRow(bi: Record<string, any>): Row {
  if (typeof bi.stopLatencyMs !== 'number') {
    return {
      name: 'Barge-in stop latency',
      status: 'unknown',
      why: bi.overTalk
        ? 'Over-talk: the agent kept talking through an interruption. That is a failure, not a missing measurement.'
        : 'No interruption in the evidence ; nothing to measure.',
    }
  }
  return {
    name: 'Barge-in stop latency',
    status: bi.stopLatencyMs <= 800 ? 'pass' : 'fail',
    value: `${Math.round(bi.stopLatencyMs)} ms`,
    source: 'Budget 800 ms, from TurnBench (arXiv 2608.25218) human turn-transfer timings.',
  }
}

function cutoffRow(fc: Record<string, any>): Row {
  if (!fc.measurable) {
    return { name: 'False cutoff rate', status: 'unknown', why: fc.note ?? 'Not measurable from this evidence.' }
  }
  const rate = fc.rate ?? 0
  if (fc.onsets < 5) {
    return {
      name: 'False cutoff rate',
      status: 'unknown',
      why: `${fc.onsets} agent onset${fc.onsets === 1 ? '' : 's'} is too few to gate a rate on.`,
      value: `${Math.round(rate * 100)}%`,
    }
  }
  return {
    name: 'False cutoff rate',
    status: rate <= 0.10 ? 'pass' : 'fail',
    value: `${Math.round(rate * 100)}% of ${fc.onsets} onsets`,
    source: 'Floor 10%, not zero: LiveKit’s Turn Detector reports ~9.9% at a 300 ms budget, so a 0% gate would fail every shipped system.',
  }
}

function asrRow(asr: any): Row {
  if (!asr) {
    return { name: 'Word error rate', status: 'unknown', why: 'No ASR engine wired.' }
  }
  const s = asr.wer_strict, l = asr.wer_loose
  if (s == null) {
    return { name: 'Word error rate', status: 'unknown', why: 'ASR run produced no words to score.' }
  }
  const worst = l ?? s
  return {
    name: 'Word error rate',
    status: worst <= 0.15 ? 'pass' : 'fail',
    value: `${(s * 100).toFixed(1)}–${((l ?? s) * 100).toFixed(1)}%`,
    source: `${asr.engine}, ${asr.n_recordings} Indic DiarBench recordings (CC BY 4.0). Range, not a point: the script-fold threshold has no safe value.`,
  }
}

function naturalnessRow(n: any): Row {
  if (!n) return { name: 'Naturalness signals', status: 'unknown', why: 'The evidence carried no transcript.' }
  const ok = n.verdict === 'natural'
  return {
    name: 'Naturalness signals',
    status: ok ? 'pass' : 'fail',
    value: ok ? `${n.agentTurns} agent turns inside the human bands` : undefined,
    source: 'Banded against real conversations? the worst signal is named, never averaged into a score.',
    why: ok ? undefined : n.failures?.[0]?.detail,
  }
}

function ttsQualityRow(audio: any): Row {
  return {
    name: 'Voice model calibration',
    status: audio && audio.significant_at_95 === false ? 'fail' : 'unknown',
    value: audio ? `r = ${audio.pearson} (95% CI ${audio.pearson_ci95?.[0]} to ${audio.pearson_ci95?.[1]})` : undefined,
    source: audio ? `${audio.n} SOMOS clips with human MOS ratings (CC BY-NC-SA 4.0).` : undefined,
    why: audio
      ? audio.significant_at_95 === false
        ? 'No demonstrated relationship with human judgement, so it cannot gate a release. This is the finding, not a gap.'
        : undefined
      : 'No calibration run.',
  }
}

/* ------------------------------------------------------------------ */

function RowView({ row }: { row: Row }) {
  return (
    <>
      <span className="row-name">{row.name}</span>
      {row.value && <span className="row-value">{row.value}</span>}
      {row.status === 'unknown'
        ? <span className="row-why">{row.why ?? 'Not measured.'}</span>
        : <span className="row-source">{row.source ?? 'Threshold has no measured source.'}</span>}
    </>
  )
}

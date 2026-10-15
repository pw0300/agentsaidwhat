import { useState } from 'react'
import { EmptyState } from './nav'

/**
 * The result half of the simulation bench, split out from the controls.
 *
 * Separated so it can be server-rendered in a test against a real API payload.
 * A component that only exists inside another file cannot be rendered in
 * isolation, and "it compiles" is not the same claim as "it displays a payload
 * the server actually produces" — the server can emit a field the view does
 * not read, and only rendering the real shape finds that.
 *
 * Every optional field is genuinely optional here. The suite endpoint degrades:
 * a scenario that could not run comes back with empty scores, no transcript and
 * an error string, and a suite where every scenario failed still has to render
 * something a person can read.
 */

export interface SimFinding {
  layer: string
  severity: string
  what: string
  evidence: string
  suggestedFix: string
}

export interface SimCall {
  scenarioId: string
  name: string
  difficulty: string
  language: string
  ok: boolean
  verdict: 'good' | 'mixed' | 'bad' | 'error'
  summary: string
  goalAchieved: boolean | null
  scores: { paramId: string; value: number }[]
  findings: SimFinding[]
  turns: number
  looped: boolean
  hitTurnLimit: boolean
  transcript: string
  error: string
}

export interface SimTheme {
  layer: string
  severity: string
  summary: string
  evidence: string
  suggestedFix: string
  calls: number
}

export interface SimResult {
  agentName: string
  ranAt: string
  verdict: string
  summary: string
  measured: { composite: number | null; paramAverages: Record<string, number | null>; samples: number; blockerFindings: number }
  coverage?: { total: number; behavioursExercised: string[]; byDifficulty?: Record<string, number> }
  themes: SimTheme[]
  calls: SimCall[]
}

export function SuiteResult({ result, onPromote }: { result: SimResult; onPromote: (f: SimFinding, scenario: string) => void }) {
  const [open, setOpen] = useState<string | null>(null)

  const calls = result.calls ?? []
  const passed = calls.filter(c => c.ok && c.verdict === 'good')
  const mixed = calls.filter(c => c.ok && c.verdict === 'mixed')
  const failed = calls.filter(c => c.ok && c.verdict === 'bad')
  const errored = calls.filter(c => !c.ok)
  const composite = result.measured?.composite ?? null

  return (
    <>
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Suite result</h2>
          <span className={`badge verdict-${result.verdict}`}>{result.verdict}</span>
          <div style={{ flex: 1 }} />
          <span className="muted">{result.ranAt ? new Date(result.ranAt).toLocaleString() : ''}</span>
        </div>
        <p style={{ marginBottom: 0 }}>{result.summary}</p>
        <div className="review-grid" style={{ marginTop: 10 }}>
          <div><span className="muted">Composite</span>{composite != null ? composite.toFixed(2) : '–'}</div>
          <div><span className="muted">Blocker findings</span>{result.measured?.blockerFindings ?? 0}</div>
          <div><span className="muted">Scenarios run</span>{result.coverage?.total ?? calls.length}</div>
          <div><span className="muted">Behaviours</span>{result.coverage?.behavioursExercised?.length ?? 0}</div>
        </div>
        {result.coverage?.behavioursExercised?.length ? (
          <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
            Exercised: {result.coverage.behavioursExercised.join(', ')}.
          </p>
        ) : null}
        {/* The honesty line. A simulator cannot hear prosody or measure
            barge-in latency, and a report that omits that reads as a stronger
            claim than it is. Stating the limit is what makes the rest of the
            number believable. */}
        <p className="muted" style={{ marginBottom: 0, marginTop: 6 }}>
          A simulator cannot hear prosody or measure barge-in latency — those still need real calls. Treat a green
          result as evidence, not proof.
        </p>
      </div>

      {(result.themes ?? []).length > 0 && (
        <div className="card">
          <h2>What broke, clustered</h2>
          {result.themes.map((t, i) => (
            <div key={i} className="verify-item" style={{ display: 'block' }}>
              <div className="row" style={{ gap: 6 }}>
                <span className={`badge ${t.severity}`}>{t.severity}</span>
                <span className={`badge layer-${t.layer}`}>{t.layer}</span>
                <strong>{t.summary}</strong>
                <div style={{ flex: 1 }} />
                <span className="muted">{t.calls} call{t.calls === 1 ? '' : 's'}</span>
              </div>
              {t.evidence && <div className="muted">"{t.evidence}"</div>}
              {t.suggestedFix && <div>🔧 {t.suggestedFix}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Calls ({calls.length})</h2>
        <div className="review-grid" style={{ marginBottom: 10 }}>
          <div><span className="muted">Good</span>✅ {passed.length}</div>
          <div><span className="muted">Mixed</span>➖ {mixed.length}</div>
          <div><span className="muted">Bad</span>❌ {failed.length}</div>
          <div><span className="muted">Could not run</span>⚠️ {errored.length}</div>
        </div>
        {calls.length === 0 && <EmptyState icon="Calls" title="No calls ran" body="Choose scenarios and run another simulation." actionLabel="Choose scenarios" to="simulate" />}
        {calls.map(c => (
          <div key={c.scenarioId} className="verify-item" style={{ display: 'block' }}>
            <div className="row">
              <span className={`badge verdict-${c.ok ? c.verdict : 'error'}`}>{c.ok ? c.verdict : 'error'}</span>
              <strong>{c.name}</strong>
              <span className="muted">{c.language} · {c.turns} turns</span>
              {c.looped && <span className="badge major">looped</span>}
              {c.hitTurnLimit && <span className="badge minor">hit turn limit</span>}
              <div style={{ flex: 1 }} />
              <button className="btn small secondary" onClick={() => setOpen(open === c.scenarioId ? null : c.scenarioId)}>
                {open === c.scenarioId ? 'Collapse' : 'Details'}
              </button>
            </div>
            {c.error && <p style={{ color: 'var(--bad)' }}>{c.error}</p>}
            {c.summary && <p style={{ margin: '6px 0 0' }}>{c.summary}</p>}
            {open === c.scenarioId && (
              <div style={{ marginTop: 8 }}>
                {c.scores.length > 0 && (
                  <div className="row" style={{ gap: 6, marginBottom: 6 }}>
                    {c.scores.map(s => <span key={s.paramId} className="badge draft">{s.paramId}: {s.value}</span>)}
                  </div>
                )}
                {c.findings.map((f, i) => (
                  <div key={i} style={{ marginTop: 8 }}>
                    <span className={`badge ${f.severity}`}>{f.severity}</span>{' '}
                    <span className={`badge layer-${f.layer}`}>{f.layer}</span>{' '}
                    <strong>{f.what}</strong>
                    {f.evidence && <div className="muted">"{f.evidence}"</div>}
                    {f.suggestedFix && <div>🔧 {f.suggestedFix}</div>}
                    {f.layer === 'simulation' ? (
                      <div className="muted" style={{ marginTop: 4 }}>
                        Caller-side artefact — not the agent's fault, and not promotable.
                      </div>
                    ) : (
                      <div style={{ marginTop: 4 }}>
                        <button className="btn small secondary" onClick={() => onPromote(f, c.name)}>→ Promote to Issue</button>
                      </div>
                    )}
                  </div>
                ))}
                {c.transcript && (
                  <>
                    <h3>Transcript</h3>
                    <div className="md" style={{ maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{c.transcript}</div>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

import { bad, checkDeployment, json } from './_lib'
import {
  DEFAULT_SCENARIOS, behaviourCount, coverage, customerSeed, customerSystemPrompt,
  judgeSystemPrompt, judgeUserPrompt, toTranscript, type Scenario, type SimulationTurn,
} from './_simulate'
import { classifyCall, gateSafe, rollUp, selectScenarios } from './_suite'
import {
  judgeWithPanel, selectJudges, suiteVerdictFor,
  type JudgeOpinion, type PanelJudgement,
} from './_judgepanel'
import { PROVIDERS, buildRequest, extractText, isRefusal } from './_judge'

export const config = { runtime: 'edge' }

/**
 * Run a whole scenario suite against a candidate prompt, unattended.
 *
 *   POST /api/simulate-suite  { agentName, prompt, scenarioIds?, rubric }
 *
 * This is the endpoint a pipeline calls and the one the product calls on its
 * own the moment a new prompt version is created. It exists separately from
 * /api/simulate so the two costs can be reasoned about: one call is a thing a
 * human does while debugging, a suite is a thing a machine does without being
 * asked. Keeping them apart also keeps a 12-scenario sweep from being
 * mistaken for a single exploratory call in the logs.
 *
 * Runs concurrently with a small cap. Sequential would take four minutes for
 * the default suite, and a gate nobody waits for is a gate that gets skipped.
 * The cap is low because each simulation is several model calls: high
 * concurrency here is just a way to hit a rate limit on all of them.
 *
 * Every failure is contained. One scenario that times out or returns junk
 * comes back as a failed scenario with the reason attached, and the suite
 * still reports — a suite that aborts on the first error tells the team
 * nothing, which is strictly worse than a suite with one hole in it.
 */

const CONCURRENCY = 3
const MAX_SCENARIOS = 24

interface SuiteCall {
  scenarioId: string
  name: string
  difficulty: string
  language: string
  behaviours: number
  ok: boolean
  verdict: 'good' | 'mixed' | 'bad' | 'error'
  summary: string
  goalAchieved: boolean | null
  scores: { paramId: string; paramName?: string; value: number }[]
  findings: { layer: string; severity: string; what: string; evidence: string; suggestedFix: string }[]
  turns: number
  looped: boolean
  hitTurnLimit: boolean
  transcript: string
  error: string
  /** True when judges disagreed: the measurement is contested, not negative. */
  contested?: boolean
  panel?: {
    agreement: string
    answered: number
    configured: number
    reason: string
    opinions: { provider: string; ok: boolean; verdict: string | null; error: string }[]
  }
}

async function simUrl(): Promise<string> {
  // Internal call: same deployment, no public round trip and no auth header to
  // re-attach. Falls back to a loopback address for `vercel dev`.
  const host = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://127.0.0.1:3000'
  return `${host}/api/simulate`
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return bad('POST only', 405)
  const denied = checkDeployment(req)
  if (denied) return denied
  if (!process.env.ANTHROPIC_API_KEY) return bad('Set ANTHROPIC_API_KEY in the server environment and restart or redeploy to run simulation suites. Manual logging, scoring, triage and gates over saved evidence still work without it.', 503)

  const body = (await req.json().catch(() => ({}))) as {
    agentName?: string
    prompt?: string
    scenarioIds?: string[]
    scenarios?: Scenario[]
    rubric?: { id: string; name: string; question: string; appliesTo?: string[] }[]
    maxTurns?: number
  }

  const agentName = String(body.agentName ?? 'the agent')
  const prompt = String(body.prompt ?? '')
  if (!prompt.trim()) return bad('Pass the prompt under test.', 400)

  // A caller may ship their own scenarios; otherwise the built-in library runs.
  const library = Array.isArray(body.scenarios) && body.scenarios.length ? body.scenarios : DEFAULT_SCENARIOS
  // Selection, including which requested ids do not exist, lives in _suite.ts
  // where it is unit-tested. Doing it inline is how a caller ends up asking for
  // twelve scenarios, getting four, and seeing a green result.
  const selection = selectScenarios(library, body.scenarioIds)
  if (!selection.scenarios.length) {
    return bad(
      selection.missing.length
        ? `No matching scenarios. Unknown ids: ${selection.missing.join(', ')}`
        : 'No matching scenarios.',
      400)
  }
  const scenarios = selection.scenarios

  const rubricText = (body.rubric ?? []).map(p => `- id "${p.id}" — ${p.name}: ${p.question}`).join('\n')

  const results: SuiteCall[] = new Array(scenarios.length)
  let cursor = 0
  const base = await simUrl()

  async function worker() {
    for (;;) {
      const i = cursor++
      if (i >= scenarios.length) return
      const sc = scenarios[i]
      const started = Date.now()
      try {
        const res = await fetch(base, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            agentName,
            prompt,
            customerSystem: customerSystemPrompt(agentName, sc),
            seed: customerSeed(sc),
            maxTurns: body.maxTurns,
            judge: {
              system: judgeSystemPrompt(agentName, sc),
              user: judgeUserPrompt(agentName, sc, prompt, rubricText, ''),
            },
          }),
          signal: AbortSignal.timeout(180_000),
        })
        if (!res.ok) throw new Error(`Simulator returned ${res.status}`)
        const data = (await res.json()) as {
          ok: boolean; turns: SimulationTurn[]; transcript: string
          looped: boolean; hitTurnLimit: boolean
          judgement: { verdict?: string; summary?: string; goalAchieved?: boolean | null; scores?: { paramId: string; value: number }[]; findings?: { layer: string; severity: string; what: string; evidence: string; suggestedFix: string }[] } | null
          judgeError: string
        }
        // Re-judge with the transcript in hand. The first pass cannot include it
        // because the transcript does not exist until the call is over, so the
        // judge is a second call that takes the real text.
        const panel = await judgeTranscript(agentName, sc, prompt, rubricText, data.transcript)
        // The simulator's own first-pass judgement is a fallback for when the
        // second judging call produced nothing at all. It is the SAME family as
        // the simulator, so it is only ever used when there is no panel opinion
        // -- never in preference to one.
        const j = panel.decision
        const settled = suiteVerdictFor(panel)

        // A run that produced no verdict is a failed MEASUREMENT, and used to be
        // recorded as `ok: true, verdict: 'mixed'`. 'mixed' is a real quality
        // verdict: inventing one out of a judge that returned nothing let a
        // suite report "mixed" on every scenario while the judge was broken, and
        // the gate read that as a finding about the prompt under test.
        //
        // A CONTESTED verdict -- two judges disagreeing -- is also not a
        // measurement, and `contested` records that in the call so a reader can
        // tell "the judges disagreed" from "the judge was down".
        const cls = classifyCall(sc.id, {
          ok: settled.ok,
          verdict: settled.verdict === 'error' ? undefined : settled.verdict,
          goalAchieved: j?.goalAchieved ?? null,
          scores: (j?.scores ?? []) as { paramId: string; value: number }[],
          findings: (j?.findings ?? []) as { severity?: string }[],
          error: settled.contested ? settled.note : (data.judgeError || settled.note),
        })
        results[i] = {
          scenarioId: sc.id, name: sc.name, difficulty: sc.difficulty, language: sc.language,
          behaviours: behaviourCount(sc),
          ok: cls.ok,
          verdict: cls.verdict,
          summary: j?.summary ?? '',
          goalAchieved: j?.goalAchieved ?? null,
          scores: (j?.scores ?? []).map(s => ({ ...s })),
          findings: (j?.findings ?? []).map(f => ({ ...f })),
          turns: data.turns.length,
          looped: data.looped,
          hitTurnLimit: data.hitTurnLimit,
          transcript: data.transcript,
          error: cls.error,
          contested: settled.contested,
          panel: {
            agreement: panel.agreement,
            answered: panel.answered,
            configured: panel.configured,
            reason: panel.reason,
            opinions: panel.opinions.map(o => ({
              provider: o.provider, ok: o.ok, verdict: o.verdict ?? null, error: o.error,
            })),
          },
        }
      } catch (e) {
        results[i] = {
          scenarioId: sc.id, name: sc.name, difficulty: sc.difficulty, language: sc.language,
          behaviours: behaviourCount(sc), ok: false, verdict: 'error',
          summary: '', goalAchieved: null, scores: [], findings: [],
          turns: 0, looped: false, hitTurnLimit: false, transcript: '',
          error: e instanceof Error ? e.message : String(e),
        }
      }
      void started
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, scenarios.length) }, worker))

  /* ---------------- aggregate ---------------- */

  // The roll-up lives in _suite.ts and is unit-tested. Two things it fixes:
  //
  //  - The composite used to average every score including those from runs that
  //    ERRORED, so a suite where half the scenarios timed out reported a
  //    confident mean over the survivors with nothing indicating that half the
  //    evidence was missing. A gate that reads that is a gate that passes on
  //    partial data.
  //  - The goal rate counted a null as a failure, understating the rate on
  //    exactly the runs most likely to have failed.
  const up = rollUp(results.filter(Boolean).map(c => ({
    ok: c.ok,
    verdict: c.verdict,
    goalAchieved: c.goalAchieved,
    scores: c.scores.map(s => ({ paramId: s.paramId, value: s.value, paramName: s.paramName })),
    findings: c.findings as { severity?: string }[],
    error: c.error,
  })))
  const safety = gateSafe(up)
  // `done` and the theme clustering are still needed below: clustering reads the
  // raw findings, which the roll-up deliberately does not carry.
  const done = results.filter(Boolean)
  const themes = clusterFindings(done.flatMap(c => c.findings))

  return json({
    ok: true,
    agentName,
    ranAt: new Date().toISOString(),
    verdict: up.verdict,
    summary: up.summary,
    /**
     * Whether this run may gate a release.
     *
     * A suite where 8 of 12 scenarios errored and 4 passed has not shown the
     * prompt works -- it has shown that four calls succeeded. Carried in the
     * response so a caller cannot read the verdict without it.
     */
    gateSafe: safety.usable,
    gateReason: safety.reason,
    requested: {
      scenarios: scenarios.length,
      missing: selection.missing,
      truncated: selection.truncated,
    },
    /**
     * How the judging went, across the whole run.
     *
     * `contested` is the number of scenarios two judges disagreed on. It is
     * surfaced at the top level rather than buried per-call because it is the
     * single most important thing about the result: those scenarios have NO
     * verdict, and a caller who reads only `verdict` is reading a number
     * computed without them.
     */
    judging: {
      providers: selectJudges(),
      contested: done.filter(c => c.contested).length,
      singleJudge: done.filter(c => c.panel?.agreement === 'single').length,
    },
    measured: {
      composite: up.composite,
      paramAverages: up.paramAverages,
      samples: up.samples,
      goalRate: up.goalRate,
      blockerFindings: up.blockerFindings,
    },
    coverage: coverage(scenarios),
    themes,
    calls: done,
  })
}

/** Second judging pass, now that the transcript exists. */
/**
 * Provider plumbing, delegating to the panel in _judge.ts.
 *
 * Written here as thin wrappers rather than inline so that the request shaping
 * has exactly ONE implementation in the codebase. The three compatible-looking
 * chat APIs are not compatible -- Anthropic takes `system` at the top level,
 * Gemini puts the model in the path and the system prompt under
 * `systemInstruction`, and the other two use a bearer token and a system
 * message -- so a second copy of that logic is a second set of bugs.
 */

function judgeEndpoint(provider: string): string {
  // Gemini's model id goes in the URL; buildRequest escapes it.
  return provider === 'gemini'
    ? `${PROVIDERS.gemini.endpoint}/${encodeURIComponent(PROVIDERS.gemini.model)}:generateContent`
    : PROVIDERS[provider as 'openai' | 'deepseek' | 'anthropic'].endpoint
}

function judgeHeaders(provider: string): Record<string, string> {
  const p = PROVIDERS[provider as keyof typeof PROVIDERS]
  const key = process.env[p.envVar] ?? ''
  if (provider === 'anthropic') {
    return { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  }
  if (provider === 'gemini') {
    return { 'content-type': 'application/json', 'x-goog-api-key': key }
  }
  return { 'content-type': 'application/json', authorization: `Bearer ${key}` }
}

function judgeBody(provider: string, system: string, user: string): Record<string, unknown> {
  const p = PROVIDERS[provider as keyof typeof PROVIDERS]
  if (provider === 'anthropic') {
    return { model: p.model, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] }
  }
  if (provider === 'gemini') {
    return {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: 4000 },
    }
  }
  return {
    model: p.model, max_tokens: 4000,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  }
}

/**
 * Pull the judge's text out of whichever envelope it arrived in.
 *
 * A refusal is reported as no text rather than parsed, because a model that says
 * "I can't evaluate this call" and returns null looks identical to one that
 * returned prose, and treating prose as a verdict is how a judge panel starts
 * agreeing with itself.
 */
function extractJudgeText(provider: string, payload: unknown): string {
  const raw = extractText(provider as 'anthropic' | 'openai' | 'gemini' | 'deepseek', payload)
  if (!raw || isRefusal(raw)) return ''
  return raw
}

/**
 * Parse the judge's JSON.
 *
 * Balanced-brace extraction rather than first `{` to last `}`: models append
 * "let me know if you need more detail!" after the object often enough that the
 * greedy form fails and the whole judgement is lost to a trailing sentence.
 */
function parseJudgeJson(raw: string): Record<string, unknown> | null {
  const unfenced = raw.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1')
  let depth = 0, start = -1
  const found: string[] = []
  for (let i = 0; i < unfenced.length; i++) {
    const ch = unfenced[i]
    if (ch === '{') { if (depth === 0) start = i; depth++ }
    else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) { found.push(unfenced.slice(start, i + 1)); start = -1 }
      if (depth < 0) depth = 0
    }
  }
  for (const candidate of found) {
    try {
      const o = JSON.parse(candidate)
      if (o && typeof o === 'object') return o as Record<string, unknown>
    } catch { /* try the next candidate */ }
  }
  return null
}

/**
 * Ask one provider to judge one transcript.
 *
 * The previous version returned `null` for EVERY failure -- HTTP error, timeout,
 * malformed JSON, missing verdict -- so a suite could not distinguish "the judge
 * was rate limited" from "the judge returned something I could not parse" from
 * "the transcript was empty". All three became the same downstream verdict.
 * Every failure now carries its own reason.
 */
async function judgeWithProvider(
  provider: string, agentName: string, sc: Scenario,
  prompt: string, rubricText: string, transcript: string,
): Promise<JudgeOpinion> {
  const blank = { summary: '', goalAchieved: null, scores: [], findings: [] }
  if (!transcript.trim()) {
    return { provider, ok: false, verdict: undefined, ...blank, error: 'empty transcript' }
  }

  const res = await fetch(judgeEndpoint(provider), {
    method: 'POST',
    headers: judgeHeaders(provider),
    body: JSON.stringify(judgeBody(provider,
      judgeSystemPrompt(agentName, sc),
      judgeUserPrompt(agentName, sc, prompt, rubricText, transcript))),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) {
    // Status only, never the upstream body: it echoes request details back.
    return { provider, ok: false, verdict: undefined, ...blank, error: `provider returned ${res.status}` }
  }

  const raw = extractJudgeText(provider, await res.json())
  if (!raw) return { provider, ok: false, verdict: undefined, ...blank, error: 'no text in response' }

  const parsed = parseJudgeJson(raw)
  if (!parsed) return { provider, ok: false, verdict: undefined, ...blank, error: 'response was not valid JSON' }

  const v = String(parsed.verdict ?? '').toLowerCase()
  if (v !== 'good' && v !== 'mixed' && v !== 'bad') {
    return { provider, ok: false, verdict: undefined, ...blank, error: `unrecognised verdict "${parsed.verdict ?? ''}"` }
  }
  return {
    provider, ok: true, verdict: v,
    summary: String(parsed.summary ?? ''),
    goalAchieved: typeof parsed.goalAchieved === 'boolean' ? parsed.goalAchieved : null,
    scores: Array.isArray(parsed.scores) ? parsed.scores : [],
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
    error: '',
  }
}

/** Judge one transcript with every configured provider, then reduce. */
async function judgeTranscript(
  agentName: string, sc: Scenario, prompt: string, rubricText: string, transcript: string,
): Promise<PanelJudgement> {
  const providers = selectJudges()
  if (!providers.length) {
    return judgeWithPanel([{
      provider: 'none', ok: false, verdict: undefined,
      summary: '', goalAchieved: null, scores: [], findings: [],
      error: 'no judge provider is configured on this deployment',
    }])
  }
  const opinions = await Promise.all(providers.map(p =>
    judgeWithProvider(p, agentName, sc, prompt, rubricText, transcript)))
  return judgeWithPanel(opinions)
}

/**
 * Group findings by what they are about.
 *
 * Twelve calls each reporting "the agent looped" is one problem, and a report
 * that lists it twelve times reads as twelve problems. The key deliberately
 * ignores the scenario and the wording and keys on the layer plus the first few
 * significant words, which is crude but keeps a one-line fix from fragmenting
 * into four themes that each look tiny.
 */
function clusterFindings(findings: { layer: string; severity: string; what: string; evidence: string; suggestedFix: string }[]) {
  const groups = new Map<string, {
    layer: string; severity: string; summary: string; evidence: string; suggestedFix: string
    calls: number; scenarios: Set<string>
  }>()
  for (const f of findings) {
    const words = f.what.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3)
    const key = `${f.layer}|${words.slice(0, 4).join(' ')}`
    const g = groups.get(key)
    if (g) { g.calls++; continue }
    groups.set(key, {
      layer: f.layer, severity: f.severity, summary: f.what,
      evidence: f.evidence, suggestedFix: f.suggestedFix, calls: 1, scenarios: new Set(),
    })
  }
  return [...groups.values()]
    .sort((a, b) => (a.severity === b.severity ? b.calls - a.calls : a.severity === 'blocker' ? -1 : 1))
    .map(g => ({ ...g, affectedScenarios: g.scenarios.size }))
}

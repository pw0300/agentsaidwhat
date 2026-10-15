/**
 * A panel of judges, not one judge.
 *
 * WHY THIS IS A PANEL AND NOT A PROVIDER SWITCHER
 *
 * The obvious build is a settings dropdown: "which model do we call". That is
 * worth nothing, because a judge that works is the prerequisite, not the
 * feature. What makes a judge trustworthy is that its output has been checked
 * against something, and arXiv 2608.09930 is the reason to check it against
 * MORE THAN ONE:
 *
 *   "MOS predictors collapse onto acoustic signal quality, while Audio-LLMs
 *    judges show selective, prompt-dependent detection that does not generalise
 *    across all dimensions. Neither class reliably captures a breadth of
 *    linguistically structured speech errors."
 *
 * Read that as an engineer: two judges given the same call can disagree, and
 * where they disagree is not random. One of them is wrong. A single-judge design
 * has no way to notice which one, and neither does its owner.
 *
 * So the panel's PRIMARY OUTPUT IS THE DISAGREEMENT. Two providers agree, that is
 * evidence. They split, that call is UNRESOLVED and routes to a human, and it is
 * explicitly not averaged into a middle score that means nothing.
 *
 *     agreed-pass    every panelist passed
 *     agreed-fail    every panelist failed
 *     split          they disagree -- NOT A DATA point, needs a human
 *
 * `split` is the valuable state. It is the one a single-judge product cannot
 * produce, and it is where the genuinely hard calls live.
 *
 * WHAT THIS IS NOT
 *
 * This is NOT OAuth into anyone's ChatGPT or Claude subscription. It calls
 * documented, billed APIs with the operator's own keys. A subscription grants no
 * API entitlement, and a third-party product driving one violates every major
 * provider's terms. That is not a scope decision -- it is why there is a
 * BYO-key design here and no other.
 *
 * The keys live in server environment variables and never reach the browser,
 * which is what lets an enterprise deploy this without their call transcripts
 * leaving their own account. The traffic shape is the same one described in
 * api/anthropic.ts: every user turn is redacted on the way out and again on the
 * way back in.
 */

import { redact } from './_redact'

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'deepseek'

/**
 * Every provider is PINNED to a model id and an endpoint.
 *
 * Not configurable by the caller. A caller-supplied model name in a URL that
 * takes a bearer token is a request-forgery primitive, and a model id is a
 * behavioural variable -- letting one change under a stored rubric invalidates
 * every calibration the product has ever reported. The rubric is version-pinned
 * for exactly this reason; the judge is pinned for the same reason.
 */
export const PROVIDERS: Record<ProviderId, {
  label: string
  model: string
  endpoint: string
  envVar: string
  /** Google's API is the only one that puts its key in a header. */
  keyIn: 'header' | 'query'
}> = {
  anthropic: {
    label: 'Anthropic',
    model: 'claude-opus-4-8',
    endpoint: 'https://api.anthropic.com/v1/messages',
    envVar: 'ANTHROPIC_API_KEY',
    keyIn: 'header',
  },
  openai: {
    label: 'OpenAI',
    model: 'gpt-5.2',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    envVar: 'OPENAI_API_KEY',
    keyIn: 'header',
  },
  gemini: {
    label: 'Google Gemini',
    model: 'gemini-3-flash',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    envVar: 'GOOGLE_API_KEY',
    keyIn: 'header',
  },
  deepseek: {
    label: 'DeepSeek',
    model: 'deepseek-chat',
    endpoint: 'https://api.deepseek.com/chat/completions',
    envVar: 'DEEPSEEK_API_KEY',
    keyIn: 'header',
  },
}

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[]

/**
 * Which providers are actually usable, from environment variables only.
 *
 * `configured` is a FACT about the deployment, not a preference. An unconfigured
 * provider returns `unconfigured` and is excluded from the panel -- never
 * treated as a pass, and never silently dropped so the panel looks unanimous.
 */
export function configuredProviders(env: Record<string, string | undefined> = process.env): ProviderId[] {
  return PROVIDER_IDS.filter(id => {
    const v = env[PROVIDERS[id].envVar]
    return typeof v === 'string' && v.trim().length > 20
  })
}

/* ------------------------------------------------------------------ */
/* What a judge returns                                                */
/* ------------------------------------------------------------------ */

export type Verdict = 'pass' | 'fail'

export interface JudgeResult {
  provider: ProviderId
  /** The model that actually answered, echoed back from the response. */
  model: string
  verdict: Verdict
  /** Why, in one sentence. Carried because a gate must be able to explain itself. */
  reason: string
  /** Which layer the judge blames. Drives the owner, which is the actual product. */
  layer: string
  /** Free-text flags the judge raised, e.g. mispronounced a term. */
  flags: string[]
}

/**
 * A panelist that did not produce a verdict.
 *
 * Every one of these is DISTINCT from `fail`, and collapsing them is how a gate
 * ends up reporting 4/4 pass when one judge was rate-limited and another
 * returned prose instead of JSON. A panel of one is not a panel, and a panel
 * where half the members are missing must never report agreement.
 */
export type PanelErrorKind =
  | 'unconfigured'   // no key in the environment
  | 'http'           // provider returned non-200
  | 'unparseable'    // 200, but the text was not a verdict
  | 'refused'        // 200, but the model declined

export interface PanelError {
  provider: ProviderId
  kind: PanelErrorKind
  detail: string
}

export type Panelist = JudgeResult | PanelError

export function isVerdict(p: Panelist): p is JudgeResult {
  return 'verdict' in p && typeof (p as JudgeResult).verdict === 'string'
}

/** Narrow a panel to the abstentions, for callers that only want failures. */
export function abstentionsOf(panel: Panelist[]): PanelError[] {
  return panel.filter((p): p is PanelError => !isVerdict(p))
}

export type Agreement = 'agreed-pass' | 'agreed-fail' | 'split'

export interface PanelOutcome {
  agreement: Agreement
  /** Present only when agreement is agreed-*. */
  verdicts?: JudgeResult[]
  /** Present only when agreement is split. */
  sides?: { pass: ProviderId[]; fail: ProviderId[] }
  /** Panelists that produced no verdict, if any. */
  abstentions: PanelError[]
  /**
   * True when the panel cannot be trusted to agree because not enough members
   * actually answered. The gate must treat this as NO DATA.
   */
  underpowered: boolean
  reason: string
}

/** Two answering judges are the minimum for "agreement" to mean anything. */
export const MIN_PANEL = 2

/**
 * Reduce the panel to an agreement.
 *
 * The underpowered rule is the important one and it is not decoration. A single
 * answering judge among four configured providers has not confirmed anything --
 * it has just been the one that happened to finish first, which is exactly the
 * provider whose verdict you would have trusted on your own.
 */
export function reducePanel(panel: Panelist[], minPanel = MIN_PANEL): PanelOutcome {
  const verdicts = panel.filter(isVerdict)
  const abstentions = abstentionsOf(panel)

  if (verdicts.length < minPanel) {
    return {
      agreement: 'split',
      abstentions,
      underpowered: true,
      reason: `${verdicts.length} of ${panel.length} panelists returned a verdict; ${minPanel} are needed for agreement to mean anything`,
    }
  }

  const passed = verdicts.filter(v => v.verdict === 'pass')
  const failed = verdicts.filter(v => v.verdict === 'fail')

  if (passed.length === verdicts.length) {
    return { agreement: 'agreed-pass', verdicts, abstentions, underpowered: false, reason: `all ${verdicts.length} panelists passed` }
  }
  if (failed.length === verdicts.length) {
    return { agreement: 'agreed-fail', verdicts, abstentions, underpowered: false, reason: `all ${verdicts.length} panelists failed` }
  }
  return {
    agreement: 'split',
    sides: { pass: passed.map(v => v.provider), fail: failed.map(v => v.provider) },
    abstentions,
    underpowered: false,
    reason: `${passed.length} passed, ${failed.length} failed -- the call is unresolved, not averaged`,
  }
}

/* ------------------------------------------------------------------ */
/* Reading a verdict out of whatever the provider sent back            */
/* ------------------------------------------------------------------ */

/**
 * Pull a verdict object out of a model's text.
 *
 * Every provider wraps JSON differently and none of them reliably. It can come
 * back as bare JSON, fenced in ```json, wrapped in a sentence of preamble, or
 * -- with Gemini and DeepSeek especially -- trailed by an offer to help further.
 * A regex for `\{.*\}` handles the first and fails silently on the others, which
 * produces an `unparseable` abstention that looks like a provider outage.
 *
 * Returns null when there is genuinely no verdict object, and NEVER invents a
 * default. A judge that could not answer does not get to pass.
 */
export function parseVerdict(text: string): Omit<JudgeResult, 'provider' | 'model'> | null {
  if (typeof text !== 'string' || text.length === 0) return null

  // Strip fences first so the fenced form and the bare form take one path.
  const unfenced = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1')

  // Scan for balanced braces rather than matching to the last `}`: trailing
  // prose after a valid object is the common failure, not multiple objects.
  let depth = 0
  let start = -1
  const candidates: string[] = []
  for (let i = 0; i < unfenced.length; i++) {
    const ch = unfenced[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        candidates.push(unfenced.slice(start, i + 1))
        start = -1
      }
      // depth going negative means a stray brace in prose; clamp it.
      if (depth < 0) depth = 0
    }
  }

  for (const raw of candidates) {
      let obj: Record<string, unknown>
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') obj = parsed as Record<string, unknown>
        else continue
      } catch { continue }

      // Accept `verdict`, and accept a nested `{result:{...}}` shape. Models wrap.
      const inner = (obj.result && typeof obj.result === 'object' ? obj.result : obj) as Record<string, unknown>
      // Named `label`, NOT `raw`. This was `raw`, which shadowed the loop
      // variable of the same name, so the field read itself, was always an object
      // rather than a string, and every parse returned null. Eight tests caught
      // it; the shadowing compiled clean and produced no error anywhere.
    const label = inner.verdict ?? inner.judgement ?? inner.verdict_label ?? inner.result

    // Normalise the LABEL, not the whole field value.
    //
    // Stripping non-letters from `"VERDICT: pass"` gives `"verdictpass"`, which
    // matches nothing -- and models write that shape constantly, because
    // "VERDICT: pass" is how people write a verdict. The colon is punctuation
    // around a word, not part of the word. So split on anything that is not a
    // letter first and look for pass/fail among the resulting words, rather than
    // treating the field as one token.
    let norm: string | null = null
    if (typeof label === 'string') {
      // Punctuation is stripped but CONTENT WORDS are kept, because a qualifier
      // changes the answer. "VERDICT: pass" is a pass; "partially pass",
      // "mostly fail" and "would pass" are not verdicts at all -- reading any of
      // them as one is how a judge panel starts rubber-stamping, and the first
      // version of this function did exactly that.
      //
      // It went unnoticed for a commit because a variable shadowing bug made
      // every parse return null, so this branch never executed. Fixing the
      // shadow exposed it. That is the argument for the parse tests existing.
      const PREFIX = ['verdict', 'judgement', 'judgment', 'overall', 'final', 'result']
      const words = label.toLowerCase().split(/[^a-z]+/).filter(Boolean)
      // A leading label word is punctuation-adjacent noise ("verdict: pass").
      // Anything else is content, and more than one content word makes the field
      // a sentence rather than a machine verdict.
      const bare = words.filter(w => !PREFIX.includes(w))
      if (bare.length === 1 && (bare[0] === 'pass' || bare[0] === 'fail')) {
        norm = bare[0]
      }
    }
        if (norm !== 'pass' && norm !== 'fail') continue

    const flags = inner.flags ?? inner.issues ?? []
    return {
      verdict: norm,
      reason: typeof inner.reason === 'string' ? inner.reason.trim() : '',
      layer: typeof inner.layer === 'string' ? inner.layer.trim() : '',
      flags: Array.isArray(flags) ? flags.filter(f => typeof f === 'string') : [],
    }
  }
  return null
}

/** A refusal is a decline to answer, and it must never be read as a pass. */
export function isRefusal(text: string): boolean {
  return /\b(i (?:can'?t|cannot|am unable to)|i'?m not able to|as an ai)\b/i.test(text ?? '')
}

/* ------------------------------------------------------------------ */
/* Request shaping, per provider                                       */
/* ------------------------------------------------------------------ */

/**
 * Each provider has its own request shape. This is unavoidable -- the three
 * compatible-looking APIs are not compatible.
 */
export function buildRequest(
  provider: ProviderId,
  system: string,
  user: string,
  maxTokens: number,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const p = PROVIDERS[provider]
  const key = process.env[p.envVar] ?? ''

  switch (provider) {
    case 'anthropic':
      return {
        url: p.endpoint,
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: { model: p.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] },
      }
    case 'openai':
    case 'deepseek':
      return {
        url: p.endpoint,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: { model: p.model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
      }
    case 'gemini':
      return {
        // The model id goes in the PATH, not the body. Escaped because it is
        // caller-influenced data reaching a URL.
        url: `${p.endpoint}/${encodeURIComponent(p.model)}:generateContent`,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        },
      }
  }
}

/** Each provider nests its text differently. */
export function extractText(provider: ProviderId, payload: unknown): string {
  const p = payload as Record<string, any>
  switch (provider) {
    case 'anthropic':
      // content is an array of blocks; text may sit in several of them.
      return (Array.isArray(p?.content) ? p.content : [])
        .map((b: { type?: string; text?: string }) => (b?.type === 'text' ? b.text : ''))
        .join('')
    case 'gemini':
      return p?.candidates?.[0]?.content?.parts?.map((x: { text?: string }) => x.text ?? '').join('') ?? ''
    default:
      return p?.choices?.[0]?.message?.content ?? ''
  }
}

/**
 * Ask one provider for a verdict on one call.
 *
 * The user turn is redacted on the way out and the model's reply on the way back
 * in, for the same reason api/anthropic.ts does it: a judge can quote a phone
 * number back in its reason string, and that string lands in a report.
 */
export async function judgeOne(
  provider: ProviderId,
  system: string,
  user: string,
  maxTokens = 2000,
): Promise<Panelist> {
  const p = PROVIDERS[provider]
  const key = process.env[p.envVar]
  if (typeof key !== 'string' || key.trim().length <= 20) {
    return { provider, kind: 'unconfigured', detail: `Set ${p.envVar} to a valid provider key in the server environment and restart or redeploy to use ${p.label} judging. Manual logging, scoring, triage and gates over saved evidence still work without it.` }
  }

  const req = buildRequest(provider, system, redact(user).text, maxTokens)

  let res: Response
  try {
    res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(30_000) })
  } catch (e) {
    return { provider, kind: 'http', detail: `network: ${(e as Error).message}` }
  }

  if (!res.ok) {
    // Never surface the raw upstream body: it echoes request details back.
    return { provider, kind: 'http', detail: `${p.label} returned ${res.status}` }
  }

  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    return { provider, kind: 'unparseable', detail: `${p.label} returned a non-JSON body` }
  }

  const raw = extractText(provider, payload)
  if (isRefusal(raw)) {
    return { provider, kind: 'refused', detail: `${p.label} declined to judge` }
  }

  const parsed = parseVerdict(redact(raw).text)
  if (!parsed) {
    return { provider, kind: 'unparseable', detail: `${p.label} replied without a parseable verdict` }
  }

  // Echo the model the provider ACTUALLY served, not the one we asked for. If
  // they differ, the calibration is invalid and the report must show it.
  const served = (payload as Record<string, any>)?.model
  return { provider, model: typeof served === 'string' ? served : p.model, ...parsed }
}

/**
 * Run the whole panel. Providers that are unconfigured are reported as such
 * rather than omitted, so `panel.length` always reflects what was attempted.
 */
export async function runPanel(
  system: string,
  user: string,
  providers: ProviderId[] = configuredProviders(),
  maxTokens = 2000,
): Promise<{ panel: Panelist[]; outcome: PanelOutcome }> {
  const panel = await Promise.all(providers.map(p => judgeOne(p, system, user, maxTokens)))
  return { panel, outcome: reducePanel(panel) }
}

import { bad, checkDeployment, json } from './_lib'

export const config = { runtime: 'edge' }

/**
 * Run one simulated call.
 *
 *   POST /api/simulate  { agentName, prompt, scenario, rubric, maxTurns }
 *
 * Two model calls per turn, alternating, plus a final judge call. The caller
 * side is stateless between turns — every turn re-sends the full transcript so
 * far — which is what makes a caller that "forgets" after five turns
 * impossible, and it is the right trade: a sim that drifts into incoherence
 * produces findings about the simulator, not the agent.
 *
 * The agent side gets the customer's real system prompt, unmodified, because
 * the entire question is whether the shipping prompt survives this. Any edit
 * here would invalidate the result.
 *
 * Three convergence rules, because an unbounded two-agent conversation never
 * ends on its own:
 *
 *  1. A turn budget, default 12. Past that the call is truncated and flagged,
 *     because a conversation that will not end is itself a finding.
 *  2. The call ends when the agent says something that closes it — and the
 *     customer is told to accept it, so the agent can actually win.
 *  3. A repetition check on the agent's side. If the agent has emitted the
 *     same substantive sentence twice, the call stops immediately and the run
 *     is flagged, because a loop is the defect and there is no value in
 *     watching it three more times.
 */

const MODELS = {
  /** The agent under test. */
  agent: 'claude-sonnet-5',
  /** The simulated customer. Cheap and fast — it is scaffolding, not product. */
  caller: 'claude-sonnet-5',
  judge: 'claude-sonnet-5',
}

const MAX_TOKENS = { agent: 700, caller: 400, judge: 4000 }
const DEFAULT_MAX_TURNS = 12
const HARD_MAX_TURNS = 30

interface Msg { role: 'user' | 'assistant'; content: string }

async function callModel(
  key: keyof typeof MODELS,
  system: string,
  messages: Msg[],
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-03',
    },
    body: JSON.stringify({
      model: MODELS[key],
      max_tokens: MAX_TOKENS[key],
      system,
      messages,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    let detail = body
    try { detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body } catch { /* keep raw */ }
    throw new Error(`${key} model call failed (${res.status}): ${detail}`)
  }
  const data = (await res.json()) as { content: { type: string; text?: string }[] }
  return data.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('').trim()
}

/**
 * Normalise a reply into a spoken turn.
 *
 * Models leak structure into a roleplay: "Customer: hi there", "**Agent:**",
 * a bulleted list, a stage direction in brackets. Left in, those become
 * "findings" against the agent that are really artefacts of the generator, and
 * the whole report stops being trustworthy. Everything that is not dialogue
 * gets stripped before it can reach the judge.
 */
function cleanTurn(raw: string, who: 'agent' | 'caller'): string {
  let t = raw.trim()
  // Drop any speaker label the model added, at either end.
  t = t.replace(/^(customer|agent|caller|user|assistant)\s*:\s*/i, '')
  // Stage directions and parentheticals.
  t = t.replace(/^\s*[[(][^\])]*[\])]\s*/, '')
  // Bullets and headings.
  t = t.split('\n').filter(line => !/^\s*([-*•]|\d+\.)\s/.test(line)).join(' ')
  t = t.replace(/[*_#>`]/g, '').replace(/\s{2,}/g, ' ').trim()
  // A caller turn longer than this is the model writing a monologue.
  const cap = who === 'caller' ? 400 : 1200
  if (t.length > cap) t = t.slice(0, cap).replace(/\s+\S*$/, '') + '…'
  return t
}

/** Does this turn close the call? Deliberately generous — a missed close just
 *  burns a turn, while an aggressive one ends calls the agent should have won. */
const CLOSERS = /\b(thank you for (your )?(time|interest|calling)|thanks for (your )?(time|interest)|goodbye|bye|have a great day|is there anything else|anything else i can help|that's all|that's it,|we'll call you back|will call you back)\b/i

/**
 * Has the agent said this before?
 *
 * Compared on a normalised skeleton — first six significant words — because a
 * verbatim match misses the real loop, which is the same sentence reworded.
 * Two hits is a loop; one is a callback.
 */
function isRepeat(turns: { role: string; text: string }[], text: string): boolean {
  const skeleton = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3).slice(0, 6).join(' ')
  const now = skeleton(text)
  if (!now) return false
  const prior = turns.filter(t => t.role === 'agent').map(t => skeleton(t.text))
  return prior.filter(s => s === now).length >= 1
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return bad('POST only', 405)
  const denied = checkDeployment(req)
  if (denied) return denied

  if (!process.env.ANTHROPIC_API_KEY) return bad('Set ANTHROPIC_API_KEY in the server environment and restart or redeploy to run the simulator. Manual logging, scoring, triage and gates over saved evidence still work without it.', 503)

  const body = (await req.json().catch(() => ({}))) as {
    agentName?: string; prompt?: string; system?: string
    scenario?: { name?: string; intent?: string; context?: string; difficulty?: string; language?: string; behaviour?: Record<string, boolean> }
    rubric?: { id: string; name: string; question: string }[]
    customerSystem?: string
    seed?: string
    maxTurns?: number
    judge?: { system?: string; user?: string }
  }

  const agentName = String(body.agentName ?? 'the agent')
  const prompt = String(body.prompt ?? body.system ?? '')
  if (!prompt.trim()) return bad('Pass the prompt under test.', 400)
  if (!body.customerSystem) return bad('Pass the customer system prompt.', 400)

  const maxTurns = Math.min(HARD_MAX_TURNS, Math.max(2, Number(body.maxTurns) || DEFAULT_MAX_TURNS))
  const transcript: { role: 'agent' | 'caller'; text: string }[] = []
  let hitTurnLimit = false
  let looped = false

  // Caller-visible history. The caller model sees roles from ITS point of view,
  // so the agent's lines are "user" turns to it and its own are "assistant".
  const callerMsgs: Msg[] = [{ role: 'user', content: String(body.seed ?? 'Hi, I am calling about your project.') }]

  try {
    for (let i = 0; i < maxTurns; i++) {
      /* ---- agent turn: the shipping prompt, unmodified ---- */
      const agentMsgs: Msg[] = [
        ...transcript.map(t => ({ role: t.role === 'agent' ? 'assistant' as const : 'user' as const, content: t.text })),
      ]
      const lastCaller = [...transcript].reverse().find(t => t.role === 'caller')
      agentMsgs.push({ role: 'user', content: lastCaller ? lastCaller.text : 'The customer has just connected.' })

      const agentRaw = await callModel('agent', prompt, agentMsgs)
      const agentText = cleanTurn(agentRaw, 'agent')
      if (!agentText) break
      transcript.push({ role: 'agent', text: agentText })

      /* ---- the two ways this call ends early ---- */
      if (CLOSERS.test(agentText)) break
      if (isRepeat(transcript, agentText)) { looped = true; break }

      /* ---- caller turn ---- */
      callerMsgs.push({ role: 'assistant', content: transcript[transcript.length - 1].text })
      const callerRaw = await callModel('caller', String(body.customerSystem), callerMsgs)
      const callerText = cleanTurn(callerRaw, 'caller')
      if (!callerText) break
      transcript.push({ role: 'caller', text: callerText })
      callerMsgs.push({ role: 'user', content: callerText })

      if (transcript.length >= maxTurns * 2) { hitTurnLimit = true; break }
    }
    if (transcript.length >= maxTurns * 2) hitTurnLimit = true
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Simulation failed.', 502)
  }

  /* ---- judge the transcript ---- */
  let judgement: unknown = null
  let judgeError = ''
  if (body.judge?.system && transcript.length) {
    try {
      const raw = await callModel('judge', String(body.judge.system), [{ role: 'user', content: String(body.judge.user) }])
      const start = raw.indexOf('{')
      const end = raw.lastIndexOf('}')
      if (start !== -1 && end > start) judgement = JSON.parse(raw.slice(start, end + 1))
      else judgeError = 'Judge returned no JSON.'
    } catch (e) {
      judgeError = e instanceof Error ? e.message : String(e)
    }
  }

  return json({
    ok: true,
    agentName,
    turns: transcript,
    turnCount: transcript.length,
    hitTurnLimit,
    looped,
    transcript: transcript.map(t => `${t.role === 'agent' ? 'Agent' : 'Customer'}: ${t.text}`).join('\n'),
    judgement,
    judgeError,
  })
}

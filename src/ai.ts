import { callAnthropic, textOf } from './api'
import type { Agent, CallAnalysis, CallFinding, FailureLayer, Observation, PromptVersion, RubricParam, Score, Severity, TestSession } from './types'

// Analyzes a test session (transcript + scores + observations) against the
// prompt version and returns suggested prompt fixes. The call goes to this
// app's own /api/anthropic function; the Anthropic key lives in a Vercel
// environment variable and never reaches the browser.
export async function analyzeSession(
  version: PromptVersion,
  session: TestSession,
  observations: Observation[],
): Promise<string> {
  const obsText = observations.length
    ? observations.map((o, i) => `${i + 1}. [${o.severity}] What happened: ${o.whatHappened}\n   Expected: ${o.expected}${o.quote ? `\n   Quote: "${o.quote}"` : ''}`).join('\n')
    : '(none reported)'

  const scoresText = session.scores.map(s => `- ${s.paramName}: ${s.value}/5`).join('\n')

  const response = await callAnthropic({
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system:
      'You are a QA analyst for AI voice/chat agents. You are given the system prompt of an agent, a call transcript, tester scores, and tester observations. Diagnose which parts of the PROMPT caused the problems observed in the TRANSCRIPT, and propose concrete prompt edits. Be specific: quote the offending prompt lines, quote the transcript evidence, and give the exact replacement text. Order findings by severity. If the transcript shows problems the tester did not report, flag those too. Output plain readable markdown.',
    messages: [
      {
        role: 'user',
        content: `## Agent prompt (v${version.number})\n\n${version.promptText}\n\n## Transcript of the tested call (use case: ${session.useCase})\n\n${session.transcript || '(no transcript pasted)'}\n\n## Tester scores\n${scoresText}\n\n## Tester observations\n${obsText}\n\n## Tester comments\n${session.comments || '(none)'}\n\nAnalyze what in the prompt needs to change.`,
      },
    ],
  })

  return textOf(response)
}

/* ---------------- Bulk call-analysis bench ---------------- */

const LAYERS: FailureLayer[] = ['prompt', 'voice-tts', 'vad', 'platform', 'unknown']
const SEVERITIES: Severity[] = ['blocker', 'major', 'minor', 'nitpick']

// Pull the first JSON object out of a model reply (tolerates code fences and prose).
function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('No JSON object in model reply')
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
}

export interface CallJudgement {
  verdict: 'good' | 'mixed' | 'bad'
  summary: string
  goalAchieved: boolean | null
  scores: Score[]
  findings: Omit<CallFinding, 'id' | 'issueId'>[]
}

// Judge ONE call transcript against the agent's prompt: verdict, rubric scores,
// and findings each attributed to the stack layer that owns the failure.
// Sonnet per call (cheap enough to run hundreds), Opus for the aggregate pass.
export async function analyzeCall(
  agent: Agent,
  version: PromptVersion,
  rubric: RubricParam[],
  fileName: string,
  transcript: string,
): Promise<CallJudgement> {
  const params = rubric.filter(p => p.appliesTo.includes(agent.type))
  const rubricText = params.map(p => `- id "${p.id}" — ${p.name}: ${p.question}`).join('\n')

  const response = await callAnthropic({
    model: 'claude-sonnet-5',
    max_tokens: 4000,
    system: `You are a QA judge for AI ${agent.type} agents (Ultravox LLM + ElevenLabs TTS voice stack). You get the agent's system prompt and ONE call transcript. Judge the call and attribute every failure to the layer that owns it:
- "prompt" — WHAT was said: wrong facts, looping, script-marching past interruptions, ignoring exits, wrong language switching, pitching before discovery, robotic templated phrasing, hallucinated capabilities.
- "voice-tts" — HOW it sounds (ElevenLabs): pronunciation/pacing. Only attributable if visible in the transcript text (e.g. phonetic respellings read wrong); otherwise do NOT guess.
- "vad" — turn-taking: restart loops after barge-in, sputtering, treating backchannels ("haan", "okay") as interrupts, self-closing on silence.
- "platform" — tool/telephony failures (tool errors, dropped call artifacts).
- "unknown" — real problem, unclear owner.

Rules: judge only what the TRANSCRIPT shows — never invent audio qualities you cannot see in text. Score only rubric parameters judgeable from the transcript; omit the rest. Every finding needs a verbatim transcript quote as evidence and a concrete suggested fix (exact prompt edit, or the setting to change for voice-tts/vad). "good" = goal progressed, no major/blocker findings; "bad" = goal failed or any blocker; else "mixed".

Reply with ONLY a JSON object:
{"verdict":"good|mixed|bad","summary":"1-2 lines: what happened on this call","goalAchieved":true|false|null,"scores":[{"paramId":"<rubric id>","value":1-5}],"findings":[{"layer":"prompt|voice-tts|vad|platform|unknown","severity":"blocker|major|minor|nitpick","what":"...","evidence":"verbatim quote","suggestedFix":"..."}]}`,
    messages: [{
      role: 'user',
      content: `## Agent: ${agent.name} (${agent.type}, ${agent.direction})\n\n## System prompt (v${version.number})\n\n${version.promptText}\n\n## Rubric parameters\n${rubricText}\n\n## Call transcript (file: ${fileName})\n\n${transcript}`,
    }],
  })

  const j = extractJson(textOf(response))
  const verdict = j.verdict === 'good' || j.verdict === 'bad' ? j.verdict : 'mixed'
  const byId = new Map(params.map(p => [p.id, p]))
  const scores: Score[] = (Array.isArray(j.scores) ? j.scores : [])
    .map((s: { paramId?: string; value?: number }) => {
      const p = s.paramId ? byId.get(s.paramId) : undefined
      const v = Math.round(Number(s.value))
      return p && v >= 1 && v <= 5 ? { paramId: p.id, paramName: p.name, value: v } : null
    })
    .filter((s): s is Score => s !== null)
  const findings = (Array.isArray(j.findings) ? j.findings : []).map((f: Partial<CallFinding>) => ({
    layer: LAYERS.includes(f.layer as FailureLayer) ? (f.layer as FailureLayer) : 'unknown',
    severity: SEVERITIES.includes(f.severity as Severity) ? (f.severity as Severity) : 'minor',
    what: String(f.what ?? ''),
    evidence: String(f.evidence ?? ''),
    suggestedFix: String(f.suggestedFix ?? ''),
  })).filter(f => f.what)
  return {
    verdict,
    summary: String(j.summary ?? ''),
    goalAchieved: typeof j.goalAchieved === 'boolean' ? j.goalAchieved : null,
    scores,
    findings,
  }
}

// Cross-call synthesis: cluster the per-call findings into themes, rank by
// frequency x severity, and produce a prioritized improvement plan.
export async function aggregateBatch(
  agent: Agent,
  version: PromptVersion,
  calls: CallAnalysis[],
): Promise<string> {
  const done = calls.filter(c => ['good', 'mixed', 'bad'].includes(c.verdict))
  const callsText = done.map((c, i) => {
    const f = c.findings.map(x => `  - [${x.layer}/${x.severity}] ${x.what} | evidence: "${x.evidence}" | fix: ${x.suggestedFix}`).join('\n')
    return `### Call ${i + 1} (${c.fileName}) — ${c.verdict}, goal ${c.goalAchieved === null ? 'unclear' : c.goalAchieved ? 'achieved' : 'missed'}\n${c.summary}\n${f || '  (no findings)'}`
  }).join('\n\n')

  const response = await callAnthropic({
    model: 'claude-opus-4-8',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: `You are the lead QA analyst for an AI voice-agent operation (Ultravox prompt + ElevenLabs TTS + VAD turn-taking). You get per-call judgements for a whole batch of calls on one prompt version. Produce the improvement plan the builder acts on:
1. **Batch verdict** — one paragraph: overall health, goal-achievement rate, the single biggest problem.
2. **Issue themes** — cluster duplicate findings across calls into themes. For each: name, layer owner, severity, how many calls it hit (cite call file names), best evidence quote, root cause.
3. **Prioritized fixes** — ordered by (calls affected x severity). For prompt-layer fixes give the exact edit (quote the offending prompt line if identifiable, give replacement text). For voice-tts/vad give the specific setting to change. One theme = one fix; never repeat a finding as multiple themes.
4. **What's working** — patterns to keep (so fixes don't regress them).
Plain readable markdown. Be specific, no filler.`,
    messages: [{
      role: 'user',
      content: `## Agent: ${agent.name} (${agent.type}, ${agent.direction})\n\n## System prompt (v${version.number})\n\n${version.promptText}\n\n## Per-call judgements (${done.length} calls)\n\n${callsText}`,
    }],
  })
  return textOf(response)
}

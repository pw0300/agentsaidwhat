/**
 * Client side of the serverless proxy.
 *
 * The app used to hold an Anthropic key in localStorage and call Anthropic
 * straight from the tab. It now calls its own origin, and the key lives in a
 * Vercel environment variable that never reaches the browser. What a tester can
 * hold is at most a team access code, which is revocable and worth nothing
 * outside this deployment.
 */

import { DEMO_MODE, DEMO_SERVER_REASON } from './mode'

// Keep the legacy browser key so saved access credentials remain available.
const ACCESS_KEY = 'agent-qa-access'

export function getAccessCode(): string {
  return localStorage.getItem(ACCESS_KEY) ?? ''
}

export function setAccessCode(code: string): void {
  if (code) localStorage.setItem(ACCESS_KEY, code)
  else localStorage.removeItem(ACCESS_KEY)
}

export interface MessageBlock { type: string; text?: string }
export interface MessageResponse { content: MessageBlock[] }

/** The subset of the Messages API this app sends. */
export interface MessageRequest {
  model: string
  max_tokens: number
  system: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  thinking?: { type: string }
}

export async function callAnthropic(body: MessageRequest): Promise<MessageResponse> {
  if (DEMO_MODE) throw new Error(DEMO_SERVER_REASON)
  const code = getAccessCode()
  let res: Response
  try {
    res = await fetch('/api/anthropic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(code ? { 'x-qa-access': code } : {}) },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error('Could not reach the analysis service. Check your connection.')
  }

  // `vite dev` serves the SPA, not the functions, so /api/* falls through to
  // index.html and parses as HTML. Say so plainly instead of "unexpected token".
  if (res.status === 404 || (res.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error('The analysis API is not running. Use npm run local and set ANTHROPIC_API_KEY in the server environment for AI analysis. Manual logging and scoring still work without a key.')
  }

  const data = (await res.json().catch(() => ({}))) as { error?: string } & MessageResponse
  if (!res.ok) {
    if (res.status === 401) throw new Error('Access code rejected. Check it in Settings.')
    if (res.status === 503) throw new Error(data.error ?? 'Set ANTHROPIC_API_KEY in the server environment and restart or redeploy for AI analysis. Manual logging, scoring, triage and gates over saved evidence still work without it.')
    throw new Error(data.error ?? `Analysis failed (${res.status}).`)
  }
  return data
}

/** Whether the deployment can run AI at all, and whether a code is required. */
export interface ApiHealth { anthropic: boolean; accessCodeRequired: boolean; store: boolean; mode?: 'local' | 'hosted'; home?: string; judges?: string[] }

export async function apiHealth(): Promise<ApiHealth | null> {
  if (DEMO_MODE) return { anthropic: false, accessCodeRequired: false, store: false }
  try {
    const res = await fetch('/api/health')
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null
    return (await res.json()) as ApiHealth
  } catch {
    return null
  }
}

export const textOf = (r: MessageResponse): string =>
  r.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')

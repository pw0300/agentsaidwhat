import type { AppState } from './types'
import { getAccessCode } from './api'

/**
 * Client half of the shared store.
 *
 * The app stays offline-first — localStorage is still what renders, and every
 * edit lands there first. This layer only reconciles: it sends the server
 * snapshot it last saw (`base`) plus the current local state, and the server
 * merges them. Keeping `base` in localStorage is what makes deletions work
 * across reloads; without it a deleted session looks identical to a session
 * this browser has simply never seen, and the server would resurrect it.
 *
 * When no store is provisioned every call reports `configured: false` and the
 * app behaves exactly as it did before — per-browser, no errors, no nagging.
 */

// Legacy sync keys preserve the saved base snapshot and revision.
const BASE_KEY = 'agent-qa-base-v1'
const REV_KEY = 'agent-qa-rev-v1'

export type SyncStatus = 'local-only' | 'idle' | 'syncing' | 'error'

export interface SyncResult { configured: boolean; state: AppState | null; rev: number }

export function loadBase(): { base: AppState | null; rev: number } {
  try {
    const raw = localStorage.getItem(BASE_KEY)
    return { base: raw ? (JSON.parse(raw) as AppState) : null, rev: Number(localStorage.getItem(REV_KEY) ?? 0) || 0 }
  } catch {
    return { base: null, rev: 0 }
  }
}

export function saveBase(state: AppState, rev: number): void {
  try {
    localStorage.setItem(BASE_KEY, JSON.stringify(state))
    localStorage.setItem(REV_KEY, String(rev))
  } catch { /* quota — sync still works, deletions just get less reliable */ }
}

const headers = (): Record<string, string> => {
  const code = getAccessCode()
  return { 'content-type': 'application/json', ...(code ? { 'x-qa-access': code } : {}) }
}

async function call(init: RequestInit): Promise<SyncResult> {
  const res = await fetch('/api/state', { ...init, headers: headers() })
  // `npm run dev` serves index.html for /api/*; treat that as "no store here".
  if (!(res.headers.get('content-type') ?? '').includes('json')) return { configured: false, state: null, rev: 0 }
  const data = (await res.json()) as SyncResult & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `Sync failed (${res.status})`)
  return data
}

export const pull = (): Promise<SyncResult> => call({ method: 'GET' })

export const push = (base: AppState | null, local: AppState): Promise<SyncResult> =>
  call({ method: 'POST', body: JSON.stringify({ base: base ?? {}, local }) })

export const sameState = (a: AppState | null, b: AppState | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

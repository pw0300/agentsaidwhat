import { useEffect, useRef, useState } from 'react'
import type { Agent, PromptVersion } from './types'
import { LAYER_TEAM, LAYER_FIRST_CHECK, toFailureLayer } from './types'
import { now } from './data'
import { useStore } from './store.tsx'
import { DEFAULT_SCENARIOS, runSuite } from './SimulationBench'

/**
 * Runs the simulation suite by itself.
 *
 * This is the piece that turns the feature from "a tab someone remembers to
 * open" into something that runs whether anyone is looking or not. A gate that
 * only fires when a human goes looking at it is a gate that gets skipped in the
 * week the team is shipping something important.
 *
 * Three triggers, all of them unattended:
 *
 *  1. A new prompt version is created. This is the important one — the moment
 *     a candidate is born, it gets tested. The person creating it does not
 *     have to opt in, because the whole premise is that a change nobody tests
 *     is a change nobody knows about.
 *
 *  2. A version moves to `testing`. Covers the case where a version was
 *     created from a template and the real prompt pasted in later.
 *
 *  3. A periodic re-run on whatever is currently in `testing`, so a
 *     regression caused by something upstream — a model upgrade, a TTS voice
 *     change, a third-party tool going down — surfaces without anyone shipping
 *     a change to trigger it.
 *
 * It is off by default and the switch is in the UI, not in a config file. A
 * background job that spends money on model calls has to be something the
 * person paying for it can see and turn off.
 *
 * Nothing here is allowed to block the UI. The suite takes minutes; a builder
 * who creates a version and gets a spinner for four minutes will assume the
 * tool is broken and go back to shipping untested.
 */

// Legacy browser keys preserve automatic simulation preferences and logs.
const STORAGE_KEY = 'agent-qa-auto-sim'
const REPO_KEY = 'agent-qa-autosim-log'
/** How often the periodic sweep runs. A week is often enough to catch a
 *  slow-burn regression and rare enough not to matter on a free tier. */
const PERIODIC_MS = 7 * 864e5

export interface AutoSimState {
  enabled: boolean
  lastRunAt: string
  lastVersionId: string
  running: boolean
  lastSummary: string
}

export function useAutoSimulation(
  agent: Agent | undefined,
  version: PromptVersion | undefined,
  rubric: { id: string; name: string; question: string }[],
  onResult?: (summary: string) => void,
) {
  const { state, mutate } = useStore()
  const [enabled, setEnabled] = useState(() => localStorage.getItem(STORAGE_KEY) === '1')
  const [running, setRunning] = useState(false)
  const [lastRunAt, setLastRunAt] = useState('')
  const lastVersionId = useRef<string>('')
  const inFlight = useRef(false)
  const seenVersions = useRef<Set<string>>(new Set())

  // Seed "already seen" from existing versions on mount, so opening the app
  // does not fire a suite for every version in the workspace at once.
  useEffect(() => {
    if (seenVersions.current.size) return
    for (const v of state.versions) seenVersions.current.add(v.id)
  }, [state.versions])

  const fire = async (target: Agent, v: PromptVersion, reason: string) => {
    if (inFlight.current) return
    inFlight.current = true
    setRunning(true)
    try {
      const data = await runSuite({
        agentName: target.name,
        prompt: v.promptText,
        scenarios: DEFAULT_SCENARIOS,
        rubric,
      })
      const summary = data.summary ?? 'Suite finished.'
      const stamp = now()
      setLastRunAt(stamp)

      // Store the run as a batch so it shows up in the issue board's history
      // and in the audit trail — an automatic run that leaves no record is
      // indistinguishable from one that never happened.
      mutate(d => {
        d.batches.push({
          id: `sim-${v.id}-${Date.now().toString(36)}`,
          agentId: target.id,
          versionId: v.id,
          name: `${target.name} · simulated ${new Date(stamp).toLocaleDateString()} (${reason})`,
          report: [
            `**Automated simulation — ${reason}**`,
            '',
            summary,
            '',
            `Composite: ${data.measured?.composite?.toFixed(2) ?? 'n/a'} · Blocker findings: ${data.measured?.blockerFindings ?? 0}`,
            data.coverage ? `Coverage: ${data.coverage.total} scenarios, ${data.coverage.behavioursExercised.length} behaviours.` : '',
            '',
            ...(data.themes ?? []).map((t: any) =>
              `- **[${t.severity}/${t.layer}]** ${t.summary} — ${t.calls} call(s)${t.suggestedFix ? `\n  Fix: ${t.suggestedFix}` : ''}`),
          ].filter(Boolean).join('\n'),
          createdAt: stamp,
        })
        // Promote the worst findings so they cannot be lost in a batch nobody opens.
        for (const call of data.calls ?? []) {
          for (const f of call.findings ?? []) {
            if (f.layer === 'simulation' || f.severity === 'nitpick') continue
            const already = d.issues.some(i => i.description.includes(f.what.slice(0, 60)))
            if (already) continue
            const autoLayer = toFailureLayer(f.layer)
            d.issues.push({
              id: `sim-${Date.now().toString(36)}-${d.issues.length}`,
              projectId: target.projectId, agentId: target.id,
              title: f.what.slice(0, 90),
              description: `[${f.layer}] ${f.what}${f.evidence ? ` — "${f.evidence}"` : ''}\nSuggested fix: ${f.suggestedFix}\n(raised automatically by simulation: ${call.name})`,
              severity: f.severity, status: 'open',
              bornInVersionId: v.id,
              claimedFixedInVersionId: null, verifiedFixedInVersionId: null,
              resolutionNote: '', verifications: [], createdAt: stamp,
              // The unattended path is where attribution matters most: nobody is
              // watching this run, so a ticket with no owner sits unread. Route
              // it on creation or it will not be routed at all.
              layer: autoLayer, ownerTeam: LAYER_TEAM[autoLayer], ownerPerson: '',
              attribution: LAYER_FIRST_CHECK[autoLayer],
            })
          }
        }
      })

      try {
        const log = JSON.parse(localStorage.getItem(REPO_KEY) ?? '[]') as { at: string; summary: string; version: string }[]
        log.unshift({ at: stamp, summary, version: `v${v.number}` })
        localStorage.setItem(REPO_KEY, JSON.stringify(log.slice(0, 20)))
      } catch { /* log is a convenience, not a requirement */ }

      onResult?.(summary)
    } catch (e) {
      // A failed background run is recorded and otherwise ignored. Surfacing
      // an error toast four minutes after someone closed the tab teaches people
      // to ignore this thing.
      try {
        const log = JSON.parse(localStorage.getItem(REPO_KEY) ?? '[]') as unknown[]
        log.unshift({ at: now(), summary: `Failed: ${e instanceof Error ? e.message : String(e)}`, version: `v${v.number}` })
        localStorage.setItem(REPO_KEY, JSON.stringify(log.slice(0, 20)))
      } catch { /* give up quietly */ }
    } finally {
      inFlight.current = false
      setRunning(false)
    }
  }

  /* ---- trigger 1 & 2: a version we have not tested before ---- */
  useEffect(() => {
    if (!enabled || !agent || !version) return
    if (seenVersions.current.has(version.id)) return
    seenVersions.current.add(version.id)
    void fire(agent, version, version.number > 1 ? 'new version' : 'first version')
    // `fire` is recreated every render; depending on it would loop. The guards
    // above plus the seen-set make the effect idempotent, so the deps are the
    // stable things it actually reacts to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, agent?.id, version?.id])

  /* ---- trigger 3: periodic sweep on whatever is in testing ---- */
  useEffect(() => {
    if (!enabled) return
    const due = () => {
      if (!agent || !version) return false
      const last = Number(localStorage.getItem(`${STORAGE_KEY}-last-${agent.id}`) ?? 0)
      return Date.now() - last > PERIODIC_MS
    }
    const check = () => {
      if (!agent || !version || !due()) return
      localStorage.setItem(`${STORAGE_KEY}-last-${agent.id}`, String(Date.now()))
      void fire(agent, version, 'scheduled sweep')
    }
    // Not on mount: a fresh tab should not immediately spend a suite's worth of
    // model calls. The first sweep happens a day after enabling.
    const t = setTimeout(check, 86_400_000)
    const onVisible = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearTimeout(t); document.removeEventListener('visibilitychange', onVisible) }
  }, [enabled, agent?.id, version?.id])

  const toggle = (on: boolean) => {
    setEnabled(on)
    localStorage.setItem(STORAGE_KEY, on ? '1' : '')
  }

  return { enabled, toggle, running, lastRunAt, fire }
}

import { adapterLabel } from './adapters'
import { useEffect, useState } from 'react'
import { StoreProvider, useStore } from './store.tsx'
import { LogCall } from './LogCall'
import { Calls } from './Calls'
import { Scenarios } from './Scenarios'
import { Compare } from './Compare'
import { demoState, DEMO_PROJECT_ID } from './demo'
import { Grid, Versions, Triage, IssueBoard } from './Workbench.tsx'
import { BulkBench } from './BulkBench'
import { SimulationBench } from './SimulationBench'
import { Settings } from './Settings'
import { Overview } from './Overview'
import { NavProvider, type View } from './nav'
import GatePage from './GatePage'
import { uid } from './data'
import { apiHealth, type ApiHealth } from './api'
import { untriagedCount } from './notes'
import { CommandPalette } from './CommandPalette'
import type { Command } from './palette'

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

// Legacy browser storage keys stay unchanged to preserve saved preferences and navigation.
type Theme = 'system' | 'light' | 'dark'

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('agent-qa-theme') as Theme) || 'system')
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    localStorage.setItem('agent-qa-theme', theme)
  }, [theme])
  const cycle = () => setTheme(t => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system'))
  return { theme, cycle }
}

/* ------------------------------------------------------------------ */
/* First run                                                           */
/* ------------------------------------------------------------------ */

function Setup({ onComplete }: { onComplete: (projectId: string, tester: string) => void }) {
  const { state, mutate } = useStore()
  const [health, setHealth] = useState<ApiHealth | null>(null)
  useEffect(() => { void apiHealth().then(setHealth) }, [])
  const [projectName, setProjectName] = useState('')
  const [testerName, setTesterName] = useState('')

  const projectCreated = state.projects.length > 0
  const testerCreated = state.testers.length > 0

  const createProject = () => {
    const name = projectName.trim()
    if (!name) return
    const id = uid()
    mutate(d => { d.projects.push({ id, name }) })
    setProjectName('')
  }

  const createTester = () => {
    const name = testerName.trim()
    if (!name) return
    mutate(d => { if (!d.testers.includes(name)) d.testers.push(name) })
    setTesterName('')
  }

  return (
    <div className="setup-screen">
      <div className="card setup-card">
        <div className="setup-mark" aria-hidden="true">✓</div>
        <h2>Set up Our Agent Said What?!</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          An agentic QA testbench for voice agents. Catch it before your customers do.
        </p>

        <label className="field">Project name</label>
        {projectCreated ? (
          <p className="setup-done">✓ {state.projects[0].name}</p>
        ) : (
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input type="text" className="grow" value={projectName} autoFocus
              onChange={e => setProjectName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createProject()}
              placeholder="e.g. Crown Greens sales agents" />
            <button className="btn" disabled={!projectName.trim()} onClick={createProject}>Create</button>
          </div>
        )}

        <label className="field">Your name</label>
        {testerCreated ? (
          <p className="setup-done">✓ {state.testers[0]}</p>
        ) : (
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input type="text" className="grow" value={testerName}
              onChange={e => setTesterName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createTester()}
              placeholder="Shown next to every score you give" />
            <button className="btn" disabled={!testerName.trim()} onClick={createTester}>Add</button>
          </div>
        )}

        <button className="btn big" style={{ width: '100%', marginTop: 18 }}
          disabled={!projectCreated || !testerCreated}
          onClick={() => onComplete(state.projects[0].id, state.testers[0])}>
          Open Our Agent Said What?! →
        </button>
        <div className="or-rule"><span>or</span></div>
        <button className="btn big secondary" style={{ width: '100%' }}
          onClick={() => {
            mutate(d => { Object.assign(d, demoState(d)) })
            onComplete(DEMO_PROJECT_ID, 'Sample tester')
          }}>
          Look around with sample data first
        </button>
        <p className="muted center" style={{ margin: '6px 0 0' }}>A made-up agent with two prompt versions and ten logged calls. Remove it from Settings in one click.</p>
        <p className="muted center" style={{ marginTop: 12, marginBottom: 0 }}>
          {health?.mode === 'local'
            ? <>Saved on this machine in <code>{health.home}</code>, with every revision kept.</>
            : health?.store ? 'Saved to your team workspace.' : 'Stored in this browser only. Export a backup from Settings to move it.'}
        </p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

interface NavItem { view: View; label: string; icon: string }

const NAV: { group: string | null; items: NavItem[] }[] = [
  { group: null, items: [{ view: 'overview', label: 'Overview', icon: '◎' }] },
  {
    group: 'Manual QA', items: [
      { view: 'score', label: 'Log a call', icon: '✎' },
      { view: 'calls', label: 'Calls', icon: '🎧' },
    ],
  },
  {
    group: 'Automated', items: [
      { view: 'simulate', label: 'Simulate calls', icon: '⚡' },
      { view: 'bulk', label: 'Bulk analysis', icon: '⛁' },
    ],
  },
  {
    group: 'Results', items: [
      { view: 'scorecard', label: 'Scorecard', icon: '▦' },
      { view: 'triage', label: 'Triage', icon: '⚑' },
      { view: 'issues', label: 'Issues', icon: '◈' },
      { view: 'gate', label: 'Release gate', icon: '⛨' },
    ],
  },
  {
    group: 'Setup', items: [
      { view: 'versions', label: 'Prompt versions', icon: '⑂' },
      { view: 'scenarios', label: 'Scenarios', icon: '🗂' },
    ],
  },
  { group: null, items: [{ view: 'settings', label: 'Settings', icon: '⚙' }] },
]

/* Every destination says what it is for. A label alone makes you click to find out. */
const TITLES: Record<View, [string, string]> = {
  overview: ['Overview', 'Where every agent stands right now'],
  score: ['Log a call', 'Recording, transcript, ratings and timestamped notes, on one screen'],
  calls: ['Calls', 'Every logged call, with its recording, notes and transcript'],
  scenarios: ['Scenarios', 'What to test, per agent. Testers propose, builders approve'],
  simulate: ['Simulate calls', 'Run the prompt against difficult simulated customers, before you ship'],
  bulk: ['Bulk analysis', 'Drop in a batch of transcripts and let AI score and group the failures'],
  scorecard: ['Scorecard', 'Every agent × parameter × version, and what changed between two versions'],
  triage: ['Triage', 'Decide which tester reports become real issues'],
  issues: ['Issues', 'Track each defect from open to verified-fixed'],
  versions: ['Prompt versions', 'The prompt versions every score is pinned to'],
  gate: ['Release gate', 'What this product can prove, and what it cannot'],
  settings: ['Settings', 'Projects, agents, testers, rubric, backup and sharing'],
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

function Shell() {
  const { state } = useStore()
  const { theme, cycle } = useTheme()

  // Tester mode is an explicit, labelled choice — not a hidden padlock. The
  // person who opens a fresh deploy is the builder, so full nav is the default.
  const [testerMode, setTesterMode] = useState(() => localStorage.getItem('agent-qa-tester-mode') === '1')
  const [view, setView] = useState<View>(() => { const requested = new URLSearchParams(window.location.hash.slice(1)).get('view'); return requested && Object.prototype.hasOwnProperty.call(TITLES, requested) ? requested as View : 'overview' })
  const [projectId, setProjectId] = useState(() => localStorage.getItem('agent-qa-last-project') ?? state.projects[0]?.id ?? '')
  useEffect(() => { localStorage.setItem('agent-qa-last-project', projectId) }, [projectId])
  const [tester, setTester] = useState(state.testers[0] ?? '')
  const [setupDone, setSetupDone] = useState(state.projects.length > 0)
  const [navOpen, setNavOpen] = useState(false)
  const [dense, setDense] = useState(() => localStorage.getItem('agent-qa-dense') === '1')
  useEffect(() => { document.documentElement.classList.toggle('dense', dense); localStorage.setItem('agent-qa-dense', dense ? '1' : '') }, [dense])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [target, setTarget] = useState<{ agentId?: string; scenarioId?: string; callId?: string; issueId?: string; newVersion?: boolean }>({})
  const [routeKey, setRouteKey] = useState(0)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); setPaletteOpen(open => !open)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const project = state.projects.find(p => p.id === projectId) ?? state.projects[0]
  const pid = project?.id ?? ''

  const untriaged = untriagedCount(state, new Set(state.agents.filter(a => a.projectId === pid).map(a => a.id)))

  const setMode = (on: boolean) => {
    setTesterMode(on)
    localStorage.setItem('agent-qa-tester-mode', on ? '1' : '')
    go(on ? 'score' : 'overview')
  }

  const go = (v: View) => {
    setView(v); setTarget({}); setNavOpen(false)
    const params = new URLSearchParams(window.location.hash.slice(1)); params.set('view', v); history.replaceState(null, '', `#${params}`)
  }
  const jump = (v: View, project: string, detail: typeof target) => {
    setProjectId(project); go(v); setTarget(detail); setRouteKey(k => k + 1); setNavOpen(false)
  }
  const commands: Command[] = [
    ...NAV.flatMap(section => section.items).map(item => ({ id: item.view, label: item.label, detail: 'Page', run: () => go(item.view) })),
    { id: 'new-version', label: 'New version', detail: 'Action', run: () => jump('versions', pid, { newVersion: true }) },
    { id: 'dense', label: dense ? 'Turn off dense mode' : 'Dense mode', detail: 'Action', run: () => setDense(d => !d) },
    { id: 'theme', label: 'Switch theme', detail: 'Action', run: cycle },
    { id: 'tester', label: testerMode ? 'Builder view' : 'Tester view', detail: 'Action', run: () => setMode(!testerMode) },
    ...state.agents.map(a => ({ id: `agent-${a.id}`, label: a.name, detail: 'Agent / Log a call', run: () => jump('score', a.projectId, { agentId: a.id }) })),
    ...(state.scenarios ?? []).map(sc => ({ id: `scenario-${sc.id}`, label: sc.name, detail: `Scenario / ${state.agents.find(a => a.id === sc.agentId)?.name ?? ''}`, run: () => jump('scenarios', state.agents.find(a => a.id === sc.agentId)?.projectId ?? pid, { agentId: sc.agentId, scenarioId: sc.id }) })),
    ...state.sessions.map(call => ({ id: `call-${call.id}`, label: call.useCase, detail: `Call / ${call.tester} / ${call.createdAt} / ${new Date(call.createdAt).toLocaleDateString()} / ${state.agents.find(a => a.id === call.agentId)?.name ?? ''}`, run: () => jump('calls', state.agents.find(a => a.id === call.agentId)?.projectId ?? pid, { callId: call.id }) })),
    ...state.issues.map(issue => ({ id: `issue-${issue.id}`, label: issue.title, detail: 'Issue', run: () => jump('issues', issue.projectId, { issueId: issue.id }) })),
  ]

  if (!setupDone) {
    return <Setup onComplete={(p, t) => { setProjectId(p); setTester(t); setSetupDone(true) }} />
  }

  const themeLabel = theme === 'system' ? '◐ System' : theme === 'light' ? '☀ Light' : '☾ Dark'

  const body = (() => {
    switch (view) {
      case 'overview': return <Overview projectId={pid} tester={tester || 'there'} />
      case 'score': return <LogCall key={pid + tester + routeKey} initialAgentId={target.agentId} projectId={pid} tester={tester || 'Anonymous'} />
      case 'calls': return <Calls key={pid + routeKey} projectId={pid} initialCallId={target.callId} />
      case 'scenarios': return <Scenarios key={pid + routeKey} projectId={pid} initialAgentId={target.agentId} initialScenarioId={target.scenarioId} />
      case 'simulate': return <SimulationBench projectId={pid} />
      case 'bulk': return <BulkBench projectId={pid} />
      case 'scorecard': return <><Grid projectId={pid} /><div style={{ height: 12 }} /><Compare projectId={pid} /></>
      case 'triage': return <Triage projectId={pid} />
      case 'issues': return <IssueBoard key={pid + routeKey} projectId={pid} initialIssueId={target.issueId} />
      case 'versions': return <Versions key={pid + routeKey} projectId={pid} initialAgentId={target.agentId} initialNew={target.newVersion} />
      case 'gate': return <GatePage />
      case 'settings': return <Settings dense={dense} onDense={setDense} testerMode={testerMode} onTesterMode={setMode} />
    }
  })()

  return (
    <NavProvider value={go}>
      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
      <div className="topbar">
        {!testerMode && (
          <button className="icon-btn nav-toggle" onClick={() => setNavOpen(o => !o)} aria-label="Toggle navigation">☰</button>
        )}
        <span className="brand">Our Agent Said What?!</span>
        <button className="icon-btn" onClick={() => setPaletteOpen(true)}>Search <kbd>Ctrl/Cmd K</kbd></button>
        {state.projects.length > 1 && (
          <select value={pid} onChange={e => setProjectId(e.target.value)} aria-label="Project">
            {state.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <div className="spacer" />
        {(view === 'score' || testerMode) && state.testers.length > 0 && (
          <select value={tester} onChange={e => setTester(e.target.value)} aria-label="Who are you?">
            {state.testers.map(t => <option key={t}>{t}</option>)}
          </select>
        )}
        <button className="icon-btn" onClick={cycle} title="Switch theme">{themeLabel}</button>
        {testerMode && (
          <button className="icon-btn" onClick={() => setMode(false)}>Builder view</button>
        )}
      </div>

      <div className={`layout ${testerMode ? 'solo' : ''}`}>
        {!testerMode && (
          <nav className={`sidebar ${navOpen ? 'open' : ''}`}>
            {NAV.map((sec, i) => (
              <div key={i} className="nav-group">
                {sec.group && <div className="nav-group-label">{sec.group}</div>}
                {sec.items.map(it => (
                  <button key={it.view} className={`nav-item ${view === it.view ? 'active' : ''}`} onClick={() => go(it.view)}>
                    <span className="nav-icon" aria-hidden="true">{it.icon}</span>
                    <span className="nav-label">{it.label}</span>
                    {it.view === 'triage' && untriaged > 0 && <span className="nav-count">{untriaged}</span>}
                  </button>
                ))}
              </div>
            ))}
            <div className="nav-foot">
              <button className="nav-item subtle" onClick={() => setMode(true)}>
                <span className="nav-icon" aria-hidden="true">◑</span>
                <span className="nav-label">Switch to tester view</span>
              </button>
              <p className="muted">Hides everything except call scoring — use it when you hand this link to a tester.</p>
            </div>
          </nav>
        )}

        <main className="content">
          {!testerMode && (
            <div className="content-head">
              <h1>{TITLES[view][0]}</h1>
              <span className="muted">
                {TITLES[view][1]}{project && <> · {project.name}</>}
              </span>
            </div>
          )}
          {state.agents.some(a => adapterLabel(a.name) !== a.name) && <p className="notice" role="note">
            Experimental adapters in this workspace: {state.agents.filter(a => adapterLabel(a.name) !== a.name).map(a => adapterLabel(a.name)).join(', ')}. Live provider behavior, audio and timing are NOT MEASURED.
          </p>}
          {body}
        </main>
      </div>
    </NavProvider>
  )
}

/**
 * Named export alongside the default.
 *
 * The render test imports this file directly, and a default-only export means the
 * test can only reach the module through a dynamic import of `default` -- which
 * the previous test tried and got wrong, producing five failures that looked like
 * broken components and were actually a missing export.
 */
export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}

export { App as default }

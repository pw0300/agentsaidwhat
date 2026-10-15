import { useState } from 'react'
import { searchCommands, type Command } from './palette'
import { useDialogFocus } from './hotkeys'
import { EmptyState } from './nav'

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const ref = useDialogFocus()
  const results = searchCommands(commands, query)
  const active = Math.min(index, Math.max(0, results.length - 1))
  const run = (command: Command) => { onClose(); command.run() }
  return <div className="overlay" onClick={onClose}>
    <div ref={ref} className="card overlay-card command-palette" role="dialog" aria-modal="true" aria-label="Command palette"
      onClick={e => e.stopPropagation()} onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); onClose() }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const next = Math.max(0, Math.min(results.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)))
          setIndex(next)
          document.getElementById(`command-${next}`)?.scrollIntoView({ block: 'nearest' })
        }
        if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && results[active]) { e.preventDefault(); run(results[active]) }
      }}>
      <div className="row"><h2>Go to or do something</h2><div className="spacer" /><button className="btn secondary" onClick={onClose}>Close</button></div>
      <input autoFocus aria-label="Search commands" role="combobox" aria-expanded="true" aria-controls="command-results"
        aria-activedescendant={results.length ? `command-${active}` : undefined} value={query}
        onChange={e => { setQuery(e.target.value); setIndex(0) }} placeholder="Search pages, agents, scenarios, calls and issues" />
      <div id="command-results" role="listbox" className="command-results">
        {results.map((command, i) => <div id={`command-${i}`} role="option" aria-selected={i === active} key={command.id}
          className={`command-result ${i === active ? 'sel' : ''}`} onMouseMove={() => setIndex(i)}>
          <button tabIndex={-1} onClick={() => run(command)}><strong>{command.label}</strong><span className="muted">{command.detail}</span></button>
        </div>)}
        {!results.length && <EmptyState icon="Search" title="No matching commands" body="Try a shorter search or show all commands." actionLabel="Show all commands" onAction={() => { setQuery(''); setIndex(0) }} />}
      </div>
      <p className="muted">Arrow keys to move · Enter to run · Esc to close</p>
    </div>
  </div>
}

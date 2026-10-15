import { useEffect, useRef } from 'react'

/**
 * Keyboard shortcuts for people who log calls all day.
 *
 * Keys are ignored while typing in a text field, except the few that must work
 * from anywhere (save, escape). Space is left alone when a button has focus, so
 * pressing Space on a focused button clicks it rather than also toggling audio.
 */
export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>

const ALWAYS = new Set(['mod+enter', 'escape'])

export function comboOf(e: KeyboardEvent): string {
  const key = e.key === ' ' ? 'space' : e.key.toLowerCase()
  return `${e.ctrlKey || e.metaKey ? 'mod+' : ''}${e.altKey ? 'alt+' : ''}${key}`
}

export function isTyping(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null
  if (!t || !t.tagName) return false
  if (t.isContentEditable) return true
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true
  if (t.tagName === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'range', 'file'].includes((t as HTMLInputElement).type)
  return false
}

export function useHotkeys(map: HotkeyMap, enabled = true): void {
  const ref = useRef(map)
  ref.current = map
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return
      const combo = comboOf(e)
      const fn = ref.current[combo]
      if (!fn) return
      if (isTyping(e.target) && !ALWAYS.has(combo)) return
      if ((combo === 'space' || combo === 'enter') && ['BUTTON', 'A', 'INPUT'].includes((e.target as HTMLElement | null)?.tagName ?? '')) return
      e.preventDefault()
      fn(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}

/** Keep keyboard focus inside overlays and restore it on close. */
export function useDialogFocus() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const root = ref.current
    const firstField = root?.querySelector<HTMLElement>('input, textarea') ?? root?.querySelector<HTMLElement>('button')
    firstField?.focus()
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !root) return
      const nodes = Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input, select, textarea, [tabindex="0"]'))
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
    }
    root?.addEventListener('keydown', trap)
    return () => { root?.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus() }
  }, [])
  return ref
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

export function ShortcutHelp({ groups, onClose }: { groups: [string, [string, string][]][]; onClose: () => void }) {
  const ref = useDialogFocus()
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={onClose}>
      <div ref={ref} className="card overlay-card" onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); onClose() } }}>
        <div className="row"><h2 style={{ margin: 0 }}>Keyboard shortcuts</h2><div className="spacer" /><button className="btn small secondary" onClick={onClose}>Close</button></div>
        <div className="shortcut-groups">
          {groups.map(([title, rows]) => (
            <div key={title}>
              <h3>{title}</h3>
              {rows.map(([keys, what]) => (
                <div key={keys} className="shortcut-row">
                  <span>{keys.split(' ').map((k, i) => <Kbd key={i}>{k}</Kbd>)}</span>
                  <span className="muted">{what}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

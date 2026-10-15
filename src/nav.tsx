import { createContext, useContext } from 'react'

/** Every top-level destination in the app. Flat on purpose — the old shape
 *  nested five of these inside a "Workbench" tab that itself sat behind an
 *  unlabelled padlock, so nothing below the first level was discoverable. */
export type View =
  | 'overview'
  | 'score'
  | 'calls'
  | 'scenarios'
  | 'bulk'
  | 'simulate'
  | 'scorecard'
  | 'triage'
  | 'issues'
  | 'versions'
  | 'gate'
  | 'settings'

const NavCtx = createContext<(v: View) => void>(() => {})

export const NavProvider = NavCtx.Provider
export const useNav = () => useContext(NavCtx)

/** A dead-end empty state is a bug. Every one of them gets the button that
 *  resolves it, so the user is never told to go somewhere they can't find. */
export function EmptyState({ icon, title, body, actionLabel, to, onAction }: {
  icon: string
  title: string
  body: string
  actionLabel?: string
  to?: View
  onAction?: () => void
}) {
  const go = useNav()
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">{icon}</div>
      <h3>{title}</h3>
      <p className="muted">{body}</p>
      {actionLabel && (
        <button className="btn" onClick={() => (onAction ? onAction() : to && go(to))}>
          {actionLabel}
        </button>
      )}
    </div>
  )
}

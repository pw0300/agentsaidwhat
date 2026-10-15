import type { AppState } from './types'

/** Reverse unchanged records from one edit, preserving later or remote edits. */
export function undoMutation(before: AppState, after: AppState, current: AppState): AppState {
  const result = JSON.parse(JSON.stringify(current)) as AppState
  const keyOf = (item: unknown) => typeof item === 'string' ? item : (item as { id: string }).id
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])] as (keyof AppState)[]) {
    const oldRows = before[key] ?? []
    const newRows = after[key] ?? []
    const rows = [...(result[key] ?? [])] as unknown[]
    for (const id of new Set([...oldRows, ...newRows].map(keyOf))) {
      const old = oldRows.find(row => keyOf(row) === id)
      const next = newRows.find(row => keyOf(row) === id)
      if (same(old, next)) continue
      const index = rows.findIndex(row => keyOf(row) === id)
      if (!same(index >= 0 ? rows[index] : undefined, next)) continue
      if (old === undefined) rows.splice(index, 1)
      else if (index >= 0) rows[index] = old
      else rows.splice(Math.min(oldRows.findIndex(row => keyOf(row) === id), rows.length), 0, old)
    }
    Object.assign(result, { [key]: rows })
  }
  return result
}

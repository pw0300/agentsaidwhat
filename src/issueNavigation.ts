import type { Issue, IssueStatus } from './types'

export function adjacentIssue(issues: Issue[], selectedId: string, direction: number, columns: IssueStatus[]): string {
  const selected = issues.find(i => i.id === selectedId)
  if (!selected) return issues[0]?.id ?? ''
  const step = direction < 0 ? -1 : 1
  for (let column = columns.indexOf(selected.status) + step; column >= 0 && column < columns.length; column += step) {
    const card = issues.find(i => i.status === columns[column])
    if (card) return card.id
  }
  return selectedId
}

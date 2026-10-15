import type { TestSession } from './types'
import { isProblem } from './notes'

export const DEFAULT_FILTERS = { agent: '', version: '', scenario: '', tester: '', problems: '', recording: '', from: '', to: '', q: '', sort: 'date', direction: 'desc' }
export type CallFilters = typeof DEFAULT_FILTERS

export function readCallFilters(hash: string): CallFilters {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const filters = { ...DEFAULT_FILTERS }
  for (const key of Object.keys(filters) as (keyof CallFilters)[]) filters[key] = params.get(`calls.${key}`) ?? filters[key]
  if (!['date', 'agent', 'scenario', 'tester', 'score', 'notes', 'recording'].includes(filters.sort)) filters.sort = 'date'
  if (!['asc', 'desc'].includes(filters.direction)) filters.direction = 'desc'
  return filters
}

export function writeCallFilters(filters: CallFilters, hash = ''): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  params.set('view', 'calls')
  for (const key of Object.keys(filters) as (keyof CallFilters)[]) {
    params.delete(`calls.${key}`)
    if (filters[key] && filters[key] !== DEFAULT_FILTERS[key]) params.set(`calls.${key}`, filters[key])
  }
  return `#${params}`
}

export function filterCalls(sessions: TestSession[], filters: CallFilters, agentNames: Record<string, string>): TestSession[] {
  const q = filters.q.trim().toLowerCase()
  const value = (s: TestSession): string | number => {
    switch (filters.sort) {
      case 'agent': return agentNames[s.agentId] ?? ''
      case 'scenario': return s.useCase
      case 'tester': return s.tester
      case 'score': return s.scores.length ? s.scores.reduce((sum, score) => sum + score.value, 0) / s.scores.length : -1
      case 'notes': return s.observations.length
      case 'recording': return s.audioId ? 1 : 0
      default: return s.createdAt
    }
  }
  return sessions.filter(s => s.agentId in agentNames)
    .filter(s => !filters.agent || s.agentId === filters.agent)
    .filter(s => !filters.version || s.versionId === filters.version)
    .filter(s => !filters.scenario || s.useCase === filters.scenario)
    .filter(s => !filters.tester || s.tester === filters.tester)
    .filter(s => !filters.problems || s.observations.some(isProblem))
    .filter(s => !filters.recording || !!s.audioId)
    .filter(s => !filters.from || s.createdAt.slice(0, 10) >= filters.from)
    .filter(s => !filters.to || s.createdAt.slice(0, 10) <= filters.to)
    .filter(s => !q || [s.useCase, s.tester, s.createdAt, s.transcript, s.comments, ...s.observations.map(o => `${o.whatHappened} ${o.quote}`)].join(' ').toLowerCase().includes(q))
    .sort((a, b) => {
      const x = value(a), y = value(b)
      const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
      return (filters.direction === 'asc' ? order : -order) || a.id.localeCompare(b.id)
    })
}

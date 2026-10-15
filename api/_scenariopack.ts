import { parse } from 'yaml'

/** The caller supplies YAML text and a filename for diagnostics. */
export interface PackScenario {
  id: string
  name: string
  persona: string
  goal: string
  successCriteria: string[]
  language: string
  tags: string[]
  callerTurns?: string[]
}
export interface ScenarioPack {
  version: 1
  id: string
  name: string
  scenarios: PackScenario[]
}

export function loadScenarioPack(text: string, file: string): ScenarioPack {
  const fail = (field: string, detail: string): never => {
    throw new Error(`${file}: ${field} ${detail}`)
  }
  const object = (value: unknown, field: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return fail(field, 'must be an object')
    }
    return value as Record<string, unknown>
  }
  const string = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !value.trim()) return fail(field, 'must be a non-empty string')
    return value
  }
  const strings = (value: unknown, field: string, allowEmpty = false): string[] => {
    if (!Array.isArray(value) || (!allowEmpty && !value.length)) {
      return fail(field, 'must be an array of non-empty strings')
    }
    return value.map((v, i) => string(v, `${field}[${i}]`))
  }
  let parsed: unknown
  try { parsed = parse(text, { maxAliasCount: 100 }) } catch { return fail('document', 'must be valid YAML') }
  const pack = object(parsed, 'pack')
  if (pack.version !== 1) return fail('version', 'must be 1 (supported format version)')
  const id = string(pack.id, 'id')
  const name = string(pack.name, 'name')
  if (!Array.isArray(pack.scenarios) || !pack.scenarios.length) return fail('scenarios', 'must be a non-empty array')
  const ids = new Set<string>()
  const scenarios = pack.scenarios.map((value, i): PackScenario => {
    const prefix = `scenarios[${i}]`
    const s = object(value, prefix)
    const scenarioId = string(s.id, `${prefix}.id`)
    if (ids.has(scenarioId)) return fail(`${prefix}.id`, `duplicates "${scenarioId}"`)
    ids.add(scenarioId)
    return {
      id: scenarioId,
      name: string(s.name, `${prefix}.name`),
      persona: string(s.persona, `${prefix}.persona`),
      goal: string(s.goal, `${prefix}.goal`),
      successCriteria: strings(s.successCriteria, `${prefix}.successCriteria`),
      language: string(s.language, `${prefix}.language`),
      tags: strings(s.tags, `${prefix}.tags`, true),
      ...(s.callerTurns === undefined ? {} : { callerTurns: strings(s.callerTurns, `${prefix}.callerTurns`, true) }),
    }
  })
  return { version: 1, id, name, scenarios }
}

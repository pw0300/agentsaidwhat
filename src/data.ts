import type { AppState, RubricParam, Scenario } from './types'

// Keep the legacy workspace key so existing browser data remains available.
const KEY = 'agent-qa-state-v1'

export const uid = () => Math.random().toString(36).slice(2, 10)
export const now = () => new Date().toISOString()

const anchors135 = (a1: string, a3: string, a5: string) => ({ 1: a1, 3: a3, 5: a5 })

export const defaultRubric: RubricParam[] = [
  // Shared core
  { id: 'understanding', name: 'Understanding', question: 'Did it understand what the customer said or asked, even with accents or rambling?', appliesTo: ['voice', 'chatbot'], anchors: anchors135('Repeatedly misunderstood the customer', 'Understood mostly, missed a few things', 'Understood everything, even messy input') },
  { id: 'accuracy', name: 'Accuracy', question: 'Was every fact it stated correct (price, RERA, configuration, possession)?', appliesTo: ['voice', 'chatbot'], anchors: anchors135('Stated a wrong fact confidently', 'Minor slip, self-corrected', 'Everything correct') },
  { id: 'helpfulness', name: 'Helpfulness', question: 'Did the customer get what they came for / move toward the goal (site visit, answer)?', appliesTo: ['voice', 'chatbot'], anchors: anchors135('Customer left with nothing', 'Partially helped', 'Goal achieved or clearly progressed') },
  { id: 'naturalness', name: 'Naturalness', question: 'Did it sound/read like a good human agent, not a script?', appliesTo: ['voice', 'chatbot'], anchors: anchors135('Robotic, obviously scripted', 'Okay but stiff in places', 'Felt like a good human agent') },
  { id: 'recovery', name: 'Recovery', question: 'When confused, interrupted, or corrected — did it handle it gracefully?', appliesTo: ['voice', 'chatbot'], anchors: anchors135('Got stuck or looped', 'Recovered after some fumbling', 'Recovered smoothly every time') },
  { id: 'tone', name: 'Persuasion & tone', question: 'Polite, confident, right push toward the goal without being pushy?', appliesTo: ['voice', 'chatbot'], anchors: anchors135('Rude, pushy, or timid', 'Fine but flat', 'Warm, confident, persuasive') },
  // Voice only
  { id: 'clarity', name: 'Clarity & pacing', question: 'Easy to hear and follow? Right speed, right pauses?', appliesTo: ['voice'], anchors: anchors135('Hard to follow, too fast/slow', 'Mostly fine, some rushed parts', 'Perfect pace and pauses') },
  { id: 'pronunciation', name: 'Pronunciation', question: 'Names, numbers, dates, Hindi/English switching said correctly?', appliesTo: ['voice'], anchors: anchors135('Frequent mispronunciations', 'A few slips', 'Everything pronounced right') },
  { id: 'interruptions', name: 'Interruption handling', question: 'When the caller talked over it, did it stop and adapt (no script-marching)?', appliesTo: ['voice'], anchors: anchors135('Kept reading the script over the caller', 'Stopped but lost thread', 'Stopped, adapted, continued naturally') },
  { id: 'callflow', name: 'Call flow', question: 'Right opening, no looping, closed properly (no self-hangup on silence)?', appliesTo: ['voice'], anchors: anchors135('Looped or ended the call wrongly', 'Minor flow hiccups', 'Clean open, middle, and close') },
  // Chatbot only
  { id: 'relevance', name: 'Response relevance', question: 'Did each reply address the actual message?', appliesTo: ['chatbot'], anchors: anchors135('Replies off-topic', 'Mostly on point', 'Every reply on point') },
  { id: 'formatting', name: 'Formatting & length', question: 'Replies scannable, right length, not walls of text?', appliesTo: ['chatbot'], anchors: anchors135('Walls of text', 'Somewhat long', 'Crisp and scannable') },
  { id: 'memory', name: 'Context memory', question: 'Did it remember earlier parts of the chat?', appliesTo: ['chatbot'], anchors: anchors135('Forgot earlier context', 'Occasionally forgot', 'Remembered everything relevant') },
]

function seed(): AppState {
  return {
    projects: [],
    agents: [],
    versions: [],
    sessions: [],
    issues: [],
    rubric: defaultRubric,
    testers: [],
    batches: [],
    calls: [],
    scenarios: [],
  }
}

/**
 * Give every agent's old free-text use cases a place in the scenario library.
 *
 * Ids are derived from the agent and the name, not random, so two browsers
 * migrating the same workspace produce the same records and the merge sees one
 * scenario instead of two copies of it.
 */
export function migrateScenarios(s: AppState): boolean {
  s.scenarios ??= []
  let changed = false
  for (const a of s.agents) {
    for (const name of a.useCases ?? []) {
      let hash = 2166136261
      for (const ch of name) hash = Math.imul(hash ^ ch.codePointAt(0)!, 16777619) >>> 0
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
      const id = `sc-${a.id}-${slug}-${hash.toString(16).padStart(8, '0')}`
      if (s.scenarios.some(x => x.id === id || (x.agentId === a.id && x.name === name))) continue
      const sc: Scenario = {
        id, agentId: a.id, name, persona: '', goal: '', successCriteria: '', language: '',
        tags: [], status: 'approved', proposedBy: '', createdAt: now(),
      }
      s.scenarios.push(sc)
      changed = true
    }
    // Retire the migration source so renames and deletions cannot recreate it.
    if (a.useCases?.length) { a.useCases = []; changed = true }
  }
  return changed
}

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const s = JSON.parse(raw) as AppState
      // migrations for states saved before the bulk bench existed
      s.batches ??= []
      s.calls ??= []
      if (migrateScenarios(s)) saveState(s)
      // Anyone who used the app before the proxy existed still has an Anthropic
      // key sitting in localStorage. Drop it on load — leaving a live secret in
      // browser storage after removing the UI that manages it is worse than
      // never having stored it, because nobody can see it to revoke it.
      if ('apiKey' in s) {
        delete (s as AppState & { apiKey?: string }).apiKey
        saveState(s)
      }
      return s
    }
  } catch { /* corrupted -> reseed */ }
  const s = seed()
  saveState(s)
  return s
}

export function saveState(s: AppState) {
  // loadState was guarded against a missing localStorage and saveState was not,
  // which is why server-rendering this app threw `Cannot read properties of
  // undefined (reading 'setItem')` at module load rather than at the first edit.
  //
  // The asymmetry was invisible because loadState always ran first and always
  // caught: it made the whole module look guarded when only half of it was.
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // A full quota or a privacy mode throws here. Losing a draft is bad;
    // taking the app down mid-session over it is worse.
  }
}

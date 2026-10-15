import { useState } from 'react'
import { useStore } from './store'
import { replyToClarification } from './workspaceActions'
export function ClarificationReply({ sessionId, observationId }: { sessionId: string; observationId: string }) {
  const { mutate } = useStore()
  const [reply, setReply] = useState('')
  return <div>
    <label>Clarification reply <textarea value={reply} onChange={e => setReply(e.target.value)} /></label>
    <button className="btn small secondary" disabled={!reply.trim()} onClick={() => {
      mutate(d => { const note = d.sessions.find(s => s.id === sessionId)?.observations.find(o => o.id === observationId); if (note) replyToClarification(note, reply) })
      setReply('')
    }}>Reply and return to triage</button>
  </div>
}
export function ClarificationRequests({ projectId, tester }: { projectId: string; tester: string }) {
  const { state } = useStore()
  const agents = new Set(state.agents.filter(a => a.projectId === projectId).map(a => a.id))
  const requests = state.sessions.filter(s => agents.has(s.agentId) && s.tester === tester).flatMap(s => s.observations.filter(o => o.triage === 'needs-clarification').map(o => ({s, o})))
  if (!requests.length) return null
  return <section className="card"><h2>Clarification requested</h2>{requests.map(({s,o}) => <div key={o.id}>
    <p>{s.useCase}: {o.whatHappened}</p><p>Reviewer: {o.triageNote}</p>
    <ClarificationReply sessionId={s.id} observationId={o.id} />
  </div>)}</section>
}

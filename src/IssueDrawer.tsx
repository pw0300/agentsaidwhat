import { useState } from 'react'
import { FAILURE_LAYERS, LAYER_LABEL, LAYER_TEAM, toFailureLayer } from './types'
import { recordVerification } from './issueActions'
import type { Issue, IssueVerification, PromptVersion } from './types'

export function IssueDrawer({ issue, versions, onClose, onUpdate }: { issue: Issue; versions: PromptVersion[]; onClose: () => void; onUpdate?: (update: (issue: Issue) => void) => void }) {
  const [testedVersion, setTestedVersion] = useState(issue.claimedFixedInVersionId ?? '')
  const [tester, setTester] = useState('')
  const [note, setNote] = useState('')
  const [verdict, setVerdict] = useState<IssueVerification['verdict']>('fixed')
  const version = (id: string) => { const v = versions.find(v => v.id === id); return v ? `v${v.number}` : 'Unavailable version' }
  return <aside className="card issue-drawer" aria-label="Issue details">
    <div className="row"><h2>{issue.title}</h2><div className="spacer" /><button className="btn secondary" autoFocus onClick={onClose}>Close</button></div>
    <p>{issue.description}</p>
    <p><strong>Owner:</strong> {issue.ownerTeam || 'Unassigned team'}{issue.ownerPerson ? ` · ${issue.ownerPerson}` : ' · No person assigned'}</p>
    <p className="muted">{issue.attribution}</p>
    {onUpdate && issue.claimedFixedInVersionId && <form onSubmit={e => {
      e.preventDefault()
      onUpdate(current => recordVerification(current, { versionId: testedVersion, tester: tester.trim(), verdict, note: note.trim(), createdAt: new Date().toISOString() }))
      setNote('')
    }}>
      <h3>Verify the claimed fix</h3>
      <label className="field">Version tested<select required value={testedVersion} onChange={e => setTestedVersion(e.target.value)}><option value="">Choose a version</option>{versions.filter(v => v.agentId === issue.agentId).map(v => <option key={v.id} value={v.id}>v{v.number}</option>)}</select></label>
      <label className="field">Tester name<input required value={tester} onChange={e => setTester(e.target.value)} /></label>
      <label className="field">Result<select value={verdict} onChange={e => setVerdict(e.target.value as IssueVerification['verdict'])}><option value="fixed">Fixed</option><option value="not-fixed">Not fixed</option><option value="partial">Partial</option></select></label>
      <label className="field">Verification note<textarea required value={note} onChange={e => setNote(e.target.value)} /></label>
      <button className="btn" disabled={!testedVersion || !tester.trim() || !note.trim()}>Record verification</button>
    </form>}
    {onUpdate && <section>
      <label className="field">Failure layer<select value={toFailureLayer(issue.layer)} onChange={e => onUpdate(current => { current.layer = toFailureLayer(e.target.value); current.ownerTeam = LAYER_TEAM[current.layer] })}>{FAILURE_LAYERS.map(layer => <option key={layer} value={layer}>{LAYER_LABEL[layer]}</option>)}</select></label>
      <label className="field">Owner team<input value={issue.ownerTeam ?? ''} onChange={e => onUpdate(current => { current.ownerTeam = e.target.value })} /></label>
      <label className="field">Owner person<input value={issue.ownerPerson ?? ''} onChange={e => onUpdate(current => { current.ownerPerson = e.target.value })} /></label>
    </section>}
    <h3>Timeline</h3>
    <ol className="issue-timeline">
      <li><strong>Born in {version(issue.bornInVersionId)}</strong><p className="muted">{new Date(issue.createdAt).toLocaleString()}</p></li>
      {issue.claimedFixedInVersionId && <li><strong>Claimed fixed in {version(issue.claimedFixedInVersionId)}</strong><p className="muted">{versions.find(v => v.id === issue.claimedFixedInVersionId)?.changelog}</p></li>}
      {issue.verifiedFixedInVersionId && <li><strong>Verified fixed in {version(issue.verifiedFixedInVersionId)}</strong></li>}
      {[...issue.verifications].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((v, index) => <li key={index}>
        <strong>{v.tester} checked {version(v.versionId)}: {v.verdict}</strong><p>{v.note}</p><p className="muted">{new Date(v.createdAt).toLocaleString()}</p>
      </li>)}
      <li><strong>Current status: {issue.status.replace(/-/g, ' ')}</strong><p>{issue.resolutionNote}</p></li>
    </ol>
    {!issue.claimedFixedInVersionId && <p className="muted">No fix claimed yet. Claim a fix when creating its prompt version.</p>}
  </aside>
}

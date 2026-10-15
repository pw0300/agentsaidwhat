import type { Issue, IssueVerification } from './types'

export function recordVerification(issue: Issue, verification: IssueVerification) {
  if (!verification.versionId || !verification.tester.trim() || !verification.note.trim()) throw new Error('Choose a version and enter your name and verification note.')
  issue.verifications.push(verification)
  issue.status = verification.verdict === 'fixed' ? 'verified-fixed' : 'reopened'
  issue.verifiedFixedInVersionId = verification.verdict === 'fixed' ? verification.versionId : null
  issue.resolutionNote = verification.note
}

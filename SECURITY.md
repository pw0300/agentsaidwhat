# Security

Report vulnerabilities privately to `TODO-security-contact@example.com`.
This is a placeholder: maintainers must configure a working private reporting
channel before publication. If repository private vulnerability reporting is
enabled, use its Security tab. Do not post exploit details, recordings or secrets
in a public issue while a report is being assessed.

Include affected versions, a minimal synthetic reproduction and expected impact.
Do not send customer data. No response-time guarantee is established yet.

Never commit recordings, private transcripts, keys, session tokens or downloaded
corpora. Keep credentials in environment variables or CI secrets. If a credential
is exposed, revoke it and report privately; removing it from the current tree
does not remove it from git history.

PII redaction happens at the local and hosted state API boundaries for transcripts,
observations, comments and call finding evidence. Model message text is redacted
again before forwarding. It does not erase
identities from audio or guarantee that every identifier is caught. Check inputs
and exported evidence before sharing them. Local mode binds to localhost and
has no sign-in; network access requires the operator to protect the service.

Local requests require an allowed Host. Writes require a matching Origin when
one is supplied, plus JSON Content-Type or an accepted audio upload type.
These browser protections do not authenticate other programs on the machine.
Audio uploads check container signatures, not whether a recording is safe or
contains personal data. See [privacy and storage notes](docs/PRIVACY.md) for
retention, membership migration and budget limits.

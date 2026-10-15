# Privacy and storage

Local and hosted state sync use the same redaction helper. It masks transcript
text, session observations (text, whatHappened, expected and quote), comments,
and call finding evidence before saving or returning the merged state. Local
history restoration also runs redaction before saving the restored revision.
Agent prompts are preserved so version comparisons remain meaningful.

Patterns cover common contact and financial identifiers, UPI handles, Indian
PIN codes after address or PIN context, numeric dates after DOB or born, and
runs of at least ten spoken digit words in English, Hindi transliteration or
Devanagari. Short numeric-word lists and dates without birth context are kept.
These are conservative heuristics, not a guarantee that all personal data is
removed. Review evidence and exports before sharing. Audio is not anonymized.
Existing database revisions and backups are not rewritten by a new sync.

The model relay redacts user and assistant message strings and text blocks.
System prompts are operator configuration and are preserved. Keep customer
identifiers out of system prompts. When hosted accounts exist, model requests
require a live signed-in membership; viewers cannot run analysis.

Every model relay request spends from QA_MONTHLY_CALL_CAP (default 2000).
Hosted budgets use an atomic Redis increment per workspace, with the anonymous
account-free deployment using the default workspace budget. Local deployments
without Redis use an in-process budget, which resets when the process restarts.
This is a request count limit, not a token cost estimate. Provider failures
still spend a request. Invalid caps use the default; zero disables calls.

# Local request and recording controls

The local server accepts Host names localhost, 127.0.0.1, [::1], and the
configured HOST. POST, PUT, DELETE and PATCH require application/json, except
audio POSTs, which accept supported audio types or application/octet-stream.
Any supplied Origin must match the request's own HTTP origin, including port.
Scripts without Origin still need an allowed Host and Content-Type. Local mode
has no account authentication. Protect any service exposed beyond this machine.

Static serving uses a path-relative containment check, so encoded traversal
cannot serve sibling dist-server or dist-private folders. Server bundle imports
use filesystem URLs with path escaping, including installation paths with #.

Recording extensions and any audio Content-Type must agree with the leading
container bytes: RIFF/WAVE, ID3 or MPEG frames, OggS, fLaC, ftyp, EBML, or ADTS.
This checks file type, not complete audio validity. Display names lose directory
components, control characters and unsafe filename characters. Files on disk
use generated identifiers. Connector HTTP bodies and WebSocket messages are
limited to 1 MB; the existing 15 second connector timeout remains in effect.

# Memberships and deletion

<!-- The aq: Redis namespace remains unchanged so existing hosted data stays accessible. -->

Workspace membership stores both tenantId and role. Creators receive admin;
invitees receive the invite role. Sign-in and workspace switching read that
stored role. Legacy membership entries containing only a workspace id receive
viewer access until an operator assigns the intended role in aq:user-tenants.
Do not infer admin access from an old session or from missing role data.

State merges retain deleted record ids in _tombstones for each collection.
Deletion wins over concurrent edits, and old tabs cannot re-add those ids even
when absent from their base. Tombstones persist without expiry; new records
must use new ids. Local history restoration is an explicit recovery operation
and can restore an older record. Deleting current evidence does not erase local
revision history or backups. Use the privacy erasure workflow and manage
retained history and backups separately when complete erasure is required.

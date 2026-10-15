# Gate output stability

[gate-result.v1.json](schemas/gate-result.v1.json) describes evaluated results
from local and hosted /api/gate and CLI gate --json. It does not describe
authentication, transport or invalid-request errors, which have an error string.

Within v1, required fields, types and outcome values stay compatible. New optional
fields may be added. Consumers must ignore unknown fields and must not parse
human-readable summary, label, detail or blocker prose. Check IDs identify checks;
parameter checks use param:<rubric-id>. Changes to required fields, types or
outcome meanings require a new schema version and documented migration. The
filename versions the contract; the existing response has no schemaVersion field.

Outcomes are pass, fail, inconclusive and disabled. CLI exits are 0, 1, 2 and 2
respectively. HTTP returns 200 for pass or disabled and 409 for fail or
inconclusive. Disabled is never evidence of a passing evaluation.

Receipts share agent, version, measured values, promptHash and evaluatedAt.
Local receipts have signed: false. Hosted receipts add tenant, policy, summary,
blockers, hash and signature. A local receipt cannot prove authenticity. Schema
validation checks shape, not signature validity or measurement quality. Null
composite means absent scores, not a score of zero. Counts name the evidence
sample, not all calls that might have occurred.

Evidence accounting adds optional v1 receipt fields: unsubstantiatedSessions
counts excluded sessions with no transcript, recording reference or observations;
paramSamples maps each rubric parameter to its scored-call count. samples is the
total substantiated session and batch-call count, not the number of ratings.
A parameter floor with fewer than minSamples measured calls is inconclusive.
Human sessions exclude source: simulated. simulatedSessions counts those sessions;
aiCalls counts batch calls. These disjoint counts sum to samples. Optional policy
minHumanSessions defaults to 0; insufficient human evidence is inconclusive.
Rejected manual blockers and issues verified fixed in or before the candidate
version are excluded from blockerFindings. Claimed fixes and later fixes count.
CLI gate returns 2 for malformed JSON or missing/unknown outcomes. Unsigned local
receipts print unsigned (local mode). ready --json preserves text-mode exit codes
and emits only JSON. Export and inventory require hosted mode.

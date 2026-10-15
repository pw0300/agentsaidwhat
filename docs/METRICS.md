# Metrics and limits

A metric without evidence is NOT MEASURED, never PASS. Record the source,
sample size, version and limits with every reported number.

Manual rubric averages describe the calls people scored. They depend on the
rubric and tester consistency. Automated judge scores describe text judgments,
not human listening. Panel disagreement and absent input must remain visible.
The release gate pools available rubric scores and checks policy floors; a gate
pass is conditional on that policy and those samples, not a universal guarantee.

Audio probes require the inputs declared in `REQUIRED_INPUT` in
`api/_voicebench.ts`. Timing needs recordings, separated channels or turn
telemetry. Mixed-channel timing can be an estimate. Synthetic signals test code
behavior and do not establish real-call performance. ASR research measures an
engine against a recorded reference; it does not establish what an agent heard
in a live conversation. See [the README's recorded results](../README.md#measured-results-and-limits)
and [real speech calibration](REAL-SPEECH-CALIBRATION.md) for evidence and limits.

## NOT MEASURED

- End-to-end live telephone quality across languages, providers and networks.
- Agent ASR errors and code-switch boundary accuracy in real caller exchanges.
- TTS pronunciation and human-rated Hindi voice quality across the target population.
- A broadly calibrated judge on that population.
- Production load, reliability and deployment latency.

Text simulation cannot hear prosody or measure barge-in latency. Small recorded
samples cannot establish population performance. Research notes are historical;
consult committed artifacts rather than treating their status labels as current.

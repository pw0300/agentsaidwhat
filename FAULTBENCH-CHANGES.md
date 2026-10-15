# Constructed fault benchmark changes

Implemented the fault catalogue, seeded multilingual call generator, committed set and data card, blinded deterministic and optional judge scorer, hidden-regression gate validation, CLI, npm script and tests. No runtime dependencies were added. No src files or existing api files were edited. Test setup now builds the bundle expected by the existing UI tests and the frontend required by the CLI smoke test.

Source: [deterministic results](bench/results/v1-deterministic.json), input hash 034ad6e20710e850a96f0452b108eafc4eddf000f1a3953320c162152d4c4cbe. Run: node bench/run.mjs --set v1 --judge none. 300 constructed calls; 315 injected fault events; 90 clean calls.

All rates below are fractions, copied without rounding from the result file. Counts are audit counts, not rate estimates.

| Overall metric | Result |
| --- | --- |
| Precision | 1 (n=120; 95% CI [1, 1]) |
| Recall | 0.41237113402061853 (n=291; 95% CI [0.35611510791366907, 0.46938775510204084]) |
| F1 | 0.583941605839416 (n=291; 95% CI [0.5251989389920424, 0.6388888888888888]) |
| Layer attribution on matched faults | 0.7833333333333333 (n=120; 95% CI [0.7105263157894737, 0.8492063492063492]) |
| Clean-call false positive rate | 0 (n=90; 95% CI [0, 0]) |

120 matches, 0 spurious fault predictions and 171 missed measured fault events. The 24 ASR injection events are excluded from overall rates because their generated trace is circular.

| Fault | Found/injected (raw counts) | Precision | Recall | F1 | Layer accuracy |
| --- | --- | --- | --- | --- | --- |
| wrong-fact | 0/28 | INSUFFICIENT SAMPLE (n=0) | 0 (n=28; 95% CI [0, 0]) | 0 (n=28; 95% CI [0, 0]) | INSUFFICIENT SAMPLE (n=0) |
| dodged-question | 0/27 | INSUFFICIENT SAMPLE (n=0) | 0 (n=27; 95% CI [0, 0]) | 0 (n=27; 95% CI [0, 0]) | INSUFFICIENT SAMPLE (n=0) |
| loop-repeat | 1/29 | INSUFFICIENT SAMPLE (n=1) | 0.034482758620689655 (n=29; 95% CI [0, 0.11764705882352941]) | 0.06666666666666667 (n=29; 95% CI [0, 0.21052631578947367]) | INSUFFICIENT SAMPLE (n=1) |
| ignored-language-switch | 0/27 | INSUFFICIENT SAMPLE (n=0) | 0 (n=27; 95% CI [0, 0]) | 0 (n=27; 95% CI [0, 0]) | INSUFFICIENT SAMPLE (n=0) |
| talked-over-caller | 36/36 | 1 (n=36; 95% CI [1, 1]) | 1 (n=36; 95% CI [1, 1]) | 1 (n=36; 95% CI [1, 1]) | 1 (n=36; 95% CI [1, 1]) |
| false-endpoint | 27/27 | 1 (n=27; 95% CI [1, 1]) | 1 (n=27; 95% CI [1, 1]) | 1 (n=27; 95% CI [1, 1]) | 1 (n=27; 95% CI [1, 1]) |
| long-gap | 30/30 | 1 (n=30; 95% CI [1, 1]) | 1 (n=30; 95% CI [1, 1]) | 1 (n=30; 95% CI [1, 1]) | 1 (n=30; 95% CI [1, 1]) |
| early-hangup | 26/26 | 1 (n=26; 95% CI [1, 1]) | 1 (n=26; 95% CI [1, 1]) | 1 (n=26; 95% CI [1, 1]) | 0 (n=26; 95% CI [0, 0]) |
| asr-mishear | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED | NOT MEASURED |
| hallucinated-policy | 0/33 | INSUFFICIENT SAMPLE (n=0) | 0 (n=33; 95% CI [0, 0]) | 0 (n=33; 95% CI [0, 0]) | INSUFFICIENT SAMPLE (n=0) |
| unconfirmed-success | 0/28 | INSUFFICIENT SAMPLE (n=0) | 0 (n=28; 95% CI [0, 0]) | 0 (n=28; 95% CI [0, 0]) | INSUFFICIENT SAMPLE (n=0) |

Deterministic semantic detectors are absent for wrong-fact, dodged-question, ignored-language-switch, hallucinated-policy, unconfirmed-success. Each has zero matched predictions in this run. These are concrete roadmap gaps, not evidence that an agent passes those behaviors. The repetition check found 1 of 29 constructed loops. Its existing call-level repetition band misses most single repeated answers. The existing self-hangup voice check attributes early disconnects to VAD, while this construction injected the telephony layer. That disagreement remains visible in the confusion table; it was not relabelled to inflate accuracy.

The panel file reports 0 measured calls. Judges were explicitly disabled; every judge metric is NOT MEASURED. This run establishes no judge accuracy.

Source: [gate validation](bench/results/gate-validation.json). 30 paired constructed score rows. Baseline composite 3.3333333333333335; candidate composite 4. Baseline accuracy 4; candidate accuracy 2. Baseline outcome pass; candidate outcome fail; failing check param:accuracy. These controlled scores prove gate behavior, not agent performance.

Source: [validation record](bench/results/validation.json). npm test: 485 passing, 0 failing across 32 files. Required repository typechecks and direct benchmark typechecking all exited successfully.

The generator preservation tests prevent paired injections from overwriting each other, including the ASR injector's next-response change and repeat injections depending on an earlier answer. The committed set and data card were regenerated after those checks.

This measures call/fault presence and layer attribution on synthetic text and timing telemetry. It does not measure turn localization, real-world prevalence, acoustic quality, real ASR behavior on audio, live network latency or Hindi voice quality. Whole-call bootstrap intervals describe this constructed fixture population with repeated templates, not new production callers. Zero-width fixture intervals do not imply production certainty. Read [bench/README.md](bench/README.md) for methods, limits and commands.

ASR mishear is NOT MEASURED: comparing generated heardText to generated truth is circular, with no independent recognition evidence. Timing faults use exact synthetic timings and are easier than real calls. Overall recall covers 291 non-ASR injected events.

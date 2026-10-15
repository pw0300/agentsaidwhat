# Constructed fault benchmark

Install the checkout dependencies, including development dependencies:

```sh
npm ci --include=dev
npm run bench:faults -- --set v1 --judge none
node bench/make-set.mjs
node bench/validate-gate.mjs
```

The runner bundles its TypeScript modules with the repository's existing esbuild dependency. It resolves files relative to itself. `make-set.mjs` recreates the committed set and data card. The set card and distribution JSON describe its composition.

Results go to `bench/results/<set>-deterministic.json` and `<set>-panel.json`. Each file names its input, input hash, scoring unit, measured checks, sample size, bootstrap method and limits. Evidence preserves the actual predictions and checks on each call. Every injected label stays separate from the input passed to detectors or judges.

Precision is matched fault predictions divided by all predictions. Recall is matched labels divided by injected labels. F1 combines the two using event counts. Overall results are micro averages of call/fault presence, not a percentage of completely correct calls. Predictions match by fault id within a call; turn localization is not measured. Paired calls retain both labels. Layer accuracy uses only matched events and compares the detailed engine layer. The confusion table also records misses and spurious predictions as raw counts.

Intervals are percentile bootstrap intervals resampling whole calls with a fixed seed. This preserves faults paired in the same call. Undefined ratio replicates are omitted. Repeated templates limit what these intervals mean: they quantify resampling this fixture set, not variation across real customers. Constant fixture outcomes can have zero-width intervals. Counts under the minimum support remain visible for auditing, but rate estimates are labelled `INSUFFICIENT SAMPLE`. A missing or disabled judge returns `NOT MEASURED`, never PASS.

With `--judge panel`, configured providers are selected by `api/_judgepanel.ts` and called using the existing provider request builders. The panel uses the repository's verdict agreement rule; a contested verdict produces no measurement. A single provider remains explicitly single. Agreement on an overall verdict does not establish agreement on individual faults. The first answering opinion supplies the selected fault predictions. Replies, errors and agreement states are saved. API calls can incur provider charges. Provider keys remain in the environment and are not written to result files.

The deterministic runner uses existing naturalness repetition and voice budget checks on constructed text and timing telemetry, plus a new endpoint-versus-caller-end check. It does not add a semantic detector tailored to the injection wording. Faults lacking a deterministic detector remain in the recall denominator so gaps are visible. Other naturalness signals are saved but are not mapped to faults they do not measure. Audio probes require recordings and cannot run on these transcripts. Gate measurement and suite helpers aggregate scores rather than detecting faults; the separate gate validation exercises suite aggregation and the release gate with controlled score inputs.

The gate artifact proves a per-parameter floor catches a constructed regression hidden by an improving composite. Its controlled scores are fixtures, not observed agent performance.

This benchmark does not measure real-world fault prevalence, acoustic quality, live network performance, actual ASR on audio, TTS pronunciation or human-rated Hindi quality. The handwritten template family is limited and public. These synthetic transcripts are easier than real calls. No UI files are changed; the Release gate UI is owned by another worker.

The corrected deterministic artifact reports 120 matches across 291 measured injection events: precision 1 (n=120; 95% CI [1, 1]), recall 0.41237113402061853 (n=291; 95% CI [0.35611510791366907, 0.46938775510204084]), F1 0.583941605839416 (n=291; 95% CI [0.5251989389920424, 0.6388888888888888]), and layer accuracy 0.7833333333333333 (n=120; 95% CI [0.7105263157894737, 0.8492063492063492]). Clean-call false positive rate is 0 (n=90; 95% CI [0, 0]). ASR mishear is NOT MEASURED because generated heardText compared with generated truth is circular; its 24 injections are excluded from rates. Timing faults use exact synthetic timings and are easier than real calls.

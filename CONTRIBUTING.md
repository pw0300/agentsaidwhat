# Contributing to Our Agent Said What?!

Use Node 22.13 or newer. Clone the repository, then run:

```sh
npm ci
npm run local
```

<!-- Legacy data paths and AGENT_QA_* environment names stay unchanged for compatibility. -->

Open http://localhost:5199 for the demo workspace. Local mode needs no account
or hosted services. Keep your `agent-qa-data/` folder out of git. Add a server
provider key only if you want model-backed simulations.

## Checks before a pull request

```sh
npx tsc -b
npx tsc -p tsconfig.api.json
npm test
npm run build
```

`npm test` builds test modules and uses `test/run_all.mjs`. The runner discovers
all `*.test.mjs` files, runs each even if another fails, aggregates their reports
and fails on a bad exit or silent test file. A bare `&&` chain stops at the first
failure and the last reporter's count is only that file's total. Do not use that
count as the suite total. Inspect the aggregate result and exit status.

## Hard review criterion: evidence

A metric without evidence must say NOT MEASURED (`no-data` or `inconclusive` in
code), never PASS. Every reported number needs its source, sample size and what
it does not measure. Separate fixture results from live measurements. Preserve
uncertainty, failed controls and judge disagreement. A pull request that hides
missing inputs behind a green result cannot be accepted.

## Add a scenario pack

Follow [scenarios/README.md](scenarios/README.md). Add a versioned YAML
pack with concrete caller goals and observable success criteria. Test it through
`loadScenarioPack` from `api/_scenariopack.ts`; invalid fields must name both the
file and field. Add fixtures to `test/scenariopack.test.mjs`. External pack loading
is an extension seam, not a UI import feature. A runner must explicitly map the
pack to the built-in `Scenario` format in `api/_simulate.ts`.

## Add an agent adapter

Implement `VoiceAdapter` in `api/_voicebench.ts`: declare the layers covered and
return evidence from `run` for the exact agent and version. For a telephony
bridge, inspect `AgentBridge` in `api/_telephony.ts`. Document credentials,
formats, channel separation and timing units. Test disconnects and absent audio
as well as a successful exchange. Do not claim a live integration from fixtures.

## Add a metric probe

Keep reproducible corpus preparation in `tools/`. Define the input, units,
source licence, sample size and missing-input behavior. Reuse measurement types
and `REQUIRED_INPUT` in `api/_voicebench.ts`. Test against a known signal or
annotation, and include a control that could reveal a plausible wrong number.
Publish permitted summary artifacts under `data/`; apply DATA-LICENSES.md first.

## Add a judge provider

Follow `PROVIDERS` and response handling in `api/_judge.ts`, then update panel
selection in `api/_judgepanel.ts` as needed. Pin the model and endpoint, keep keys
in the server environment and redact text at the API boundary. Test malformed
responses, timeouts, missing credentials and disagreement. Extend the calibration
fixtures in `api/_calibration.ts` and state whether live calibration was run.

## Scope and privacy

Start with [scoped starter tasks](docs/GOOD-FIRST-ISSUES.md). The
[documentation index](docs/README.md) links the user and architecture guides.

Keep changes focused. Never commit real recordings, private transcripts, keys
or personal contact details. Use synthetic fixtures and example.com addresses.
Follow [SECURITY.md](SECURITY.md), [DATA-LICENSES.md](DATA-LICENSES.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Describe behavior and validation in the
pull request, including any measurements that remain unavailable.

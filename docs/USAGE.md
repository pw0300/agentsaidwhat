# Usage reference

Detailed setup, CLI, CI, architecture and Docker notes. The [README](../README.md) is the short tour.

## 60-second quickstart

Use Node 22.13 or newer. Once the package is published:

```sh
npx agentsaidwhat
```

Until then, or when working from a checkout:

```sh
npm ci
npm run local
```

<!-- Legacy data paths and AGENT_QA_* environment names stay unchanged for compatibility. -->

Open http://localhost:5199. The app starts with demo data. One Node process stores
the workspace in SQLite and recordings in `agent-qa-data/audio/`. No account,
Redis or Vercel is needed. Set `AGENT_QA_HOME` to choose another data folder.
Demo scores are examples, not benchmark results. Model-backed suites need a
provider key in the server environment; manual logging works without one.

`npx agentsaidwhat` launches the local app. Use `npx agentsaidwhat help` for CI commands.
The repository URL must be set before publishing the package.

## Test your own agent in under 10 minutes

From a checkout, install and build, then start the reference agent:

```sh
npm ci --include=dev
npm run build
node examples/reference-agent/server.mjs
```

In another terminal:

```sh
node cli.mjs run scenarios/hinglish-support.yaml --agent ws://localhost:8080 --version v3
node cli.mjs run scenarios/hinglish-support.yaml --agent http://localhost:8080/turn --version v3 --json
node cli.mjs
```

After publication the equivalent command is:

```sh
npx agentsaidwhat run scenarios/hinglish-support.yaml --agent ws://localhost:8080 --version v3
```

Pack paths are checked in your current directory first. If absent, bundled
paths such as `scenarios/hinglish-support.yaml` are resolved relative to the installed package.
Your own existing pack files take precedence. This works from an empty consumer directory.

Replace the URL with your agent's endpoint using the [adapter schemas](ADAPTERS.md).
The reference agent returns deterministic support replies and needs no API keys.
The pack's optional `callerTurns` run in order by default. Use `--mode simulated`
to let an LLM play the persona toward its goal. Keys come from `OPENAI_API_KEY`,
`GOOGLE_API_KEY`, `DEEPSEEK_API_KEY` or `ANTHROPIC_API_KEY` in the environment.
Without a key, simulated mode prints one line and falls back to `callerTurns`.
Without either, the run is inconclusive and exits 2.

Results are saved to the local SQLite workspace under `AGENT_QA_HOME` (default
`./agent-qa-data`). Open the local app, select Connected agents, the endpoint,
and v3 to see the simulated sessions beside human logs on the scorecard.
`--version` pins evidence to a version label; deploy that version yourself before
running. The CLI does not update the remote agent's prompt.

Exit codes are 0 pass, 1 fail and 2 inconclusive or misconfigured. Without a
judge key, the Hinglish pack exits 2: reply presence is checked, but its prose
criteria remain NOT MEASURED. Timing is NOT MEASURED on text-only adapters.
For a fully deterministic smoke check that exits 0 without keys:

```sh
node cli.mjs run examples/reference-agent/scenarios.yaml --agent ws://localhost:8080 --version v3
```

Literal criteria such as `contains: order ID` check the agent's text only. They
do not prove conversational quality, audio quality or semantic goal achievement.
Vapi, Retell, Pipecat and LiveKit adapters are experimental. Live deployments
have not been verified. Their text connectors and SDK bridges are described in
[ADAPTERS.md](ADAPTERS.md).

## Two ways to use it

### Manual logging

The tester screen records a real call: recording, transcript, 1-5 rubric ratings
and timestamped went-right / went-wrong notes. Select the agent and exact prompt
version before scoring. The workbench compares versions and shows the shared
scorecard. Triage assigns failures to a layer and owner. The issue board tracks
claimed fixes and their verification evidence.

<!-- screenshot: tester screen with version-pinned call evidence -->

<!-- screenshot: workbench scorecard and issue board -->


### Automated suites

The simulation bench selects scenarios and caller personas, then runs a prompt
against simulated callers. The suite result screen shows calls, rubric scores,
failures and coverage. Results feed the same scorecard as manual calls.
The built-in simulator uses text. It does not establish audio quality or live
telephone latency. [Scenario packs](../scenarios/README.md) provide an extension
format and a loader; importing external packs into the UI is not wired yet.

<!-- screenshot: simulation bench and suite result -->


## CI release gate

```sh
export QA_URL=https://qa.example.com
export QA_TOKEN=YOUR_SESSION_TOKEN
npx agentsaidwhat gate --agent "$AGENT_ID" --version "$PROMPT_VERSION"
```

The gate checks composite and per-parameter floors, blocker count, sample size
and regression against the previous version. Exit codes are `0` pass, `1` fail
and `2` inconclusive, disabled or misconfigured. A missing measurement is not a
successful check. Hosted gate results include a signed receipt covering the
prompt hash, policy, measurement and verdict.

After publishing this repository, use the root composite action. Replace the
repository placeholder with its published name and pin a reviewed commit:

```yaml
- uses: pw0300/agentsaidwhat@TODO-reviewed-commit
  with:
    agent: ${{ vars.AGENT_ID }}
    version: ${{ vars.PROMPT_VERSION }}
  env:
    QA_URL: ${{ secrets.QA_URL }}
    QA_TOKEN: ${{ secrets.QA_TOKEN }}
```

The action runs `cli.mjs gate` with Node 22. It exposes `exit-code` and preserves
the CLI exit status. Keep deployment credentials in secrets. Hosted tokens have
the permissions of the account that owns the session.

## Architecture

Local mode is the default. `server/local.mjs` serves the React app, SQLite
workspace, revision history and audio folder. It uses shared gate, merge and
redaction helpers from `api/`, and reuses the model-backed handlers in `api/`
through `server/lib.ts`. Local storage and authentication routes are handled
locally. It binds to localhost; local mode has no sign-in.

Hosted mode is optional: Vercel runs `api/` handlers with Upstash storage.
It adds tenant-scoped sessions, audit records and privacy routes. Configure
`QA_SESSION_SECRET`, `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or their Upstash
aliases). Model calls need the chosen provider's environment key, such as
`ANTHROPIC_API_KEY`. `QA_ACCESS_CODE`, `QA_ALLOWED_IPS` and `QA_MONTHLY_CALL_CAP`
are optional controls. `/api/health` and `npx agentsaidwhat ready` check readiness.

| Path | Purpose |
| --- | --- |
| `src/` | React tester, workbench and simulation screens |
| `api/` | Shared measurements, judges, simulation and hosted request handlers |
| `server/` | Local HTTP server, SQLite and audio storage |
| `cli.mjs` | Gate, readiness, export and inventory commands |
| `test/` | Tests collected by `test/run_all.mjs` |
| `tools/` | Dataset download and metric reproduction scripts |

Hosted privacy endpoints provide inventory, export and erasure. Transcripts are
PII-redacted at the API boundary. Treat recordings as sensitive: text redaction
does not remove identities from audio. See [SECURITY.md](../SECURITY.md).

## Measured results and limits

[ASR comparison](../data/asr_compare.json) evaluates Whisper small and large-v3 on
six Indic DiarBench Hindi clips, with 3,128 reference words. Both fail the 15%
WER budget. Small spans 60.5-83.8% WER and large-v3 spans 41.3-57.2% when showing
both overlap-corrected and raw estimates. Small's 60.5% is derived from the
comparison JSON's raw 83.79% multiplied by its 0.7218 overlap correction.
The [large-v3 verdict](../data/asr_verdict.json) stores its corrected and raw values.
The comparison JSON's `wer_min` and `wer_max` currently preserve only the raw
endpoints, 83.8% and 57.2%; they are not the corrected ranges. These ranges
are normalization choices, not confidence intervals. Fold choice and overlap
correction affect the estimates.
This measures the **ASR engine**, not an agent mishearing a caller. Six clips
cannot establish performance across languages, domains or telephone networks.

[Real-speech calibration](REAL-SPEECH-CALIBRATION.md) and
[voice-scoring research](VOICE-SCORING.md) explain their inputs and limits.
Synthetic fixture checks establish behavior on constructed signals, not a live
call benchmark. Research notes describe earlier experiments and may have older
status claims; the committed artifacts are the evidence for reported results.

## What is NOT MEASURED yet

- End-to-end live telephone performance with a real caller voice and agent bridge.
- Agent ASR mistakes, code-switch boundary accuracy and TTS pronunciation quality.
- Human-rated Hindi voice quality and calibrated judge accuracy on that population.
- Production load, network reliability and latency across deployments.

Text simulations cannot hear prosody, detect a TTS mispronunciation or measure
barge-in latency. Audio probes need recordings, separated channels or turn
telemetry as specified by `REQUIRED_INPUT` and `VoiceAdapter` in
`api/_voicebench.ts`. Do not interpret a missing input as a passing agent.

## Contributing

See the [documentation index](README.md) for task guides, shortcuts,
architecture and measurement limits.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for setup, tests and extension points.
Scenario packs, adapters, metric probes and judge providers are welcome.
Review follows the honesty rule above and our [code of conduct](../CODE_OF_CONDUCT.md).

## Docker

From a checkout, run `docker compose up --build -d` and open
http://localhost:5199. The Node 22 image runs as the node user, binds to
0.0.0.0 inside the container and checks /api/health. Compose exposes it only
on this machine because local mode has no sign-in. The named volume at /data
keeps SQLite, revision history and recordings across container replacements.
Use `docker compose down` to stop; adding -v deletes the workspace volume.

Manual logging needs no key. Set ANTHROPIC_API_KEY before starting Compose for
simulation and analysis. Optional judge panel keys are OPENAI_API_KEY,
GOOGLE_API_KEY and DEEPSEEK_API_KEY. Never bake credentials into the image.
For a bind mount instead of the named volume, make the folder writable by the
container's node user (UID 1000). Back up /data while the service is stopped.

## Licence

Code: [Apache-2.0](../LICENSE), copyright 2026 Our Agent Said What?! contributors.
Datasets and model weights have separate terms in [DATA-LICENSES.md](../DATA-LICENSES.md).

## Static sample demo

`npm run build:demo` builds a read-only sample workspace into `dist-demo/`.
Serve that folder with a static web server. It makes no server API calls and
cannot upload, judge, simulate or save workspace changes. The sample scores are
illustrations. The Pages workflow deploys on main or manual dispatch; select
GitHub Actions as the Pages source in repository settings.

# Release gate and CI

Configure a policy for the agent and choose its exact prompt version. The gate
checks composite and per-parameter floors, sample count, blocker findings and
regression against the baseline. Missing evidence must not become a pass.

```sh
export QA_URL=http://localhost:5199
export QA_TOKEN=YOUR_SESSION_TOKEN
npx <pkg> gate --agent YOUR_AGENT_ID --version YOUR_VERSION_ID --json
```

`<pkg>` is defined in [Quickstart](QUICKSTART.md). Hosted deployments require a
session token. Local mode has no sign-in; the current CLI still requires a
non-empty QA_TOKEN, so use any non-secret local value for local requests.

| Outcome | CLI exit | HTTP status |
| --- | --- | --- |
| pass | 0 | 200 |
| fail | 1 | 409 |
| inconclusive | 2 | 409 |
| disabled | 2 | 200 |

Request and configuration errors also exit 2. Consumers should use structured
outcomes and checks, not parse summary prose. See the [v1 contract](STABILITY.md).
Local receipts are unsigned. Hosted receipts include a hash and signature.

Use the root [composite action](../action.yml) after replacing its repository
placeholder and pinning a reviewed commit. Supply agent and version inputs and
QA_URL / QA_TOKEN secrets. The action preserves the CLI exit status.

The [release workflow](../.github/workflows/release.yml) responds to v* tags.
Before tagging, choose an available npm name, align package.json name and bin,
set the repository URL, add the exact version's CHANGELOG section, and configure
NPM_TOKEN. The tag must equal v plus the package version. The workflow tests,
builds, checks package contents, smoke-tests Docker, publishes with provenance,
pushes GHCR images and creates a GitHub release. It is not an atomic transaction;
an external publish failure can require maintainer recovery. No publication was
performed as part of this work.

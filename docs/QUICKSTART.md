# Quickstart

Use Node 22.13 or newer. From a checkout:

```sh
npm ci
npm run local
```

Open http://localhost:5199. The local server needs no account or model key.
Load sample data from the first-run screen, or create a project and agent.
Sample scores are illustrations, not benchmark evidence.

Run `npx agentsaidwhat` to start Our Agent Said What?! locally. The package
is `agentsaidwhat`; its CLI is `saidwhat`, with `agentsaidwhat` as an alias.
In these docs, `<pkg>` means `agentsaidwhat`. Do not paste the angle brackets
into your command.

<!-- Legacy data paths and AGENT_QA_* environment names stay unchanged for compatibility. -->

SQLite revisions and recordings live in the local data folder printed at
startup. Set `AGENT_QA_HOME` to choose a different folder, and `PORT` to choose
a different port. Keep your workspace out of git. Manual logging, scoring,
triage and gates over saved evidence work without provider keys. Set
`ANTHROPIC_API_KEY` in the server environment for simulation and AI analysis,
then restart. Never paste a provider key into the browser.

For a container, see [Docker setup](../README.md#docker). For the static sample
build, see [architecture](ARCHITECTURE.md). For development checks, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

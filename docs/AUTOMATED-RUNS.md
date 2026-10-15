# Automated runs

The current simulation screen runs a prompt against text callers and judges the
result. It needs `ANTHROPIC_API_KEY` in the server environment. Text simulations
can test content and recovery, but cannot establish voice quality, live ASR
accuracy or telephone timing.

## Connected agent runs

The shipped CLI runner connects to generic WebSocket or HTTP endpoints and saves
version-pinned sessions in the local workspace. The [ADAPTERS.md guide](ADAPTERS.md)
describes request schemas, platform limits and SDK bridge setup. Vapi, Retell,
Pipecat and LiveKit adapters are experimental and untested on live deployments.

```sh
npx agentsaidwhat run scenarios/hinglish-support.yaml --agent http://localhost:8080/turn --version v3
```

[Scenario packs](../scenarios/README.md) accept native YAML and JSON with goals,
criteria and optional caller turns. Scripted mode uses those turns; simulated
mode uses a configured model and falls back to scripted turns when no key is set.
Literal criteria provide deterministic text smoke checks. Prose criteria require
a configured judge; absent or failed measurements are NOT MEASURED.
Loading an external pack does not import it into the simulation screen.

Text runs do not establish acoustic interruption handling, voice quality or
production reliability. See [CONTRIBUTING.md](../CONTRIBUTING.md#add-an-agent-adapter).

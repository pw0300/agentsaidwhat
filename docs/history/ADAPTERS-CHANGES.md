# Adapter changes

## What works

- One turn contract in `api/_adapter.ts` with session open, caller send, agent
  response, close, text/audio/timing/barge-in capabilities and validated timing.
- Generic WebSocket and HTTP adapters tested against a deterministic local
  reference agent. No API keys or new runtime dependencies are needed.
- `saidwhat run <pack> --agent <url> --version v3`, compact table, JSON output,
  and exit codes 0 pass, 1 fail, 2 inconclusive or misconfigured.
- Scripted callerTurns and simulated callers using the existing supported LLM
  providers and persona prompt. Missing keys produce one fallback notice in
  simulated mode. Missing both keys and scripted turns produces exit 2.
- Version-pinned simulated sessions in the local SQLite workspace, including
  transcripts, adapter status/capabilities, checks and scorecard ratings.
- Deterministic response presence and explicit contains/notContains assertions.
  Prose criteria use existing judge request/response code. Missing or contested
  judgement remains NOT MEASURED. Missing timing never creates a passing timing
  result or a timing score.
- README quickstart, schemas, contributor example, platform documentation links
  and a reference smoke pack that passes without keys.

## What is untested-live

- Vapi text chat through its documented `/chat` API and previousChatId context.
- Retell chat agents through documented create-chat, create-chat-completion and
  end-chat APIs. This requires a chat agent ID.
- Pipecat SDK bridge using sendText and LLM token/stop callbacks. The owner
  supplies a connected, bot-ready client factory.
- LiveKit SDK bridge using lk.chat and text-only lk.transcription streams. The
  owner supplies an isolated room and agent identity. Audio transcription
  segments are ignored because they do not establish full turn completion.

All four carry `status: 'untested-live'`. Request schemas and bridge behavior
have mock tests; no paid platform calls were made and no live credentials were
available. Pipecat and LiveKit are deployment-owned SDK bridges, not turnkey
cloud integrations. No platform SDK is added to the base installation.

## What could not be built or established

- Native audio calling, audio quality grading, physical barge-in and voice
  latency are not implemented or established by these text tests. Those require
  an audio caller and platform-specific media transport, not HTTP round-trip
  duration. The contract permits audio without pretending it was exercised.
- Universal Pipecat/LiveKit cloud start endpoints were not invented. Their
  documented client APIs need deployment-specific transport, room creation,
  dispatch and authentication. A bridge module provides that configuration.
- Semantic success cannot be established without a configured judge. Literal
  smoke criteria establish only the stated text assertions, not semantic goal
  achievement. An overall pass never means that audio quality was tested.
- Real YAML parsing remains the shared scenario loader's responsibility. It was
  left untouched as instructed. This revision accepts JSON-format YAML packs;
  optional callerTurns are preserved in a compatibility bridge. When the shared
  loader returns callerTurns for real YAML, the driver uses them directly.
- `--version` pins stored evidence, not remote deployment state. Deploy the
  desired prompt yourself before running the selected assistant or endpoint.

## Validation

- Full discovered suite: 486 passing, 0 failing, including 13 new adapter tests.
- `npx tsc -b` and `npx tsc -p tsconfig.api.json` pass.
- End-to-end tests start the reference agent on free ports and run the actual
  CLI over WS and HTTP, then inspect temp SQLite documents and version pins.
- Tests cover capability gating, malformed messages, disconnects, scripted
  fallback, simulated caller generation, judge abstention, platform schemas,
  SDK bridge cleanup and all three CLI exit codes.
- The test build now produces the UI harness bundle required by existing tests
  and builds the frontend required by the existing local CLI smoke test. No
  source UI component was changed.

Each brief item has its own commit. The final documentation commit removes the
brief and run log. Protected paths and the shared scenario parser were unchanged.

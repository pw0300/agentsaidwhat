# Agent adapters

## Write an adapter in under 50 lines

Implement the contract in `api/_adapter.ts`. This text-only adapter has no
timing claim:

```ts
import type { AgentAdapter, Capability } from './_adapter'
export function myAdapter(): AgentAdapter {
  return {
    metadata: { name: 'my-platform', status: 'untested-live' },
    capabilities: new Set<Capability>(['text']),
    async open(session) { /* Create an isolated conversation. */ },
    async send(turn) {
      const response = await fetch(process.env.MY_AGENT_URL!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env.MY_AGENT_KEY}`,
        },
        body: JSON.stringify({ text: turn.text }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`Agent returned ${response.status}.`)
      const reply = await response.json()
      if (typeof reply.text !== 'string') throw new Error('Missing reply text.')
      return { text: reply.text }
    },
    async close() { /* Release remote resources. */ },
  }
}
```

Use your platform's documented schema, keep keys in the environment, and never
include upstream bodies or credentials in error messages. Export the factory
through `server/lib.ts` and register it in `server/run.mjs`. Add the module to
`build:lib` when importing it in tests. This example assumes a stateless endpoint;
stateful agents must retain the remote session ID between sends.

The generic transports are tested locally. They default to text only. A timing
field is milliseconds since session open, and is evidence only when the adapter
advertises timing. Missing capabilities produce NOT MEASURED.

## WebSocket schema

Client sends `{"type":"open","session":{"id":"...","scenarioId":"...","version":"v3"}}`.
Server may send `{"type":"capabilities","capabilities":["text","timing"]}`.
Client sends `{"type":"turn","id":"1","turn":{"text":"Hello"}}`.
Server replies `{"type":"turn","id":"1","turn":{"text":"Hi","startMs":0,"endMs":10,"firstByteMs":2}}`.
The ID must match. One turn is in flight at a time. Close ends the session.
Optional audio is `{"data":"base64 bytes","mimeType":"audio/wav"}`.

## HTTP schema

POST the endpoint with `{"type":"turn","session":{"id":"...","scenarioId":"...","version":"v3"},"turn":{"text":"Hello"}}`.
Return a turn object directly: `{"text":"Hi"}`. Non-2xx responses fail the call.
HTTP provides text only; request duration is not voice latency. Both transports
time out after 15 seconds. Session IDs isolate reference agent conversations.

## Platform status

Vapi, Retell, Pipecat and LiveKit adapters are experimental (`untested-live`). Credentials were unavailable; no
paid calls were made. These connectors test text behavior only.

| Platform | Connection | Limits and docs |
| --- | --- | --- |
| Vapi (experimental) | `--agent vapi://<assistant-id>`, `VAPI_API_KEY` | Chat API with previousChatId. [Docs](https://docs.vapi.ai/chat/quickstart). Local close clears context; no remote delete. |
| Retell (experimental) | `--agent retell://<chat-agent-id>`, `RETELL_API_KEY` | Create chat, completion, end chat. Requires a chat agent, not a voice agent ID. [Create](https://docs.retellai.com/api-references/create-chat), [completion](https://docs.retellai.com/api-references/create-chat-completion), [end](https://docs.retellai.com/api-references/end-chat). |
| Pipecat (experimental) | SDK bridge with `pipecatAdapter(connect)` | Factory creates a bot-ready client with supplied callbacks. Uses sendText, LLM text tokens and LLM stop. [Methods](https://docs.pipecat.ai/api-reference/client/js/client-methods), [callbacks](https://docs.pipecat.ai/api-reference/client/js/callbacks). |
| LiveKit (experimental) | SDK bridge with `livekitAdapter(connect)` | Factory returns isolated connected room and agentIdentity. Uses lk.chat and text-only lk.transcription. Agent must disable audio and emit one complete reply stream. Audio sentence transcripts are ignored. [Docs](https://docs.livekit.io/agents/multimodality/text/). |

<!-- Legacy data paths and AGENT_QA_* environment names stay unchanged for compatibility. -->

For the experimental Pipecat and LiveKit adapters, set `AGENT_QA_ADAPTER_MODULE` to a local `.mjs` module
exporting `createAdapter(url)`, returning the corresponding SDK adapter from
`dist-server/lib.mjs`. Set `--agent pipecat://my-agent` or
`--agent livekit://my-agent`. The factory owns deployment-specific transport,
dispatch, room isolation and credentials, all from environment variables.
The SDK is supplied by the owner and loaded only from that bridge; the base
package has no SDK dependencies. These are SDK bridges, not turnkey cloud
connectors. Native audio calling, timing and barge-in are not implemented.

## Packs, scoring and caller modes

Packs load through `loadScenarioPack` in `api/_scenariopack.ts`, which accepts
native YAML and JSON and validates the versioned scenario schema.
The caller driver retains optional `callerTurns: string[]` for scripted runs.
See the [scenario format](../scenarios/README.md) and the shipped
[runner guide](AUTOMATED-RUNS.md).

`--mode scripted` is the default. Simulated mode uses the existing caller persona
prompt and configured provider request builders. No key means one fallback
notice, then scripted turns if available. A model error does not silently switch
the caller midway through a conversation. Caller generation stops on `[DONE]`
or after 12 turns; reaching the limit makes the run inconclusive.

Every run checks non-empty replies. `contains: text` and `notContains: text`
criteria are deterministic case-insensitive literal checks against agent replies,
never caller text. All other criteria need the existing LLM judge providers.
Unconfigured judges, failed judges or disagreeing judges produce NOT MEASURED.
A single configured judge can score but is not independent panel confirmation.
Timing checks require both an advertised capability and all three timestamps;
passing this check establishes evidence completeness only. It does not grade
latency. HTTP network duration is never reported as voice timing.

SQLite sessions store the transcript, checks, source, version and adapter results.
The scorecard parameters are Response presence and Scenario goal. Missing scores
are omitted, with NOT MEASURED explained in session comments. Literal-only
criteria can pass the Scenario goal parameter as a smoke assertion, not a
semantic goal judgement. Audio and barge-in quality remain unmeasured.

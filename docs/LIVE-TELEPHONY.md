# Live telephony harness

Run the testbench locally with `npm ci` and `npm run local`. Vercel and
Upstash are optional hosted components. See [the README](../README.md).
These research notes record earlier experiments; consult committed artifacts
for current evidence and [DATA-LICENSES.md](../DATA-LICENSES.md) before using data.

**Added 1 October 2026.** `api/_telephony.ts`, `test/telephony.test.mjs` (23 tests).

This is the piece that connects to a number and talks to a live agent over an
internet telephony line. It exists because one measurement in this repo cannot be
done from a recording.

## The gap this closes

`measureBargeIn` on a **mixed mono track** infers the agent's stop point from the
gap between alternating turns. That is an upper bound, and the source has always
said so.

On **separated channels** it is exact.

The good news, from Twilio's Media Streams documentation: a *bidirectional* stream
delivers the two directions as separate byte streams on one socket. Inbound
`media` frames are the caller. Outbound `media` frames are the agent. **Dual-
channel capture is not a separate feature to buy — it falls out of the protocol
required to speak at all.** That is the whole argument for building on a
bidirectional stream rather than on a recording API.

## What it does

1. Places a call to a test number via Twilio Programmable Voice.
2. Answers with `<Connect><Stream direction="inbound">` — bidirectional.
3. Streams a parameterised caller persona as 8 kHz mu-law.
4. Writes caller audio and agent audio to two separate sample-aligned WAVs.
5. Feeds them to `measureBargeIn({ channels: 2 })`, which is now exact.

Then the gate can answer *did the agent stop when the caller interrupted* with a
number instead of a bound.

## What it deliberately does not do

**It does not implement a voice agent.** It bridges via an `AgentBridge` to
whatever the customer runs — LiveKit, Vapi, Ultravox, or their own WebSocket. The
moment this file contained a STT/LLM/TTS pipeline it would be measuring itself,
and the bench's vendor-neutrality would be gone.

Supported bridge kinds are real integration shapes, not hypotheticals:
`livekit` · `vapi` · `ultravox` · `websocket`.

## Bugs found, all in production code

Building this found **three defects in the acoustic bench** that 26 passing
fixture tests had not caught. All three are in the shared audio path, so all
three affect every measurement in the product.

### 1. The barge-in scanner could not detect a barge-in

The channel path looked for "the caller speaking AND the agent silent" and called
that the caller's onset.

On an overlap the agent is still talking through the whole interruption, so that
condition first becomes true only **after the agent has already stopped**. The
scan was measuring *when the agent finished yielding* and reporting it as the
caller's onset. It could never report a barge-in, because by construction the
barge-in had ended.

Measured: a 2000 ms caller onset with a 2400 ms agent stop came back as
`callerStartMs: 2400, stopLatencyMs: 10`. The truth was 400 ms. **Wrong by 40×,
and in the direction that makes a bad agent look like a good one.**

The onset is now simply when the caller starts talking; whether the agent was
talking at that moment is what `overTalk` reports.

### 2. The channel path never derived its own thresholds

`detectSpeech` defaults to a hardcoded −48 dB, and the two legs were passed no
thresholds — so each was thresholded at a level chosen for some other recording.
On a leg whose noise sat at −54 dBFS, −48 is inside the noise: every frame read as
silence and the measurement returned nothing.

Each leg now derives thresholds from its own energy. The two legs of a call can
sit at completely different levels, so a shared threshold is never right.

### 3. A fixed dB margin cannot span a real noise/speech gap

The speech threshold was `noiseFloor + 14 dB`. That works when speech sits ~15 dB
above the noise and fails catastrophically when it sits 45 dB above: the
threshold lands inside the noise mode and **zero frames cross it**.

This is the same class of bug as the noise-floor estimator fixed earlier — a
constant where a measurement belongs — and it only became visible once the floor
was correct.

The threshold is now a **fraction of the measured dynamic range** (`0.35`), which
is scale-free: the same expression works for a 20 dB spread and a 60 dB spread.

## Two codec facts worth knowing

**mu-law has no encoder here, deliberately.** One was written and removed. The
harness only ever *decodes* mu-law (every inbound frame); *encoding* would only be
needed to synthesise the caller's voice, which belongs to the TTS layer and which
every telephony provider ships natively. Four passes of hand-rolled companding
ended with a version that mis-encoded everything below 9000. Deleting it deleted
that risk.

The decoder is verified **exhaustively** instead: all 8 exponent segments, exact
`8<<e` steps, base values 0/132/396/924/1980/4092/8316/16764, zero out-of-range
results, both zeros → 0.

**−0 is a real trap.** Code `0x7f` decodes to `-0`, which is correct. But
`Object.is(-0, 0)` is false, so a strict equality check fails on correct code and a
`> 0` test treats silence as speech. Normalised in the decoder.

**mu-law cannot represent anything below ±32.** A caller at −40 dBFS lands near
the zero code. That is the wire format, not a bug — and it means the noise-floor
estimator sees *quiet* rather than *speech* at the very bottom of the range.

## The failure mode this file exists to prevent

A live call harness **fails silently**. A script that never reaches the agent's
STR produces no findings and no error, and a gate that reports "no issues" for a
call that never connected is worse than useless — it is a false green.

`assertCallReachedAgent` exists to make that loud. It returns **specific reasons**,
not a boolean, because "the call failed" and "the agent was silent" need different
fixes:

- the media stream never connected
- the stream connected but never started
- no caller audio was streamed
- **the agent produced no audio — the structure passed, the content did not**
- agent audio sent but Twilio never confirmed playback with a mark
- call lasted < 500 ms — too short to measure, so latency is `NO DATA`, not 0

## Files

| file | what |
|---|---|
| `api/_telephony.ts` | wire format, dual-channel capture, `TwilioAdapter`, `AgentBridge`, health checks |
| `test/telephony.test.mjs` | 23 tests: codec codebook, capture, the dual-channel claim, false-green guards |

## Running it

Needs `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY`, `TWILIO_API_KEY_SECRET`, a
purchased number, and a publicly reachable `wss://` stream endpoint. Credentials
are environment-only and never accepted from a client — a client-supplied token
would let anyone point this at a billable number, and the failure mode there is a
phone bill rather than a crash.

```
209 tests, both typecheckers clean, both benches exit 0.
Real-speech calibration held at 92.8% recall after the threshold change.
```

## Still missing

- **No provider adapter for LiveKit/Vapi/Ultravox has been written.** The
  `AgentBridge` interface exists and is the right seam; the implementations are
  the next thing to build, and each is ~100 lines against a documented API.
- **No live call has been placed.** Everything here is verified against
  constructed signals and the provider's published protocol, not against a real
  telephone network. Treat it as correct-until-proven-otherwise on first run.
- **No authenticated `wss` server.** `TwilioAdapter` takes a `wsFactory` rather
  than owning a server, so the transport is the customer's choice.
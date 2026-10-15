# Exotel: simulating a real call

Run the testbench locally with `npm ci` and `npm run local`. Vercel and
Upstash are optional hosted components. See [the README](../README.md).
These research notes record earlier experiments; consult committed artifacts
for current evidence and [DATA-LICENSES.md](../DATA-LICENSES.md) before using data.

**Added 1 October 2026.** `api/_exotel.ts`, `dial-exotel.mjs`,
`tools/caller-script.txt`, `test/exotel.test.mjs` (24 tests).

Exotel is the provider the India/BFSI deployments actually run on, and it turns
out to be the **better-supported provider for this particular job**.

## What Exotel gives that Twilio does not

**1. One request places the call AND opens the stream.**

```
POST /v1/Accounts/{sid}/Calls/connect
  From, To, CallerId
  StreamUrl, StreamType=bidirectional
  Record=true, RecordingChannels=dual
```

No call flow to configure, no applet canvas, no TwiML. The caller's phone rings,
they answer, Exotel opens the WebSocket. For a harness that runs hundreds of
calls, "no flow to maintain" is the difference between a test suite and a
configuration project.

**2. `RecordingChannels=dual`** puts each party on its own channel, and Exotel's
docs name the use case verbatim:

> *"Speech analytics where overlapping speech needs to be distinguished"*

That is barge-in measurement, stated by the provider.

**3. A simulator ships.** `github.com/exotel/voice-streaming` plus an echo-bot
reference server, so the WebSocket protocol can be exercised end to end without
spending a minute of real voice.

## Two silent failures if you copy a Twilio client across

### snake_case

```js
// Twilio                          Exotel
{ event: 'media',                  { event: 'media',
  streamSid: 'ST1',                  stream_sid: 'ST1',
  sequenceNumber: '3',               sequence_number: '3',
  media: { timestamp: '10',          media: { chunk: 2, timestamp: '10',
            payload: '<b64>' } } }    payload: '<b64>' } } }
```

A Twilio client reads `streamSid` on an Exotel payload and gets `undefined` on
every frame — which surfaces as "no audio on a call that was fine."

### raw PCM, not mu-law

Exotel sends **raw/slin: 16-bit little-endian, 8 kHz, mono**, base64. The mu-law
codec in `_telephony.ts` is Twilio-only and irrelevant here.

This is nastier than a crash. **A test asserts the two decoders produce similar
RMS levels** — because they do. Feeding Exotel PCM to a mu-law decoder yields
noise at a plausible amplitude. Nothing throws, the level check passes, and the
caller hears static. Only listening reveals it.

## The chunk-size window, enforced rather than documented

Exotel's constraints:

| constraint | value | consequence of breaking it |
|---|---|---|
| minimum | 3.2 KB (100 ms) | jitter artefacts |
| maximum | 100 KB | timeout |
| multiple of | 320 bytes | **platform waits 20 ms → audio gap** |

That 20 ms gap is not cosmetic. It lands at exactly the point being measured and
is indistinguishable from 20 ms of extra stop latency.

`chunkPcm` enforces all three, including padding a short final tail. **10.05
seconds of audio leaves a 7-sample remainder** — precisely the case Exotel warns
about — and zero-padding preserves the timeline.

Note the arithmetic trap: 100 ms of 8 kHz 16-bit audio is **1600 bytes, which is
below the 3.2 KB minimum**. Asking for 100 ms chunks produces frames Exotel will
mangle. The smallest compliant chunk at 8 kHz is 200 ms.

## Three bugs the tests caught

**1. Float samples encoded as near-silence.** `clampPcm` from `_telephony.ts`
takes an **int16** (the mu-law decoder's range) and returns an int16. Exotel hands
over **Float32** in [-1, 1]. `Math.round(0.5)` is `1`, not `16384` — so the entire
agent encoded as a whisper.

Completely silent: frames well-formed, byte counts correct, a level check on a
loud segment still passes because *something* came out. `floatToInt16` now
scales explicitly.

**2. A short final chunk was sent undersize.** Same 20 ms gap, at the worst
possible moment.

**3. The rate mismatch was unflagged.** The recorder writes 8 kHz WAV headers.
Exotel recommends `?sample-rate=16000` for voicebots. A 16 kHz stream written
into an 8 kHz header makes **every duration wrong by 2×**, and nothing crashes.
Now reported.

## The false-green guards, in Exotel's vocabulary

`AgentStream` **is not enabled by default** on an Exotel account, so the most
likely first-run failure is a stream that silently never opens. Each refusal
names its cause:

- *"check AgentStream is enabled on the account (contact the provider support channel if it
  is not in the dashboard)"*
- *"StreamType must be bidirectional for a bot to speak"*
- *"the agent produced no audio — the STRUCTURE passed, the CONTENT did not.
  This is a false green: do not report it as a pass"*
- *"marks sent and none played back — the caller likely never heard it"*
- *"call lasted 200ms — too short to measure, so latency is NO DATA rather than 0"*

A caller hang-up is recorded as a **finding**, not a harness error — someone
hanging up mid-turn is exactly what this product exists to catch.

## Running it

```
export EXOTEL_ACCOUNT_SID=... EXOTEL_API_KEY=... EXOTEL_API_TOKEN=...
export EXOTEL_REGION=mumbai
export STREAM_URL=wss://your-bridge.example.com/media

node dial-exotel.mjs --to +91XXXXXXXXXX --caller-id 080XXXXXXX
```

Credentials are **environment-only**. A client-supplied credential here would let
anyone dial billable numbers, and the failure mode is an invoice rather than an
exception. Both refusal paths are tested.

The runner:
1. validates credentials **before** dialling
2. places the call with `StreamType=bidirectional`, `RecordingChannels=dual`
3. waits for `start` (45 s), and on timeout prints the likely causes and hangs up
4. plays `tools/caller-script.txt` with explicit silences
5. writes both legs as sample-aligned WAVs
6. prints anything that makes the result unsafe

### Why the script has explicit `- 800` waits

A real conversation has gaps, and those gaps are the only thing the agent's VAD
has to detect. A script that flips between turns with no silence measures
nothing — there is no end-of-turn to measure. This is the same principle as the
turn-gap fixtures.

## What is honestly placeholder

**The caller's audio is a tone-shaped signal, not speech.** It is called out in
the script comments and printed in the runner output. It exercises the telecom
path — real codec, real jitter, real 8 kHz band-limiting — and:

- barge-in **is** measurable from it (barge-in is energy and timing)
- ASR content is **not** (the agent's ASR sees nothing useful)
- naturalness is **not** (there are no words)

`session.onCallerAudio` is the seam for real TTS at 8 kHz. That is the one piece
of work left before the "simulate an actual call" path is complete.

## Still not verified

- **No live call has been placed.** Everything is verified against Exotel's
  published protocol and constructed signals, not a real PSTN call. Two regions
  exist (`api.exotel.com`, `api.in.exotel.com`) and picking the wrong one is not
  a soft failure — it is a call that crosses an ocean and lands with ~300 ms of
  extra latency that would be measured as the agent's problem.
- **No bridge written.** `STREAM_URL` must point at something that answers with
  the agent's audio. Exotel's echo-bot reference is the starting point.
- **TRAI/DLT compliance is untested.** Outbound calls to Indian numbers involve
  DLT registration and a transactional vs promotional classification. A
  promotional call to a transactional template is a compliance violation, not a
  test failure, and nothing in this harness checks for it.

## Sources

- [Stream & Voicebot Applet](https://developer.exotel.com/docs/agentstream/stream-voicebot-applet) — protocol, chunk window
- [Connect Voice AI API](https://docs.exotel.com/voice-apis/connect-voice-ai-api) — the connect call
- [Voice v3 overview](https://developer.exotel.com/docs/voice-v3/overview) — endpoints, regions
- [Call Recording](https://developer.exotel.com/docs/call-support/call-features/call-recording) — dual channel
- [exotel/voice-streaming](https://github.com/exotel/voice-streaming) — simulator
- [exotel/Agent-Stream-echobot](https://github.com/exotel/Agent-Stream-echobot) — reference server
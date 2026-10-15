# The harness engineering domain: every component, and what to use

Run the testbench locally with `npm ci` and `npm run local`. Vercel and
Upstash are optional hosted components. See [the README](../README.md).
These research notes record earlier experiments; consult committed artifacts
for current evidence and [DATA-LICENSES.md](../DATA-LICENSES.md) before using data.

**Assembled 1 October 2026.** What a voice-agent test harness needs, which
component fills each gap, what we already have, and what is missing.

Ordered by dependency: a component can only be evaluated once the ones above it
work. Status is honest — **BUILT** means tested and working, **PARTIAL** means the
code exists and something material is missing, **GAP** means it does not exist and
I have said what should fill it.

---

## 0. The shape of the problem

A voice agent is not a program you call. It is a **pipeline of five sequential
hops**, each with its own latency, its own failure mode, and its own owner. A
harness that tests only the text layer tests one hop in five — and Vapi's own
docs say so bluntly about their Evals:

> "Evals run mock conversations at the text and model layer. They do not test the
> voice, transcriber, audio quality, or turn-taking behavior."[vapi-evals]

That sentence is the market. Everything below exists to close it.

---

## 1. Transport — getting audio to and from a real phone

| | Component | Status |
|---|---|---|
| Telephony provider | **Exotel** (`api.in.exotel.com`) | **BUILT** — `api/_exotel.ts`, 24 tests |
| | Twilio bidirectional Media Streams | **BUILT** — `api/_telephony.ts`, 23 tests |
| | LiveKit SIP (inbound trunk + dispatch rule) | GAP |
| Media format | Exotel: raw PCM 16-bit LE, 8 kHz | **BUILT** |
| | Twilio: mu-law 8 kHz + base64 | **BUILT**, decoder verified exhaustively |
| WebSocket server | `ws` — the bridge that receives audio and returns the agent's | **BUILT** (dep added), **no bridge written** |
| Public exposure | ngrok / Cloudflare Tunnel / a public `wss://` | **GAP** — not configured |

**Why Exotel is primary:** one request places the call *and* opens the stream, so
there is no call flow to maintain; and `RecordingChannels=dual` is documented by
Exotel for exactly the use case this is ("speech analytics where overlapping
speech needs to be distinguished").

**Region matters and is not a soft setting.** Exotel runs `api.exotel.com`
(Singapore) and `api.in.exotel.com` (Mumbai). Picking the wrong one puts an ocean
between the caller and the agent, and that ~300 ms arrives in the measurement
looking like the agent's latency. `EXOTEL_REGION` defaults to Mumbai.

**Compliance — a gate, not a feature.** TRAI requires DLT registration and a
registered content template for outbound calls to Indian numbers, and the
transactional/promotional classification must match. A promotional call against a
transactional template is a **regulatory violation**, not a test failure, and
nothing in this harness currently checks it. This is the one item that can cost
more than the rest of the project combined.

---

## 2. The caller — who is on the other end of the line

This is the component the whole "simulate an actual call" requirement turns on,
and it is **the largest remaining gap**.

| | Component | Status |
|---|---|---|
| Tone-shaped placeholder | `_telephony.ts` / `_exotel.ts` internal | **BUILT** — exercises the telecom path |
| Real simulated caller | TTS → 8 kHz PCM → chunked frames | **GAP** — `session.onCallerAudio` is the seam |
| Real human caller | a second phone, or `start_call_playback` | GAP — Exotel supports it |
| Call script | `tools/caller-script.txt` with explicit silences | **BUILT** |

### What the caller must actually be able to do

Not "produce audio." A caller that cannot do the following will not find bugs:

| Capability | Why it matters | Metric it exercises |
|---|---|---|
| Variable speech rate | real callers range ~90–185 wpm (measured, n=1200) | dead air, false cutoff |
| Mid-sentence hesitation | *"I want to book for… um… next Tuesday"* | **false cutoff** — the big one |
| Backchannels | "haan", "okay", "right" while the agent talks | **false interrupts** |
| Code-switching | Hinglish mid-sentence | ASR WER, language boundaries |
| True barge-in | starts talking *during* the agent's turn | stop latency, over-talk |
| Trailing disfluency | "…like" after an apparent completion | premature commit |
| Background noise | street, café, bad line | noise floor, false interrupts |

### What to use for the voice

**Sarvam AI Bulbul v3** is the recommendation, and the reason is specific rather
than general.

- **11 languages including Indian English**, with 30+ persona voices
- **Code-switching is generated in a single pass.** This is the property that
  matters and it is architectural: a pipeline that *detects* a language boundary
  and hands off between engines produces an audible pause or an accent shift
  mid-sentence. For a Hinglish caller that artefact is the whole defect.
- **Sample rates 8 kHz–48 kHz**, and the output formats include PCM and
  **MULAW** — which is exactly what a Twilio leg needs, and means the caller
  voice drops into this harness without a conversion step.
- **Sub-250 ms to first byte** over WebSocket.
- **₹30 per 10,000 characters** (beta), against ElevenLabs at roughly
  $0.05–0.10 per 1,000 — about an order of magnitude more per character, for a
  model that does not do code-switching natively.

The cost matters because a harness runs thousands of calls. At 100k characters a
month that is a few dollars versus tens, and the budget goes on calls rather than
on the caller voice.

**Where ElevenLabs still wins:** English-first traffic and voice cloning. Bulbul
v3 does **not** offer self-serve cloning. If the product is Hindi-first — which
the positioning says it is — that trade is worth taking.

⚠️ **Both prices are from secondary sources**, not vendor pricing pages. Verify
before anything goes into a business case.

---

## 3. Turn-taking — the layer everyone gets wrong

**This is where the most valuable measurement lives, and it is the one every
competitor treats as a single number.**

VAD and endpointing are conflated constantly, and they are different decisions
with different failures:

- **VAD** is frame-level: is this 20 ms speech or not?
- **Endpointing** is turn-level: has the caller *finished their thought*?

Endpointing fails in exactly two ways, **and they are not symmetric**:

| Failure | What the caller experiences | Recovery cost |
|---|---|---|
| **False cutoff** | agent talks over you mid-thought | caller restarts; trust is lost |
| **Dead air** | you finish, nothing happens | caller re-asks |

Averaging them produces a meaningless number. An agent with 2% false cutoffs and
1.5 s median dead air is not "0% wrong on turn-taking" — it is **two different
agents failing two different callers.**

### The tradeoff, measured

LiveKit's Turn Detector v1 evaluation sweeps the policy settings and plots the
curve: **latency budget on one axis, false-cutoff rate on the other.** Reported
figures put v1 at **9.9% false-cutoff at a 300 ms latency budget**, against 12.9%
for Deepgram Flux and 27.7% for ultraVAD.

Whatever the specific numbers, **the shape is the point**: you pick an operating
point deliberately, and any single-threshold gate hides the choice.

### Our position, and why the earlier change was right

`DEFAULT_VOICE_BUDGET.vad.maxDeadAirMs` was 4000, justified as "where a caller
stops believing the line is live." Measuring 1,200 real call-centre transcripts
showed **94% of real calls contain a silence ≥ 4 s**, median longest silence 12.8 s.
It is now 2000 ms, and redefined as silence *after a completed turn*.

That change is correct on its own terms. This research says it is also the right
*shape*: a dead-air number is meaningless without the cutoff rate beside it. A
budget that ignores false cutoffs optimises for silence and produces an agent that
never interrupts anyone and is unbearable to talk to.

### What to use

| Layer | Component | Notes |
|---|---|---|
| Semantic turn detection | **LiveKit Turn Detector**, AssemblyAI semantic endpointing, OpenAI `semantic_vad`, Pipecat Smart Turn v2 | all fuse acoustic + semantic |
| Fallback | Silero VAD + silence timer | the classical stack; the timer is the source of the pain |
| A 700 ms silence window | — | adds 700 ms to **every turn** — invisible in transcript benchmarks, painfully visible live |

| Mode | Wins when | Fails when |
|---|---|---|
| VAD-only, aggressive | ultra-low latency, short commands | long-form callers, hesitation, disfluency |
| VAD-only, conservative | callers who pause a lot | quick back-and-forth, feels sluggish |
| STT endpointing | well-formed callers, dictated speech | fragmented speech, code-switching |
| Semantic detector | general case, hesitant callers | domain pause patterns not in training |

**GAP: the harness scores neither.** `measureBargeIn` measures stop latency;
there is no false-cutoff metric. Adding it is the highest-value single
measurement in the project.

---

## 4. Perception — does it sound human

**BUILT** — `api/_naturalness.ts`, 8 signals against bands real conversations sit
in, 17 tests. Worst signal named, no blended score.

Signals: turn length · repeated turn shapes · contractions · discourse markers ·
question count · sentence stacking · call-wide lexical diversity · register
markers.

Measured on the live agent that lost two leads: **67% repeated turn shapes** where
humans sit at 0%. Every individual line was accurate, helpful and grammatical.

**The finding that shapes the prompt advice:** persona and style instructions
explain **under 10% of naturalness variance.** Voice and timing carry the rest. So
a prompt can move perceived humanness appreciably and cannot move it to human.

And the trap: **"be more human" makes an agent longer and slanger, not more human**
— a model reads it as permission rather than as a direction toward brevity.
Define it as **shorter and softer**.

---

## 5. Measurement — what actually got measured, and on what

| Layer | Metric | Status |
|---|---|---|
| Acoustic | speech/non-speech segmentation | **BUILT** — **93.0% recall, 97.6% precision on real Hindi speech** |
| | turn gaps, dead air | **BUILT** |
| | barge-in stop latency | **BUILT** — exact on separated channels |
| | clip rate, SNR, dynamic range | **BUILT** |
| | first-audio latency | **BUILT** |
| VAD | false cutoff rate | **GAP** — see §3 |
| VAD | dead air p50/p95 | PARTIAL — the budget is right, the context is missing |
| STT | WER, critical mishears | **PARTIAL** — schema exists, no engine wired |
| | code-switch boundary accuracy | **GAP** |
| TTS | pronunciation | **GAP** |
| | first-audio | **PARTIAL** — needs a real TTS in the loop |
| Telecom | jitter, packet loss, codec artefacts | **PARTIAL** — fixtures only |

### Corpora used

| Corpus | Licence | What it gave |
|---|---|---|
| **Indic DiarBench** (Hindi) | **CC BY 4.0** | 108 h, 22 languages, speaker-attributed, code-switched. Produced the 93% recall figure. |
| **CallCenterEN** | CC BY-NC | 91,706 transcripts, word timestamps. **No speaker labels in 1,489 files checked** — so no turn boundaries. Produced the dead-air finding. |
| Synthetic fixtures | ours | 11 fixtures with ground truth fixed before render. Covers telephony degradation. |

**The gap nobody has closed:** no public Indian **call-centre** audio with
turn-level labels. Indian data is meetings; call-centre data is English and mostly
non-commercial. That is the technical moat.

---

## 6. Judgment — deciding whether a call passed

| | Component | Status |
|---|---|---|
| Rubric, version-pinned | `api/_voicebench.ts` | **BUILT** |
| Layer attribution | `LAYER_OWNER` + `toFailureLayer` | **BUILT** — 9 tests |
| Issue lifecycle | open → claimed → verified-fixed | **BUILT** |
| **Verified by re-scoring** | `api/_verify.ts` — re-scores a fix against its own evidence | **BUILT**, 17 tests |
| Calibration corpus | 61 scenarios, 122 gold/trap judgements | **BUILT** |
| Judge kappa | — | **GAP** — needs an `ANTHROPIC_API_KEY` |
| False-cutoff scoring | — | **GAP** |

`verified-fixed` is **earned, not declared.** Braintrust's own docs concede the
gap: *"Closing a pattern as resolved does not verify the fix."*

---

## 7. The gate — turning all of this into a decision

| | Component | Status |
|---|---|---|
| Pure policy engine | `api/_gate.ts` | **BUILT** |
| HTTP endpoint + signed receipt | `api/gate.ts` | **BUILT** |
| CLI for CI | `cli.mjs`, exit 0/1/2 | **BUILT** |
| GitHub Actions wiring | documented, not committed | PARTIAL |
| Simulation suite | 12 scenarios × personas | **BUILT** |
| Unattended triggers | new version, → testing, periodic | **BUILT** |
| Load testing | — | **GAP** |

---

## 8. Evidence from this session that shapes the tool choices

Five bugs found by running on real signals, each of which was invisible to
synthetic tests. They are listed because **they are the argument for each tool
choice**, not as a list of fixes:

1. **Noise-floor estimator** — on a real 75 s clip where humans speak 85% of the
   time, the "quiet frames" filter selected 99.4% of frames. Recall 35.7% →
   93.0% on the percentile fix. *Lesson: fixtures with digital silence cannot
   model speech-dense audio.*
2. **Fixed dB margin** — `floor + 14 dB` cannot span a 45 dB gap. Threshold landed
   inside the noise; zero frames crossed. Now a fraction of the measured range.
3. **Barge-in scanner could not detect a barge-in** — it searched for "caller
   speaking AND agent silent", which only becomes true *after* the agent has
   already stopped. 400 ms measured as 10 ms. *Lesson: wrong by 40×, in the
   direction that makes a bad agent look good.*
4. **Channel path never derived thresholds** — both legs thresholded at a
   hardcoded −48 dB picked for another recording.
5. **Unit inference** — `audio_duration` in seconds, word timestamps in
   milliseconds. Produced 111,812 words per minute and a 47,406% speech share: a
   plausible table of impossible numbers.

Every one produced *numbers*, not errors. That is the argument for measuring
against real corpora and real calls rather than against generated fixtures.

---

## 9. What is needed to make this work, in build order

**Blocking — nothing else matters until these exist:**

1. **A bridge.** A `wss://` server that receives Exotel frames and returns the
   agent's audio. Exotel's echo-bot reference is the starting point. ~150 lines.
2. **A real caller voice.** Sarvam Bulbul v3 at 8 kHz PCM behind
   `onCallerAudio`, with code-switched lines and hesitation. The seam exists; the
   implementation does not.
3. **TRAI/DLT registration.** A compliance gate on the dial path. Nothing should
   place an outbound Indian call before this exists.
4. **A public `wss://` endpoint.** ngrok or a tunnel, and it must not be the
   production host.

**High value, small:**

5. **False-cutoff rate.** The single most valuable missing measurement. Score
   every turn for "agent started speaking before the caller finished."
6. **Run the calibration corpus against a live judge** and get a real kappa. The
   corpus exists; the number does not.
7. **STT in the loop** for WER on names and numbers — the thing that breaks real
   estate calls.

**Later:**

8. Real ASR scoring on Indic DiarBench, which is CC BY 4.0 and shippable
9. Load testing — six phases, but baseline and ramp are the two that matter
10. CI workflow on the CLI gate

---

## 10. One table, the whole stack

| Layer | Use | Status |
|---|---|---|
| Telephony | Exotel, Mumbai region | BUILT |
| Wire format | raw PCM 8 kHz LE, chunked to Exotel's window | BUILT |
| Caller voice | Sarvam Bulbul v3, 8 kHz PCM | **GAP** |
| Bridge | `ws` server | **GAP** |
| Turn detection | LiveKit Turn Detector / semantic | **GAP** |
| Naturalness | 8 signals vs human bands | BUILT |
| Segmentation | own PCM analysis | BUILT, 93% on real speech |
| Barge-in | exact on separated channels | BUILT |
| ASR | Sarvam Saaras v3, ₹1.5/min | **GAP** |
| LLM judge | version-pinned rubric | BUILT, uncalibrated |
| Fix verification | re-score against own evidence | BUILT |
| Gate | CLI exit codes, signed receipts | BUILT |
| Compliance | TRAI/DLT | **GAP — blocking** |

## Sources

[vapi-evals]: https://docs.vapi.ai/test/evals-best-practices
[exotel-agentstream]: https://developer.exotel.com/docs/agentstream/stream-voicebot-applet
[exotel-recording]: https://developer.exotel.com/docs/call-support/call-features/call-recording
[livekit-turn]: https://livekit.io/docs/agents/build/turns/turn-detector/
[roark-endpointing]: https://roark.ai/blog/testing-endpointing-voice-ai-agents
[sarvam-stt]: https://sarvam.ai/speech-to-text
[hamming-load]: https://hamming.ai/blog/voice-agent-load-testing-guide
[bt-patterns]: https://www.braintrust.dev/docs/observe/patterns/review

**Not verified from primary sources:** all pricing for Sarvam, ElevenLabs and
Exotel — every figure above came from third-party comparison blogs, not vendor
pages. The LiveKit false-cutoff numbers are attributed to their evaluation as
reported elsewhere and were not read from the paper. No benchmark for
LLM-judge accuracy on code-switched Hindi-English voice transcripts exists publicly.
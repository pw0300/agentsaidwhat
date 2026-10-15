# Real call-centre timing — CallCenterEN / AIxBlock 92k

Run the testbench locally with `npm ci` and `npm run local`. Vercel and
Upstash are optional hosted components. See [the README](../README.md).
These research notes record earlier experiments; consult committed artifacts
for current evidence and [DATA-LICENSES.md](../DATA-LICENSES.md) before using data.

**Measured 1 October 2026.** `tools/calibrate_callcentre.py`, n=1200 transcripts
across three domains. **CC BY-NC 4.0** — fine for a personal research project,
which is what this is.

```
python tools/calibrate_callcentre.py \
  data/cc_medequip.zip data/cc_insurance_outbound.zip data/cc_customer_service_general_inbound.zip \
  --limit 400 --json data/callcentre_timing.json
```

## What this corpus does NOT contain, and why that matters

I proposed in `DATA-SOURCES.md` that CallCenterEN's word-level timestamps could
serve as **turn-boundary ground truth**. Having read the files, that was wrong.

**There are no speaker labels.** Checked across 1,489 transcripts in two
domains — every word carries `"speaker": null`. Not sparse; zero, in every file.

A turn is a change of speaker. Word timestamps alone give a stream of words with
durations and nothing about who said them. So there is no turn boundary in this
corpus to recover, and any "turn detector" scored against it would be scoring
against an annotation that does not exist.

**What this means for the plan:** Indic DiarBench covers segmentation on real
audio (93.0% recall). This corpus covers *timing realism* on real call
structure. **Neither covers turns.** Nothing public does.

## What it does contain

| property | p10 | median | p90 | max |
|---|---|---|---|---|
| call duration (s) | 246 | 480 | 1,283 | 1,691 |
| words per call | 405 | 1,001 | 1,819 | 3,481 |
| speaking rate (wpm) | 92 | 121 | 146 | 184 |
| speech share of call (%) | 49 | 62 | 74 | 83 |
| median word length (ms) | 240 | 280 | 280 | 360 |
| p90 inter-word gap (ms) | 240 | 400 | 800 | 1,680 |
| longest silence in call (ms) | 4,560 | 12,810 | 45,780 | 305,240 |

Per domain, so one odd domain cannot hide inside the pooled number:

| domain | n | wpm median | duration median |
|---|---|---|---|
| customer_service_general_inbound | 400 | 120 | 771s |
| medical_equipment_outbound | 400 | 114 | 540s |
| insurance_outbound | 400 | 127 | 337s |

Median ASR confidence 0.95. PII policies applied per call: 44 categories.

## The finding that changed a budget

Real calls contain **long silences as a matter of course**:

- **94% of calls contain a silence ≥ 4s**
- 99.8% contain a silence ≥ 2s
- median longest silence is **12.8 seconds**; p90 is **45.8 seconds**

`DEFAULT_VOICE_BUDGET.vad.maxDeadAirMs` was **4000**, commented as "where a
caller stops believing the line is live."

**That threshold fires on 94% of real calls.** Those silences are think-pauses,
transfers and hold music, not dead air. A gate that fires on almost every call
gets switched off in week two — which is worse than no gate at all, because it
discredits the barge-in and latency rules next to it.

**Now 2000ms**, and redefined: it measures silence *after a completed turn*, not
raw silence. `measureDeadAir` already works on gaps between utterances, so the
measurement was right and the threshold was wrong. Two tests pin it: 800ms of
thinking time passes, 5000ms after a turn fails.

The distribution a dead-air budget *should* come from:

```
<200ms        100 ( 8.3%)  ###
200-500ms     690 (57.5%)  #######################
500ms-1s      365 (30.4%)  ############
1-2s           45 ( 3.8%)  #
2-5s            0 ( 0.0%)
>5s             0 ( 0.0%)
```

The whole p10–p90 band of inter-word silence is **240–800ms**. Anything above
1s is already unusual in continuous speech.

## What a simulator must reproduce to be believable

- Calls run **4 to 21 minutes**, median 8. The synthetic fixtures are 5–16
  **seconds** — three orders of magnitude short of real.
- Speech occupies **49–74%** of a call. The rest is silence and overlap.
  Uniform speech density produces calls that cannot happen.
- Median inter-word gap is **0ms** but p90 is **800ms**. A single pause
  distribution cannot represent both — a simulator needs the distribution, not
  a mean.

## Two bugs the harness hit, both worth recording

**1. `audio_duration` is in seconds; word timestamps are in milliseconds.**
Verified directly: a call reports `audio_duration=500` while its last word ends
at `496990`. Taking the field at face value produced **111,812 words per minute**
and a **47,406% speech share** — a plausible-looking table of impossible numbers,
which is the most dangerous failure mode a harness has. Nothing errors; the
numbers simply mean nothing.

The fix is not a conversion constant. The harness cross-checks the field against
the word timestamps and only trusts it when they agree: **378/400 resolved as
seconds, 22 fell back to the last word end and said so.**

**2. Turn counts derived from diarization overlaps.** The Indic DiarBench
harness had the same class of bug — a plausible "truth turn" count invented by
merging overlapping segments, which collapsed a 75-second clip into 1 span and
scored the detector at 33%. Both harnesses now refuse to report a metric the
corpus does not annotate.

## Honest limits

- **Not turn boundaries.** No speaker labels. This is the whole point.
- **Not barge-in, overlap, or who spoke when.** Same reason.
- **Transcripts, not audio.** Timing realism only — no signal, no prosody, no
  latency. Indic DiarBench is the audio corpus.
- **Outbound + inbound US market.** Agents speak Indian-accent English
  (CallCenterEN, arXiv 2507.02958), which is closer to the target register than
  most public corpora, but it is English. Code-switched timing is Indic
  DiarBench's territory.
- **n=1200 of ~91,706.** The three domains are all mid-size; `medicare_inbound`
  (61,513 calls) is unread.

## Source

- AIxBlock / Axion Research. *LMSYS / AIxBlock 92k real-world call centre
  scripts*. arXiv 2507.02958.
  `huggingface.co/datasets/AIxBlock/92k-real-world-call-center-scripts-english`
  — CC BY-NC 4.0, 11 archives, 1.40 GB total, 10,448 hours.
- Archive inventory (all verified reachable, sizes from the HF API):

| archive | size |
|---|---|
| medical_equipment_outbound.zip | 13.5 MB |
| (re-uploaded)…automotive-stereo-inbound-104h.zip | 14.2 MB |
| (reupload)PII_redacted_auto_insurance_script.zip | 36.6 MB |
| auto_insurance_customer_service_inbound.zip | 36.6 MB |
| automotive_and_healthcare_insurance_inbound.zip | 41.4 MB |
| customer_service_general_inbound.zip | 43.0 MB |
| insurance_outbound.zip | 55.3 MB |
| home_ervice_inbound&telecom _outbound.zip | 59.1 MB |
| home_service_inbound.zip | 131.2 MB |
| automotive_inbound.zip | 141.6 MB |
| medicare_inbound.zip | 826.5 MB |

One filename contains `&` and a space, which breaks naive URL construction —
that is what made the first download attempt fail with a 15-byte error page.
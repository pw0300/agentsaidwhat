# Real-speech calibration — Indic DiarBench (Hindi)

Run the testbench locally with `npm ci` and `npm run local`. Vercel and
Upstash are optional hosted components. See [the README](../README.md).
These research notes record earlier experiments; consult committed artifacts
for current evidence and [DATA-LICENSES.md](../DATA-LICENSES.md) before using data.

**Measured 1 October 2026.** Produced by `tools/calibrate_indic.py` against the
Hindi test split of Indic DiarBench (Sarvam AI + AI4Bharat, IIT Madras,
arXiv 2607.23808). **CC BY 4.0** — usable and redistributable, which is why it
was chosen over CallCenterEN's CC BY-NC.

```
python tools/calibrate_indic.py data/hindi_test.parquet --limit 12
```

## What the corpus is

94 clips, 16 kHz mono, real multi-speaker conversation in Hindi with **inline
English code-switching** — the exact register the product targets. Ground truth
is speaker-attributed with `start_time`/`end_time` per segment, so segmentation
can be scored against a human annotation rather than against a construction.

Sample ground truth, taken straight from the file:

```
SPEAKER_05  0.16-0.74   'हाँ।'
SPEAKER_02  0.29-1.34   'एग्ज़ैक्टली(exactly)।'      <- code-switched
SPEAKER_04  1.41-1.79   'हम्म।'
SPEAKER_02  4.96-11.71  'और उनकी निजी जिजीवन भी यही था…'
```

## The result

| metric | all (n=12) | code-mixed (n=12) |
|---|---|---|
| frame agreement | 91.4% | 91.4% |
| **speech recall** | **93.0%** | 93.0% |
| **speech precision** | **97.6%** | 97.6% |
| missed speech | 7.0% | 7.0% |
| false speech | 2.4% | 2.4% |
| separable clips | 12/12 | 12/12 |
| median SNR spread | 55.0 dB | 55.0 dB |

All 12 clips were code-mixed, which is itself a finding: **this corpus does not
contain monolingual Hindi.** Every clip carries English inside Devanagari. So
there is no "mono" column to compare against, and the code-mixed number is the
only number — the one with no public benchmark, measured on real audio.

**n=12 is an indication, not a result.** The file is not committed; the harness
runs against 94 clips in about 40 minutes.

## The bug this found

Running against real audio found a defect that **26 passing fixture tests could
not**, and it was in production code (`api/_audio.ts`), not the harness.

The noise floor was estimated as "the median of frames more than 20 dB below the
peak". On the synthetic fixtures that works — they have genuine digital silence
between segments, so the filter selects a small quiet set.

On real speech it collapses. On one 75-second Hindi clip where humans speak for
**85% of the time**, the filter selected **99.4% of all frames**. The "quiet
set" was the entire recording. So the noise floor was the median of the whole
clip, the threshold floated to −26 dBFS, only 36.5% of the audio crossed it, and
**speech recall came back at 35.7%.**

The failure mode is worth naming precisely: **a filter written to select the
minority selects the majority the moment the majority becomes large enough.** No
fixture tuning could have revealed it, because no fixture is 85% speech.

### The fix

A low percentile of frame energy (p10), which samples the noise mode regardless
of speech proportion. Frame energy on real speech is strongly bimodal — on that
clip p20 is −78 dBFS and p50 is −32 dBFS, a 46 dB gap.

| | speech recall | speech precision |
|---|---|---|
| median-below-peak (old) | **35.7%** | 99.5% |
| p10 of frame energy (new) | **93.0%** | 97.6% |

The `peak - headroom` cap stays. It is what guarantees a threshold can never sit
above the signal — a property that has caught two separate bugs already.

### Verification

`test/floor.test.mjs`, seven tests, all reproducing the conditions that caused it:

- dense speech (duty 0.6 / 0.75 / 0.85 / 0.95) keeps the threshold below the peak
- detected duty cycle tracks the true one: **87.1% detected on an 85% clip, 20.1% on a 20% clip**
- the mode boundary sits at p10→p15 on a dense clip and p80→p90 on a sparse one, ~57 dB either way
- a 40-sample click cannot drag the floor (why p10 and not the minimum)

Two of those seven were wrong on the first run and were corrected:

- The clip generator emitted all speech first, then all silence — so an 85%-speech
  clip had a median in the *noise*. The test read that as a broken estimator. Real
  conversation interleaves phrases and pauses, and that structure is what the
  percentile estimator depends on.
- The bimodality test asserted on a fixed `p80 - p20` pair and measured 0.1 dB. The
  gap spans *both* modes on a dense clip. Asserting a fixed pair is wrong precisely
  because the pair moves with the duty cycle; the test now finds the largest gap.

## What this does and does not establish

**Does:** speech/non-speech segmentation recall and precision on real Indian
multi-speaker code-switched audio. The metric that matters operationally —
missed speech is a caller going unrecorded, which is the failure that loses a
lead.

**Does not:**

- **Turn counting.** This corpus has no turn-boundary annotation. It marks *who
  spoke*, not *where a turn ended*. Utterance counts are reported as counts and
  are not ground truth. Inferring turns from overlaps is a research problem, and
  the harness refuses to score it as if it were a convenience.
- **Turn-gap timing, barge-in latency, naturalness.** Those need turn
  annotations the corpus does not contain.
- **Telephony behaviour.** This is clean studio audio — no codec, no packet loss,
  no 8 kHz band-limiting. The synthetic fixtures cover those, and the acoustic
  bench still passes.

## Why this dataset and not CallCenterEN

| | Indic DiarBench | CallCenterEN |
|---|---|---|
| Licence | **CC BY 4.0** | CC BY-NC 4.0 |
| Audio | **yes, 108 h** | **no** |
| Language | 22 Indian, code-switched | English only (Indian-accent agents) |
| Annotation | speaker + time-aligned | word-level timestamps |
| Domain | meetings/conversation | real call centre |

For calibration this is not close. Indic DiarBench has the audio, the licence and
the code-switching; CallCenterEN has the domain but no audio and a non-commercial
licence. The calibration question is "does the detector recover speech on real
Indian speech", and only one of these can answer it.

CallCenterEN can inform word-timing research, but its inspected transcripts lack
speaker labels. It cannot provide turn-boundary ground truth. See the later
[call-centre timing audit](CALL-CENTRE-TIMING.md).

## Reproducing

```bash
curl -L -o data/hindi_test.parquet \
  https://huggingface.co/datasets/sarvamai/indic-diarbench/resolve/main/Hindi/test-00000-of-00001.parquet

python tools/calibrate_indic.py data/hindi_test.parquet --limit 12 --json data/indic_calibration.json
```

The parquet is 1.2 GB and gitignored. The JSON summary is committed.

## Source

- Sarvam AI + AI4Bharat (IIT Madras). Indic DiarBench. arXiv 2607.23808.
  `huggingface.co/datasets/sarvamai/indic-diarbench` — CC BY 4.0.
- Best published DER on this benchmark is 16.0% (Sarvam pipeline); AWS Transcribe
  23.5%, Gemini 3 Pro 74.0%. Those are diarization error rates from a diarization
  system — **not comparable to the segmentation numbers above**, which come from
  a VAD scored against annotation. The two measure different things.
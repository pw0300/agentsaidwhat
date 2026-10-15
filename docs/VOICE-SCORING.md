# Voice-layer scoring: what works, what is blocked, and why

Run the testbench locally with `npm ci` and `npm run local`. Vercel and
Upstash are optional hosted components. See [the README](../README.md).
These research notes record earlier experiments; consult committed artifacts
for current evidence and [DATA-LICENSES.md](../DATA-LICENSES.md) before using data.

## The question this answers

Should the harness use an actual voice model to rate **generation**, **voice** and
**naturalness**, rather than only text?

**Yes.** `api/_naturalness.ts` takes `Turn { role, text }` and never sees a sample.
It can tell you the wording is conversational. It cannot tell you the voice is.

The text-only design is not wrong as far as it goes, but it is a hole, and it is
the same hole in a different place from the one the LLM judge fills.

## What the research says about doing it naively

arXiv 2608.09930 benchmarked four MOS predictors and four Audio-LLMs judges
against **860 utterances annotated by trained linguist raters** across 10
perceptual dimensions.

> "MOS predictors collapse onto acoustic signal quality, while Audio-LLMs judges
> show selective, prompt-dependent detection that does not generalise across all
> dimensions."

Concretely, **no MOS model showed significant detection of Phonetic Accuracy,
Lexical Stress, or Prosodic Boundary Placement.**

Those three are precisely what breaks a voice agent in a bank call centre:

| Dimension | Real failure it catches |
|---|---|
| Phonetic accuracy | Mispronouncing "Hinjawadi", a product name, a street |
| Lexical stress | Wrong word emphasis, so the caller hears the wrong number as the important one |
| Prosodic boundary placement | Flat intonation where the caller cannot hear the agent is about to transfer them |

**A single holistic MOS score would have scored all three as fine.** So the
integration must be per-dimension, never one number.

## RAN IT. Here is what NISQA-TTS actually does on Hindi.

**Not blocked.** The fix was a Python 3.11 venv plus one thing I had wrong: this
box leaks `PYTHONPATH`/`PYTHONHOME` from Hermes' own environment, so the venv
silently loaded numpy 2.4 and torch broke. Every invocation needs:

```
VIRTUAL_ENV= PYTHONPATH= PYTHONHOME= .venv-nisqa\Scripts\python.exe -E <script>
```

NISQA has only ever published **one** PyPI release (`2.0.post2`); the 1.x line the
paper documents was never packaged. It also needs `setuptools<81` — 84 dropped
`pkg_resources`, which librosa 0.10 imports.

### The experiment

4 real recordings from Indic DiarBench, each degraded six ways. Only the signal
changes; same words, same speaker, same duration.

| variant | mean MOS | vs clean |
|---|---|---|
| clean | **2.033** | — |
| hum (1 kHz @ -18dBFS) | 2.348 | **+0.315** |
| band (7 kHz lowpass) | 1.964 | -0.069 |
| telephone (300-3400 Hz) | 1.954 | -0.079 |
| clipped | 1.489 | -0.544 |
| noisy (5 dB SNR) | 1.037 | **-0.996** |

### Finding 1 — it is not inert, and my earlier worry was wrong

I predicted a constant prior. It isn't: 5 dB SNR costs it 1.0 MOS, clipping 0.54,
and the ordering is identical on all four recordings. It **rejects 4/4** real
degradations. That correction is recorded in `tools/voice_verdict.py` because the
first version of that file asserted the opposite.

### Finding 2 — two behaviours that disqualify it as a gate

**a) So does clean English — and that refutes my first explanation.**

I attributed 2.03 to speech structure: NISQA-TTS trained on continuous synthesized
speech, real Hindi conversation is 53% speech, so NISQA reads the pauses as
deficiency. **That was a mechanism asserted from transcript timings, not
measured.** Two controls measure it, and they kill it:

| control | n | mean MOS |
|---|---|---|
| **english_clean** — clean studio English, speech fraction matched at 45–68% | 6 | **2.344** |
| **hindi_baseline** — pauses intact | 4 | **2.033** (−0.311 vs English) |
| **hindi_speechonly** — every pause cut, using the corpus's own turn timings | 4 | **2.106** (+0.073 vs baseline) |

Removing the pauses moved the score **+0.073**. Silence is not the cause.

The honest reading is the boring one: **NISQA-TTS is harsh on real conversational
audio generally, in both languages.** Clean studio English scores 2.34, not the 4+
its own literature reports on its training distribution. A budget calibrated on
either language would reject essentially every real call.

The India-specific finding survives, weaker: Hindi sits **0.31 below English** —
real, but second-order. The primary result is that this model class cannot gate
anything without recalibration on the target population.

Control corpus: LibriSpeech `test-clean` (CC BY 4.0), FLAC-in-parquet, stitched
per chapter to ≥20s with LibriSpeech's digital-silence padding trimmed — left in,
it would have dragged the control's speech fraction toward conversational audio,
which is the variable the control exists to hold constant.

**b) Adding 1 kHz of mains hum RAISED the score by 0.32**, on all four recordings.
A steady narrow-band tone lifts frame energy uniformly and NISQA rewards energy
consistency. It scores a hum-corrupted capture as an *improvement* — the exact
defect class a voice QA tool exists to catch.

### Why this is still the right result

"NISQA scores Hindi low" would say nothing; it could be correctly calibrated for a
harder population. These two findings are **diagnostic, not merely low** — the
score is not tracking speech quality on this material, and each failure has a
known mechanism.

Incumbent voice-QA tooling is DNS/UTMOS/NISQA-class models applied to English.
**Nobody has published a per-dimension audit of any of them on code-switched
Hindi-English.** This is that audit, with a reproduction script.

It is 4 recordings. It is not a benchmark. What it establishes is that the gap is
real, demonstrable, and that integration must be per-dimension and adversarial-
tested before any of it can gate a release.

### Reproduce

```
uv venv --python 3.11 .venv-nisqa
uv pip install --python .venv-nisqa/Scripts/python.exe nisqa "setuptools<81"
curl -sL -o models/nisqa_tts.tar \
  https://github.com/gabrielmittag/NISQA/raw/master/weights/nisqa_tts.tar
.venv-nisqa/Scripts/python.exe tools/voice_probe.py      # builds 24 paired clips
#   then nisqaModel({mode:"predict_dir", data_dir:"data/voice_probe", ...})
python tools/voice_verdict.py                            # the table above
```

NISQA's data args are **seconds**, not samples (`ms_hop_length: 0.01`,
`ms_win_length: 0.04`). Passing 1024 asks for a 1024-second window and librosa
correctly rejects it.

## THE CALIBRATION GAP, MEASURED AT n=100

Everything above established that NISQA-TTS behaves badly. None of it showed the
model is *wrong* — a model can be harsh and correctly ordered. The missing
measurement was whether its number tracks a human number.

SOMOS (Samsung Open MOS Dataset, Zenodo 7378801, Maniati et al. 2022) supplies
it: **359,100 listener ratings over 20,100 synthesized English utterances**, 1–5.
Aggregated to per-utterance MOS, human scores span **1.78–4.71, median 3.44** —
NISQA-TTS's own training domain, with independent human labels.

**100 clips**, evenly spaced across five bands of the human range, each with ≥8
ratings (weak labels excluded rather than averaged in):

| | n=12 (first pass) | **n=100** |
|---|---|---|
| human MOS | mean 3.295, 1.78–3.94 | mean 3.412, 1.78–4.24 |
| NISQA prediction | mean 2.183, 1.835–2.586 | mean 2.180, 1.661–3.129 |
| **Pearson r** | +0.359 | **+0.124** |
| **95% CI** | — | **[−0.073, +0.290]** |
| **Spearman ρ** | +0.413 | **+0.092** |
| range compression | 0.35× | 0.60× |

### Scaling changed the answer, and that is the point

**r fell from 0.36 to 0.12, and the confidence interval now includes zero.** At
n=100 this cannot distinguish a real relationship from noise.

This is why the first pass was not allowed to stand. r=0.36 would have been
quotable — it is a respectable-looking number — and it was an artefact of twelve
points. The honest report is the interval, not the point estimate: *on this data,
NISQA-TTS has no demonstrated linear relationship with human MOS ratings for
synthetic English speech.*

The CI is wide because n=100 still leaves it that way, and the fix is more clips,
not a better statistic.

### What survives the scaling

**The scale cannot resolve a decision that matters.** Measured, not asserted:

- residual SD about the fit: **0.402** predicted units — the model's noise floor here
- a human difference worth acting on (~0.5 MOS, "audible not subtle") arrives as
  **0.299** predicted units after compression
- 0.299 < 0.402, so a difference a customer would call real is **smaller than the
  model's own scatter**

That is the disqualification, and it is independent of the correlation: even a
perfect rank ordering could not turn a 0.5-MOS human gap into anything the model
resolves.

Note the earlier version of this analysis called the scale "usable" whenever
compression cleared an invented 0.5 ratio — the same unsourced-constant mistake
this project has been removing elsewhere, and at n=100 it flipped the verdict to
True while the correlation said otherwise. Both inputs above are measured from
this data. The one assumption, a 0.5-MOS decision gap, is stated in the code.

**The −0.31 Hindi/English gap.** Bootstrapped CI **[−0.48, −0.15]**, excludes zero,
so the language penalty is real — while the calibration against human MOS
collapses. Two claims, tested separately, with different outcomes.

**Licence:** SOMOS is CC BY-NC-SA 4.0 — non-commercial. Fine for research; these
numbers cannot ship inside a product's calibration.

## The old block, for the record

NISQA-TTS (`arXiv 2104.09494`, Mittag & Möller, Interspeech 2020) is the right
first target — it predicts naturalness of **synthesized** speech, unlike
telephony-era MOS predictors which track signal artefacts.

It cannot run here, and it is not a fixable dependency issue:

```
NISQA 2.0.post2 pins:   torch ==2.2.1   pillow ==10.2.0   numpy ==1.26.4
                        numba ==0.59.0  scipy ==1.12.0    torchvision ==0.17.1

This machine:           Python 3.14.7    torch 2.11.0+cpu  numpy 2.4.4

pip install torch==2.1.1 --dry-run ->
  "from versions: 2.9.0, 2.9.1, 2.10.0, 2.11.0, 2.12.0, 2.12.1, 2.13.0, 2.14.0, 2.14.1"
  No matching distribution found.
```

torch 2.2.1 publishes cp310/311/312 wheels only. numpy 1.26.4 predates Python
3.14. `import nisqa` succeeds with `--no-deps` but the TTS model module cannot
load, and no weights ship with the wheel.

**Do not retry `pip install nisqa` on this box.** It has been tried and failed.

### What would unblock it

A Python 3.11 virtualenv, where the pinned versions resolve. Nothing else.
`uv venv --python 3.11` then `uv pip install nisqa`. The harness itself is
Node/TypeScript, so the scorer would be a small Python subprocess either way —
this only decides whether that subprocess can import NISQA.

## The bigger problem: no benchmark exists for Hindi-English

Even with NISQA running, it is **English-trained**. It has never heard
code-switched Hindi-English, which is the entire deployment target.

Before NISQA scores a single agent, it should be run against real Indian speech —
**Indic DiarBench is already on disk** (`data/hindi_test.parquet`, CC BY 4.0,
real Hindi with genuine overlap and diarization labels).

The honest experiment:

1. Score the Indic DiarBench utterances.
2. Score known-good recordings and known-degraded ones.
3. Report whether the score moves at all.

If NISQA returns 4.2 on every Hindi sample because it cannot hear the
code-switching, **that is the finding** — and it is worth more than a working
number, because it is the published evidence that the incumbent tooling does not
cover the market being sold into. That is the same gap as the LLM judge: nobody
has measured judge or MOS accuracy on code-switched Hindi-English, and the first
enterprise technical reviewer will ask for exactly that number.

## Where a model legitimately belongs

Layered, with the deterministic layer underneath and nothing removed:

| Layer | Computes it | Why it stays deterministic |
|---|---|---|
| Segmentation, timing, barge-in, dead air | arithmetic | reproducible; five bugs here produced *plausible wrong numbers* |
| WER, critical mishears | ASR | ground truth exists on Indic DiarBench |
| Transcript naturalness | regex, counts, n-grams | banded against real conversations |
| **Wording fit, prosody, expressiveness** | **audio model** | no closed form; this is the hole |
| Verdict on a transcript | **judge panel** | see `api/_judge.ts` |

The rule that keeps this honest: **a model may produce a score; it may not
decide a release.** The gate reads the deterministic layers, and reports a model
score as a measurement with a stated floor — `conventional` provenance in
`BUDGET_PROVENANCE`, never `measured`.

## Status

- [x] `api/_judge.ts` — 4-provider panel, disagreement is the output (committed)
- [x] NISQA-TTS running on real Hindi — `tools/voice_probe.py`, `tools/voice_verdict.py`
- [x] Per-dimension audit published — two disqualifying behaviours found with mechanisms
- [ ] Voice model as a *gate* input — **rejected on current evidence**, and that is now data, not caution
- [ ] Natural audio control (English or human-rated Hindi) — the audit has no positive control yet
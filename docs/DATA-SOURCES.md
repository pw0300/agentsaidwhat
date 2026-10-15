# Data sources for the voice bench

Run the testbench locally with `npm ci` and `npm run local`. Vercel and
Upstash are optional hosted components. See [the README](../README.md).
These research notes record earlier experiments; consult committed artifacts
for current evidence and [DATA-LICENSES.md](../DATA-LICENSES.md) before using data.

What exists, what it can be used for, and what it cannot. Assembled 30 Sep 2026
from vendor pages, papers and dataset cards — not from search snippets. Where a
claim could not be verified from a primary source it says so.

The short version: **there is no public dataset of Indian call-centre audio with
turn-level labels.** Everything splits into two piles — Indian *text*, and
call-centre *timing* — and the one combination a voice bench wants is exactly
what nobody has released. That gap is also the opening.

---

## 1. Call-centre data (right domain, wrong language)

### CallCenterEN / AIxBlock 92k — the closest thing to the real thing
- **91,706 transcripts, ~10,448 hours**, from 9–10 BPO centres, 2020–2025.
- Agents speak **Indian, Filipino and American** English accents. Customers are
  primarily US. Inbound 91.3% / outbound 8.7%.
- **Word-level timestamps and per-word ASR confidence** on every file. Domains
  include Medicare inbound (61,513), home services (11,407), automotive (6,045),
  insurance outbound (4,005, Indian agent).
- PII-redacted across 43 categories, to CCPA and India's DPDP Act 2023.
- **Audio is not released** — biometric re-identification risk.
- Transcribed with AssemblyAI; 0.1% human-reviewed, WER 3.87% on that subset;
  per-conversation confidence 86–98%.
- **Licence: CC BY-NC 4.0.** Attribution required, **commercial use prohibited**.

Source: arXiv 2507.02958 · `huggingface.co/datasets/AIxBlock/91706-real-world-call-center-scripts-english`

**What it is good for.** Research on word timing and silence distributions.
The later [timing audit](CALL-CENTRE-TIMING.md) found no speaker labels in the
inspected files. Word timestamps are not turn-boundary ground truth. No derived
CallCenterEN dataset files are committed.

**What it cannot do.** No audio, so nothing acoustic. English, so nothing
code-switched. And **CC BY-NC makes it unusable in a commercial product** —
a gate that a customer runs on their own calls is a commercial use, and no
amount of attribution makes that legal.

That last point is the important one, and it generalises: **almost everything
public in this space is non-commercial.** Plan around it before downloading,
not after.

### Commercial audio (the money option)
| Dataset | Volume | Licence | Notes |
|---|---|---|---|
| AxonData English contact-centre | 1,000+ hrs + transcripts | HuggingFace listing | English-only ASR fine-tunes |
| AxonData German | 1,000+ hrs + transcripts | HuggingFace listing | — |
| AxonData multilingual (7 langs) | 10,000 hrs | HuggingFace listing | EN/RU/PL/FR/DE/ES/PT — no Indic |
| 3.44M-hr single + dual-channel | 3.44M hrs | £741,200 / 100k hrs | Explicitly **dual-channel** |
| 20k B2C audio + verbatim | 25,000 hrs underlying | £373,000 | Stereo, agent/customer separated |
| 243K hrs single-channel | 243,816 hrs | £594,100 | Claims CC BY 4.0 |
| 243K hrs dual-channel | 243,816 hrs | £594,100 | Claims CC BY 4.0 |

**Dual-channel is the one that matters here.** Separated agent/caller audio is
what makes barge-in and stop-latency measurable rather than inferred. The
bench's `measureBargeIn` has a mono fallback that is an *upper bound* by its own
documentation; on dual-channel input the same function is exact. Any real
deployment that separates its legs — which most telephony stacks do — gets the
accurate path for free.

**Licence claims on the marketplace listings are unaudited.** A listing that says
CC BY 4.0 is a seller's description, and the underlying BPO contracts are where
the real terms live. Do not put a purchase order against a marketplace
assertion without a written answer from the seller.

Prices are indicative and vary by configuration. I have not obtained quotes.

### NCSU robocall
1,432 calls, FTC Project Point of No Entry. **Genuinely public domain.**
Useless for QA — one-sided robocalls — but it is the only dataset here with no
licence ambiguity, so it is worth a smoke test of the audio pipeline.

---

## 2. Indian-language data (right language, wrong domain)

### Indic DiarBench — the most useful find
- **108 hours, all 22 scheduled Indian languages**, 485 speakers from 189
  districts. Near-field meetings, far-field, and in-the-wild.
- **Human-corrected, time-aligned, speaker-attributed** transcriptions, RTTM
  speaker annotations. Explicit English code-mixing and speaker overlap.
- **Licence: CC BY 4.0** — research and redistribution, with attribution.
- Best duration-weighted DER is 16.0% (Sarvam pipeline); AWS Transcribe 23.5%;
  GPT-4o 36.2% DER and 83.1% cpWER; Gemini 3 Pro 74.0% DER.

Source: Sarvam AI + AI4Bharat (IIT Madras) · arXiv 2607.23808 ·
`sarvamai/indic-diarbench`

**CC BY 4.0 is the operative fact.** This is the one Indian corpus here that a
commercial product may legally use. It is the closest available substitute for
the missing Indian call-centre set: real Indian speech, real code-mixing, real
overlap, real speaker labels, real time alignment.

It is labelled evaluation-only, and the 16% DER is the honest bar — a pipeline
scoring worse than that is failing Indian speech, not passing it.

### VoiceAgentBench
6,000+ spoken queries, English + **six Indic languages** (61% non-English), with
`.wav` audio and expected tool calls. Speaker diversity via TTS voice conversion
sampled by speaker embedding. Krutrim Community Licence — **read it before
use; not a standard permissive licence.** It explicitly excludes background
noise from its evaluation, which is the one thing a voice bench most needs.

### MUCS 2021 / OpenSLR 103
~600 hours across Hindi, Marathi, Odia, Tamil, Telugu, Gujarati, plus 150 hours
of **Hindi-English and Bengali-English code-switched**. 8 kHz, 16-bit, with
sentence-level transcripts and timestamps. Spoken tutorials, not conversations.

**8 kHz 16-bit is exactly a telephony leg** — the same rate the bench's fixtures
target. And the timestamps are sentence-level, which is coarser than turn-level
but usable for a weak baseline.

### IIT Bombay Hindi-English code-switching
Text transcriptions plus Praat TextGrid tier-1/tier-2 code-switch segment
markings, time-aligned, with silence marked. Two speakers over YouTube video.
**Non-commercial research only.**

The tier-1/tier-2 scheme (H, H(E), E, E(H)) is the useful part even without
using the data: it is a clean four-way classification of code-switch type, and
the bench's language-switch scenarios currently model switching as a boolean
when the real phenomenon is a continuum with four named states.

### BEHE-CMDisfl (WILDRE 2026)
Bengali-English and **Hindi-English code-mixed with disfluencies** — filled
pauses, repetitions, restarts. Synthetic, via Indic Parler TTS. Baseline GMM-HMM
WER 37.74%.

Disfluencies are the correct thing for a voice bench to train on, and synthetic
generation with controlled disfluency is reproducible in a way real disfluency
is not. The WER is poor, so it is not a recognition target — it is a
*robustness* target.

### One dataset I could not assess
`bosonai/IHBench` — banking dialogue with per-turn `*_audio`, an
`interruption_type` column, and `tf_rubric` / `rq_rubrics` per turn. If the
audio and the interruption labels are both present and the licence is
permissive, this is the single most valuable dataset on this page: per-turn
audio with per-turn interruption ground truth and per-turn rubrics is precisely
the bench's data model. I could not confirm the licence or download terms, so
I am flagging it as unverified rather than recommending it.

---

## 3. Turn-taking ground truth (right measurement, English)

### TurnBench — Sesame AI, CMU, Mundo AI
- **30 hours dual-channel**, 154 dialogues, 106 actors, studio-recorded, **one
  speaker per channel**. Triple-annotated, Fleiss' κ = 0.78. 104-hour labelled
  training set. Leaderboard at turnbench.sesame.com.
- **Human reference: turn transfers begin a median 151 ms BEFORE the turn ends**
  (−281 ms including floor-taking interruptions). 60% of smooth transfers begin
  in overlap; the rest after a median 329 ms silence gap. After a floor-taking
  interruption the interrupted speaker keeps talking a **median 1.48 s**.
- No evaluated system reached the 151 ms reference without excessive false
  positives. In-budget systems run 368–1234 ms. RMS energy VAD: interruption
  recall 0.996 at **FPR 0.38–0.55** — it fires on nearly every onset.
- Dev split (`mundo-ai/turn-benchmark-dev`) is **attribution required, commercial
  use not permitted**.

Source: arXiv 2608.25218

**This changed a number in the code.** `DEFAULT_VOICE_BUDGET` had a 500 ms
barge-in budget, which I had written as a plausible "industry convention". It is
now 800 ms, bracketed by the two published human anchors, with the citation in
the source and a test that fails if the budget drifts outside them.

Two things from that paper belong in the product:

1. **The 151 ms anticipatory gap is the commercial opening, and it is measured.**
   Humans start before the turn ends; no shipped system does. A gate that
   grades a voice agent against the human reference has a number no competitor
   is publishing.
2. **The RMS-VAD false-positive rate is a warning about this bench's own
   detector.** 0.38–0.55 FPR on interruptions is a detector that fires on
   nearly everything. My energy-based path is in the same family. On backchannel-
   dense calls it will over-report, and the honest fix is per-interaction-type
   budgets rather than one global threshold — which is what TurnBench's
   finding that casual INT FPR exceeds argumentative INT FPR implies.

### Krisp turn-taking-test-v1
4 hours, 976 "shift" and 1,754 "hold" labelled cases, single-channel 16 kHz.
Manual annotation, includes the last silence duration and speaker metadata.
**Gated behind contact-info sharing; "other" licence, login required.**

Worth requesting — the shift/hold labels are exactly the endpointer ground
truth, and the recorded last-silence duration is a directly comparable latency.

---

## 4. What this means for the product

**The three gaps, in order of how much they cost:**

1. **No Indian call-centre audio with turn labels exists publicly.** Everything
   Indian is meetings or read speech; everything call-centre is English and
   mostly non-commercial.
2. **The best call-centre corpus is CC BY-NC.** Usable for research, for
   calibration, and to sharpen the turn-taking model. Not usable in a product a
   customer pays for.
3. **Indic DiarBench is CC BY 4.0 and is genuinely usable** — the one Indian
   corpus with a commercial-compatible licence, real code-mixing and real
   speaker overlap.

**The strategy that follows, and it is the same shape as the rest of this
product:**

- **Study CallCenterEN timing** for research only. Its word timestamps do not
  label speaker changes or turn boundaries. Keep derived data outside git.
- **Ground the budgets in Indic DiarBench** (CC BY 4.0, so shippable). Real
  Indian speech, real overlap, and a published 16% DER to grade against.
- **Buy dual-channel audio** for acoustic validation. That is what turns the
  barge-in measurement from an upper bound into a measurement.
- **Treat a customer's own calls as the real corpus.** This is the one the
  research already identified as the uncopyable asset, and it now has a second
  justification: the public corpora are all either non-commercial or wrong
  domain, so the data moat is not a nice-to-have, it is the only route to the
  numbers.

**The honest strategic read.** The datasets confirm the earlier market finding
rather than contradicting it. Indic DiarBench, TurnBench, VoiceAgentBench,
CallCenterEN — the Indian-speech and turn-taking ground is being built, in
public, mostly under licences that block commercial reuse, and mostly for
Indian *meetings* rather than Indian *call centres*. Nobody has assembled the
call-centre case. That is a narrower window than the one the market brief
described, and it is a technical one rather than a commercial one — which is
better, because a technical window is closed by doing the work.

---

## 5. Provenance and gaps

Verified from primary sources: the CallCenterEN figures (arXiv 2507.02958,
read directly), Indic DiarBench (arXiv 2607.23808, read directly), TurnBench
(arXiv 2608.25218, via the paper and the Sesame leaderboard page), VoiceAgentBench
(arXiv 2510.07978 and the HuggingFace card), MUCS 2021 (OpenSLR 103 listing),
IIT Bombay (the lab's own dataset page), BEHE-CMDisfl (ACL Anthology 2026).

**Not verified, and I am not claiming otherwise:**

- Every marketplace price. Indicative, from listings, not quotes.
- Marketplace licence claims. Seller descriptions, not audited terms.
- IHBench's licence, download terms, or whether the audio columns are
  populated. Flagged as the most valuable unverified find.
- Whether CallCenterEN's HuggingFace mirrors are byte-identical to the paper's
  release; two mirrors exist and I did not diff them.
- Any dataset's suitability for training a commercial model. Several are
  explicitly evaluation-only.

I did not download any of these. Everything above is from documentation, and
nothing here should be treated as a data-processing decision until the licence
has been read by someone who can be held to it.

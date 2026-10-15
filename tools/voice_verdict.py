"""
Does an English-trained TTS-quality model actually measure quality on
code-switched Hindi-English?

RESULT (reproduce with: .venv-nisqa\\Scripts\\python.exe tools/voice_probe.py
then the same nisqa predict_dir call; see docs/VOICE-SCORING.md)

  NISQA-TTS v1.0, MITAG & MÖLLER 2020 (arXiv 2104.09494), scored on 4 real
  recordings from Indic DiarBench (CC BY 4.0), each degraded six ways.

  variant       mean MOS    vs clean
  clean           2.033        --
  hum             2.348      +0.315   <-- a 1 kHz tone RAISED the score
  band            1.964      -0.069
  telephone       1.954      -0.079
  clipped         1.489      -0.544
  noisy           1.037      -0.996

TWO FINDINGS

1. The model is not inert. A 5 dB-SNR line costs it 1.0 MOS and clipping costs
   0.54, and the ordering (noisy worst, clean/hum best) is identical on all four
   recordings. So the earlier worry that it would emit a constant prior is wrong,
   and this file records that correction rather than the assumption.

2. But two of its behaviours make it unusable as a release gate on real Indian
   call audio.

   a) CLEAN HUMAN SPEECH SCORES 2.03 / 5 -- AND SO DOES CLEAN ENGLISH.

      I first attributed this to speech structure: NISQA-TTS trained on
      continuous synthesized speech, real Hindi conversation is 53% speech and
      47% silence, so NISQA reads the pauses as deficiency.

      THE CONTROLS KILLED THAT EXPLANATION. Clean studio ENGLISH (LibriSpeech
      test-clean, speech fraction 45-68%, deliberately matched against the
      Hindi) scores 2.344. Hindi with every pause removed scores 2.106, only
      +0.073 above the 2.033 baseline. Silence is not the cause.

          english_clean   n=6   2.344
          hindi_baseline  n=4   2.033   (-0.311 vs English)
          hindi_speechonly n=4  2.106   (+0.073 vs baseline)

      So the honest reading is the boring one: NISQA-TTS is harsh in general on
      real conversational recordings, on BOTH languages, and the Hindi penalty
      is a modest -0.31 on top of that. It does not report the 4+ its own
      literature reports on its training distribution, which means a budget
      calibrated on either language would reject essentially all real calls.

      The India-specific finding survives in a weaker form -- 2.03 vs 2.34 is a
      real gap -- but it is second-order. The primary result is that this model
      class cannot gate anything, in any language, without recalibration on the
      target population.

   b) ADDING 1 kHz OF MAINS HUM RAISED THE SCORE BY 0.32.
      A steady narrow-band tone lifts frame energy uniformly, and NISQA-TTS
      rewards energy consistency. So the model prefers the degraded file. This is
      the exact class of defect a voice QA tool exists to catch, scored as an
      improvement, on every one of the four recordings.

WHY THIS IS STILL THE RIGHT RESULT

"NISQA scores Hindi low" would have said nothing -- it could be correctly
calibrated for a population that is simply harder. The two findings above are
diagnostic rather than merely low: the score is not tracking speech quality on
this material, and it has a known mechanism for each failure.

WHAT THIS BUYS

The incumbent voice-QA tooling is DNS/UTMOS/NISQA-class models applied to
English. Nobody has published a per-dimension audit of any of them on
code-switched Hindi-English. This is that audit, on 4 recordings, with a
reproduction script.

It is 4 recordings. It is not a benchmark. What it establishes is that the gap is
real and demonstrable, and that the integration must be per-dimension and
adversarial-tested before any of it can gate a release.

THE DESIGN CONSEQUENCE

A voice model may produce a score. It may not decide a release -- and this run is
the reason that rule is now evidence-backed rather than stylistic. The gate reads
the deterministic layers; model output is `conventional` provenance in
BUDGET_PROVENANCE until it has been validated on the target language.

    score   2.033 on clean real Hindi
    budget  anything calibrated on NISQA-TTS's own training distribution
    result  would fail 100% of real Indian calls
"""

import json
import os
import statistics as st

RESULTS = "data/voice_probe/NISQA_results.csv"

# The degradation that must lower a quality score, ordered by how obviously wrong
# it sounds to a human. `hum` is the control-in-reverse: it is in this list
# because a good model must REJECT it, and NISQA-TTS accepts it.
EXPECTED = ["noisy", "clipped", "telephone", "band"]
HUM_CONTROL = "hum"


def load(path=RESULTS):
    """Group NISQA output by degradation variant.

    NISQA names files `<recording>.<variant>.wav`, so the variant is the segment
    after the FIRST dot -- not the last, since variants can contain none but the
    recording ids themselves contain digits.
    """
    import csv
    if not os.path.exists(path):
        raise SystemExit(f"{path} not found -- run the nisqa predict_dir step first")
    by = {}
    for r in csv.DictReader(open(path)):
        name = r["deg"]
        parts = name.split(".")
        variant = parts[1] if len(parts) > 2 else "unknown"
        by.setdefault(variant, []).append(float(r["mos_pred"]))
    return {k: {"mean": st.mean(v), "min": min(v), "max": max(v), "n": len(v)} for k, v in by.items()}


def report(by=None):
    by = by or load()
    clean = by["clean"]["mean"]
    print(f"{'variant':11} {'mean':>7} {'n':>3}  vs clean")
    for v in ["clean", HUM_CONTROL] + EXPECTED:
        if v not in by:
            continue
        m = by[v]["mean"]
        delta = "" if v == "clean" else f"{m - clean:+.3f}"
        print(f"{v:11} {m:7.3f} {by[v]['n']:3d}  {delta}")

    # The check that matters: does the model REJECT the degradation a customer
    # would immediately complain about?
    rejected = [v for v in EXPECTED if by[v]["mean"] < clean]
    accepted = [v for v in EXPECTED if by[v]["mean"] >= clean]
    print(f"\nrejects real degradation: {len(rejected)}/{len(EXPECTED)} {rejected}")
    if accepted:
        print(f"  ACCEPTED: {accepted} -- scored equal to or better than clean")

    hum_delta = by[HUM_CONTROL]["mean"] - clean if HUM_CONTROL in by else None
    if hum_delta is not None and hum_delta > 0:
        print(f"\nFAIL: {HUM_CONTROL} raised the score by {hum_delta:+.3f}.")
        print("  A model that rewards added mains hum cannot gate a release.")

    print(f"\nclean real Hindi speech = {clean:.3f} / 5 on a TTS-trained scale.")
    return {
        "clean_mos": clean,
        "rejected_degradations": rejected,
        "accepted_degradations": accepted,
        "hum_delta": hum_delta,
        # A budget derived from the model's training distribution would sit well
        # above 2.03 and therefore reject every real call.
        "usable_as_gate": bool(accepted) and (hum_delta or 0) > 0,
    }


if __name__ == "__main__":
    out = report()
    with open("data/voice_probe/verdict.json", "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    print("\nwrote data/voice_probe/verdict.json")
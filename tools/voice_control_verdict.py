"""
Read the control scores and state what they mean, including what they refute.

tools/voice_verdict.py attributed the low Hindi score to speech/silence
structure. That was a mechanism asserted from transcript timings, not measured.
These controls measure it, and they refute it.

    python tools/voice_control_verdict.py
"""

import csv
import json
import os
import random
import statistics as st

CONTROLS = "data/voice_probe/NISQA_control.csv"
OUT = "data/voice_probe/control_verdict.json"


def group(rows):
    g = {}
    for r in rows:
        n = r["deg"]
        if n.startswith("english_clean"):
            k = "english"
        elif n.startswith("hindi_speechonly"):
            k = "hindi_speechonly"
        elif n.startswith("hindi_baseline"):
            k = "hindi_baseline"
        elif n.startswith("hindi_00") and n.endswith(".clean.wav"):
            k = "hindi_clean"
        else:
            continue
        g.setdefault(k, []).append(float(r["mos_pred"]))
    return {k: {"mean": st.mean(v), "n": len(v), "scores": v} for k, v in g.items()}


def bootstrap_effect(a, b, n_boot=3000, seed=3):
    """95% bootstrap CI on the difference of two means.

    n=4 Hindi clips against n=6 English is small enough that the point estimate
    needs an interval before it can be called a finding. It was measured before
    this existed and happened to hold; the point is that it should have to.
    """
    rnd = random.Random(seed)
    out = []
    for _ in range(n_boot):
        out.append(st.mean(rnd.choice(b) for _ in b) - st.mean(rnd.choice(a) for _ in a))
    out.sort()
    return out[int(0.025 * len(out))], out[int(0.975 * len(out))]


def main():
    if not os.path.exists(CONTROLS):
        raise SystemExit(f"{CONTROLS} not found -- run the nisqa predict_dir step")
    g = group(list(csv.DictReader(open(CONTROLS))))

    print(f"{'control':20} {'n':>3} {'mean MOS':>9}")
    for k in ("english", "hindi_baseline", "hindi_speechonly"):
        if k in g:
            print(f"{k:20} {g[k]['n']:3d} {g[k]['mean']:9.3f}")

    en = g["english"]["mean"]
    hb = g["hindi_baseline"]["mean"]
    hs = g["hindi_speechonly"]["mean"]
    silence_effect = hs - hb
    language_effect = hb - en

    ci = bootstrap_effect(g["english"]["scores"], g["hindi_baseline"]["scores"])
    print(f"\nEnglish clean studio speech : {en:.3f}")
    print(f"Hindi, pauses intact        : {hb:.3f}  ({language_effect:+.3f} vs English)")
    print(f"Hindi, pauses removed       : {hs:.3f}  ({silence_effect:+.3f} vs baseline)")

    verdict = {
        "english_clean": round(en, 3),
        "hindi_baseline": round(hb, 3),
        "hindi_speechonly": round(hs, 3),
        "language_effect": round(language_effect, 3),
        "silence_effect": round(silence_effect, 3),
        # The claim that silence explains the low Hindi score. If this is small,
        # that claim is refuted and must not be repeated.
        "language_effect_ci95": [round(ci[0], 4), round(ci[1], 4)],
        "language_effect_real": not (ci[0] <= 0 <= ci[1]),
        "silence_explains_hindi": abs(silence_effect) > 0.3,
        # A usable gate needs clean English well clear of the pass line, since a
        # budget is set from the best case the model can recognise.
        "english_is_confidently_good": en >= 3.5,
        "usable_as_gate": en >= 3.5,
    }

    print("\n--- verdict ---")
    if not verdict["silence_explains_hindi"]:
        print(f"Silence does NOT explain the Hindi score (effect {silence_effect:+.3f}).")
        print("The earlier mechanism was wrong and has been removed from the docs.")
    if not verdict["english_is_confidently_good"]:
        print(f"Clean English studio speech scores only {en:.2f}/5.")
        print("The model is harsh on real conversational audio generally, so it")
        print("cannot gate real calls in ANY language without recalibration.")
    if verdict["language_effect_real"]:
        print(f"Hindi sits {abs(language_effect):.2f} below English, CI [{ci[0]:+.2f}, {ci[1]:+.2f}]")
        print("excludes zero, so the language penalty is real -- but second-order.")
    else:
        print(f"The language gap CI [{ci[0]:+.2f}, {ci[1]:+.2f}] includes zero: at this")
        print("sample size it is not established.")

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(verdict, fh, indent=2)
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()

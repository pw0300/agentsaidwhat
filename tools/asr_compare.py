"""
Compare two engines on identical audio, through an identical metric.

WHY A SEPARATE TOOL

tools/asr_wer.py runs one engine and writes one CSV. Comparing two engines means
running it twice, and the second run overwrites the first -- which is exactly
what happened, and why data/asr_wer_small.csv is kept separately.

An earlier version of this file ran a GATED model
(ai4bharat/indic-conformer-600m-multilingual). It is MIT licensed, covers 22 Indic
languages and is built for code-switching with English, so it remains the right
target for a product -- but the repo needs an HF token this environment does not
have, and every clip failed with "You are trying to access a gated repo". Rather
than leave a script that cannot run, this compares two CSVs that already exist,
which is the comparison that is actually available.

THE COMPARISON IS ONLY VALID IF EVERYTHING ELSE MATCHES

Same clips, same references, same normalisation, both fold thresholds, the same
overlap correction. Everything is imported from asr_wer rather than restated, so
a change to the metric cannot silently apply to one engine and not the other.
That is the failure mode a hand-copied comparison always has.

The per-clip WER is RE-DERIVED from the stored text rather than read from each
CSV's own column. Those columns were written by whichever version of the metric
ran at the time, and comparing a number produced by one version against a number
produced by another is not a comparison. The text is the artefact.

WHAT IT DELIBERATELY DOES NOT DO

It does not claim either engine is good enough. A 49.8% WER against a 15% budget
is a better engine and still a failing one, and saying "large-v3 is better"
without the budget beside it would be the half that sells.

    python tools/asr_compare.py [a.csv] [b.csv] [a_name] [b_name]
"""

import csv
import importlib.util
import json
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, f"{name}.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


aw = _load("asr_wer")

BUDGET = 0.15   # the same conventional figure the gate uses
OUT_JSON = "data/asr_compare.json"
OUT_CSV = "data/asr_compare.csv"


def read(path):
    if not os.path.exists(path):
        raise SystemExit(f"{path} not found")
    with open(path, newline="", encoding="utf-8") as fh:
        return {r["recording"]: r for r in csv.DictReader(fh)}


def rescore(rows):
    """Re-derive WER from stored text, at both folds."""
    out = {}
    for sid, r in rows.items():
        s = aw.wer(r["reference"], r["hypothesis"], aw.FOLD_THRESHOLD)
        l = aw.wer(r["reference"], r["hypothesis"], aw.FOLD_THRESHOLD_LOOSE)
        if s and l:
            out[sid] = {"strict": s, "loose": l}
    return out


def main():
    a_path = sys.argv[1] if len(sys.argv) > 1 else "data/asr_wer_small.csv"
    b_path = sys.argv[2] if len(sys.argv) > 2 else "data/asr_wer.csv"
    a_name = sys.argv[3] if len(sys.argv) > 3 else "small"
    b_name = sys.argv[4] if len(sys.argv) > 4 else "large-v3"

    A, B = rescore(read(a_path)), rescore(read(b_path))
    shared = sorted(set(A) & set(B))
    if not shared:
        raise SystemExit(f"no shared clips between {a_path} and {b_path}")

    ov = aw.overlap_ratio()
    corr = ov if ov else 1.0
    n = sum(A[s]["strict"]["ref_words"] for s in shared)

    def agg(src, key):
        return sum(src[s][key]["wer"] * src[s][key]["ref_words"] for s in shared) / n

    # Gate on the WORST endpoint for each engine. A fold threshold chosen to
    # flatter one engine is a choice, and allowing it per-engine would let the
    # comparison decide its own result.
    a_range = tuple(sorted((agg(A, "strict"), agg(A, "loose"))))
    b_range = tuple(sorted((agg(B, "strict"), agg(B, "loose"))))

    gap = a_range[1] - b_range[1]
    margin = aw.FOLD_MARGIN
    established = abs(gap) > margin

    print(f"same {len(shared)} clips, {n} reference words, overlap correction {corr:.3f}\n")
    print(f"{'engine':12} {'WER range':>16}   vs {BUDGET*100:.0f}% budget")
    for name, rng in ((a_name, a_range), (b_name, b_range)):
        print(f"{name:12} {rng[0]*100:5.1f}-{rng[1]*100:5.1f}%   "
              f"{'FAIL' if rng[1] > BUDGET else 'pass'}")

    print(f"\ngap on the worst endpoint: {gap*100:+.1f} points")
    print(f"fold margin, the measurement's own uncertainty: {margin:.3f}")
    print(f"gap exceeds the uncertainty: {established}")

    # A sample-size label the reader cannot miss, because the headline numbers
    # are legible on their own and a JSON of them invites being quoted out of
    # context. One clip is a probe: enough to establish a direction with a 20x
    # margin, nowhere near enough to call an engine's quality.
    MIN_CLIPS = 5
    MIN_WORDS = 2000
    sample_ok = len(shared) >= MIN_CLIPS and n >= MIN_WORDS
    if not sample_ok:
        print(f"\n  SAMPLE TOO SMALL TO CALL: {len(shared)} clips and {n} reference words,")
        print(f"  against a floor of {MIN_CLIPS} clips and {MIN_WORDS} words.")
        print(f"  The direction of the gap may be established; the LEVELS are a probe.")

    verdict = {
        "clips": len(shared),
        "reference_words": n,
        "sample_sufficient": sample_ok,
        "sample_floor": {"clips": MIN_CLIPS, "words": MIN_WORDS},
        "label": "benchmark" if sample_ok else "PROBE -- not a benchmark",
        "overlap_correction": round(corr, 4),
        "fold_margin": aw.FOLD_MARGIN,
        "a": {"name": a_name, "wer_min": round(a_range[0], 4), "wer_max": round(a_range[1], 4),
              "passes_budget": a_range[1] <= BUDGET},
        "b": {"name": b_name, "wer_min": round(b_range[0], 4), "wer_max": round(b_range[1], 4),
              "passes_budget": b_range[1] <= BUDGET},
        "gap_worst_endpoint": round(gap, 4),
        "gap_exceeds_uncertainty": established,
        "budget": BUDGET,
        "caveat": "engine against engine on identical audio. NOT an agent mishearing a "
                  "caller -- different layer, not measured.",
    }
    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(verdict, fh, indent=2)

    with open(OUT_CSV, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["recording", f"{a_name}_wer", f"{b_name}_wer", "ref_words"])
        for s in shared:
            w.writerow([s, A[s]["strict"]["wer"], B[s]["strict"]["wer"],
                        A[s]["strict"]["ref_words"]])

    print(f"\nwrote {OUT_JSON} and {OUT_CSV}")
    print(f"\n  {verdict['caveat']}")
    if verdict["b"]["passes_budget"] and not verdict["a"]["passes_budget"]:
        print(f"\n  {b_name} clears {BUDGET*100:.0f}% and {a_name} does not. The gap is the")
        print(f"  MODEL, not the language -- and the gate should measure {b_name}.")
    elif not verdict["b"]["passes_budget"]:
        print(f"\n  Neither engine clears the budget. The gap is capacity, but the ceiling")
        print(f"  for off-the-shelf multilingual models on code-switched Hindi is still")
        print(f"  above it, which is the case for a purpose-built Indic engine.")
    if not established:
        print(f"\n  NOTE: the gap is inside the measurement's own uncertainty, so the")
        print(f"  ordering of these two engines is NOT established by this data.")
    if not sample_ok and established:
        print(f"\n  The gap DOES exceed the uncertainty, so the direction is real. But")
        print(f"  at this sample size the levels are a probe, and neither engine's")
        print(f"  number should be quoted as its quality.")


if __name__ == "__main__":
    main()
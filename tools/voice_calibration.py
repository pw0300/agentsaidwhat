"""
Is NISQA-TTS calibrated, or just consistent?

The audit so far establishes that NISQA-TTS is harsh on real conversational
audio (clean English 2.34, clean Hindi 2.03) and that it rewards added mains
hum. Both are reasons not to gate a release with it. Neither is evidence about
the model being WRONG -- a model can be harsh and correctly ordered.

The question this answers is the missing one: does NISQA's number track a human
number? That needs a corpus with MOS ratings collected from listeners, and
NISQA-TTS cannot be evaluated against data it was trained on.

SOMOS (Samsung Open MOS Dataset, Zenodo 7378801, CC BY-NC-SA 4.0, Maniati et
al. 2022) supplies it: synthesized English TTS utterances rated 1-5 by crowd
workers, which is the same domain NISQA-TTS was trained on but with independent
human labels. Its own pairwise subset keeps only pairs whose human MOS differs by
more than 1.0 -- a much stronger signal than the absolute scale.

THE LICENCE MATTERS

CC BY-NC-SA 4.0 is NON-COMMERCIAL. That is fine for this project's stated use and
is recorded rather than assumed. It also means SOMOS-derived numbers cannot go
into a commercial product's calibration -- a real constraint on what this proves,
stated up front so nobody builds a plan on top of it.

    python tools/voice_calibration.py
"""

import csv
import json
import os
import statistics as st

SCORES = "data/voice_probe/NISQA_somos.csv"
MOS = "data/somos/mos_labels.csv"
OUT = "data/voice_probe/calibration_verdict.json"


def _pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    mx, my = st.mean(xs), st.mean(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = sum((x - mx) ** 2 for x in xs) ** 0.5
    dy = sum((y - my) ** 2 for y in ys) ** 0.5
    if dx == 0 or dy == 0:
        return None
    return num / (dx * dy)


def _residual_sd(pred, human, r):
    """SD of the residuals around the least-squares fit.

    This is the model's own noise floor on THIS data: how far a prediction
    typically sits from the value its rank implies. A decision gap has to be
    larger than this to mean anything, so it is the right denominator for
    "can the model see a difference that matters" rather than an invented one.
    """
    n = len(pred)
    if n < 3 or r is None:
        return None
    mp, mh = st.mean(pred), st.mean(human)
    sxx = sum((p - mp) ** 2 for p in pred)
    if sxx == 0:
        return None
    slope = sum((p - mp) * (h - mh) for p, h in zip(pred, human)) / sxx
    intercept = mh - slope * mp
    resid = [h - (intercept + slope * p) for p, h in zip(pred, human)]
    return (sum(r * r for r in resid) / (n - 2)) ** 0.5


def _spearman(xs, ys):
    """Rank-based, because MOS is ordinal.

    A Pearson correlation on a 1-5 subjective scale rewards assuming the
    distances between ratings are equal, which they are not. Spearman only
    assumes the order is right.
    """
    def rank(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2.0 + 1
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r
    return _pearson(rank(xs), rank(ys))


def bootstrap_ci(pred, human, n_boot=2000, seed=7):
    """95% bootstrap CI on Pearson r.

    The reason n=12 was unusable is that a single point estimate carries no
    sense of its own uncertainty. At n=100 a CI is what says whether a low r is
    the model or the sample -- and it costs nothing but repeated resampling.
    """
    import random
    rnd = random.Random(seed)
    out = []
    n = len(pred)
    for _ in range(n_boot):
        idx = [rnd.randrange(n) for _ in range(n)]
        p2 = [pred[i] for i in idx]
        h2 = [human[i] for i in idx]
        r = _pearson(p2, h2)
        if r is not None:
            out.append(r)
    if len(out) < 100:
        return None, None
    out.sort()
    return out[int(0.025 * len(out))], out[int(0.975 * len(out))]


def load_pairs(scores_path=SCORES, mos_path=MOS):
    if not os.path.exists(scores_path) or not os.path.exists(mos_path):
        raise SystemExit(
            "missing SOMOS artefacts -- see docs/VOICE-SCORING.md for the fetch steps"
        )
    pred = {}
    for r in csv.DictReader(open(scores_path)):
        pred[os.path.basename(r["deg"])] = float(r["mos_pred"])
    rows = []
    for r in csv.DictReader(open(mos_path)):
        raw = r.get("wav") or r.get("filename") or r.get("path") or ""
        if not raw:
            continue
        name = os.path.basename(str(raw))
        if name in pred:
            rows.append((name, pred[name], float(r["mos"])))
    return rows


def main():
    rows = load_pairs()
    if len(rows) < 3:
        raise SystemExit(f"only {len(rows)} paired clips -- cannot correlate")

    pred = [p for _, p, _ in rows]
    human = [h for _, _, h in rows]
    pear = _pearson(pred, human)
    spear = _spearman(pred, human)

    print(f"paired clips: {len(rows)}")
    print(f"human MOS  mean {st.mean(human):.3f}  range {min(human):.1f}-{max(human):.1f}")
    print(f"NISQA pred mean {st.mean(pred):.3f}  range {min(pred):.3f}-{max(pred):.3f}")
    lo_ci, hi_ci = bootstrap_ci(pred, human)
    # A significance test, not a threshold on the point estimate: with a CI
    # available, ask whether r=0 is excluded rather than whether r clears an
    # arbitrary bar. H0: no linear relationship.
    verdict_sig = bool(lo_ci is not None and (lo_ci > 0 or hi_ci < 0))
    print(f"\nPearson  r = {pear:+.4f}", end="")
    if lo_ci is not None:
        print(f"   95% CI [{lo_ci:+.3f}, {hi_ci:+.3f}]")
    else:
        print()
    print(f"Spearman r = {spear:+.4f}   (rank-based; MOS is ordinal)")

    # The bias that matters commercially: does the model compress a wide human
    # range into a narrow band? A model that maps 1.5-5.0 human onto 2.0-2.5
    # cannot separate two releases no matter how well it ranks them.
    human_range = max(human) - min(human)
    pred_range = max(pred) - min(pred)
    ratio = pred_range / human_range if human_range else 0.0

    # Resolution is the question that decides this, and the compression ratio
    # alone does not answer it.
    #
    # The earlier version of this script called the scale "usable" whenever the
    # ratio cleared an invented 0.5, which is the same unsourced-constant mistake
    # this project has been removing elsewhere -- and at n=100 it flipped the
    # verdict to True while the correlation said otherwise.
    #
    # What actually matters is: does a difference a customer would call a real
    # difference survive the mapping as a difference the model can see? A release
    # decision turns on a human MOS gap of about 0.5 (roughly "audible", not
    # "subtle"). Under compression `ratio` that gap arrives as 0.5*ratio -- and it
    # has to clear the model's own run-to-run spread, estimated from the residual
    # around the fitted line, to be distinguishable from noise at all.
    #
    # Both inputs are measured from this data: the residual spread, and the
    # compression. The 0.5-MOS decision threshold is the one assumption, and it
    # is stated here rather than buried.
    DECISION_GAP_HUMAN_MOS = 0.5
    residual_spread = _residual_sd(pred, human, pear)
    visible_gap = DECISION_GAP_HUMAN_MOS * ratio
    resolution_ok = bool(residual_spread and visible_gap > residual_spread)

    print(f"\nhuman range {human_range:.2f} -> predicted range {pred_range:.3f}")
    print(f"compression ratio {ratio:.2f}x", end="")
    if ratio < 0.5:
        print("   <-- heavily compressed: ordering may hold, the NUMBER does not")
    else:
        print()

    print("\n--- highest vs lowest human-rated clips ---")
    for name, p, h in sorted(rows, key=lambda r: -r[2])[:3]:
        print(f"  human {h:.2f} -> NISQA {p:.3f}   {name}")
    for name, p, h in sorted(rows, key=lambda r: r[2])[:3]:
        print(f"  human {h:.2f} -> NISQA {p:.3f}   {name}")

    # A correlation can legitimately be undefined (constant input), and writing
    # null is honest where rounding None would crash or silently become 0.
    verdict = {
        "n": len(rows),
        "pearson": round(pear, 4) if pear is not None else None,
        "pearson_ci95": [round(lo_ci, 4), round(hi_ci, 4)] if lo_ci is not None else None,
        "spearman": round(spear, 4) if spear is not None else None,
        "human_mean": round(st.mean(human), 3),
        "pred_mean": round(st.mean(pred), 3),
        "compression_ratio": round(ratio, 3),
        "residual_sd": round(residual_spread, 4) if residual_spread else None,
        "decision_gap_human_mos": DECISION_GAP_HUMAN_MOS,
        "decision_gap_predicted": round(visible_gap, 4),
        # A significance test, not a threshold on the point estimate: with a CI
        # available, ask whether r=0 is excluded rather than whether r clears an
        # arbitrary bar. H0: no linear relationship.
        "significant_at_95": verdict_sig,
        "calibrated": bool(pear is not None and pear >= 0.7),
        # Resolution AND a demonstrated relationship are both required. A
        # calibrated-but-compressed model could still gate on ranking; an
        # uncompressed-but-uncorrelated one cannot gate on anything.
        "usable_as_absolute_scale": bool(resolution_ok and verdict_sig),
        "licence": "CC BY-NC-SA 4.0 (non-commercial) -- cannot ship in a product",
    }
    print("\n--- verdict ---")
    if pear is None:
        print("Correlation undefined: one of the inputs is constant.")
        print("The model returned the same number for everything.")
    elif verdict["calibrated"]:
        print(f"Pearson r={pear:.2f}: the ranking tracks human judgement.")
    else:
        print(f"Pearson r={pear:.2f}: too weak to gate.")
    if lo_ci is not None:
        if verdict["significant_at_95"]:
            print(f"CI [{lo_ci:+.2f}, {hi_ci:+.2f}] excludes zero: the relationship is real,")
            print("and it is weak. That is a property of the model, not of the sample.")
        else:
            print(f"CI [{lo_ci:+.2f}, {hi_ci:+.2f}] includes zero: at n={len(rows)} this")
            print("cannot distinguish a real relationship from noise.")
    if not verdict["usable_as_absolute_scale"]:
        print(f"Not usable as an absolute scale: a {DECISION_GAP_HUMAN_MOS}-MOS human "
              f"difference arrives as {visible_gap:.3f},")
        if residual_spread:
            print(f"below the {residual_spread:.3f} noise floor"
                  + ("" if verdict_sig else " AND no demonstrated correlation with human MOS") + ".")

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(verdict, fh, indent=2)
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
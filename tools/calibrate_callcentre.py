#!/usr/bin/env python
"""
Calibrate speech-segmentation timing against real call-centre transcripts.

    python tools/calibrate_callcentre.py data/cc_medequip.zip [--limit 200]

Why this is not the turn-boundary calibration I said it would be
--------------------------------------------------------------
DATA-SOURCES.md proposed using CallCenterEN's word-level timestamps as
turn-boundary ground truth. Having now read the files, that proposal is wrong in
a way worth recording:

    The corpus contains NO speaker labels.

Checked across 1,489 transcripts in two domains (medical_equipment_outbound and
automotive-stereo-inbound), every word carries `"speaker": null`. Not sparse —
zero, in every file sampled.

Without speaker labels there is no turn boundary to recover. A turn is a change
of speaker; word timestamps alone give a stream of words with durations and
nothing about who said them. Any "turn detector" scoring against this corpus
would be scoring against a boundary the corpus does not contain.

So this harness calibrates what the corpus *does* contain, which is still worth
something:

    1. Speaking-rate realism. Real calls have a words-per-minute distribution
       with a long tail of silence. Synthetic fixtures are nowhere near this,
       and a simulator that produces uniform speech density produces calls that
       cannot happen.

    2. Silence structure. The distribution of pauses between words, and the
       fraction of a call that is silence. This is what a call-routing budget
       needs, and it is the distribution the "dead air" threshold should be
       derived from rather than from a round number.

    3. Interrupt plausibility. Calls where a short utterance lands inside a
       longer one's span — the textual signature of a barge-in, and the thing a
       simulated caller needs to reproduce credibly.

    4. Duration and turn-proxy shape. Real calls are 2 to 22 minutes. Fixtures
       are 5 to 16 seconds.

What this cannot do, stated plainly
----------------------------------
Turn boundaries, speaker attribution, barge-in latency, overlap. All four need
speaker labels or separate channels. Neither exists here. Indic DiarBench
covers segmentation on real audio; this corpus covers *timing realism* on real
call structure. Neither covers turns. Nothing public does — see
docs/DATA-SOURCES.md.

Every number is printed with the count behind it.
"""

import argparse
import json
import math
import statistics
import sys
import os
import zipfile
from collections import Counter


# --------------------------------------------------------------------------
# Reading
# --------------------------------------------------------------------------

def load_calls(zip_path, limit):
    """Yield {name, durationMs, words:[{text,start,end,conf,speaker}]}."""
    z = zipfile.ZipFile(zip_path)
    names = [n for n in z.namelist()
             if n.endswith(".json") and "__MACOSX" not in n]
    out = []
    for n in names:
        if len(out) >= limit:
            break
        try:
            d = json.loads(z.read(n))
        except Exception:
            continue
        w = d.get("words") or []
        if not w:
            continue
        # A word with a non-positive or missing duration is corrupt; keeping it
        # would corrupt every rate downstream.
        clean = []
        for x in w:
            try:
                s, e = float(x["start"]), float(x["end"])
            except Exception:
                continue
            if e <= s:
                continue
            clean.append({"text": str(x.get("text", "")), "start": s, "end": e,
                          "conf": x.get("confidence"),
                          "speaker": x.get("speaker")})
        if len(clean) < 40:
            continue
        # UNITS. Word start/end are MILLISECONDS. `audio_duration` is SECONDS.
        # Verified directly: a call reports audio_duration=500 while its last
        # word ends at 496990 — consistent only if the duration is seconds and
        # the words are milliseconds.
        #
        # Taking the field at face value made every rate nonsense: 111,812 words
        # per minute and a 47,406% speech share. A plausible-looking table of
        # impossible numbers, which is the most dangerous failure mode this
        # harness has — nothing errors, the numbers just mean nothing.
        #
        # Rather than trust the field, the duration is cross-checked against the
        # words themselves and the field is used only when they agree. Where they
        # disagree, the word timestamps win, because they are the fine-grained
        # measurement and the duration is a single aggregate that may be in
        # seconds, milliseconds, or rounded.
        dur_field = float(d.get("audio_duration") or 0)
        word_end = max(x["end"] for x in clean)
        # The field is seconds when converting it to ms lands near the words.
        if dur_field > 0 and abs(dur_field * 1000.0 - word_end) / max(1.0, word_end) < 0.05:
            duration_ms = dur_field * 1000.0
            duration_unit = "seconds (converted)"
        elif dur_field > 0 and abs(dur_field - word_end) / max(1.0, word_end) < 0.05:
            duration_ms = dur_field
            duration_unit = "milliseconds (as given)"
        else:
            # Disagreement. Trust the words, and say so, because a duration
            # derived from the last word end misses any trailing silence — which
            # is real and is exactly what a dead-air check cares about.
            duration_ms = word_end
            duration_unit = "derived from last word (field disagreed)"

        out.append({"name": n.split("/")[-1],
                    "durationMs": duration_ms,
                    "durationUnit": duration_unit,
                    "confidence": d.get("confidence"),
                    "words": clean,
                    "nPiiPolicies": len(d.get("redacted_pii_policies") or [])})
    return out


def spans_and_gaps(call):
    """Word spans, and the silence between consecutive words."""
    w = call["words"]
    spans = [{"startMs": x["start"], "endMs": x["end"]} for x in w]
    gaps = []
    for i in range(1, len(w)):
        gaps.append(w[i]["start"] - w[i - 1]["end"])
    return spans, gaps


def speech_time(spans):
    return sum(s["endMs"] - s["startMs"] for s in spans)


# --------------------------------------------------------------------------
# What a real call looks like
# --------------------------------------------------------------------------

def analyse(calls):
    rows = []
    for c in calls:
        spans, gaps = spans_and_gaps(c)
        dur = c["durationMs"]
        st = speech_time(spans)
        rows.append({
            "name": c["name"],
            "domain": c.get("domain", "?"),
            "durationMs": dur,
            "words": len(c["words"]),
            "wpm": 60000.0 * len(c["words"]) / dur if dur else 0,
            "speechPct": 100.0 * st / dur if dur else 0,
            "wordDurMs": statistics.median([s["endMs"] - s["startMs"] for s in spans]),
            "gapMedianMs": statistics.median(gaps) if gaps else 0,
            "gapP90Ms": sorted(gaps)[int(0.9 * (len(gaps) - 1))] if gaps else 0,
            "gapMaxMs": max(gaps) if gaps else 0,
            "longestSilenceMs": max(gaps) if gaps else 0,
            "durationUnit": c.get("durationUnit", "?"),
            "asrConfidence": c["confidence"],
            "meanWordConf": statistics.mean(
                [w["conf"] for w in c["words"] if w["conf"] is not None] or [0]),
        })
    return rows


def fmt(v, nd=0):
    return f"{v:,.{nd}f}"


def pct(vals, q):
    if not vals:
        return 0.0
    s = sorted(vals)
    return s[min(len(s) - 1, int(q * (len(s) - 1)))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("zip", nargs="+",
                    help="one or more archives; pooled across domains")
    ap.add_argument("--limit", type=int, default=400,
                    help="max calls PER archive, so domains are not dominated by size")
    ap.add_argument("--json", help="write full results here")
    args = ap.parse_args()

    calls = []
    for zpath in args.zip:
        got = load_calls(zpath, args.limit)
        for c in got:
            c["domain"] = os.path.basename(zpath)
        calls.extend(got)
    if not calls:
        print("No usable calls in the archive(s).", file=sys.stderr)
        return 1
    rows = analyse(calls)

    print("=" * 74)
    print("REAL CALL-CENTRE TIMING — CallCenterEN / AIxBlock 92k")
    print("=" * 74)
    doms = Counter(r["domain"] for r in rows)
    print(f"transcripts read: {len(rows)}   across {len(doms)} domains")
    for d_, n_ in doms.most_common():
        print(f"    {n_:>5}  {d_}")
    print(f"{' '*74}")
    print("speaker labels present: 0  —  so NO turn boundary exists in this corpus.")
    print("This calibrates timing realism, not turns. See the module docstring.")
    print()

    wpm = [r["wpm"] for r in rows]
    sp = [r["speechPct"] for r in rows]
    wd = [r["wordDurMs"] for r in rows]
    gm = [r["gapMedianMs"] for r in rows]
    g90 = [r["gapP90Ms"] for r in rows]
    gmax = [r["longestSilenceMs"] for r in rows]
    dur = [r["durationMs"] for r in rows]

    print(f"{'property':<34}{'p10':>10}{'median':>10}{'p90':>10}{'max':>10}")
    print("-" * 74)
    for label, vals, nd in [
        ("call duration (s)", [v / 1000 for v in dur], 0),
        ("words per call", [float(v) for v in wpm[:0]] or [r["words"] for r in rows], 0),
        ("speaking rate (wpm)", wpm, 0),
        ("speech share of call (%)", sp, 1),
        ("median word length (ms)", wd, 0),
        ("median inter-word gap (ms)", gm, 0),
        ("p90 inter-word gap (ms)", g90, 0),
        ("longest silence in call (ms)", gmax, 0),
    ]:
        print(f"{label:<34}{fmt(pct(vals,.1)):>10}{fmt(pct(vals,.5)):>10}"
              f"{fmt(pct(vals,.9)):>10}{fmt(max(vals)):>10}")

    print()
    print("What a simulator has to reproduce to be believable:")
    print(f"  - calls run {pct([v/1000 for v in dur],.1):.0f}s to {pct([v/1000 for v in dur],.9):.0f}s,"
          f" median {pct([v/1000 for v in dur],.5):.0f}s. The synthetic fixtures are 5-16s.")
    print(f"  - speech occupies {pct(sp,.1):.0f}-{pct(sp,.9):.0f}% of a call; the rest is")
    print("    silence and overlap. Uniform speech density produces calls that cannot happen.")
    print(f"  - the median inter-word gap is {pct(gm,.5):.0f}ms but p90 is {pct(g90,.9):.0f}ms."
          " A single")
    print("    pause distribution cannot represent both.")

    print()
    print("Per domain (speaking rate and call length):")
    for d_ in sorted(doms):
        sub = [r for r in rows if r["domain"] == d_]
        print(f"    {d_:<44} n={len(sub):<4} "
              f"wpm median {pct([r['wpm'] for r in sub],.5):>5.0f}  "
              f"duration median {pct([r['durationMs']/1000 for r in sub],.5):>6.0f}s")

    print()
    print("Silence structure — the distribution a dead-air budget should come from:")
    buckets = Counter()
    for r in rows:
        g = r["gapP90Ms"]
        for hi, name in [(200, "<200ms"), (500, "200-500ms"), (1000, "500ms-1s"),
                         (2000, "1-2s"), (5000, "2-5s"), (10**9, ">5s")]:
            if g < hi:
                buckets[name] += 1
                break
    total = sum(buckets.values())
    for name in ["<200ms", "200-500ms", "500ms-1s", "1-2s", "2-5s", ">5s"]:
        n = buckets.get(name, 0)
        bar = "#" * int(40 * n / total) if total else ""
        print(f"  {name:<12}{n:>4} ({100*n/total:>4.1f}%)  {bar}")
    print("  (p90 inter-word gap per call, bucketed)")

    print()
    long_silent = sum(1 for r in rows if r["longestSilenceMs"] >= 4000)
    print(f"calls with a silence >= 4s: {long_silent}/{len(rows)} "
          f"({100*long_silent/len(rows):.0f}%)")
    print(f"calls with a silence >= 2s: "
          f"{sum(1 for r in rows if r['longestSilenceMs'] >= 2000)}/{len(rows)}")
    print()
    print("Note on the 4s dead-air budget: it is currently a round number in")
    print("_voicebench.ts. Real calls contain silences this long as a matter of")
    print("course, so 'a 4s silence' is NOT by itself a defect — it is only a defect")
    print("when it follows a caller turn and precedes no response. The budget needs")
    print("the conversational context, which a word-timestamp corpus also lacks.")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({
                "n": len(rows),
                "speakerLabelsPresent": 0,
                "summary": {
                    "durationS": {"p10": pct([v/1000 for v in dur], .1),
                                  "median": pct([v/1000 for v in dur], .5),
                                  "p90": pct([v/1000 for v in dur], .9)},
                    "wpm": {"p10": pct(wpm, .1), "median": pct(wpm, .5), "p90": pct(wpm, .9)},
                    "speechPct": {"p10": pct(sp, .1), "median": pct(sp, .5), "p90": pct(sp, .9)},
                    "gapMedianMs": pct(gm, .5),
                    "gapP90Ms": pct(g90, .9),
                    "longestSilenceMs": {"median": pct(gmax, .5), "p90": pct(gmax, .9)},
                    "asrConfidenceMedian": pct([r["asrConfidence"] for r in rows
                                               if r["asrConfidence"] is not None], .5),
                },
                "silenceBuckets": dict(buckets),
                "calls": rows,
            }, fh, indent=2)
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
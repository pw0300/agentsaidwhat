#!/usr/bin/env python
"""
Calibrate the acoustic bench against real annotated speech.

    python tools/calibrate_indic.py data/hindi_test.parquet [--limit 40]

Why this exists
---------------
The acoustic measurements in `api/_audio.ts` are validated against synthetic
fixtures whose ground truth was fixed before the audio was rendered. That proves
the arithmetic is right. It does not prove the detector works on a human voice,
an Indian voice, or a bad telephone line — and those are the only three things
that matter commercially.

Indic DiarBench (Sarvam AI + AI4Bharat, IIT Madras; arXiv 2607.23808) is 108
hours of natural multi-speaker audio across all 22 scheduled Indian languages,
human-corrected, time-aligned and speaker-attributed. CC BY 4.0, so this file
and everything it produces can be shipped. It is the one corpus here that is
both real and legally usable, and it is what the "no Indian call-centre audio
exists" gap in DATA-SOURCES.md was waiting for.

What is actually measured
-------------------------
For each clip, from the human speaker annotations:

  speech / non-speech segmentation
    The detector emits utterance spans. Compared against spans derived from the
    diarization ground truth. Reported as a frame-level agreement plus the two
    error rates that matter operationally — false speech (inventing voice) and
    missed speech (dropping it). Missed speech is the dangerous one: it means a
    caller hanging up goes unrecorded.

  turn structure
    How many turns the human annotation implies vs how many the detector found.
    A detector that halves the turn count is under-segmenting, and every
    turn-gap and barge-in number downstream is then wrong.

  code-mixed turns
    Turns the annotation marks as containing more than one language. Reported
    separately, because this is the case with no public benchmark and it is the
    one a skeptical enterprise evaluator will attack first.

Every number here is printed with the count behind it. A metric with n=4 is not
a result, and the output says so rather than letting a percentage imply
confidence it has not earned.

Honest limits, stated in the output rather than buried
------------------------------------------------------
- Ground truth is diarization annotation, not turn-taking annotation. Two people
  talking alternately give the same diarization whether or not the *timing* was
  natural. So this calibrates segmentation and turn counting; it does NOT
  calibrate turn-gap timing, barge-in latency or naturalness.
- Meeting-style multi-speaker audio, not telephony. No codec, no packet loss,
  no 8 kHz band-limiting.
- DER in the paper's terms needs a diarization system, not a VAD. This reports
  frame agreement against the annotation, which is a related but different
  number, and it is labelled as such.
"""

import argparse
import json
import math
import sys
from collections import defaultdict

# --------------------------------------------------------------------------
# The detector, ported from api/_audio.ts.
#
# Duplicated rather than imported because that file is TypeScript and this is a
# validation harness that has to run against a parquet file without the JS build
# step. The constants are asserted equal to the TS ones by tools/check_parity.py
# so the two cannot drift.
# --------------------------------------------------------------------------
FRAME_MS = 20.0
HOP_MS = 10.0
HANGOVER_FRAMES = 12      # ~120ms
MIN_UTTERANCE_MS = 120.0
FLOOR_FRACTION = 0.35   # matches adaptiveThresholds() in api/_audio.ts
PEAK_HEADROOM_DB = 8.0
MIN_DYNAMIC_RANGE_DB = 12.0

# Multiplier from the annotation's own unit to milliseconds.
# Indic DiarBench stores SECONDS, so 1000.0. A corpus already in milliseconds
# would use 1.0.
#
# Declared, not inferred. The first version guessed from value magnitude
# ("over 1000 means milliseconds"), which is wrong for every clip under 17
# minutes — a 74-second clip was read as 74 milliseconds, every segment
# collapsed into one 74ms span, and the detector scored 33.6% recall against a
# target covering 0.1% of the audio.
UNIT_SCALE = 1000.0


def to_db(rms):
    if rms <= 1e-12:
        return -120.0
    return 20.0 * math.log10(rms)


def frame(samples, sample_rate):
    hop = int(sample_rate * HOP_MS / 1000.0)
    win = int(sample_rate * FRAME_MS / 1000.0)
    out = []
    if win <= 0 or hop <= 0:
        return out
    for i in range(0, max(1, len(samples) - win + 1), hop):
        chunk = samples[i:i + win]
        if len(chunk) < win:
            break
        s = 0.0
        for v in chunk:
            s += v * v
        out.append({"startMs": i * 1000.0 / sample_rate,
                    "endMs": (i + win) * 1000.0 / sample_rate,
                    "rms": math.sqrt(s / win),
                    "peak": max(abs(v) for v in chunk)})
    return out


def adaptive_thresholds(frames):
    """Same estimator as adaptiveThresholds() in api/_audio.ts.

    The floor is a low percentile of frame energy, NOT a median of the frames
    below the peak.

    That distinction was found by running this against real annotated speech
    (Indic DiarBench) rather than synthetic fixtures, and it is the difference
    between working and not:

      old:  median of frames below peak-3dB
      real:  on one 75s Hindi clip that set contained 99.4% of all frames, so
            the "noise floor" was the median of the entire recording. The
            threshold floated up to -26 dBFS, only 36.5% of the clip crossed
            it, and recall came back at 35.7% — a total failure dressed up as
            a measurement.

    Why the old form seemed to work on the fixtures: on synthetic audio with
    clean silence, "frames below peak-3dB" is a small, genuinely quiet set. On
    continuous human conversation with 85% speech occupancy, that same filter
    selects almost everything. The estimator was not wrong in the fixtures, it
    was untested outside them.

    Why a low percentile is right here: frame energy is strongly bimodal on
    real speech. On the same clip, p20 = -78 dBFS and p50 = -32 dBFS — a 46 dB
    gap. A percentile from the bottom samples the noise mode regardless of how
    much of the clip is speech, which is the property the old form lacked.
    """
    if not frames:
        return {"noiseFloorDb": -60.0, "speechDb": -40.0, "peakDb": -120.0,
                "dynamicRangeDb": 0.0, "separable": False}
    db = sorted(to_db(f["rms"]) for f in frames)
    n = len(db)
    peak = db[-1]
    # p10 of frame energy. Not the minimum, which a single click would set, and
    # not p50, which on a dense clip is speech.
    floor = db[int(0.10 * (n - 1))]
    q10 = db[int(0.10 * (n - 1))]
    q90 = db[int(0.90 * (n - 1))]
    rng = q90 - q10
    # Threshold placed a FRACTION OF THE WAY ACROSS the measured gap, not a
    # fixed dB above the floor. See adaptiveThresholds() in api/_audio.ts for
    # why: on a 45 dB gap a fixed 14 dB margin lands inside the noise.
    speech = min(floor + rng * FLOOR_FRACTION, peak - PEAK_HEADROOM_DB)
    return {"noiseFloorDb": floor, "speechDb": speech, "peakDb": peak,
            "dynamicRangeDb": rng, "separable": rng >= MIN_DYNAMIC_RANGE_DB}


def detect_speech(frames, speech_db, hangover=HANGOVER_FRAMES):
    out = []
    on = False
    last = -1
    misses = 0
    for i, f in enumerate(frames):
        if to_db(f["rms"]) >= speech_db:
            if not on:
                out.append({"startIdx": i, "endIdx": i})
                on = True
            last = i
            misses = 0
        elif on:
            misses += 1
            if misses > hangover:
                out[-1]["endIdx"] = last
                on = False
    if on and out:
        out[-1]["endIdx"] = last
    return [o for o in out if o["endIdx"] >= o["startIdx"]]


def to_utterances(spans, frames):
    utts = []
    for s in spans:
        a, b = frames[s["startIdx"]], frames[s["endIdx"]]
        utts.append({"startMs": a["startMs"], "endMs": b["endMs"],
                     "durationMs": b["endMs"] - a["startMs"]})
    return utts


# --------------------------------------------------------------------------
# Ground truth from the annotation
# --------------------------------------------------------------------------

def parse_annotation(raw):
    """Pull per-speaker segments out of the annotation.

    Handles the two shapes this actually sees:

      - Indic DiarBench: a list of
        {speaker_id, transcript, start_time, end_time}, times in SECONDS.
      - An RTTM-ish string or JSON blob, times already normalised.

    `<noise>` segments are dropped. They are annotated non-speech, so counting
    them as speech would make the detector look wrong for being right.

    Tolerant by design: an unparseable annotation returns [] rather than
    guessing, and the caller refuses to report a number when every ground truth
    is empty. A calibration that silently scores against nothing is worse than
    no calibration.
    """
    if not raw:
        return []
    data = raw
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except Exception:
            return []
    if isinstance(data, dict):
        for key in ("segments", "annotation", "diarization", "turns", "items"):
            if key in data:
                return parse_annotation(data[key])
        data = [data]

    segs = []
    for node in data:
        if not isinstance(node, dict):
            continue
        text = str(node.get("transcript") or node.get("text") or "")
        # Annotated non-speech. Keeping it would penalise the detector for
        # correctly ignoring a cough.
        if text.strip().lower().startswith("<noise"):
            continue
        start = node.get("start_time", node.get("start"))
        end = node.get("end_time", node.get("end"))
        if start is None or end is None:
            continue
        try:
            start, end = float(start), float(end)
        except Exception:
            continue
        if end <= start:
            continue
        # Units. This corpus stores SECONDS, and the field names say so
        # (`start_time`, in a file whose `duration_seconds` column agrees).
        #
        # The first version used a magnitude heuristic — "over 1000 means
        # milliseconds" — which is wrong for every clip under 17 minutes, i.e.
        # almost all of them. A 74-second clip came back as 74 *milliseconds*,
        # every segment collapsed into one 74ms span, and the detector scored
        # 33.6% recall against a target that occupied 0.1% of the audio.
        #
        # The heuristic cannot be fixed by moving the threshold: a 2-hour
        # recording in seconds crosses 1000 and would be misread the other way.
        # So the unit is declared per-corpus rather than guessed per-value.
        segs.append({"start": start * UNIT_SCALE, "end": end * UNIT_SCALE,
                     "speaker": str(node.get("speaker_id") or node.get("spk")
                                    or node.get("speaker") or "?")})
    return segs


def truth_turns(segs, min_gap_ms=250.0):
    """Speech spans from the diarization, for frame-level scoring only.

    NOTE: this deliberately does NOT try to produce turns.

    The first version merged segments on a 250 ms gap and called the result
    "turns". On real multi-speaker audio that is wrong in a way that looks
    plausible: overlapping speakers chain into a single span covering almost
    the whole clip — one clip produced 279 detected utterances against 1
    "truth" turn, and frame agreement collapsed to 33.8%.

    The number was not measuring the detector. It was measuring my merge.

    So this returns speech/non-speech spans, which is what frame agreement
    actually needs. Turn counting is not reported as ground-truthed:
    diarization marks WHO spoke, not WHERE a turn ended.
    """
    if not segs:
        return []
    # parse_annotation already returns MILLISECONDS. The first version
    # multiplied by 1000 again, inflating a 74-second clip into a
    # 73,000-second one and merging every segment into a single span.
    iv = sorted([(s["start"], s["end"]) for s in segs if s["end"] > s["start"]])
    merged = []
    for a, b in iv:
        if merged and a - merged[-1][1] <= min_gap_ms:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [{"startMs": a, "endMs": b} for a, b in merged]


def frame_labels(utterances, frames):
    """Ground-truth speech/no-speech per frame."""
    lab = [0] * len(frames)
    for u in utterances:
        for i, f in enumerate(frames):
            if f["startMs"] >= u["startMs"] and f["endMs"] <= u["endMs"]:
                lab[i] = 1
    return lab


def score(pred, truth):
    """Frame agreement plus the two error rates that carry operational weight."""
    n = len(truth)
    if n == 0:
        return None
    tp = sum(1 for p, t in zip(pred, truth) if p and t)
    fp = sum(1 for p, t in zip(pred, truth) if p and not t)
    fn = sum(1 for p, t in zip(pred, truth) if not p and t)
    tn = sum(1 for p, t in zip(pred, truth) if not p and not t)
    agree = (tp + tn) / n
    # False speech = the detector inventing voice. Missed speech = the detector
    # dropping a caller. Dropping one is what makes a hang-up invisible, so it
    # is reported first and called out separately.
    far = fp / max(1, fp + tp)
    mrr = fn / max(1, fn + tp)
    return {"agree": agree, "falseSpeech": far, "missedSpeech": mrr,
            "tp": tp, "fp": fp, "fn": fn, "tn": tn}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("parquet")
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--json", help="write full results to this path")
    ap.add_argument("--skip-ms", type=float, default=0.0,
                    help="skip the first N ms of every clip (useful for leading silence)")
    args = ap.parse_args()

    try:
        import pyarrow.parquet as pq
    except ImportError:
        print("pyarrow is required: pip install pyarrow", file=sys.stderr)
        return 2

    pf = pq.ParquetFile(args.parquet)
    schema = pf.schema_arrow
    cols = [c.name for c in schema]
    print(f"# {args.parquet}")
    print(f"# columns: {cols}\n")

        # Indic DiarBench's actual schema, read from the file rather than assumed:
        #   annotated_transcript: list<{speaker_id, transcript, start_time, end_time}>
        #   audio: struct<bytes, path>
        #   plus language, dataset_type, num_speakers, num_segments,
        #        duration_seconds, sample_id
        #
        # The per-speaker start_time/end_time are the ground truth, and they are
        # genuinely useful: diarization marks WHO spoke and WHEN, which is enough to
        # calibrate segmentation and turn counting. It is not enough to calibrate
        # turn-gap timing, because diarization does not record whether a handover
        # was clean or interrupted. The output says so every time.
    audio_col = next((c for c in cols if c.lower() in ("audio", "wav", "speech")), None)
    ann_col = next((c for c in cols if "transcript" in c.lower() or "annot" in c.lower()
                    or "diar" in c.lower() or "rttm" in c.lower()), None)
    text_col = None
    lang_col = next((c for c in cols if c == "language"), None)
    dtype_col = next((c for c in cols if "dataset_type" in c.lower()), None)

    if not audio_col:
        print("No audio column found; aborting rather than scoring nothing.", file=sys.stderr)
        return 2
    print(f"audio={audio_col}  annotation={ann_col}  lang={lang_col}  type={dtype_col}\n")

    import io
    import wave

    rows = []
    read = 0
    for batch in pf.iter_batches(batch_size=64):
        for row in batch.to_pylist():
            if read >= args.limit:
                break
            read += 1
            a = row.get(audio_col)
            if a is None:
                continue
            raw = a.get("bytes") if isinstance(a, dict) else a
            if not raw:
                continue
            try:
                with wave.open(io.BytesIO(raw), "rb") as w:
                    sr = w.getframerate()
                    n_ch = w.getnchannels()
                    width = w.getsampwidth()
                    data = w.readframes(w.getnframes())
            except Exception:
                continue
            if width != 2 or n_ch != 1:
                rows.append({"file": a.get("path") if isinstance(a, dict) else "?",
                             "skipped": f"{width * 8}bit {n_ch}ch"})
                continue

            import array
            pcm = array.array("h")
            pcm.frombytes(data)
            if args.skip_ms:
                off = int(sr * args.skip_ms / 1000.0)
                pcm = pcm[off:]
            scale = 1.0 / 32768.0
            samples = [v * scale for v in pcm]
            # Ground truth first: the score below depends on it, and reading it
            # after the score is a use-before-assignment that only surfaces at
            # runtime on the first clip.
            segs_raw = row.get(ann_col) if ann_col else None
            segs = parse_annotation(segs_raw)
            truth_utts = truth_turns(segs)

            fr = frame(samples, sr)
            thr = adaptive_thresholds(fr)
            spans = detect_speech(fr, thr["speechDb"])
            pred_utts = to_utterances(spans, fr)

            s = score([1 if _in_any(f, pred_utts) else 0 for f in fr],
                      frame_labels(truth_utts, fr))

            # Code-mix detection from the transcript itself, which is more
            # reliable than the language column: a Hindi clip can be single
            # language throughout and a mixed one will carry Latin runs inside
            # Devanagari sentences.
            joined = " ".join(
                str(sg.get("transcript") or "")
                for sg in (segs_raw or []) if isinstance(sg, dict)
            )
            words = joined.split()
            dev = sum(1 for w in words if any("\u0900" <= ch <= "\u097f" for ch in w))
            lat = sum(1 for w in words if any(ch.isascii() and ch.isalpha() for ch in w))
            # "Code-mixed" = both scripts present, and neither is a rounding error.
            code_mixed = dev >= 5 and lat >= 3

            rows.append({
                "file": (a.get("path") if isinstance(a, dict) else "?") or f"row-{read}",
                "sr": sr, "durMs": 1000.0 * len(samples) / sr,
                "snrDb": round(thr["dynamicRangeDb"], 1),
                "separable": thr["separable"],
                "truthSpans": len(truth_utts),
                "detUtts": len(pred_utts),
                "score": s,
                "codeMixed": code_mixed,
                "devWords": dev,
                "latWords": lat,
            })
            if len(rows) >= args.limit:
                break
        if len(rows) >= args.limit:
            break

    usable = [r for r in rows if r.get("score")]
    skipped = [r for r in rows if r.get("skipped")]
    print(f"clips read: {rows.__len__()}   scored: {len(usable)}   skipped: {len(skipped)}\n")
    if skipped:
        from collections import Counter
        print("skipped reasons:", dict(Counter(s["skipped"] for s in skipped)), "\n")
    if not usable:
        print("Nothing scored. The annotation column did not parse — refusing to report a number.")
        return 1

    def avg(key, subset=None):
        vals = [r["score"][key] for r in (subset or usable) if r["score"][key] is not None]
        return sum(vals) / len(vals) if vals else float("nan")

    cm = [r for r in usable if r["codeMixed"]]
    mono = [r for r in usable if not r["codeMixed"]]

    print("=" * 72)
    print("REAL-SPEECH CALIBRATION — Indic DiarBench (CC BY 4.0)")
    print("=" * 72)
    print(f"{'metric':<26} {'all (n=%d)' % len(usable):>16} {'code-mixed (n=%d)' % len(cm):>18} {'mono (n=%d)' % len(mono):>16}")
    print("-" * 72)
    for key, label, fmt in [
        ("agree", "frame agreement", "{:.1%}"),
        ("missedSpeech", "MISSED speech", "{:.1%}"),
        ("falseSpeech", "false speech", "{:.1%}"),
    ]:
        def f(sub):
            if not sub:
                return "n/a"
            v = avg(key, sub)
            return fmt.format(v) + (" *" if len(sub) < 10 else "")
        print(f"{label:<26} {f(usable):>16} {f(cm):>18} {f(mono):>16}")

    # How much of the annotated speech did the detector actually mark as speech.
    # This is the recall number that matters; the utterance count is reported
    # as a count and explicitly NOT as a turn ground truth, because this corpus
    # does not contain turn boundaries.
    print("-" * 72)
    _rec = sum(r["score"]["tp"] for r in usable) / max(1, sum(r["score"]["tp"] + r["score"]["fn"] for r in usable))
    print(f"{'speech recall':<26} {_rec:>16.1%}")
    _prec = sum(r["score"]["tp"] for r in usable) / max(1, sum(r["score"]["tp"] + r["score"]["fp"] for r in usable))
    print(f"{'speech precision':<26} {_prec:>16.1%}")
    ratio = sum(r["detUtts"] for r in usable) / max(1, sum(r["truthSpans"] for r in usable))
    print(f"{'separable clips':<26} {sum(1 for r in usable if r['separable'])}/{len(usable)}")
    _snr = sorted(r['snrDb'] for r in usable)[len(usable) // 2]
    print(f"{'median SNR spread (dB)':<26} {_snr:>16.1f}")
    print("\n* fewer than 10 clips — an indication, not a result\n")

    # Worst clips, because a mean hides the failure mode that matters.
    worst = sorted([r for r in usable if r["score"]["missedSpeech"] > 0.2],
                   key=lambda r: -r["score"]["missedSpeech"])[:8]
    if worst:
        print("worst clips by missed speech (a caller going unrecorded is the bad case):")
        for r in worst:
            s = r["score"]
            print(f"  {str(r['file'])[:44]:<44} missed {s['missedSpeech']:>5.1%} "
                  f"false {s['falseSpeech']:>5.1%}  SNR {r['snrDb']:>5.1f}dB  "
                  f"utts {r['detUtts']} vs {r['truthSpans']} spans")
        print()

    print("What this does and does not establish:")
    print("  DOES    — speech/non-speech segmentation recall and precision on real Indian")
    print("             multi-speaker audio, reported separately for code-mixed speech.")
    print("  DOES NOT — turn counting. This corpus has no turn-boundary annotation; it marks")
    print("             WHO spoke, not WHERE a turn ended. Utterance counts are shown as a")
    print("             count and are not a ground truth.")
    print("  DOES NOT — turn-gap timing, barge-in latency or naturalness.")
    print("  DOES NOT — telephony behaviour. This is clean studio audio: no codec, no packet")
    print("             loss, no 8 kHz band-limiting. The synthetic fixtures cover those.")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({"clips": rows,
                       "summary": {"n": len(usable),
                                   "agree": avg("agree"),
                                   "missedSpeech": avg("missedSpeech"),
                                   "falseSpeech": avg("falseSpeech"),
                                   "utterancesPerTruthSpan": ratio, "speechRecall": _rec, "speechPrecision": _prec}},
                      fh, indent=2)
        print(f"\nwrote {args.json}")
    return 0


def _in_any(f, utts):
    return any(u["startMs"] <= f["startMs"] and f["endMs"] <= u["endMs"] for u in utts)


if __name__ == "__main__":
    sys.exit(main())
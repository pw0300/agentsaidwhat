"""
Does NISQA-TTS track human MOS ratings?

The audit so far established that NISQA-TTS is harsh on real conversational audio
(clean English 2.34, clean Hindi 2.03) and that it rewards added mains hum. Both
are reasons not to gate a release with it; neither is evidence that the model is
wrong. A model can be harsh and correctly ordered.

This is the missing measurement: does NISQA's number track a human number?

SOMOS (Samsung Open MOS Dataset, Zenodo 7378801, Maniati et al. 2022) provides
it -- 359,100 listener ratings over 20,100 synthesized English utterances, each
rated 1-5. Aggregating to a per-utterance MOS gives a human target spanning
1.78-4.71 with median 3.44, which is a genuine spread rather than a cluster.

Selection: 12 clips spread across the human range, 2 per tercile, preferring
utterances with more ratings because a 3-rating mean is noisy. That matters --
the correlation is only as good as the human labels it is measured against, so
the weakest labels are excluded rather than averaged in.

THE LICENCE IS NON-COMMERCIAL

SOMOS is CC BY-NC-SA 4.0. Fine for this project's research use, and recorded
rather than assumed -- it also means SOMOS-derived numbers cannot ship inside a
product's calibration. Stated here so nobody builds a plan on top of it.

    python tools/somos_extract.py
    (then score data/voice_probe via tools/nisqa_score.py)
    python tools/voice_calibration.py
"""

import csv
import collections
import io
import json
import os
import statistics as st
import subprocess
import sys
import zipfile
import wave

ZIP = "data/somos.zip"
OUT = "data/voice_probe"
MOS_JSON = "data/somos/utterance_mos.json"
LABEL_CSV = "data/somos/mos_labels.csv"
SRC_TSV = "raw_scores_with_metadata/raw_scores_removed_excess_gt.tsv"
INNER = "audios.zip"
SR = 16000
PER_BAND = 20
MIN_RATINGS = 8
BANDS = 5


def aggregate():
    """Per-utterance MOS from the shipped pre-filtered ratings.

    The raw file also carries validation columns, and their polarity is the
    opposite of what it looks like -- 1 means the rating PASSED. Reading them as
    failure flags yields zero valid ratings, which is the kind of silent empty
    result worth avoiding. The pre-filtered file exists precisely so this does not
    have to be guessed.
    """
    z = zipfile.ZipFile(ZIP)
    raw = z.read(SRC_TSV).decode("utf-8", "replace")
    per = collections.defaultdict(list)
    for r in csv.DictReader(io.StringIO(raw), delimiter="\t"):
        try:
            per[r["utteranceId"]].append(int(r["choice"]))
        except (ValueError, KeyError):
            continue
    mos = {u: st.mean(v) for u, v in per.items() if len(v) >= 3}
    os.makedirs("data/somos", exist_ok=True)
    with open(MOS_JSON, "w", encoding="utf-8") as fh:
        json.dump(mos, fh)
    return mos


def select(mos, per_band=PER_BAND, min_ratings=MIN_RATINGS, bands=BANDS):
    """Spread clips evenly across the human range, strongest labels first.

    n=12 was the binding constraint on the correlation -- too few to separate a
    real weakness from a noisy sample. 5 bands x 20 = 100, evenly spaced rather
    than sampled at random, so the design is balanced across the MOS range
    instead of clustered wherever the ratings happen to be dense.

    Even spacing matters for a correlation: sampling only the extremes would
    inflate r by construction, and sampling randomly could leave a band thin.
    """
    z = zipfile.ZipFile(ZIP)
    raw = z.read(SRC_TSV).decode("utf-8", "replace")
    counts = collections.Counter()
    for r in csv.DictReader(io.StringIO(raw), delimiter="\t"):
        counts[r["utteranceId"]] += 1

    usable = [(u, m) for u, m in mos.items() if counts[u] >= min_ratings]
    usable.sort(key=lambda t: t[1])
    n = len(usable)
    if n == 0:
        return []
    picked = []
    for b in range(bands):
        lo, hi = int(n * b / bands), int(n * (b + 1) / bands)
        chunk = usable[lo:hi]
        step = max(1, len(chunk) // per_band)
        # Evenly spaced within the band so each band is characterised, not just
        # its lowest member -- sampling only extremes would overstate any r.
        picked.extend(chunk[::step][:per_band])
    return picked


def extract(picked):
    """Pull the selected utterances out of the inner audio zip."""
    z = zipfile.ZipFile(ZIP)
    inner = zipfile.ZipFile(io.BytesIO(z.read(INNER)))
    names = set(inner.namelist())

    os.makedirs(OUT, exist_ok=True)
    for stale in os.listdir(OUT):
        if stale.startswith("somos_"):
            os.remove(os.path.join(OUT, stale))

    rows = []
    for i, (uid, human) in enumerate(picked):
        # The utteranceId IS the filename stem: audios/<utteranceId>.wav. The
        # tempting parse -- sentenceId is the middle of utteranceId -- produces
        # "audios/2007_0056.wav", which does not exist, and silently extracts
        # zero clips while printing a plausible-looking selection. The check that
        # would have caught it: rows came back empty and the summary then crashed.
        target = f"audios/{uid}.wav"
        if target not in names:
            continue
        blob = inner.read(target)
        dest = os.path.join(OUT, f"somos_{i:02d}.wav")
        if not _to_wav16k(blob, dest):
            continue
        rows.append({"wav": os.path.basename(dest), "mos": round(human, 4), "source_id": uid})
    with open(LABEL_CSV, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["wav", "mos", "source_id"])
        w.writeheader()
        w.writerows(rows)
    return rows


def _to_wav16k(blob, dest):
    """Resample SOMOS audio (24 kHz mono) to the 16 kHz NISQA expects.

    SOMOS is 24 kHz mono 16-bit, verified across a sample of the archive rather
    than assumed. `audioop` would have been the obvious tool and it was REMOVED
    in Python 3.13, so it is gone on this interpreter; the resample here is plain
    integer-indexed linear interpolation instead.

    24 -> 16 kHz is a 2:3 reduction, so this drops samples rather than filtering.
    That is acceptable here and worth being explicit about why: NISQA's own
    front end resamples to 16 kHz and computes a mel spectrogram with fmax 8 kHz,
    well below the 12 kHz Nyquist of the input. Nothing above 8 kHz reaches the
    score, so the interpolation is not discarding information the model uses. It
    WOULD matter for any metric reading the 8-12 kHz band, and this is not one.
    """
    try:
        with wave.open(io.BytesIO(blob), "rb") as w:
            if w.getsampwidth() != 2 or w.getnchannels() != 1:
                return False
            src = w.getframerate()
            frames = w.readframes(w.getnframes())
            import struct
            data = struct.unpack(f"<{len(frames) // 2}h", frames)
    except Exception:
        return False

    if src == SR:
        with open(dest, "wb") as f:
            f.write(blob)
        return True

    n_out = int(round(len(data) * SR / src))
    if n_out < 1:
        return False
    step = src / SR
    out = []
    for i in range(n_out):
        idx = int(i * step)
        frac = i * step - idx
        a = data[idx] if idx < len(data) else data[-1]
        b = data[idx + 1] if idx + 1 < len(data) else a
        out.append(int(a + (b - a) * frac))
    import struct as _s
    with wave.open(dest, "wb") as o:
        o.setnchannels(1)
        o.setsampwidth(2)
        o.setframerate(SR)
        o.writeframes(_s.pack(f"<{len(out)}h", *out))
    return True


def main():
    if not os.path.exists(ZIP):
        raise SystemExit("data/somos.zip missing -- run tools/fetch_somos.py")
    mos = aggregate()
    vals = sorted(mos.values())
    print(f"utterances with >=3 ratings: {len(mos)}")
    print(f"human MOS range {vals[0]:.2f}-{vals[-1]:.2f}, median {st.median(vals):.2f}")

    picked = select(mos)
    print(f"selected {len(picked)} clips across the range, >= {MIN_RATINGS} ratings each")
    for u, m in picked:
        print(f"  human {m:.2f}  {u}")

    rows = extract(picked)
    print(f"\nextracted {len(rows)} wavs -> {OUT}/somos_*.wav")
    print(f"labels -> {LABEL_CSV}")
    if not rows:
        raise SystemExit("extracted 0 clips -- filename mapping is wrong, not the data")
    lo = min(r["mos"] for r in rows)
    hi = max(r["mos"] for r in rows)
    print(f"selected human spread: {lo:.2f} - {hi:.2f}")


if __name__ == "__main__":
    main()
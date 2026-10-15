"""
Two controls that separate the two explanations for NISQA-TTS scoring clean
Hindi at 2.03/5.

WHY THESE TWO

tools/voice_verdict.py reported that clean real Hindi scores 2.03 and attributed
it to the speech/silence structure -- 53.7% speech, 46.3% silence, against a
model trained on continuous synthesized speech. That was a MECHANISM I asserted
from the transcript timings, not something I measured. It could equally have
been that the model is simply harsh on everything, or that it dislikes the
language and accent specifically. Those three explanations predict different
results, so they need different clips.

  C1  english   clean read English speech (LibriSpeech test-clean, CC BY 4.0),
                studio recorded, near-continuous, no silence between sentences.
                This is the closest available proxy to NISQA-TTS's training
                domain, which is synthesized English TTS output.

  C2  speechonly
                The SAME Hindi recordings with every pause removed -- segments
                spliced back to back using the diarization timestamps the corpus
                already provides. Language unchanged, speaker unchanged, words
                unchanged; only the silence fraction drops.

Reading the result:

  C1 low                    the model is harsh in general. Finding 2a is wrong
                             and the hum result needs rechecking.
  C1 high, C2 high          it is the silence, not the language. A real call
                             will still score low, so it cannot gate one.
  C1 high, C2 low           it is the language and accent. That is the stronger
                             finding and the one worth publishing.

C2 is the informative one, and it is the honest test of a claim I made without
measuring it.

Run:
    .venv-nisqa\\Scripts\\python.exe tools/voice_probe.py     (builds the variants)
    python tools/voice_control.py                            (builds C1 + C2)
    # then the nisqa predict_dir call over data/voice_probe
    python tools/voice_control_verdict.py                    (reads the scores)
"""

import json
import math
import os
import struct
import wave

SR = 16000
OUT = "data/voice_probe"
HINDI_SRC = "data/indic_hindi"
LIBRI = "data/librispeech_test_clean.parquet"


def read_wav(path):
    with wave.open(path, "rb") as w:
        n = w.getnframes()
        raw = w.readframes(n)
        return [s / 32768.0 for s in struct.unpack(f"<{n}h", raw)], w.getframerate()


def write_wav(path, samples):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    clipped = [max(-1.0, min(1.0, s)) for s in samples]
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(struct.pack(f"<{len(clipped)}h", *[int(s * 32767) for s in clipped]))


def speech_fraction(samples):
    """Fraction of 20ms frames above a floor derived from this clip's own range.

    Absolute thresholds do not transfer between a studio recording and a
    telephone-band one, so the floor is relative: 20% of the way from the 10th
    percentile frame to the 95th. A clip that is all speech scores high; a clip
    with long pauses scores low, which is the quantity being compared.
    """
    W = int(SR * 0.02)
    frames = [math.sqrt(sum(v * v for v in samples[i:i + W]) / W)
              for i in range(0, max(len(samples) - W, 1), W)]
    frames = [f for f in frames if f > 0]
    if not frames:
        return 0.0
    fs = sorted(frames)
    lo, hi = fs[int(len(fs) * 0.10)], fs[int(len(fs) * 0.95)]
    if hi <= lo:
        return 1.0
    return sum(1 for f in frames if f > lo + (hi - lo) * 0.20) / len(frames)


def build_english(limit=3, min_seconds=20):
    """C1: clean English read speech, stitched into continuous passages.

    LibriSpeech test-clean stores FLAC inside the parquet, not raw WAV, and each
    utterance is only ~7 s with a short gap either side. Scoring a single 7 s
    clip would confound "English read speech" with "a very short clip", and
    NISQA pools its prediction over segments -- so several utterances from the
    same chapter are concatenated with only a short join, which both lengthens the
    input and keeps the speech fraction high the way continuous TTS output is.
    """
    if not os.path.exists(LIBRI):
        print(f"C1 skipped: {LIBRI} not downloaded")
        return []
    import io
    import pyarrow.parquet as pq
    rows = pq.ParquetFile(LIBRI).iter_batches(batch_size=limit * 40)
    made, batch = [], []
    for b in rows:
        batch.extend(b.to_pylist())
        if len(batch) >= limit * 40:
            break

    made = []
    join = [0.12] * int(SR * 0.12)          # 120 ms between utterances

    # Group by chapter so the stitched passage is one speaker, like one TTS voice.
    by_chapter = {}
    for r in batch:
        if not r.get("audio") or not r["audio"].get("bytes"):
            continue
        if r["audio"]["bytes"][:4] != b"fLaC":
            continue
        by_chapter.setdefault(r["chapter_id"], []).append(r)

    for chapter, items in list(by_chapter.items())[:limit]:
        stitched, n_used = [], 0
        for r in items:
            samples = _decode_audio(r["audio"]["bytes"])
            if samples is None:
                continue
            if len(samples) < SR // 2:
                continue
            # Trim the leading/trailing near-silence LibriSpeech pads each file
            # with, or the join dominates the speech fraction we are measuring.
            samples = _trim_silence(samples)
            stitched.extend(samples)
            stitched.extend(join)
            n_used += 1
            if len(stitched) / SR >= min_seconds:
                break
        if not stitched or len(stitched) / SR < 5:
            continue
        out = f"{OUT}/english_clean{len(made)}.wav"
        write_wav(out, stitched)
        made.append({
            "path": out,
            "variant": "english",
            "chapter": chapter,
            "utterances": n_used,
            "speech_frac": speech_fraction(stitched),
        })
    return made


def _decode_audio(blob):
    """FLAC bytes -> float samples at 16 kHz, via soundfile.

    soundfile is not importable from the 3.14 host interpreter, so this is only
    used where it is available and returns None otherwise rather than raising --
    a missing decoder must skip the control, not kill the run.
    """
    import io
    try:
        import soundfile as sf
    except Exception:
        return None
    try:
        data, sr = sf.read(io.BytesIO(blob), dtype="float32")
    except Exception:
        return None
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != SR:
        # Linear resample. soundfile has no resampler; this is a control clip
        # whose content is speech, and the band below 8 kHz is unaffected.
        n = int(round(len(data) * SR / sr))
        if n < 1:
            return None
        idx = [int(i * sr / SR) for i in range(n)]
        idx = [min(i, len(data) - 1) for i in idx]
        data = data[idx]
    return [float(x) for x in data]


def _trim_silence(samples, thresh_db=-42.0, pad_ms=40):
    """Drop near-silent head and tail, keeping a short pad.

    LibriSpeech pads each utterance with digital silence. Left in, it lowers the
    speech fraction of the control and makes it look like conversational audio,
    which is exactly the variable C1 exists to hold constant.
    """
    if not samples:
        return samples
    peak = max(abs(s) for s in samples) or 1e-9
    thr = peak * (10 ** (thresh_db / 20.0))
    win = max(1, int(SR * 0.01))
    frames = [max(abs(s) for s in samples[i:i + win]) for i in range(0, len(samples) - win, win)]
    loud = [i for i, f in enumerate(frames) if f > thr]
    if not loud:
        return samples
    pad = int(SR * pad_ms / 1000)
    a = max(0, loud[0] * win - pad)
    b = min(len(samples), (loud[-1] + 1) * win + pad)
    return samples[a:b]


def build_hindi_speechonly(limit=4, max_segments=40):
    """C2: Hindi with the pauses cut out, using the corpus's own turn timings."""
    import pyarrow.parquet as pq
    rows = next(pq.ParquetFile("data/hindi_test.parquet")
                .iter_batches(batch_size=limit * 6)).to_pylist()
    made = []
    for r in rows:
        segs = sorted(r["annotated_transcript"], key=lambda s: s["start_time"])[:max_segments]
        if len(segs) < 8:
            continue
        with open(f"{HINDI_SRC}/{r['sample_id']}.wav", "rb") as f:
            raw = f.read()
        with wave.open(__import__("io").BytesIO(raw), "rb") as w:
            sr = w.getframerate()
            samples = [s / 32768.0 for s in struct.unpack(f"<{w.getnframes()}h", w.readframes(w.getnframes()))]
        if sr != SR:
            continue
        stitched, total_speech = [], 0.0
        for s in segs:
            a, b = int(s["start_time"] * SR), int(s["end_time"] * SR)
            seg = samples[a:b]
            if len(seg) < SR // 20:
                continue
            stitched.extend(seg)
            total_speech += len(seg) / SR
        if not stitched:
            continue
        out = f"{OUT}/hindi_speechonly.wav" if not made else f"{OUT}/hindi_speechonly{len(made)}.wav"
        write_wav(out, stitched)
        made.append({
            "path": out,
            "variant": "speechonly",
            "speech_frac": speech_fraction(stitched),
            "segments": len(stitched) // SR,
            "source_speech_s": round(total_speech, 2),
        })
        if len(made) >= limit:
            break
    return made


def build(limit_en=6, limit_hi=4):
    controls = build_english(limit_en) + build_hindi_speechonly(limit_hi)

    # Baseline for the same comparison: the untouched Hindi, pauses intact. Index
    # by position, not by membership -- the earlier version tested whether
    # "hindi_baseline" was already in the list and so wrote every baseline to
    # hindi_baseline.wav, silently keeping only the last.
    for i, f in enumerate(sorted(os.listdir(HINDI_SRC))[:limit_hi]):
        p = os.path.join(HINDI_SRC, f)
        s, _ = read_wav(p)
        out = f"{OUT}/hindi_baseline{i}.wav"
        write_wav(out, s)
        controls.append({"path": out, "variant": "hindi_baseline", "speech_frac": speech_fraction(s)})

    with open(f"{OUT}/controls.json", "w", encoding="utf-8") as f:
        json.dump(controls, f, indent=2)

    print(f"built {len(controls)} control clips")
    for c in controls:
        extra = f"  {c.get('segments')}s spliced" if c["variant"] == "speechonly" else ""
        print(f"  {os.path.basename(c['path']):26} {c['variant']:16} speech {c['speech_frac']*100:5.1f}%{extra}")


if __name__ == "__main__":
    build()
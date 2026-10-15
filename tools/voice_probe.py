"""
Does an English-trained MOS model react to degradation at all on Hindi?

The experiment that matters is NOT "NISQA scored Hindi low". NISQA could score
Hindi low and be perfectly calibrated -- low-scoring because it hears something
it dislikes. That is a usable number.

The useless outcome is a CONSTANT score. A model that returns 4.20 for a clean
recording and 4.20 for one with the top octave removed, the SNR at 5 dB and a
1 kHz hum underneath, has not measured the degradation. It has emitted its prior.

So this builds paired variants of the SAME recording, differing only in
degradation, and reports the SPREAD. A model with no sensitivity produces a spread
of ~0 across every pair regardless of how loudly that sounds wrong to a human.

    clean          the source recording, untouched
    band           top octave removed (7 kHz lowpass) -- dull, muffled
    noisy          additive white noise to 5 dB SNR -- a bad phone line
    clipped        hard-clipped at 2x the 99th percentile -- the classic TTS fault
    hum            1 kHz tone at -18 dBFS -- mains hum on a capture
    telephone     300-3400 Hz band-limited -- what actually reaches a PSTN caller

Every variant keeps the same words, the same speaker, the same duration. Only the
signal changes. That is what makes the spread attributable to degradation rather
than to content variation between recordings.

Run:
    .venv-nisqa\\Scripts\\python.exe tools/voice_probe.py
"""

import json
import os
import struct
import sys
import wave
import math

SRC = "data/indic_hindi"
OUT = "data/voice_probe"
SR = 16000


def read_wav(path):
    with wave.open(path, "rb") as w:
        assert w.getnchannels() == 1, f"expected mono, got {w.getnchannels()}"
        assert w.getsampwidth() == 2, f"expected 16-bit, got {w.getsampwidth()}"
        n = w.getnframes()
        raw = w.readframes(n)
        sr = w.getframerate()
    samples = struct.unpack(f"<{n}h", raw)
    return [s / 32768.0 for s in samples], sr


def write_wav(path, samples, sr=SR):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    clipped = [max(-1.0, min(1.0, s)) for s in samples]
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack(f"<{len(clipped)}h", *[int(s * 32767) for s in clipped]))


def rms_db(samples):
    if not samples:
        return -120.0
    r = math.sqrt(sum(s * s for s in samples) / len(samples))
    return 20 * math.log10(max(r, 1e-12))


def add_noise(samples, seed=42, snr_db=5.0):
    """Deterministic white noise at a target SNR against this recording's RMS."""
    level = rms_db(samples) - snr_db
    amp = 10 ** (level / 20.0)
    s = seed
    out = []
    for x in samples:
        s = (s * 1103515245 + 12345) & 0x7FFFFFFF
        out.append(x + (s / 0x7FFFFFFF - 0.5) * 2 * amp)
    return out


def lowpass(samples, cutoff, sr=SR):
    """One-pole IIR. Cheap, and its weakness is irrelevant -- we only need the
    top of the spectrum removed, not a brick-wall response."""
    rc = 1.0 / (2 * math.pi * cutoff)
    dt = 1.0 / sr
    alpha = dt / (rc + dt)
    out, prev = [], 0.0
    for x in samples:
        prev = prev + alpha * (x - prev)
        out.append(prev)
    return out


def highpass(samples, cutoff, sr=SR):
    lp = lowpass(samples, cutoff, sr)
    return [x - l for x, l in zip(samples, lp)]


def bandlimit(samples, lo, hi, sr=SR):
    return highpass(lowpass(samples, hi, sr), lo, sr)


def hard_clip(samples, factor=2.0):
    """Clip at `factor` x the 99th percentile magnitude.

    Clipping at a fixed absolute threshold would only distort loud recordings,
    so the control would vary across files. The 99th percentile makes the amount
    of clipping comparable between them.
    """
    mags = sorted(abs(s) for s in samples)
    p99 = mags[int(len(mags) * 0.99)] or 1e-9
    ceiling = p99 / factor
    return [max(-ceiling, min(ceiling, s)) for s in samples]


def add_hum(samples, freq=1000.0, dbfs=-18.0, sr=SR):
    amp = 10 ** (dbfs / 20.0)
    return [x + amp * math.sin(2 * math.pi * freq * i / sr) for i, x in enumerate(samples)]


VARIANTS = {
    "clean": lambda x: x,
    "band": lambda x: lowpass(x, 7000),
    "noisy": lambda x: add_noise(x),
    "clipped": lambda x: hard_clip(x),
    "hum": lambda x: add_hum(x),
    "telephone": lambda x: bandlimit(x, 300, 3400),
}


def build(limit=4):
    files = sorted(f for f in os.listdir(SRC) if f.endswith(".wav"))[:limit]
    manifest = []
    for f in files:
        samples, sr = read_wav(os.path.join(SRC, f))
        if sr != SR:
            raise SystemExit(f"{f}: expected {SR} Hz, got {sr}")
        for name, fn in VARIANTS.items():
            out = f"{OUT}/{f[:-4]}.{name}.wav"
            write_wav(out, fn(list(samples)))
            manifest.append({
                "source": f,
                "variant": name,
                "path": out.replace("\\", "/"),
                "rms_db": round(rms_db(fn(list(samples))), 2),
                "duration_s": round(len(samples) / SR, 2),
            })
    with open(f"{OUT}/manifest.json", "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    print(f"built {len(manifest)} clips from {len(files)} recordings")
    for m in manifest:
        if m["variant"] == "clean":
            print(f"  {m['source']}  {m['duration_s']}s  {m['rms_db']} dB RMS")


if __name__ == "__main__":
    if not os.path.isdir(SRC):
        raise SystemExit(
            f"{SRC} not found. Extract it first:\n"
            "  python -c \"import pyarrow.parquet as pq, os;"
            " os.makedirs('data/indic_hindi', exist_ok=True);"
            " [open(f'data/indic_hindi/{r[\\\"sample_id\\\"]}.wav','wb').write(r['audio']['bytes'])"
            " for r in next(pq.ParquetFile('data/hindi_test.parquet')"
            ".iter_batches(batch_size=12)).to_pylist()]\""
        )
    build()
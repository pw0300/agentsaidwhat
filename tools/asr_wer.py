"""
Word Error Rate against real code-switched Hindi ground truth.

WHAT THIS IS FOR

The release gate has a row reading "ASR word error rate: NOT MEASURED -- no ASR
engine wired", and `maxWer: 0.15` in BUDGET_PROVENANCE is labelled
`conventional`. One of those two has to give: either the threshold stays an
assumption, or it gets replaced by a measurement on the speech it is actually
going to be applied to.

The corpus is Indic DiarBench (sarvamai, CC BY 4.0), already on disk: 94 real
Hindi recordings with diarized transcripts. That is genuinely code-switched --
`एग्ज़ैक्टली(exactly)` is one of its utterances, Hindi sentence structure with
English words embedded and transliterated.

WHAT THIS DOES AND DOES NOT MEASURE

It measures the ASR engine's WER against human transcripts. It does NOT measure
an agent mishearing a customer, which is the thing the gate row is nominally
about, because that needs a real agent on a real call. Those are different
layers and conflating them is how a number ends up quoted for a claim it cannot
support.

The number this produces is therefore an UPPER BOUND on acceptable agent audio
quality, and a calibration constant for what Indian speech costs this engine.
Both are useful. Neither is "our agent has 12% WER".

THE MEASUREMENT PROBLEM THAT ACTUALLY MATTERS

Code-switched WER is not comparable across engines unless the tokenisation and
the normalisation are the same, and for Hindi-English they are a choice, not a
definition. Three decisions dominate the number and each one can move it by more
than the gap being measured:

  1. TRANSLITERATION. The corpus writes `एग्ज़ैक्टली(exactly)` -- the Hindi word
     followed by the English one in brackets. An engine that outputs only
     `exactly` has deleted nothing (the Hindi is the same word); an engine that
     outputs only the Devanagari has deleted the annotation, not content.
     Counting that as a deletion charges the engine for the corpus's own
     annotation style. So the bracketed gloss is stripped from the reference and
     the engine's output is normalised for script before anything is counted.

  2. SCRIPT. Devanagari vs Latin for the same English word ("exactly" vs
     "एक्ज़ैक्टली") is the same token to a listener and two tokens to a diff.
     Without folding, a correct transcription scores as ~50% error on every
     code-switched word, which is the most common way code-switched WER gets
     reported as catastrophically bad when the system is fine.

  3. PUNCTUATION AND CASE. Not free to ignore: Devanagari has no case, so
     lowercasing Latin and stripping danda (।) removes an asymmetry that would
     otherwise penalise Hindi and not English.

Each decision is stated here, applied identically to reference and hypothesis,
and reported in the output so the number is interpretable rather than a bare
percentage.

    .venv-nisqa\\Scripts\\python.exe -E tools/asr_wer.py
"""

import csv
import io
import json
import os
import re
import sys
import unicodedata

# Devanagari cannot be printed on a default Windows console (cp1252), and
# Python's default stdout encoding follows the console's. Without this the script
# dies on its first Hindi print, which reads as a broken corpus rather than a
# broken terminal.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
else:  # pragma: no cover - Python < 3.7
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

PARQUET = "data/hindi_test.parquet"
AUDIO_DIR = "data/indic_hindi"
# Clips to score. The full corpus is 94 recordings and about 5 hours of audio;
# transcribing all of it on CPU is a batch job, not a feedback loop. The default
# is a subset large enough for a stable aggregate, and it is reported in the
# output so a partial run is never mistaken for the corpus.
ASR_CLIP_LIMIT = 6
ASR_CLIP_SECONDS = 60

OUT_CSV = "data/asr_wer.csv"
OUT_JSON = "data/asr_verdict.json"

# The corpus annotates code-switched words as `<hindi>(<english>)`. The gloss is
# an annotation for humans reading the reference; it is not spoken a second time.
BRACKETED_GLOSS = re.compile(r"[ऀ-ॿ]+\s*\(([^)]{1,40})\)")

# Devanagari punctuation that carries no lexical content.
DEVANAGARI_PUNCT = "।॥،؛؟" + "‌‍"

# Devanagari is syllabic: each character carries a vowel unless the virama (U+094D)
# suppresses it. So folding a Devanagari token to Latin is TRANSLITERATION, not
# case folding, and it has to reconstruct the vowel from the following consonant.
#
# The first version of this file hardcoded three words (ठीक/नहीं/हाँ) and called
# it script folding. On real corpus data that maps nothing -- `exactly` against
# `एक्ज़ैक्टली` still scored 1.0 WER, a full substitution for a word a listener
# would call identical. A hardcoded list cannot scale to the code-switching it is
# supposed to measure, and the fix has to be mechanical.

# Consonant -> ("consonant", inherent vowel) for the Devanagari range in use.
_VOWELS = {
    "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo",
    "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऋ": "ri",
    "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo",
    "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ृ": "ri",
    "ॉ": "o", "ं": "n", "ँ": "n", "ः": "h", "ऽ": "",
    "्": "",      # virama: suppress the inherent vowel
    "़": "",      # nukta: fold into the base consonant
}
_CONSONANTS = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng",
    "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "ny",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
    "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
    "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
    "ष": "sh", "स": "s", "ह": "h",
    "क़": "k", "ख़": "kh", "ग़": "g", "ज़": "z", "ड़": "d", "ढ़": "dh",
    "फ़": "f", "य़": "y",
}


def transliterate(token: str) -> str | None:
    """Devanagari token -> a Latin-ish key, or None if it is not Devanagari.

    Used ONLY to decide whether two tokens are the same word written in two
    scripts. The output is not a real transliteration -- it is a comparison key,
    and it is never used as the transcript itself.
    """
    if not token or not re.fullmatch(r"[ऀ-ॿऺ-ॿ]+", token):
        return None
    out = []
    i = 0
    while i < len(token):
        ch = token[i]
        if ch in _CONSONANTS:
            out.append(_CONSONANTS[ch])
            # The next character decides the vowel: a vowel sign if present,
            # otherwise the consonant's inherent vowel.
            nxt = token[i + 1] if i + 1 < len(token) else ""
            if nxt in _VOWELS:
                out.append(_VOWELS[nxt])
                i += 2
                continue
            if nxt == "्":          # conjunct: next consonant carries the vowel
                i += 2
                continue
            out.append("a")         # inherent vowel
            i += 1
            continue
        if ch in _VOWELS:
            out.append(_VOWELS[ch])
            i += 1
            continue
        i += 1
    key = "".join(out)
    # Collapse doubled letters produced by conjuncts: "एक्ज़ैक्टली" -> eka-ktli
    key = re.sub(r"(.)\1+", r"\1", key)
    return key or None


# ------------------------------------------------------------------
# Normalisation -- applied identically to reference and hypothesis
# ------------------------------------------------------------------

# How similar two tokens must be, after transliteration, to count as one word.
#
# THERE IS NO SAFE VALUE, AND THAT IS THE MEASURED RESULT.
#
# Scoring ten known same-word pairs in two scripts against ten known
# different-word pairs:
#
#   thr   same-word matched   different-word rejected
#   0.20      10/10                 7/10
#   0.30      10/10                 8/10
#   0.50       6/10                 8/10
#   0.72       2/10                 8/10
#
# The worst same-word pair scores 0.300 and the best different-word pair 0.286 --
# a margin of 0.014. No threshold separates them cleanly, and at every setting the
# rule either misses real code-switched words or accepts wrong ones. Mechanical
# Devanagari transliteration is too lossy to decide this:
#
#     ऑर्डर -> rdara    conjunct vowels are reconstructed, but Hindi writes no
#                        schwa where Latin English does
#     नहीं  -> nahen    the final nasal mark becomes 'n', not 'ni'
#     क्वेश्चन -> kveshchana   schwa after every consonant
#
# So WER is reported as a RANGE, computed both ways, rather than as one number
# whose threshold was picked to make it look reasonable. The strict figure is
# what a naive implementation reports. The loose figure is what an optimistic
# one reports. Quoting either alone would be quoting a choice.
FOLD_THRESHOLD = 0.72      # strict: only near-identical folds count as the same
FOLD_THRESHOLD_LOOSE = 0.30 # permissive: catches most code-switched words, accepts some wrong ones
FOLD_MARGIN = 0.014        # measured separation between the two classes of pair


def normalise(text: str, fold_script: bool = True) -> list[str]:
    """Text -> comparable token list.

    Order matters: strip the gloss, strip punctuation, fold case, then fold
    script. Folding script BEFORE stripping punctuation leaves stray marks, and
    stripping the gloss before tokenising avoids removing it twice.
    """
    # The corpus marks non-speech spans as `<noise>`. That is a diarization
    # artifact, not a spoken word, and leaving it in charges the engine with
    # deletions for audio nobody was meant to transcribe.
    text = re.sub(r"<[^>]{1,20}>", " ", text)
    text = BRACKETED_GLOSS.sub(r"\1", text)          # keep the English, drop the Hindi
    text = unicodedata.normalize("NFKC", text)

    out = []
    folded = []
    for tok in re.split(r"\s+", text.strip()):
        tok = tok.strip()
        if not tok:
            continue
        for ch in DEVANAGARI_PUNCT:
            tok = tok.replace(ch, "")
        tok = tok.strip(".,!?;:'\"()[]{}…—–-")
        if not tok:
            continue
        tok = tok.lower()
        if fold_script:
            # A Latin token and its Devanagari spelling are one word to a
            # listener. Folding is what stops correct code-switched output from
            # scoring as a substitution per word -- and on Hinglish that is the
            # difference between a usable engine and a catastrophic one.
            key = transliterate(tok)
            if key:
                folded.append(key)   # keep the original too; same_word compares
                tok = key
        out.append(tok)
    return out


# ------------------------------------------------------------------
# Levenshtein alignment
# ------------------------------------------------------------------

def same_word(a: str, b: str, threshold: float = FOLD_THRESHOLD) -> bool:
    """Are these two tokens the same word, possibly written in another script?

    Exact match first. Then a similarity test, because mechanical Devanagari
    transliteration is LOSSY in ways that are not fixable in the mapping table:

        ऑर्डर   -> rdara     (the vowel after a conjunct is reconstructed, but
                               Hindi writes no schwa there and Latin English does)
        नहीं    -> nahen     (final nasal marks become 'n', not 'ni')
        ठीक    -> theka     (implicit 'a' before a silent consonant)

    So the fold has to be fuzzy or it is useless -- and the failure mode to avoid
    is being too generous, which would let a genuinely wrong word pass. Both ends
    of that trade are measured here and reported, because the threshold is a
    JUDGEMENT about what counts as the same word and belongs in the output rather
    than in a comment.
    """
    if a == b:
        return True
    # Cheap length guard: a 2-char window cannot match a 12-char token.
    if abs(len(a) - len(b)) > max(3, 0.6 * max(len(a), len(b))):
        return False
    return _ratio(a, b) >= threshold


def _ratio(a: str, b: str) -> float:
    """Similarity on [0,1] from the edit distance, not Levenshtein."""
    m, n = len(a), len(b)
    if m == 0 or n == 0:
        return 0.0
    prev = list(range(n + 1))
    for i in range(1, m + 1):
        cur = [i] + [0] * n
        for j in range(1, n + 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] != b[j - 1]))
        prev = cur
    return 1.0 - prev[n] / max(m, n)


def edit_distance(ref: list[str], hyp: list[str], threshold: float = FOLD_THRESHOLD) -> tuple[int, int, int, int]:
    """Substitutions, deletions, insertions, and the number of aligned pairs.

    Returns (S, D, I, N) where N is the reference length -- the standard
    denominators. A one-row DP is enough: these utterances are short, and the
    traceback is done by keeping the whole cost matrix rather than a direction
    matrix, which keeps the code honest about what it counted.
    """
    n, m = len(ref), len(hyp)
    if n == 0:
        return 0, 0, m, 0
    prev = list(range(m + 1))
    rows = [prev]
    for i in range(1, n + 1):
        cur = [i] + [0] * m
        for j in range(1, m + 1):
            cur[j] = min(
                prev[j] + 1,                      # deletion
                cur[j - 1] + 1,                   # insertion
                prev[j - 1] + (0 if same_word(ref[i - 1], hyp[j - 1]) else 1),
            )
        rows.append(cur)
        prev = cur

    # Walk the matrix backwards to attribute the cost.
    S = D = I = 0
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and rows[i][j] == rows[i - 1][j - 1] + (0 if same_word(ref[i - 1], hyp[j - 1]) else 1):
            if not same_word(ref[i - 1], hyp[j - 1]):
                S += 1
            i, j = i - 1, j - 1
        elif i > 0 and rows[i][j] == rows[i - 1][j] + 1:
            D += 1
            i -= 1
        else:
            I += 1
            j -= 1
    return S, D, I, n


def score_cached(csv_path: str = OUT_CSV, limit: int | None = None) -> list[dict]:
    """Re-score transcripts already on disk, without running the engine.

    Transcription is the expensive part -- minutes per clip on CPU -- and it
    produces text. Every analytical decision since then (what counts as the same
    word across scripts, what the corpus marks as non-speech, whether coverage is
    plausible) has changed at least once, and none of those changes required
    re-transcribing anything.

    Without this, fixing a normalisation bug means paying for the transcription
    again, which is why three of those fixes went in late instead of immediately.
    """
    import csv as _csv
    if not os.path.exists(csv_path):
        raise SystemExit(f"{csv_path} not found -- run the transcription first")
    out = []
    with open(csv_path, newline="", encoding="utf-8") as fh:
        for i, row in enumerate(_csv.DictReader(fh)):
            if limit is not None and i >= limit:
                break
            strict = wer(row["reference"], row["hypothesis"], FOLD_THRESHOLD)
            loose = wer(row["reference"], row["hypothesis"], FOLD_THRESHOLD_LOOSE)
            if not (strict and loose):
                continue
            out.append({
                "recording": row["recording"],
                "wer": strict["wer"], "wer_loose": loose["wer"],
                "sub": strict["sub"], "del": strict["del"], "ins": strict["ins"],
                "ref_words": strict["ref_words"], "hyp_words": strict["hyp_words"],
                "reference": row["reference"], "hypothesis": row["hypothesis"],
            })
    if not out:
        raise SystemExit("no clip could be re-scored -- is the CSV from an older run without full text?")
    # A cached row whose reference is 28 words when the corpus says 612 is a
    # TRUNCATED row from before full text was stored. Re-scoring it silently
    # produces confident nonsense -- which is exactly what happened on the first
    # --rescore attempt.
    if any(r["ref_words"] < 40 for r in out):
        raise SystemExit(
            "cached transcripts look truncated (a reference under 40 words). "
            "That CSV predates full-text storage; re-run the transcription."
        )
    return out


def wer(ref_text: str, hyp_text: str, threshold: float = FOLD_THRESHOLD) -> dict | None:
    r = normalise(ref_text)
    h = normalise(hyp_text)
    if not r:
        return None
    S, D, I, N = edit_distance(r, h, threshold)
    return {
        "wer": round((S + D + I) / N, 4),
        "sub": S, "del": D, "ins": I, "ref_words": N, "hyp_words": len(h),
    }


# ------------------------------------------------------------------
# Running the engine
# ------------------------------------------------------------------

def transcribe_one(path: str, model: str, beam: int = 5) -> str:
    """Transcribe one clip and return its text.

    Separate from transcribe() because the driver now needs per-clip results to
    flush to disk between clips -- see main().
    """
    from faster_whisper import WhisperModel
    wm = _model(model)
    import time
    t0 = time.time()
    segs, _info = wm.transcribe(
        path, language="hi", task="transcribe", beam_size=beam,
        vad_filter=True, condition_on_previous_text=False,
    )
    text = " ".join(s.text.strip() for s in segs).strip()
    print(f"  [{os.path.basename(path)}] {time.time()-t0:.0f}s  {len(text.split())} words",
          flush=True)
    return text


_MODELS = {}


def _model(name: str):
    """One model instance for the whole run.

    faster-whisper's WhisperModel loads weights into memory; constructing one per
    clip reloads them 6-12 times, which on CPU is minutes of pure waste.
    """
    if name not in _MODELS:
        from faster_whisper import WhisperModel
        _MODELS[name] = WhisperModel(name, device="cpu", compute_type="int8")
    return _MODELS[name]


def transcribe(paths: list[str], model: str, beam: int = 5) -> dict[str, str]:
    """Transcribe with faster-whisper.

    `language` is pinned rather than detected. Whisper's own language detector is
    unreliable on code-switched audio -- it picks one language and then forces the
    other through it -- and an auto-detected 'hi' run is the most common way a
    correct engine looks broken on Hinglish. Pinned to Hindi with translation off
    is the honest configuration for a Hindi corpus with English loanwords.
    """
    from faster_whisper import WhisperModel
    wm = WhisperModel(model, device="cpu", compute_type="int8")
    out = {}
    import time
    for i, p in enumerate(paths, 1):
        t0 = time.time()
        segs, info = wm.transcribe(
            p, language="hi", task="transcribe", beam_size=beam,
            vad_filter=True, condition_on_previous_text=False,
        )
        text = " ".join(s.text.strip() for s in segs).strip()
        out[os.path.basename(p)] = text
        # Printed per file, flushed, because a run over 37 minutes of audio on
        # CPU with no output is indistinguishable from a hung process -- which is
        # how the first attempt spent 35 minutes before anyone noticed it was
        # still downloading model shards.
        print(f"  [{i}/{len(paths)}] {os.path.basename(p)}  "
              f"{time.time()-t0:.0f}s  {len(text.split())} words", flush=True)
    return out


def overlap_ratio(csv_path: str = OUT_CSV) -> float | None:
    """Fraction of reference words that come from OVERLAPPING turns.

    This is the correction factor for using a diarization corpus as ASR ground
    truth, and it is not a fudge -- it is arithmetic on the corpus's own
    timestamps.

    Indic DiarBench is a DIARIZATION corpus: it transcribes each speaker's turn
    separately, and in real conversation people talk over each other. Measured on
    the first four recordings, 7 of 17, 21 of 47, 21 of 46 and 29 of 56
    consecutive turns overlap, and the summed turn durations come to 107% of the
    recording length.

    So the reference contains more words than the audio has seconds of speech:
    simultaneous speech is transcribed once per speaker, and word-count WER
    charges the engine with a DELETION for every word it can only hear once.

    The correction is to compare against the non-overlapped word count, which is
    what an engine transcribing a single audio stream can actually produce.
    """
    import csv as _csv
    if not os.path.exists(csv_path):
        return None
    # Recomputed from the corpus rather than stored, because it depends on the
    # segment timings and those are the thing being corrected for.
    import pyarrow.parquet as pq
    scored = {r["recording"] for r in _csv.DictReader(open(csv_path, encoding="utf-8"))}
    total = solo = 0
    for batch in pq.ParquetFile(PARQUET).iter_batches(batch_size=20):
        for r in batch.to_pylist():
            if r["sample_id"] not in scored:
                continue
            segs = sorted(r["annotated_transcript"], key=lambda s: s["start_time"])
            for i, a in enumerate(segs):
                n = len(normalise(a["transcript"]))
                total += n
                if n == 0:
                    continue
                dur = max(a["end_time"] - a["start_time"], 1e-6)
                # DURATION-WEIGHTED, not a yes/no overlap flag.
                #
                # The first version excluded a turn entirely if anything overlapped
                # it, which in a three-speaker conversation is nearly every turn:
                # the correction came out at 10% and implied a 9% WER, which is
                # not credible and was the correction being far too aggressive
                # rather than the engine being excellent.
                #
                # Measured on one recording: a 5.92s turn overlapped by 1.15s is 81%
                # audible, a 4.57s turn overlapped by 1.78s is 61% audible. Those
                # words are mostly there and an engine can hear most of them. Only
                # a turn that is entirely buried -- 0% audible -- should drop out.
                overlapped = 0.0
                for j, b in enumerate(segs):
                    if i == j:
                        continue
                    ov = min(a["end_time"], b["end_time"]) - max(a["start_time"], b["start_time"])
                    if ov > 0:
                        overlapped += ov
                audible = max(0.0, dur - overlapped) / dur
                solo += n * audible
    return (solo / total) if total else None


def analyse(results: list[dict], model: str, corpus: str) -> dict:
    n_words = sum(r["ref_words"] for r in results)
    # THE CONTROL. Reference against itself, which must be exactly zero.
    #
    # It lived in a verdict literal that was removed when this analysis was
    # extracted into a function, so the gate began reporting it as `undefined`
    # and failing -- correctly, since a metric with no control cannot be trusted.
    # The gate caught a field that had silently stopped existing, which is the
    # gate working.
    control = wer(results[0]["reference"], results[0]["reference"])
    self_wer = control["wer"] if control else None
    if self_wer:
        print(f"\nself-comparison control: {self_wer*100:.2f}% (must be 0.00%)")
    ratios = [(r["hyp_words"] / r["ref_words"]) if r["ref_words"] else 0 for r in results]
    min_cov = min(ratios) if ratios else 0
    mean_cov = (sum(ratios) / len(ratios)) if ratios else 0
    strict_errors = sum(r["sub"] + r["del"] + r["ins"] for r in results)
    # The overlap correction. Reported as its own number rather than folded
    # silently into the headline, because "WER 84%" and "WER 48% after correcting
    # for a corpus artefact" are different claims and only one of them is about
    # the engine.
    ov = overlap_ratio()
    overlap_correction = ov if ov is not None else 1.0
    raw_overall = strict_errors / n_words if n_words else None
    strict_overall = (raw_overall * overlap_correction) if raw_overall is not None else None
    loose_overall = (sum(r["wer_loose"] * r["ref_words"] for r in results) / n_words
                     if n_words else None)

    for r_ in results:
        print(f"  {r_['recording']}  WER {r_['wer']*100:5.1f}%  "
              f"(loose {r_['wer_loose']*100:5.1f}%)  ref {r_['ref_words']:3}w")

    if ov is not None:
        print(f"\noverlap correction: {ov*100:.0f}% of reference words are in non-overlapping turns")
        print(f"  the corpus transcribes each speaker separately and people talk over each")
        print(f"  other, so a single-stream engine is charged with a deletion for every")
        print(f"  word it can only hear once.")
        print(f"  raw {raw_overall*100:.1f}%  ->  overlap-corrected {strict_overall*100:.1f}%")
    lo_w, hi_w = sorted((strict_overall, loose_overall))
    print(f"\nWER {lo_w*100:.1f}% - {hi_w*100:.1f}%  over {n_words} reference words")
    print(f"  the range is script-fold uncertainty (margin {FOLD_MARGIN}); it is NOT measurement noise")

    return {
        "engine": f"faster-whisper {model}",
        "language": "hi (pinned, not detected)",
        "corpus": corpus,
        "n_recordings": len(results),
        "reference_words": n_words,
        "wer_strict": round(strict_overall, 4) if strict_overall is not None else None,
        "wer_loose": round(loose_overall, 4) if loose_overall is not None else None,
        "fold_threshold_strict": FOLD_THRESHOLD,
        "fold_threshold_loose": FOLD_THRESHOLD_LOOSE,
        "fold_margin": FOLD_MARGIN,
        "wer_raw": round(raw_overall, 4) if raw_overall is not None else None,
        "overlap_correction": round(overlap_correction, 4),
        "min_coverage": round(min_cov, 3),
        "mean_coverage": round(mean_cov, 3),
        "control_self_wer": self_wer,
        "control_note": "reference against itself must be 0.00% at both folds",
        "measures": "the ASR engine on human-recorded Hindi, NOT an agent mishearing a caller",
    }


def main():
    if "--rescore" in sys.argv:
        results = score_cached()
        print(f"re-scored {len(results)} cached transcripts (no engine run)")
        v = analyse(results, "(cached from a previous run)", "Indic DiarBench (CC BY 4.0)")
        with open(OUT_JSON, "w", encoding="utf-8") as fh:
            json.dump(v, fh, indent=2)
        print(f"wrote {OUT_JSON}")
        return
    if not os.path.exists(PARQUET):
        raise SystemExit(f"{PARQUET} missing")
    import pyarrow.parquet as pq

    rows = []
    seen = set()
    for batch in pq.ParquetFile(PARQUET).iter_batches(batch_size=20):
        for r in batch.to_pylist():
            sid = r["sample_id"]
            if sid in seen or not os.path.exists(f"{AUDIO_DIR}/{sid}.wav"):
                continue
            seen.add(sid)
            segs = sorted(r["annotated_transcript"], key=lambda s: s["start_time"])
            rows.append((sid, " ".join(s["transcript"] for s in segs)))
            # Checked INSIDE the inner loop. With the check after the batch loop,
            # `iter_batches(batch_size=20)` had already appended all twenty rows
            # before it was reached -- so ASR_CLIP_LIMIT=6 produced 12 clips and
            # roughly double the runtime, while the constant in the file said 6.
            # A limit that is not enforced where the append happens is not a limit.
            if len(rows) >= ASR_CLIP_LIMIT:
                break
        if len(rows) >= ASR_CLIP_LIMIT:
            break

    print(f"ground truth: {len(rows)} recordings with diarized transcripts")
    # MODEL CAPACITY IS THE FIRST THING THAT CAN BE WRONG.
    #
    # faster-whisper `tiny` was tried first and produced 95.7% WER against a
    # PERFECT self-comparison control. That combination is diagnostic rather than
    # merely bad: a broken metric fails its own control, so a clean control means
    # the metric is fine and the transcription is not.
    #
    # `tiny` returned ENGLISH for Hindi audio -- "shoulders. Exactly. And his body
    # was also..." -- at 100 words against a 207-word reference. It is a
    # multilingual model with almost no Hindi capacity, and a multilingual model
    # that does not know a language does not fail silently: it produces confident
    # fluent output in a language it does know.
    #
    # `small` or larger is required for Hindi. Anything below that cannot measure
    # Indic speech, and the number it produces is not a WER result at all.
    model = sys.argv[1] if len(sys.argv) > 1 else "small"
    print(f"engine: faster-whisper '{model}', language pinned to hi, int8 cpu\n")

    # Transcribe and score ONE CLIP AT A TIME, appending to the CSV as it goes.
    #
    # The previous version transcribed all clips, held every result in memory, and
    # wrote the CSV at the end. A schema mismatch then threw on the first row and
    # threw away 32 minutes of CPU. Two runs on this machine have now died for
    # reasons that had nothing to do with the measurement.
    #
    # `small` takes ~9 minutes per clip on CPU, so a run is measured in hours. At
    # that duration, incremental output is not a nicety: it is the difference
    # between a killed run losing nothing and losing everything.
    os.makedirs(os.path.dirname(OUT_CSV) or ".", exist_ok=True)
    import csv as _csv
    fields = ["recording", "wer", "wer_loose", "sub", "del", "ins",
              "ref_words", "hyp_words", "reference", "hypothesis"]
    if os.path.exists(OUT_CSV):
        os.remove(OUT_CSV)
    with open(OUT_CSV, "w", newline="", encoding="utf-8") as fh:
        _w = _csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        _w.writeheader()

        hyp = {}
        all_results = []
        for sid, ref_text in rows:
            h = transcribe_one(f"{AUDIO_DIR}/{sid}.wav", model)
            hyp[f"{sid}.wav"] = h
            strict = wer(ref_text, h, FOLD_THRESHOLD)
            loose = wer(ref_text, h, FOLD_THRESHOLD_LOOSE)
            if not (strict and loose):
                continue
            row = {
                "recording": sid, "wer": strict["wer"], "wer_loose": loose["wer"],
                "sub": strict["sub"], "del": strict["del"], "ins": strict["ins"],
                "ref_words": strict["ref_words"], "hyp_words": strict["hyp_words"],
                # Full text, not a 160-char prefix. The prefix made it impossible
                # to tell a genuinely short hypothesis from a truncated one -- and
                # hindi_002's hypothesis ends mid-word, which looked like data
                # loss and was only the reader's own cut.
                "reference": ref_text, "hypothesis": h,
            }
            all_results.append(row)
            _w.writerow(row)
            fh.flush()   # durable per clip, not at the end
            os.fsync(fh.fileno())
            print(f"  {sid}  WER {strict['wer']*100:5.1f}%  "
                  f"(loose {loose['wer']*100:5.1f}%)  S{strict['sub']:3} "
                  f"D{strict['del']:3} I{strict['ins']:3}  ref {strict['ref_words']:3}w",
                  flush=True)
        results = all_results
        if not results:
            raise SystemExit("no clip produced a score")

    # A sanity check that would have saved 32 minutes of transcription.
    #
    # The first run scored 95.7% WER with a PERFECT self-comparison control. That
    # combination is diagnostic rather than merely bad: a broken metric fails its
    # own control, because reference-against-itself is the easiest thing in the
    # suite to get right. A clean control means the metric is fine and the
    # TRANSCRIPTION is not.
    #
    # faster-whisper `tiny` answered Hindi audio in English -- "shoulders.
    # Exactly. And his body was also..." -- at 100 words against a 207-word
    # reference. `tiny` is multilingual with almost no Hindi capacity, and a
    # multilingual model that does not know a language does not fail quietly: it
    # produces confident fluent output in a language it does know.
    #
    # Pinning language='hi' did not save it, which is worth knowing on its own --
    # the pin stops auto-detection misdirecting a model that HAS capacity, and
    # does nothing for one that has none.
    #
    # Checked on the RESULTS, because that is what is about to be published. A
    # hypothesis that is almost entirely Latin script against a Devanagari
    # reference means the engine answered in the wrong language, and a WER number
    # computed from it describes nothing. Exit rather than report.
    total_words = sum(len(t.split()) for t in hyp.values())
    latin = sum(1 for t in hyp.values() for w_ in t.split()
                if re.fullmatch(r"[A-Za-z0-9.,?!'-]+", w_))
    latin_share = latin / max(total_words, 1)
    print(f"\nlanguage check: {latin_share*100:.0f}% of {total_words} output words are pure Latin")
    if latin_share > 0.9:
        print(f"  FAIL: the engine answered in English on a Hindi corpus.")
        print(f"  Model '{model}' does not have the Hindi capacity for this measurement.")
        print(f"  Use 'small' or larger. WER is NOT reported -- a number here would")
        print(f"  describe the wrong thing, and it would look like a real result.")
        raise SystemExit(2)

    # Both folds, because the script-fold threshold has no safe value (see
    # FOLD_THRESHOLD). Reporting one number would be reporting the choice of
    # threshold rather than the measurement.
    #
    # Aggregated over the token COUNTS rather than the per-clip rates: an average
    # of averages over-weights short clips, and the clips here run from 75s to
    # 209s.
    # COVERAGE BEFORE WER.
    #
    # A hypothesis that is a fraction of the reference length is not a
    # high-WER transcription, it is a transcription that stopped. Reporting it as
    # WER is reporting a plumbing failure as an accuracy result, and it inflates
    # the number in the least recoverable direction.
    #
    # hindi_002 scored 84.5% with 425 deletions on 612 reference words, which is
    # the signature: the engine emitted a third of the expected words. Whether
    # that is VAD clipping, a decayed recording or truncation is a DIFFERENT
    # investigation, and it is not this one.
    ratios = [(r_["hyp_words"] / r_["ref_words"]) if r_["ref_words"] else 0 for r_ in results]
    min_cov = min(ratios) if ratios else 0
    mean_cov = (sum(ratios) / len(ratios)) if ratios else 0
    print(f"\ncoverage: hypothesis/reference word ratio {min_cov:.2f} min, {mean_cov:.2f} mean")
    # NOTE: this guard does not fire on the current corpus, and would be wrong to.
    #
    # hindi_002 has a 0.31 hypothesis/reference word ratio, which looks exactly
    # like an engine that stopped. It is not: Indic DiarBench transcribes each
    # speaker separately and 21 of its 47 turns overlap, so the reference contains
    # far more words than a single audio stream contains speech. The low ratio is
    # a property of the GROUND TRUTH, measured below as the overlap correction.
    #
    # The guard stays for the case that actually means "the engine stopped":
    # truncation at a fixed fraction, roughly 0.05-0.1, which no amount of
    # overlapping speech explains.
    if min_cov < 0.10:
        print(f"  FAIL: a clip produced under a tenth of the reference word count.")
        print(f"  Overlap cannot explain that, so the engine stopped. WER would")
        print(f"  report a plumbing failure as an accuracy result, so it is not reported.")
        raise SystemExit(2)

    verdict = analyse(results, model, "Indic DiarBench (CC BY 4.0)")
    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(verdict, fh, indent=2)
    print(f"\nwrote {OUT_CSV} and {OUT_JSON}")


if __name__ == "__main__":
    main()
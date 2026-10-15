"""
Run NISQA-TTS over data/voice_probe and write the scores to a CSV.

Kept as a file rather than an ad-hoc command because the audit is only worth
anything if it can be re-run, and the two things that make it runnable are easy
to get wrong: NISQA's data args are in SECONDS, and this machine leaks PYTHONPATH
from Hermes' own environment into any venv it spawns.

    VIRTUAL_ENV= PYTHONPATH= PYTHONHOME= .venv-nisqa\\Scripts\\python.exe -E \
        tools/nisqa_score.py [output_csv]

Without -E the venv silently loads the host numpy 2.4 and torch 2.2.1 dies on
import, which looks exactly like a broken package.
"""

import os
import sys
import warnings

warnings.filterwarnings("ignore")


def collect(patterns):
    """Resolve the wavs to score, explicitly.

    NISQA's own predict_dir mode globs every *.wav in the folder, which quietly
    scored a leftover _tmp_en.wav from an aborted English-control attempt as
    though it were data. An explicit list means the CSV corresponds exactly to
    what was asked for -- a stray file cannot appear in a result nobody put
    there, which is the same discipline the release gate follows.
    """
    import glob
    files = []
    for pat in patterns:
        files.extend(sorted(glob.glob(pat)))
    return [f for f in files if not os.path.basename(f).startswith("_")]


def main(out="data/voice_probe/NISQA_results.csv", *patterns):
    from nisqa.NISQA_model import nisqaModel

    args = {
        "mode": "predict_dir",
        "data_dir": "data/voice_probe",
        "output_dir": "data/voice_probe",
        "pretrained_model": os.path.abspath("models/nisqa_tts.tar"),
        "tr_parallel": False,
        "tr_num_workers": 0,
        # Audio geometry. ms_hop_length and ms_win_length are SECONDS -- NISQA_lib
        # multiplies them by the sample rate. Passing 1024 asks for a
        # 1024-second window and librosa correctly rejects it.
        "ms_channel": 1,
        "ms_sr": 16000,
        "ms_seg_length": 15,
        "ms_seg_hop_length": 15,
        "ms_n_mels": 48,
        "ms_n_fft": 1024,
        "ms_hop_length": 0.01,
        "ms_win_length": 0.04,
        "ms_fmax": 8000,
        "ms_max_segments": 3150,
        "deg": "nisqa_dim",
    }
    model = nisqaModel(args)

    if patterns:
        # Use NISQA's own predict_mos rather than reimplementing the forward pass.
        # The first attempt called model.model(xb, n_wins) directly, which
        # skipped the per-window pooling the library does -- the score came out
        # differently from predict_dir's, so a result would have depended on WHICH
        # code path produced it. One predictor, used everywhere.
        import pandas as pd
        from nisqa import NISQA_lib as NL

        files = collect(patterns)
        if not files:
            raise SystemExit(f"no wavs matched {patterns}")
        model.ds_val.df = pd.DataFrame({"deg": [os.path.basename(f) for f in files]})
        model.args["output_dir"] = None      # keep predict() from rewriting CSV

        y_hat, y_true = NL.predict_mos(
            model.model, model.ds_val, 4, model.dev, num_workers=0
        )
        # predict_mos returns flat 1-D arrays of length n (one scalar per clip),
        # not (n,1) column vectors -- so float(v) is right and float(v[0][0])
        # raises IndexError.
        preds = [float(v) for v in y_hat]
        df = pd.DataFrame({"deg": [os.path.basename(f) for f in files], "mos_pred": preds})
    else:
        df = model.predict()

    df.to_csv(out, index=False)
    print(f"scored {len(df)} clips -> {out}")


if __name__ == "__main__":
    main(*sys.argv[1:])

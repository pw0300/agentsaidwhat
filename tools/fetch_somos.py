"""
Fetch SOMOS without the corruption that a naive retry produces.

WHY THIS SCRIPT EXISTS

The first attempt at this download produced a corrupt archive that looked fine:
4,007,040,200 bytes against a content-length of 3,971,669,902, a valid PK\\x03\\x04
header at byte 0, and an End Of Central Directory record -- at 1.98 GB, which is
nowhere near the end. Two `curl -C -` processes were writing the same file at
once, because an earlier foreground call timed out without killing its child and
the retry started a second writer. They interleaved at byte granularity: walking
the local file headers, entry 1 spans 3.96 GB and entry 2 does not exist.

That is worth writing down rather than re-discovering, because every symptom
points somewhere else. The header is valid. The size is wrong in the direction
that means "more data", which reads like a successful download. `zipfile` reports
"File is not a zip file", which reads like the wrong URL.

THE RULE

One writer, ever. Download to `NAME.part`, verify the length against the server,
and only then rename into place. If a download is interrupted, delete the partial
rather than resuming -- a resume is only safe when nothing else is writing, and
that is not checkable from inside curl.

    python tools/fetch_somos.py
"""

import os
import sys
import time
import urllib.request

URL = "https://zenodo.org/records/7378801/files/somos.zip?download=1"
DEST = "data/somos.zip"
PART = "data/somos.zip.part"


def remote_size():
    req = urllib.request.Request(URL, method="HEAD")
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers["Content-Length"])


def download():
    expected = remote_size()
    print(f"remote size: {expected:,} bytes ({expected/1e9:.2f} GB)")

    # A partial from a previous interrupted run is the exact thing that produced
    # the corrupt archive. Start clean.
    for p in (PART, DEST):
        if os.path.exists(p):
            os.remove(p)

    total = 0
    start = time.time()
    with urllib.request.urlopen(URL, timeout=120) as r, open(PART, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            total += len(chunk)
            if total % (200 << 20) < (1 << 20):
                pct = total / expected * 100
                rate = total / max(time.time() - start, 1) / 1e6
                print(f"  {pct:5.1f}%  {total/1e9:.2f} GB  {rate:.1f} MB/s", flush=True)

    got = os.path.getsize(PART)
    if got != expected:
        raise SystemExit(
            f"LENGTH MISMATCH: got {got:,}, expected {expected:,}. "
            f"Deleting {PART} rather than resuming -- see the module docstring."
        )

    os.replace(PART, DEST)
    print(f"\nOK  {got:,} bytes -> {DEST}")

    # Cheap structural proof before anyone tries to unzip it.
    import zipfile
    if not zipfile.is_zipfile(DEST):
        raise SystemExit(f"{DEST} is not a valid zip despite the correct length")
    z = zipfile.ZipFile(DEST)
    print(f"entries: {len(z.namelist())}")
    bad = z.testzip() if len(z.namelist()) < 50 else None
    if bad:
        print(f"first corrupt entry: {bad}")
    else:
        print("central directory reads cleanly")


if __name__ == "__main__":
    try:
        download()
    except KeyboardInterrupt:
        if os.path.exists(PART):
            os.remove(PART)
        print(f"\ninterrupted; removed {PART}")
        sys.exit(1)
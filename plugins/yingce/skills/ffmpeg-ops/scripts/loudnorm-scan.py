#!/usr/bin/env python3
"""Two-pass EBU R128 loudness: run the measurement pass, emit the exact pass-2 filter.

One-pass loudnorm runs in dynamic mode (pumps quiet passages). Proper linear
normalization needs the measured values fed back in — this script runs pass 1,
parses loudnorm's JSON report off stderr, and prints the ready-to-paste pass-2
filter string (and full command), so the agent never re-derives the dance.

Usage:   loudnorm-scan.py [-I LUFS] [--tp dBTP] [--lra LU] [--json] <file>
Input:   one media file with an audio stream
Output:  stdout = measured values + pass-2 filter (or --json envelope,
         schema claude-mods.ffmpeg-ops.loudnorm/v1)
Stderr:  progress, errors
Exit:    0 ok, 2 usage, 3 file not found, 4 no audio / parse failure,
         5 ffmpeg missing

Targets: -14 streaming platforms, -16 podcasts (default), -23 EBU R128 broadcast.

Examples:
  loudnorm-scan.py podcast.wav
  loudnorm-scan.py -I -14 --json music.mp4 | jq -r '.data.pass2_filter'
  loudnorm-scan.py -I -23 --tp -2 --lra 7 broadcast.mov
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

SCHEMA = "claude-mods.ffmpeg-ops.loudnorm/v1"
EXIT_OK, EXIT_USAGE, EXIT_NOT_FOUND, EXIT_VALIDATION, EXIT_MISSING_DEP = 0, 2, 3, 4, 5


def err(json_mode: bool, code: str, message: str, exit_code: int) -> NoReturn:
    if json_mode:
        print(json.dumps({"error": {"code": code, "message": message, "details": {}}}))
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(exit_code)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Measure loudness (pass 1) and emit the exact pass-2 loudnorm filter.",
        epilog="Examples:\n"
               "  loudnorm-scan.py podcast.wav\n"
               "  loudnorm-scan.py -I -14 --json music.mp4 | jq -r '.data.pass2_filter'\n",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="media file with an audio stream")
    ap.add_argument("-I", "--target-i", type=float, default=-16.0,
                    help="integrated loudness target, LUFS (default -16)")
    ap.add_argument("--tp", type=float, default=-1.5,
                    help="true-peak ceiling, dBTP (default -1.5)")
    ap.add_argument("--lra", type=float, default=11.0,
                    help="loudness range target, LU (default 11)")
    ap.add_argument("--json", action="store_true", help="emit JSON envelope on stdout")
    args = ap.parse_args()

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        err(args.json, "MISSING_DEPENDENCY",
            "ffmpeg not found on PATH", EXIT_MISSING_DEP)

    path = Path(args.file)
    if not path.is_file():
        err(args.json, "NOT_FOUND", f"file not found: {path}", EXIT_NOT_FOUND)

    base = f"I={args.target_i:g}:TP={args.tp:g}:LRA={args.lra:g}"
    print(f"measuring loudness of {path.name} (pass 1)...", file=sys.stderr)
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-nostats", "-i", str(path),
         "-af", f"loudnorm={base}:print_format=json", "-f", "null", "-"],
        capture_output=True, text=True)

    # loudnorm prints its JSON report as the last {...} block on stderr.
    stderr = proc.stderr or ""
    start, end = stderr.rfind("{"), stderr.rfind("}")
    if proc.returncode != 0 or start == -1 or end <= start:
        detail = stderr.strip().splitlines()[-1] if stderr.strip() else "no detail"
        err(args.json, "VALIDATION",
            f"loudnorm measurement failed (no audio stream?): {detail}",
            EXIT_VALIDATION)
    try:
        m = json.loads(stderr[start:end + 1])
    except json.JSONDecodeError:
        err(args.json, "VALIDATION", "could not parse loudnorm JSON report",
            EXIT_VALIDATION)

    pass2_filter = (
        f"loudnorm={base}"
        f":measured_I={m['input_i']}:measured_TP={m['input_tp']}"
        f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}"
        f":offset={m['target_offset']}:linear=true"
    )
    # loudnorm internally resamples to 192 kHz — the -ar 48000 puts it back.
    pass2_command = (f'ffmpeg -y -i "{path}" -af "{pass2_filter}" -ar 48000 '
                     f'-c:v copy "{path.stem}.normalized{path.suffix}"')

    data = {
        "file": str(path),
        "target": {"I": args.target_i, "TP": args.tp, "LRA": args.lra},
        "measured": {
            "input_i": float(m["input_i"]),
            "input_tp": float(m["input_tp"]),
            "input_lra": float(m["input_lra"]),
            "input_thresh": float(m["input_thresh"]),
            "target_offset": float(m["target_offset"]),
        },
        "normalization_mode": m.get("normalization_type", ""),
        "pass2_filter": pass2_filter,
        "pass2_command": pass2_command,
    }

    if args.json:
        print(json.dumps({"data": data, "meta": {"schema": SCHEMA}}, indent=2))
    else:
        print(f"measured   I={m['input_i']} LUFS  TP={m['input_tp']} dBTP  "
              f"LRA={m['input_lra']} LU  thresh={m['input_thresh']}")
        print(f"target     I={args.target_i:g} TP={args.tp:g} LRA={args.lra:g}")
        print(f"pass2      {pass2_filter}")
        print(f"command    {pass2_command}")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

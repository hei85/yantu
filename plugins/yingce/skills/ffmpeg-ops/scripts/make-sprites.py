#!/usr/bin/env python3
"""Scrub-preview sprites + WebVTT thumbnail track for web players.

Renders tiled sprite sheets at a fixed interval and writes the thumbs.vtt that
maps each time range to its sprite region (#xywh media fragments) — the format
Video.js / JW Player / Plyr / hls.js preview plugins consume. The geometry math
(page, row, column per thumb) is exactly the part worth never re-deriving.

Usage:   make-sprites.py [--interval S] [--width PX] [--cols N] [--rows N]
                         [--out-dir DIR] [--json] <media>
Input:   one video file as positional
Output:  stdout = written file list (or --json envelope,
         schema claude-mods.ffmpeg-ops.sprites/v1)
Stderr:  progress, errors
Exit:    0 ok, 2 usage, 3 file not found, 4 probe/render failure, 5 ffmpeg missing

Examples:
  make-sprites.py --interval 5 video.mp4
  make-sprites.py --interval 10 --width 240 --out-dir previews/ lecture.mp4
  make-sprites.py --json video.mp4 | jq -r '.data.vtt'
"""

import argparse
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

SCHEMA = "claude-mods.ffmpeg-ops.sprites/v1"
EXIT_OK, EXIT_USAGE, EXIT_NOT_FOUND, EXIT_VALIDATION, EXIT_MISSING_DEP = 0, 2, 3, 4, 5


def err(json_mode: bool, code: str, message: str, exit_code: int) -> NoReturn:
    if json_mode:
        print(json.dumps({"error": {"code": code, "message": message, "details": {}}}))
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(exit_code)


def probe(ffprobe: str, path: Path) -> dict:
    # Full -show_streams, not selective -show_entries: the rotation side data
    # (side_data_list) is silently omitted by entry-filtered queries on some
    # ffprobe versions, which made rotated sources produce squashed thumbs.
    proc = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-print_format", "json",
         "-show_streams", "-show_format", str(path)],
        capture_output=True, text=True)
    if proc.returncode != 0:
        return {}
    raw = json.loads(proc.stdout)
    streams = raw.get("streams", [])
    if not streams:
        return {}
    s = streams[0]
    rotation = 0
    for sd in s.get("side_data_list", []) or []:
        try:
            rotation = int(sd.get("rotation", 0)) % 360
        except (TypeError, ValueError):
            pass
    w, h = s.get("width", 0), s.get("height", 0)
    if rotation in (90, 270):       # ffmpeg autorotates on decode; sprites show display dims
        w, h = h, w
    return {"width": w, "height": h,
            "duration": float(raw.get("format", {}).get("duration", 0) or 0)}


def ts(seconds: float) -> str:
    h, rem = divmod(int(seconds), 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}.{int(round((seconds % 1) * 1000)):03d}"


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Sprite sheets + WebVTT thumbnail track for player scrub previews.",
        epilog="Examples:\n"
               "  make-sprites.py --interval 5 video.mp4\n"
               "  make-sprites.py --interval 10 --width 240 --out-dir previews/ in.mp4\n",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="video file")
    ap.add_argument("--interval", type=float, default=5.0,
                    help="seconds per thumbnail (default 5)")
    ap.add_argument("--width", type=int, default=160,
                    help="thumbnail width in px (default 160)")
    ap.add_argument("--cols", type=int, default=10, help="grid columns (default 10)")
    ap.add_argument("--rows", type=int, default=10, help="grid rows (default 10)")
    ap.add_argument("--out-dir", default="sprites", help="output dir (default ./sprites)")
    ap.add_argument("--json", action="store_true", help="emit JSON envelope on stdout")
    args = ap.parse_args()

    if args.interval <= 0 or args.width < 16 or args.cols < 1 or args.rows < 1:
        err(args.json, "USAGE", "interval/width/cols/rows out of range", EXIT_USAGE)

    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        err(args.json, "MISSING_DEPENDENCY", "ffmpeg/ffprobe not found on PATH",
            EXIT_MISSING_DEP)
    path = Path(args.file)
    if not path.is_file():
        err(args.json, "NOT_FOUND", f"file not found: {path}", EXIT_NOT_FOUND)

    info = probe(ffprobe, path)
    if not info or not info["width"] or info["duration"] <= 0:
        err(args.json, "VALIDATION", "no probeable video stream/duration",
            EXIT_VALIDATION)

    # Explicit even thumb height so our geometry and ffmpeg's agree exactly.
    tw = args.width // 2 * 2
    th = max(2, round(tw * info["height"] / info["width"] / 2) * 2)
    per_page = args.cols * args.rows
    n_thumbs = max(1, math.ceil(info["duration"] / args.interval))
    n_pages = math.ceil(n_thumbs / per_page)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"{n_thumbs} thumbs ({tw}x{th}) on {n_pages} sheet(s)...", file=sys.stderr)

    proc = subprocess.run(
        [ffmpeg, "-y", "-v", "error", "-i", str(path.resolve()),
         "-vf", f"fps=1/{args.interval},scale={tw}:{th},tile={args.cols}x{args.rows}",
         "-q:v", "3", "sprite_%02d.jpg"],
        capture_output=True, text=True, cwd=str(out_dir))
    if proc.returncode != 0:
        err(args.json, "VALIDATION",
            f"sprite render failed: {(proc.stderr.strip().splitlines() or ['?'])[-1]}",
            EXIT_VALIDATION)
    sheets = sorted(out_dir.glob("sprite_*.jpg"))

    lines = ["WEBVTT", ""]
    for i in range(n_thumbs):
        t0 = i * args.interval
        t1 = min((i + 1) * args.interval, info["duration"])
        page = i // per_page + 1
        idx = i % per_page
        x, y = (idx % args.cols) * tw, (idx // args.cols) * th
        lines += [f"{ts(t0)} --> {ts(t1)}",
                  f"sprite_{page:02d}.jpg#xywh={x},{y},{tw},{th}", ""]
    vtt = out_dir / "thumbs.vtt"
    vtt.write_text("\n".join(lines), encoding="utf-8")

    data = {"media": str(path), "thumbs": n_thumbs, "thumb_size": [tw, th],
            "grid": [args.cols, args.rows], "interval_s": args.interval,
            "sheets": [str(p) for p in sheets], "vtt": str(vtt)}
    if args.json:
        print(json.dumps({"data": data, "meta": {"schema": SCHEMA}}, indent=2))
    else:
        for p in [*sheets, vtt]:
            print(p)
    print(f"done: point the player's thumbnail track at {vtt.name} "
          f"(URLs resolve relative to the VTT)", file=sys.stderr)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

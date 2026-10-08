#!/usr/bin/env python3
"""Target-size compression: 'make this fit in 25MB' as one verified command.

Computes the video bitrate from the size budget (duration-aware, audio and mux
overhead subtracted), auto-selects an audio bitrate and a downscale rung when
the bits-per-pixel would be hopeless at source resolution, runs a two-pass
encode (predictable size, unlike CRF), and VERIFIES the result actually landed
under the cap — retrying once at -8% if not.

Usage:   smart-compress.py --target SIZE [-o OUT] [--codec x264|x265]
                           [--preset P] [--no-downscale] [--json] <file>
Input:   one media file as positional; SIZE like 25MB, 8M, 512KB, 1.5GB
Output:  stdout = result line (or --json envelope,
         schema claude-mods.ffmpeg-ops.compress/v1)
Stderr:  progress, plan explanation, errors
Exit:    0 ok and under target, 2 usage, 3 input missing, 4 encode failure,
         5 ffmpeg missing, 10 best effort still OVER target (kept, caller decides)

Examples:
  smart-compress.py --target 25MB video.mp4                 # Discord/email cap
  smart-compress.py --target 8MB -o clip_small.mp4 clip.mov
  smart-compress.py --target 50MB --codec x265 lecture.mp4
  smart-compress.py --target 10MB --json in.mp4 | jq '.data.final_bytes'
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import NoReturn, Optional

SCHEMA = "claude-mods.ffmpeg-ops.compress/v1"
EXIT_OK, EXIT_USAGE, EXIT_NOT_FOUND, EXIT_VALIDATION = 0, 2, 3, 4
EXIT_MISSING_DEP, EXIT_OVER_TARGET = 5, 10

MUX_OVERHEAD = 0.98          # reserve 2% of the budget for container overhead
DOWNSCALE_LADDER = [1080, 720, 540, 360, 270]
MIN_BPP = 0.045              # below this bits-per-pixel, downscale instead


def err(json_mode: bool, code: str, message: str, exit_code: int) -> NoReturn:
    if json_mode:
        print(json.dumps({"error": {"code": code, "message": message, "details": {}}}))
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(exit_code)


def parse_size(s: str) -> Optional[int]:
    m = re.fullmatch(r"([\d.]+)\s*([KMG]i?B?|B)?", s.strip(), re.IGNORECASE)
    if not m:
        return None
    mult = {"": 1, "B": 1, "K": 1000, "M": 1000**2, "G": 1000**3,
            "KI": 1024, "MI": 1024**2, "GI": 1024**3}
    unit = (m.group(2) or "").upper().rstrip("B")
    try:
        return int(float(m.group(1)) * mult[unit])
    except (KeyError, ValueError):
        return None


def probe(ffprobe: str, path: Path) -> dict:
    proc = subprocess.run(
        [ffprobe, "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True)
    if proc.returncode != 0:
        return {}
    raw = json.loads(proc.stdout)
    out = {"duration": float(raw.get("format", {}).get("duration", 0) or 0),
           "size": int(raw.get("format", {}).get("size", 0) or 0),
           "width": 0, "height": 0, "fps": 30.0, "has_audio": False}
    for s in raw.get("streams", []):
        if s.get("codec_type") == "video" and not out["width"]:
            out["width"], out["height"] = s.get("width", 0), s.get("height", 0)
            try:
                num, den = s.get("avg_frame_rate", "30/1").split("/")
                out["fps"] = (int(num) / int(den)) if int(den) else 30.0
            except (ValueError, ZeroDivisionError):
                pass
        elif s.get("codec_type") == "audio":
            out["has_audio"] = True
    return out


def plan_encode(info: dict, target_bytes: int, allow_downscale: bool) -> dict:
    budget_kbps = (target_bytes * 8 / 1000) / info["duration"] * MUX_OVERHEAD
    # Audio gets ~12% of the budget, clamped to sane speech/music rates.
    audio_kbps = int(min(160, max(48, budget_kbps * 0.12))) if info["has_audio"] else 0
    video_kbps = budget_kbps - audio_kbps
    w, h, fps = info["width"], info["height"], info["fps"] or 30.0
    scaled_h = None
    if allow_downscale and w and h:
        bpp = video_kbps * 1000 / (w * h * fps)
        if bpp < MIN_BPP:
            for rung in DOWNSCALE_LADDER:
                if rung >= h:
                    continue
                rw = w * rung / h
                if video_kbps * 1000 / (rw * rung * fps) >= MIN_BPP:
                    scaled_h = rung
                    break
            else:
                scaled_h = DOWNSCALE_LADDER[-1] if h > DOWNSCALE_LADDER[-1] else None
    return {"video_kbps": int(video_kbps), "audio_kbps": audio_kbps,
            "scale_height": scaled_h}


def two_pass(ffmpeg: str, path: Path, out: Path, plan: dict, codec: str,
             preset: str, json_mode: bool) -> None:
    enc = {"x264": "libx264", "x265": "libx265"}[codec]
    vf = ["-vf", f"scale=-2:{plan['scale_height']}"] if plan["scale_height"] else []
    audio = (["-c:a", "aac", "-b:a", f"{plan['audio_kbps']}k", "-ar", "48000"]
             if plan["audio_kbps"] else ["-an"])
    tag = ["-tag:v", "hvc1"] if codec == "x265" else []
    with tempfile.TemporaryDirectory() as td:
        passlog = str(Path(td) / "ffpass")
        base = [ffmpeg, "-y", "-v", "error", "-i", str(path),
                "-c:v", enc, "-b:v", f"{plan['video_kbps']}k",
                "-preset", preset, "-pix_fmt", "yuv420p", *tag, *vf,
                "-passlogfile", passlog]
        p1 = subprocess.run([*base, "-pass", "1", "-an", "-f", "null",
                             "NUL" if sys.platform == "win32" else "/dev/null"],
                            capture_output=True, text=True)
        if p1.returncode != 0:
            err(json_mode, "VALIDATION",
                f"pass 1 failed: {(p1.stderr.strip().splitlines() or ['?'])[-1]}",
                EXIT_VALIDATION)
        p2 = subprocess.run([*base, "-pass", "2", *audio,
                             "-movflags", "+faststart", str(out)],
                            capture_output=True, text=True)
        if p2.returncode != 0:
            err(json_mode, "VALIDATION",
                f"pass 2 failed: {(p2.stderr.strip().splitlines() or ['?'])[-1]}",
                EXIT_VALIDATION)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Compress a video to fit a size target (two-pass, verified).",
        epilog="Examples:\n"
               "  smart-compress.py --target 25MB video.mp4\n"
               "  smart-compress.py --target 8MB -o small.mp4 clip.mov\n",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="input media file")
    ap.add_argument("--target", required=True, metavar="SIZE",
                    help="size cap, e.g. 25MB, 8M, 1.5GB (MiB/GiB also accepted)")
    ap.add_argument("-o", "--output", default=None,
                    help="output path (default <stem>.compressed.mp4)")
    ap.add_argument("--codec", default="x264", choices=("x264", "x265"),
                    help="x264 = universal (default); x265 = ~40%% smaller, modern players")
    ap.add_argument("--preset", default="slow",
                    help="encoder preset (default slow; use medium/fast for speed)")
    ap.add_argument("--no-downscale", action="store_true",
                    help="never lower resolution, even at hopeless bits-per-pixel")
    ap.add_argument("--json", action="store_true", help="emit JSON envelope on stdout")
    args = ap.parse_args()

    target = parse_size(args.target)
    if not target or target <= 0:
        err(args.json, "USAGE", f"could not parse --target size: {args.target!r}",
            EXIT_USAGE)

    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        err(args.json, "MISSING_DEPENDENCY", "ffmpeg/ffprobe not found on PATH",
            EXIT_MISSING_DEP)

    path = Path(args.file)
    if not path.is_file():
        err(args.json, "NOT_FOUND", f"file not found: {path}", EXIT_NOT_FOUND)
    info = probe(ffprobe, path)
    if not info or info["duration"] <= 0:
        err(args.json, "VALIDATION", "could not probe input (no duration)",
            EXIT_VALIDATION)
    if info["size"] and info["size"] <= target:
        print(f"input is already {info['size']} bytes <= target {target} — "
              f"no encode needed (copy it as-is)", file=sys.stderr)

    out = Path(args.output) if args.output else path.with_name(
        path.stem + ".compressed.mp4")
    plan = plan_encode(info, target, not args.no_downscale)
    if plan["video_kbps"] < 50:
        err(args.json, "VALIDATION",
            f"budget gives only {plan['video_kbps']} kb/s video for "
            f"{info['duration']:.0f}s — target too small; trim the video or raise it",
            EXIT_VALIDATION)

    scale_note = f", downscale to {plan['scale_height']}p" if plan["scale_height"] else ""
    print(f"plan: video {plan['video_kbps']}k + audio {plan['audio_kbps']}k "
          f"({args.codec}, two-pass, preset {args.preset}{scale_note})", file=sys.stderr)

    attempts = []
    current = dict(plan)
    for attempt in (1, 2):
        print(f"encoding (attempt {attempt})...", file=sys.stderr)
        two_pass(ffmpeg, path, out, current, args.codec, args.preset, args.json)
        size = out.stat().st_size
        attempts.append({"video_kbps": current["video_kbps"], "bytes": size})
        if size <= target:
            break
        # Two-pass overshoot is rare but real on short/complex content: -8%.
        print(f"over target ({size} > {target}); retrying at -8% bitrate",
              file=sys.stderr)
        current["video_kbps"] = int(current["video_kbps"] * 0.92)

    final = out.stat().st_size
    data = {"input": str(path), "output": str(out), "target_bytes": target,
            "final_bytes": final, "under_target": final <= target,
            "plan": plan, "attempts": attempts}
    if args.json:
        print(json.dumps({"data": data, "meta": {"schema": SCHEMA}}, indent=2))
    else:
        print(f"{out}\t{final}\t{'OK' if final <= target else 'OVER'}\t{target}")
    if final > target:
        print(f"best effort is still over target — kept at {final} bytes; "
              f"trim duration or accept a lower resolution", file=sys.stderr)
        return EXIT_OVER_TARGET
    print(f"done: {final} bytes ({100 * final / target:.0f}% of budget)",
          file=sys.stderr)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

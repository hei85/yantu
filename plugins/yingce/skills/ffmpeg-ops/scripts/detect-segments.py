#!/usr/bin/env python3
"""Silence/scene boundaries as JSON segments — for STT chunking, dead-air cuts, shot splits.

ffmpeg's silencedetect and scene-score output is human-oriented log text on
stderr; this script runs the right filter and parses it into clean segments.
--silence also derives the inverse (speech segments), which is what STT chunking
and the cuts-land-in-silence EDL verification actually consume.

Usage:   detect-segments.py [--silence | --scenes] [options] [--json] <file>
Input:   one media file as positional
Output:  stdout = TSV segments (kind, start, end, duration), or --json envelope
         (schema claude-mods.ffmpeg-ops.segments/v1)
Stderr:  progress, errors
Exit:    0 ok, 2 usage, 3 file not found, 4 stream missing for mode / parse failure,
         5 ffmpeg missing

Examples:
  detect-segments.py --silence interview.mp4
  detect-segments.py --silence --noise -35dB --min-silence 0.8 --json in.mp4 | jq '.data.speech'
  detect-segments.py --scenes --scene-threshold 0.3 --json in.mp4 | jq '.data.cuts'
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

SCHEMA = "claude-mods.ffmpeg-ops.segments/v1"
EXIT_OK, EXIT_USAGE, EXIT_NOT_FOUND, EXIT_VALIDATION, EXIT_MISSING_DEP = 0, 2, 3, 4, 5


def err(json_mode: bool, code: str, message: str, exit_code: int) -> NoReturn:
    if json_mode:
        print(json.dumps({"error": {"code": code, "message": message, "details": {}}}))
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(exit_code)


def media_duration(ffprobe: str, path: Path) -> float:
    proc = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True)
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return 0.0


def detect_silence(ffmpeg: str, path: Path, noise: str, min_silence: float,
                   duration: float) -> dict:
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-nostats", "-i", str(path),
         "-af", f"silencedetect=noise={noise}:d={min_silence}",
         "-vn", "-f", "null", "-"],
        capture_output=True, text=True)
    if proc.returncode != 0:
        return {"_error": (proc.stderr.strip().splitlines() or ["unknown"])[-1]}

    starts = [float(m) for m in re.findall(r"silence_start:\s*(-?[\d.]+)", proc.stderr)]
    ends = [float(m) for m in re.findall(r"silence_end:\s*(-?[\d.]+)", proc.stderr)]
    # A silence running to EOF has a start but no end line.
    if len(starts) == len(ends) + 1:
        ends.append(duration)

    silences = [{"start": round(max(0.0, s), 3), "end": round(e, 3),
                 "duration": round(e - s, 3)}
                for s, e in zip(starts, ends)]

    speech, cursor = [], 0.0
    for sil in silences:
        if sil["start"] > cursor + 0.01:
            speech.append({"start": round(cursor, 3), "end": sil["start"],
                           "duration": round(sil["start"] - cursor, 3)})
        cursor = sil["end"]
    if duration > cursor + 0.01:
        speech.append({"start": round(cursor, 3), "end": round(duration, 3),
                       "duration": round(duration - cursor, 3)})
    return {"silences": silences, "speech": speech}


def detect_scenes(ffmpeg: str, path: Path, threshold: float, duration: float) -> dict:
    # metadata=print:file=- routes the per-frame report to STDOUT — a clean parse,
    # unlike silencedetect which only logs to stderr.
    proc = subprocess.run(
        [ffmpeg, "-hide_banner", "-nostats", "-i", str(path),
         "-vf", f"select='gt(scene,{threshold})',metadata=print:file=-",
         "-an", "-f", "null", "-"],
        capture_output=True, text=True)
    if proc.returncode != 0:
        return {"_error": (proc.stderr.strip().splitlines() or ["unknown"])[-1]}

    cuts, scores = [], []
    pts_re = re.compile(r"pts_time:(-?[\d.]+)")
    score_re = re.compile(r"lavfi\.scene_score=([\d.]+)")
    pending_pts = None
    for line in proc.stdout.splitlines():
        m = pts_re.search(line)
        if m:
            pending_pts = float(m.group(1))
            continue
        m = score_re.search(line)
        if m and pending_pts is not None:
            cuts.append(round(pending_pts, 3))
            scores.append(float(m.group(1)))
            pending_pts = None

    segments, cursor = [], 0.0
    for c in cuts:
        if c > cursor + 0.01:
            segments.append({"start": round(cursor, 3), "end": c,
                             "duration": round(c - cursor, 3)})
        cursor = c
    if duration > cursor + 0.01:
        segments.append({"start": round(cursor, 3), "end": round(duration, 3),
                         "duration": round(duration - cursor, 3)})
    return {"cuts": cuts, "scores": scores, "segments": segments}


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Detect silence or scene-change boundaries as JSON segments.",
        epilog="Examples:\n"
               "  detect-segments.py --silence interview.mp4\n"
               "  detect-segments.py --scenes --json in.mp4 | jq '.data.cuts'\n",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="media file to analyze")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--silence", action="store_true",
                      help="detect audio silence + derive speech segments (default)")
    mode.add_argument("--scenes", action="store_true",
                      help="detect video scene changes")
    ap.add_argument("--noise", default="-30dB",
                    help="silence threshold, e.g. -30dB (default) or -35dB")
    ap.add_argument("--min-silence", type=float, default=0.5,
                    help="minimum silence duration in seconds (default 0.5)")
    ap.add_argument("--scene-threshold", type=float, default=0.4,
                    help="scene-change score threshold 0..1 (default 0.4)")
    ap.add_argument("--json", action="store_true", help="emit JSON envelope on stdout")
    args = ap.parse_args()

    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        err(args.json, "MISSING_DEPENDENCY", "ffmpeg/ffprobe not found on PATH",
            EXIT_MISSING_DEP)

    path = Path(args.file)
    if not path.is_file():
        err(args.json, "NOT_FOUND", f"file not found: {path}", EXIT_NOT_FOUND)

    duration = media_duration(ffprobe, path)
    mode_name = "scenes" if args.scenes else "silence"
    print(f"detecting {mode_name} in {path.name}...", file=sys.stderr)

    if args.scenes:
        result = detect_scenes(ffmpeg, path, args.scene_threshold, duration)
        params = {"scene_threshold": args.scene_threshold}
    else:
        result = detect_silence(ffmpeg, path, args.noise, args.min_silence, duration)
        params = {"noise": args.noise, "min_silence_s": args.min_silence}

    if "_error" in result:
        err(args.json, "VALIDATION",
            f"{mode_name} analysis failed (missing stream for mode?): {result['_error']}",
            EXIT_VALIDATION)

    data = {"file": str(path), "mode": mode_name, "duration_s": round(duration, 3),
            "params": params, **result}

    if args.json:
        print(json.dumps({"data": data, "meta": {"schema": SCHEMA}}, indent=2))
        return EXIT_OK

    if args.scenes:
        for seg in data["segments"]:
            print(f"scene\t{seg['start']}\t{seg['end']}\t{seg['duration']}")
    else:
        for seg in data["silences"]:
            print(f"silence\t{seg['start']}\t{seg['end']}\t{seg['duration']}")
        for seg in data["speech"]:
            print(f"speech\t{seg['start']}\t{seg['end']}\t{seg['duration']}")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Chapter authoring: scene/silence boundaries or explicit JSON -> embedded chapters.

Derives chapter points (scene detection, speech-after-silence starts, or an
explicit chapters JSON), merges points closer than --min-gap, and emits any of:
ffmetadata (the format ffmpeg muxes), YouTube description text, WebVTT chapters,
or JSON. --write muxes the chapters INTO a stream-copy of the media (atomic,
original untouched).

Usage:   make-chapters.py (--from-scenes | --from-silence | --chapters FILE)
                          [--media FILE] [--min-gap S] [--duration S]
                          [--format ffmetadata|youtube|vtt|json] [--write OUT] [--json]
Input:   --media for detection modes and --write; --chapters JSON is
         [{"start": 0, "title": "Intro"}, ...] (or {"chapters": [...]})
Output:  stdout = the chosen format (default ffmetadata); --json = envelope
         (schema claude-mods.ffmpeg-ops.chapters/v1)
Stderr:  progress, YouTube-rule warnings, errors
Exit:    0 ok, 2 usage, 3 media/chapters file missing, 4 invalid chapters JSON,
         5 ffmpeg/ffprobe missing when required

Examples:
  make-chapters.py --from-scenes --media talk.mp4 --min-gap 30
  make-chapters.py --from-silence --media lecture.mp4 --write chaptered.mp4
  make-chapters.py --chapters chapters.json --duration 3600 --format youtube
  make-chapters.py --from-scenes --media in.mp4 --format json | jq '.data.chapters'
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

SCHEMA = "claude-mods.ffmpeg-ops.chapters/v1"
EXIT_OK, EXIT_USAGE, EXIT_NOT_FOUND, EXIT_VALIDATION, EXIT_MISSING_DEP = 0, 2, 3, 4, 5


def err(json_mode: bool, code: str, message: str, exit_code: int) -> NoReturn:
    if json_mode:
        print(json.dumps({"error": {"code": code, "message": message, "details": {}}}))
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(exit_code)


def media_duration(path: Path, json_mode: bool) -> float:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        err(json_mode, "MISSING_DEPENDENCY", "ffprobe not found on PATH", EXIT_MISSING_DEP)
    proc = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True)
    try:
        return float(proc.stdout.strip())
    except ValueError:
        err(json_mode, "VALIDATION", f"could not read duration of {path.name}",
            EXIT_VALIDATION)


def detect_points(mode: str, media: Path, json_mode: bool) -> list:
    """Shell out to the sibling detect-segments.py — one detection implementation."""
    sibling = Path(__file__).resolve().parent / "detect-segments.py"
    flag = "--scenes" if mode == "scenes" else "--silence"
    proc = subprocess.run(
        [sys.executable, str(sibling), flag, "--json", str(media)],
        capture_output=True, text=True)
    if proc.returncode != 0:
        err(json_mode, "VALIDATION",
            f"detect-segments {flag} failed (exit {proc.returncode}): "
            f"{(proc.stderr.strip().splitlines() or ['?'])[-1]}", proc.returncode)
    data = json.loads(proc.stdout)["data"]
    if mode == "scenes":
        return [float(c) for c in data.get("cuts", [])]
    # silence mode: a chapter candidate is where speech RESUMES
    return [float(seg["start"]) for seg in data.get("speech", [])]


def load_chapters_file(path: Path, json_mode: bool) -> list:
    if not path.is_file():
        err(json_mode, "NOT_FOUND", f"chapters file not found: {path}", EXIT_NOT_FOUND)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        err(json_mode, "VALIDATION", f"chapters file is not valid JSON: {e}",
            EXIT_VALIDATION)
    items = raw.get("chapters") if isinstance(raw, dict) else raw
    if not isinstance(items, list) or not items:
        err(json_mode, "VALIDATION",
            'chapters JSON must be a non-empty array of {"start": s, "title": "..."}',
            EXIT_VALIDATION)
    chapters = []
    for i, c in enumerate(items):
        if not isinstance(c, dict) or not isinstance(c.get("start"), (int, float)):
            err(json_mode, "VALIDATION", f"chapters[{i}] needs a numeric 'start'",
                EXIT_VALIDATION)
        chapters.append({"start": float(c["start"]),
                         "title": str(c.get("title") or f"Chapter {i + 1}")})
    return sorted(chapters, key=lambda c: c["start"])


def build_chapters(points: list, min_gap: float, duration: float) -> list:
    """Merge close points, force a chapter at 0, attach END times."""
    merged = [0.0]
    for p in sorted(p for p in points if p > 0):
        if p - merged[-1] >= min_gap and (duration <= 0 or duration - p >= min_gap):
            merged.append(round(p, 3))
    return [{"start": s, "title": f"Chapter {i + 1}"} for i, s in enumerate(merged)]


def attach_ends(chapters: list, duration: float) -> list:
    out = []
    for i, c in enumerate(chapters):
        end = chapters[i + 1]["start"] if i + 1 < len(chapters) else duration
        out.append({**c, "end": round(max(end, c["start"]), 3)})
    return out


def esc_ffmeta(s: str) -> str:
    for ch in ("\\", "=", ";", "#"):
        s = s.replace(ch, "\\" + ch)
    return s.replace("\n", " ")


def fmt_ffmetadata(chapters: list) -> str:
    lines = [";FFMETADATA1"]
    for c in chapters:
        lines += ["[CHAPTER]", "TIMEBASE=1/1000",
                  f"START={int(c['start'] * 1000)}", f"END={int(c['end'] * 1000)}",
                  f"title={esc_ffmeta(c['title'])}"]
    return "\n".join(lines) + "\n"


def ts_youtube(s: float) -> str:
    h, rem = divmod(int(s), 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def ts_vtt(s: float) -> str:
    h, rem = divmod(int(s), 3600)
    m, sec = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{sec:02d}.{int(round((s % 1) * 1000)):03d}"


def fmt_youtube(chapters: list) -> str:
    # YouTube parses chapters only if: first at 0:00, >= 3 chapters, each >= 10 s.
    if chapters and chapters[0]["start"] != 0:
        print("warning: YouTube requires the first chapter at 0:00", file=sys.stderr)
    if len(chapters) < 3:
        print("warning: YouTube needs >= 3 chapters to render them", file=sys.stderr)
    if any(c["end"] - c["start"] < 10 for c in chapters):
        print("warning: YouTube ignores chapter lists with any chapter < 10 s",
              file=sys.stderr)
    return "\n".join(f"{ts_youtube(c['start'])} {c['title']}" for c in chapters) + "\n"


def fmt_vtt(chapters: list) -> str:
    blocks = [f"{ts_vtt(c['start'])} --> {ts_vtt(c['end'])}\n{c['title']}"
              for c in chapters]
    return "WEBVTT\n\n" + "\n\n".join(blocks) + "\n"


def mux_chapters(media: Path, meta: str, out: Path, json_mode: bool) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        err(json_mode, "MISSING_DEPENDENCY", "ffmpeg not found on PATH (--write)",
            EXIT_MISSING_DEP)
    meta_file = out.parent / (out.stem + ".ffmeta.tmp")
    tmp_out = out.with_name(out.stem + ".tmp" + out.suffix)
    out.parent.mkdir(parents=True, exist_ok=True)
    meta_file.write_text(meta, encoding="utf-8")
    try:
        proc = subprocess.run(
            [ffmpeg, "-y", "-v", "error", "-i", str(media),
             "-f", "ffmetadata", "-i", str(meta_file),
             "-map", "0", "-map_metadata", "0", "-map_chapters", "1",
             "-c", "copy", str(tmp_out)],
            capture_output=True, text=True)
        if proc.returncode != 0:
            err(json_mode, "VALIDATION",
                f"chapter mux failed: {(proc.stderr.strip().splitlines() or ['?'])[-1]}",
                EXIT_VALIDATION)
        tmp_out.replace(out)
    finally:
        meta_file.unlink(missing_ok=True)
        tmp_out.unlink(missing_ok=True)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Derive chapters and emit ffmetadata/YouTube/VTT or mux them in.",
        epilog="Examples:\n"
               "  make-chapters.py --from-scenes --media talk.mp4 --min-gap 30\n"
               "  make-chapters.py --chapters ch.json --duration 3600 --format youtube\n",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--from-scenes", action="store_true",
                     help="chapter points from video scene changes")
    src.add_argument("--from-silence", action="store_true",
                     help="chapter points where speech resumes after silence")
    src.add_argument("--chapters", metavar="FILE",
                     help='explicit JSON: [{"start": s, "title": "..."}]')
    ap.add_argument("--media", metavar="FILE",
                    help="media file (required for detection modes and --write)")
    ap.add_argument("--min-gap", type=float, default=15.0,
                    help="merge detected points closer than this, seconds (default 15)")
    ap.add_argument("--duration", type=float, default=None,
                    help="total duration override (skips the ffprobe lookup)")
    ap.add_argument("--format", default="ffmetadata",
                    choices=("ffmetadata", "youtube", "vtt", "json"),
                    help="stdout format (default ffmetadata)")
    ap.add_argument("--write", metavar="OUT", default=None,
                    help="mux chapters into a stream-copy of --media at this path")
    ap.add_argument("--json", action="store_true",
                    help="emit JSON envelope on stdout (same as --format json)")
    args = ap.parse_args()
    json_mode = args.json or args.format == "json"

    detection = args.from_scenes or args.from_silence
    if (detection or args.write) and not args.media:
        err(json_mode, "USAGE",
            "--media is required for --from-scenes/--from-silence/--write", EXIT_USAGE)

    media = Path(args.media) if args.media else None
    if media and not media.is_file():
        err(json_mode, "NOT_FOUND", f"media not found: {media}", EXIT_NOT_FOUND)

    if args.duration is not None:
        duration = args.duration
    elif media:
        duration = media_duration(media, json_mode)
    else:
        err(json_mode, "USAGE", "--duration is required when no --media is given",
            EXIT_USAGE)

    if args.chapters:
        chapters = load_chapters_file(Path(args.chapters), json_mode)
        chapters = [{**c} for c in chapters]
    else:
        mode = "scenes" if args.from_scenes else "silence"
        print(f"deriving chapter points from {mode}...", file=sys.stderr)
        points = detect_points(mode, media, json_mode)  # type: ignore[arg-type]
        chapters = build_chapters(points, args.min_gap, duration)
    chapters = attach_ends(chapters, duration)

    meta = fmt_ffmetadata(chapters)
    written = None
    if args.write:
        mux_chapters(media, meta, Path(args.write), json_mode)  # type: ignore[arg-type]
        written = str(Path(args.write))
        print(f"chapters muxed -> {written}", file=sys.stderr)

    if json_mode:
        data = {"media": str(media) if media else None, "duration_s": duration,
                "count": len(chapters), "chapters": chapters, "written": written}
        print(json.dumps({"data": data, "meta": {"schema": SCHEMA}}, indent=2))
    elif args.format == "youtube":
        sys.stdout.write(fmt_youtube(chapters))
    elif args.format == "vtt":
        sys.stdout.write(fmt_vtt(chapters))
    else:
        sys.stdout.write(meta)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

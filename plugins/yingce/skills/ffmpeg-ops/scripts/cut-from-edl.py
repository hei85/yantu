#!/usr/bin/env python3
"""EDL JSON -> validated cuts + concat: the deterministic core of edit-as-code.

Reads an edit decision list (schema: assets/edl-schema.json — scenes, clips,
time ranges, written rationale), validates it, and produces the final video via
per-clip cuts + the concat demuxer. DRY-RUN BY DEFAULT: prints every command it
would run and touches nothing until --execute.

Re-encode mode (default) is frame-accurate and normalizes codec/resolution/fps
across clips so the concat is always safe; --copy is faster but requires
keyframe-aligned cut points and identical source parameters.

Usage:   cut-from-edl.py [--execute] [--copy] [-o OUT] [--workdir DIR] [--json] <edl.json>
Input:   EDL JSON as positional; clip paths resolve relative to the EDL's directory
Output:  stdout = planned/executed command list (or --json envelope,
         schema claude-mods.ffmpeg-ops.edl/v1)
Stderr:  progress, warnings, errors
Exit:    0 ok, 2 usage, 3 EDL or source file missing, 4 EDL invalid,
         5 ffmpeg missing (--execute only)

Examples:
  cut-from-edl.py edit.json                          # dry-run: show the plan
  cut-from-edl.py edit.json --execute -o final.mp4
  cut-from-edl.py edit.json --execute --copy         # keyframe-aligned EDLs only
  cut-from-edl.py edit.json --json | jq '.data.commands'
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

SCHEMA = "claude-mods.ffmpeg-ops.edl/v1"
EXIT_OK, EXIT_USAGE, EXIT_NOT_FOUND, EXIT_VALIDATION, EXIT_MISSING_DEP = 0, 2, 3, 4, 5


def err(json_mode: bool, code: str, message: str, exit_code: int) -> NoReturn:
    if json_mode:
        print(json.dumps({"error": {"code": code, "message": message, "details": {}}}))
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(exit_code)


def validate_edl(edl: dict) -> list:
    """Stdlib structural validation mirroring assets/edl-schema.json."""
    problems = []
    scenes = edl.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        return ["'scenes' must be a non-empty array"]
    for i, scene in enumerate(scenes):
        where = f"scenes[{i}]"
        if not isinstance(scene, dict):
            problems.append(f"{where} must be an object")
            continue
        clips = scene.get("clips")
        if not isinstance(clips, list) or not clips:
            problems.append(f"{where}.clips must be a non-empty array")
            continue
        for j, clip in enumerate(clips):
            cw = f"{where}.clips[{j}]"
            if not isinstance(clip, dict):
                problems.append(f"{cw} must be an object")
                continue
            if not isinstance(clip.get("file"), str) or not clip.get("file"):
                problems.append(f"{cw}.file must be a non-empty string")
            start, end = clip.get("start"), clip.get("end")
            if not isinstance(start, (int, float)) or start < 0:
                problems.append(f"{cw}.start must be a number >= 0")
            if not isinstance(end, (int, float)):
                problems.append(f"{cw}.end must be a number")
            elif isinstance(start, (int, float)) and end <= start:
                problems.append(f"{cw}: end ({end}) must be > start ({start})")
    return problems


def video_props(ffprobe: str, path: Path) -> dict:
    proc = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0",
         str(path)],
        capture_output=True, text=True)
    parts = proc.stdout.strip().split(",")
    if len(parts) == 3:
        try:
            num, den = parts[2].split("/")
            fps = round(int(num) / int(den), 3) if int(den) else 0
            return {"width": int(parts[0]), "height": int(parts[1]), "fps": fps}
        except (ValueError, ZeroDivisionError):
            pass
    return {}


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Cut + concat a final video from an EDL JSON (dry-run by default).",
        epilog="Examples:\n"
               "  cut-from-edl.py edit.json\n"
               "  cut-from-edl.py edit.json --execute -o final.mp4\n",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("edl", help="EDL JSON file (see assets/edl-schema.json)")
    ap.add_argument("--execute", action="store_true",
                    help="actually run the cuts (default: dry-run print only)")
    ap.add_argument("--copy", action="store_true",
                    help="stream-copy cuts (fast; needs keyframe-aligned points "
                         "and identical source params)")
    ap.add_argument("-o", "--output", default=None,
                    help="final output path, resolved against the CWD (default: the "
                         "EDL 'output' field resolved against the EDL file, else final.mp4)")
    ap.add_argument("--workdir", default=None,
                    help="directory for cut segments (default: <edl-dir>/edl-cuts)")
    ap.add_argument("--json", action="store_true", help="emit JSON envelope on stdout")
    args = ap.parse_args()

    edl_path = Path(args.edl)
    if not edl_path.is_file():
        err(args.json, "NOT_FOUND", f"EDL not found: {edl_path}", EXIT_NOT_FOUND)
    try:
        edl = json.loads(edl_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        err(args.json, "VALIDATION", f"EDL is not valid JSON: {e}", EXIT_VALIDATION)

    problems = validate_edl(edl)
    if problems:
        err(args.json, "VALIDATION",
            "EDL failed validation: " + "; ".join(problems[:5])
            + (f" (+{len(problems) - 5} more)" if len(problems) > 5 else ""),
            EXIT_VALIDATION)

    base = edl_path.resolve().parent
    workdir = Path(args.workdir) if args.workdir else base / "edl-cuts"
    # CLI -o resolves against the CWD (normal CLI convention); the EDL's own
    # 'output' field resolves against the EDL file (schema contract).
    if args.output:
        output = Path(args.output).resolve()
    else:
        output = Path(edl.get("output") or "final.mp4")
        if not output.is_absolute():
            output = base / output

    # Resolve and existence-check sources (fatal in execute, warning in dry-run).
    clips, missing = [], []
    for scene in edl["scenes"]:
        for clip in scene["clips"]:
            src = Path(clip["file"])
            if not src.is_absolute():
                src = base / src
            if not src.is_file():
                missing.append(str(src))
            clips.append({"scene": scene.get("scene"), "src": src,
                          "start": float(clip["start"]), "end": float(clip["end"])})
    if missing:
        for m in missing:
            print(f"warning: source missing: {m}", file=sys.stderr)
        if args.execute:
            err(args.json, "NOT_FOUND",
                f"{len(missing)} source file(s) missing (first: {missing[0]})",
                EXIT_NOT_FOUND)

    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if args.execute and not ffmpeg:
        err(args.json, "MISSING_DEPENDENCY", "ffmpeg not found on PATH",
            EXIT_MISSING_DEP)

    # Re-encode mode normalizes every segment to the first clip's geometry/fps,
    # which is what makes the concat demuxer unconditionally safe.
    norm_filter = ""
    if not args.copy and ffprobe and not missing:
        props = [video_props(ffprobe, c["src"]) for c in clips]
        props = [p for p in props if p]
        if props:
            w, h, fps = props[0]["width"], props[0]["height"], props[0]["fps"] or 30
            if any((p["width"], p["height"]) != (w, h) or p["fps"] != props[0]["fps"]
                   for p in props):
                print(f"note: mixed source params — normalizing all segments to "
                      f"{w}x{h} @ {fps}fps", file=sys.stderr)
            norm_filter = (f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
                           f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={fps}")

    commands, concat_lines = [], []
    for n, clip in enumerate(clips, 1):
        seg = workdir / f"seg{n:03d}.mp4"
        cmd = ["ffmpeg", "-y", "-ss", f"{clip['start']}", "-to", f"{clip['end']}",
               "-i", str(clip["src"])]
        if args.copy:
            cmd += ["-c", "copy", "-avoid_negative_ts", "make_zero"]
        else:
            if norm_filter:
                cmd += ["-vf", norm_filter]
            cmd += ["-c:v", "libx264", "-crf", "18", "-preset", "fast",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
                    "-ar", "48000"]
        cmd.append(str(seg))
        commands.append(cmd)
        concat_lines.append(f"file '{seg.as_posix()}'")

    concat_txt = workdir / "concat.txt"
    final_cmd = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_txt),
                 "-c", "copy", "-movflags", "+faststart", str(output)]

    data = {
        "edl": str(edl_path), "mode": "copy" if args.copy else "reencode",
        "executed": bool(args.execute), "workdir": str(workdir),
        "output": str(output), "segments": len(clips),
        "missing_sources": missing,
        "commands": [" ".join(c) for c in commands] + [" ".join(final_cmd)],
    }

    if not args.execute:
        if args.json:
            print(json.dumps({"data": data, "meta": {"schema": SCHEMA}}, indent=2))
        else:
            print(f"# DRY-RUN — {len(clips)} segment(s) -> {output}")
            for c in data["commands"][:-1]:
                print(c)
            print(f"# concat.txt:\n" + "\n".join(f"#   {l}" for l in concat_lines))
            print(data["commands"][-1])
        print("dry-run only; pass --execute to run", file=sys.stderr)
        return EXIT_OK

    workdir.mkdir(parents=True, exist_ok=True)
    for n, cmd in enumerate(commands, 1):
        print(f"cutting segment {n}/{len(commands)}...", file=sys.stderr)
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            err(args.json, "VALIDATION",
                f"segment {n} failed: {(proc.stderr.strip().splitlines() or ['?'])[-1]}",
                EXIT_VALIDATION)
    concat_txt.write_text("\n".join(concat_lines) + "\n", encoding="utf-8")

    # Atomic final write: concat to a temp name, then rename over the
    # destination. The temp KEEPS the real extension — ffmpeg infers the muxer
    # from it, and "final.mp4.tmp" would fail with "Invalid argument".
    tmp_out = output.with_name(output.stem + ".tmp" + output.suffix)
    final_cmd[-1] = str(tmp_out)
    # the destination dir must exist BEFORE ffmpeg opens the temp output -
    # otherwise concat dies with a cryptic "Error opening output files"
    output.parent.mkdir(parents=True, exist_ok=True)
    print("concatenating...", file=sys.stderr)
    proc = subprocess.run(final_cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        err(args.json, "VALIDATION",
            f"concat failed: {(proc.stderr.strip().splitlines() or ['?'])[-1]}",
            EXIT_VALIDATION)
    tmp_out.replace(output)

    if args.json:
        print(json.dumps({"data": data, "meta": {"schema": SCHEMA}}, indent=2))
    else:
        print(str(output))
    print(f"done: {output} ({len(clips)} segments)", file=sys.stderr)
    print("next: re-transcribe the output and verify no words were clipped "
          "(see references/edit-as-code.md)", file=sys.stderr)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

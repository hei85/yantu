#!/usr/bin/env python3
"""Normalized media inspection via ffprobe — the probe-first doctrine's tool.

Wraps ffprobe's verbose, build-varying JSON into one stable, compact envelope:
container, duration, per-stream codec/dimensions/fps/pix_fmt/color/rotation,
and (on request) the keyframes nearest a timestamp so the agent can decide
whether a stream-copy cut is safe.

--doctor turns the probe into triage: each detected processing hazard (VFR,
HDR transfer, rotation metadata, interlacing, non-yuv420p delivery, moov at
EOF) is reported WITH the exact fix command, and the exit code becomes a
branchable signal.

Usage:   probe-media.py [--json] [--keyframes-near SECONDS] [--doctor] <file>
Input:   one media file path as positional
Output:  stdout = human summary, or envelope {"data":...,"meta":...} with --json
         (schema claude-mods.ffmpeg-ops.probe/v1)
Stderr:  warnings, errors
Exit:    0 ok, 2 usage, 3 file not found, 4 not parseable media,
         5 ffprobe missing, 10 --doctor found at least one issue

Examples:
  probe-media.py input.mp4
  probe-media.py --json input.mp4 | jq '.data.video.fps'
  probe-media.py --keyframes-near 92.5 input.mp4
  probe-media.py --doctor input.mp4 || echo "fix before processing"
  probe-media.py --doctor --json input.mp4 | jq -r '.data.doctor.findings[].fix'
"""

import argparse
import json
import shutil
import subprocess
import sys
from fractions import Fraction
from pathlib import Path
from typing import NoReturn

SCHEMA = "claude-mods.ffmpeg-ops.probe/v1"

EXIT_OK, EXIT_USAGE, EXIT_NOT_FOUND, EXIT_VALIDATION, EXIT_MISSING_DEP = 0, 2, 3, 4, 5
EXIT_FINDINGS = 10


def err(args_json: bool, code: str, message: str, exit_code: int) -> NoReturn:
    if args_json:
        print(json.dumps({"error": {"code": code, "message": message, "details": {}}}))
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(exit_code)


def parse_rate(rate: str) -> float:
    """ffprobe rates arrive as '30000/1001' or '25/1'; '0/0' means unknown."""
    try:
        f = Fraction(rate)
        return round(float(f), 3) if f else 0.0
    except (ValueError, ZeroDivisionError):
        return 0.0


def stream_rotation(stream: dict) -> int:
    # Modern ffprobe: displaymatrix side data; legacy: tags.rotate.
    for sd in stream.get("side_data_list", []) or []:
        if "rotation" in sd:
            try:
                return int(sd["rotation"]) % 360
            except (TypeError, ValueError):
                pass
    try:
        return int(stream.get("tags", {}).get("rotate", 0)) % 360
    except (TypeError, ValueError):
        return 0


def normalize(raw: dict, path: Path) -> dict:
    fmt = raw.get("format", {})
    out = {
        "file": str(path),
        "container": fmt.get("format_name", ""),
        "duration_s": round(float(fmt.get("duration", 0) or 0), 3),
        "size_bytes": int(fmt.get("size", 0) or 0),
        "bitrate_bps": int(fmt.get("bit_rate", 0) or 0),
        "stream_count": int(fmt.get("nb_streams", 0) or 0),
        "video": None,
        "audio": [],
        "subtitles": [],
        "streams": [],
    }
    for s in raw.get("streams", []):
        kind = s.get("codec_type", "unknown")
        entry = {
            "index": s.get("index"),
            "type": kind,
            "codec": s.get("codec_name", ""),
            "profile": s.get("profile", ""),
            "language": (s.get("tags", {}) or {}).get("language", ""),
            "default": bool((s.get("disposition", {}) or {}).get("default", 0)),
        }
        if kind == "video":
            avg = parse_rate(s.get("avg_frame_rate", "0/0"))
            real = parse_rate(s.get("r_frame_rate", "0/0"))
            entry.update({
                "width": s.get("width", 0),
                "height": s.get("height", 0),
                "fps": avg or real,
                # avg != r is the cheap variable-frame-rate tell.
                "vfr_suspect": bool(avg and real and abs(avg - real) > 0.01),
                "pix_fmt": s.get("pix_fmt", ""),
                "field_order": s.get("field_order", ""),
                "color_space": s.get("color_space", ""),
                "color_transfer": s.get("color_transfer", ""),
                "color_primaries": s.get("color_primaries", ""),
                "rotation_deg": stream_rotation(s),
                "bitrate_bps": int(s.get("bit_rate", 0) or 0),
            })
            if out["video"] is None and not s.get("disposition", {}).get("attached_pic"):
                out["video"] = entry
        elif kind == "audio":
            entry.update({
                "sample_rate": int(s.get("sample_rate", 0) or 0),
                "channels": s.get("channels", 0),
                "channel_layout": s.get("channel_layout", ""),
                "bitrate_bps": int(s.get("bit_rate", 0) or 0),
            })
            out["audio"].append(entry)
        elif kind == "subtitle":
            out["subtitles"].append(entry)
        out["streams"].append(entry)
    return out


def moov_after_mdat(path: Path) -> bool:
    """Walk top-level MP4/MOV atoms: True if moov sits after mdat (no faststart)."""
    try:
        with path.open("rb") as f:
            pos, size = 0, path.stat().st_size
            seen_mdat = False
            while pos + 8 <= size:
                f.seek(pos)
                header = f.read(16)
                if len(header) < 8:
                    break
                box_len = int.from_bytes(header[0:4], "big")
                box_type = header[4:8]
                if box_len == 1 and len(header) >= 16:       # 64-bit largesize
                    box_len = int.from_bytes(header[8:16], "big")
                elif box_len == 0:                            # box runs to EOF
                    box_len = size - pos
                if box_len < 8:
                    break
                if box_type == b"mdat":
                    seen_mdat = True
                elif box_type == b"moov":
                    return seen_mdat
                pos += box_len
    except OSError:
        pass
    return False


def doctor(data: dict, path: Path) -> list:
    """Triage: each finding pairs the hazard with the exact fix command."""
    findings = []
    q = f'"{path}"'
    v = data["video"]

    def add(severity: str, issue: str, why: str, fix: str) -> None:
        findings.append({"severity": severity, "issue": issue, "why": why, "fix": fix})

    if v:
        if v["vfr_suspect"]:
            add("warn", "variable frame rate (VFR) suspected",
                "cut math drifts, concat desyncs, players/editors stutter",
                f"ffmpeg -i {q} -c:v libx264 -crf 18 -preset fast -pix_fmt yuv420p "
                f"-fps_mode cfr -r {round(v['fps']) or 30} -c:a aac -b:a 192k normalized.mp4")
        if v["color_transfer"] in ("smpte2084", "arib-std-b67"):
            kind = "PQ/HDR10" if v["color_transfer"] == "smpte2084" else "HLG"
            add("warn", f"HDR transfer ({kind})",
                "re-encoding without tonemapping produces grey, washed-out SDR",
                f"ffmpeg -i {q} -vf \"zscale=t=linear:npl=100,format=gbrpf32le,"
                f"zscale=p=bt709,tonemap=tonemap=hable:desat=0,"
                f"zscale=t=bt709:m=bt709:r=tv,format=yuv420p\" "
                f"-c:v libx264 -crf 20 -c:a copy sdr.mp4")
        if v["rotation_deg"]:
            add("warn", f"rotation metadata ({v['rotation_deg']} deg)",
                "filters/thumbnails operate on unrotated pixels; some pipelines drop the flag",
                f"ffmpeg -display_rotation 0 -i {q} -c copy upright.mp4  "
                f"# or bake: -vf transpose + re-encode")
        if v["field_order"] not in ("", "progressive", "unknown"):
            add("warn", f"interlaced (field_order={v['field_order']})",
                "combing artifacts on motion after any scale/re-encode",
                f"ffmpeg -i {q} -vf bwdif=mode=send_field -c:v libx264 -crf 19 "
                f"-c:a copy deinterlaced.mp4")
        # H.264 delivery must be 8-bit 4:2:0; HEVC Main10 (yuv420p10le) is a
        # legitimate delivery profile (and mandatory for HDR10) — don't flag it.
        ok_pix = ("", "yuv420p") if v["codec"] == "h264" else \
                 ("", "yuv420p", "yuv420p10le")
        if v["codec"] in ("h264", "hevc") and v["pix_fmt"] not in ok_pix:
            add("warn", f"pix_fmt {v['pix_fmt']} on a delivery codec",
                "Safari/QuickTime/TVs show black or refuse playback on >4:2:0",
                f"ffmpeg -i {q} -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a copy "
                f"-movflags +faststart compatible.mp4")
    elif data["audio"]:
        add("info", "no video stream (audio-only)",
            "video operations will fail; audio/STT workflows are fine", "")

    if "mp4" in data["container"] or "mov" in data["container"]:
        if moov_after_mdat(path):
            add("warn", "moov atom after mdat (no faststart)",
                "browsers must download the whole file before playback starts",
                f"ffmpeg -i {q} -c copy -movflags +faststart faststart.mp4")

    if data["duration_s"] <= 0:
        add("warn", "container reports no duration",
            "truncated/still-recording file, or a stream needing -fflags +genpts",
            f"ffmpeg -v error -i {q} -f null -   # decode check; then remux -c copy")
    return findings


def keyframes_near(ffprobe: str, path: Path, ts: float, window: float = 30.0) -> dict:
    start = max(0.0, ts - window)
    proc = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0",
         "-read_intervals", f"{start}%{ts + window}", str(path)],
        capture_output=True, text=True)
    keys = []
    for line in proc.stdout.splitlines():
        parts = line.strip().split(",")
        if len(parts) >= 2 and "K" in parts[1]:
            try:
                keys.append(float(parts[0]))
            except ValueError:
                continue
    keys.sort()
    prev = max((k for k in keys if k <= ts), default=None)
    nxt = min((k for k in keys if k > ts), default=None)
    return {
        "target_s": ts,
        "prev_keyframe_s": prev,
        "next_keyframe_s": nxt,
        "copy_cut_drift_s": round(ts - prev, 3) if prev is not None else None,
        "window_scanned_s": [round(start, 3), round(ts + window, 3)],
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Normalized media inspection via ffprobe.",
        epilog="Examples:\n"
               "  probe-media.py input.mp4\n"
               "  probe-media.py --json input.mp4 | jq '.data.video.fps'\n"
               "  probe-media.py --keyframes-near 92.5 input.mp4\n",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="media file to probe")
    ap.add_argument("--json", action="store_true", help="emit JSON envelope on stdout")
    ap.add_argument("--keyframes-near", type=float, metavar="SECONDS", default=None,
                    help="also report nearest keyframes to this timestamp")
    ap.add_argument("--doctor", action="store_true",
                    help="triage mode: report processing hazards with exact fix "
                         "commands; exit 10 if any found")
    args = ap.parse_args()

    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        err(args.json, "MISSING_DEPENDENCY",
            "ffprobe not found on PATH (install ffmpeg)", EXIT_MISSING_DEP)

    path = Path(args.file)
    if not path.is_file():
        err(args.json, "NOT_FOUND", f"file not found: {path}", EXIT_NOT_FOUND)

    proc = subprocess.run(
        [ffprobe, "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True)
    if proc.returncode != 0 or not proc.stdout.strip():
        err(args.json, "VALIDATION",
            f"ffprobe could not parse '{path.name}' as media: "
            f"{proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else 'no detail'}",
            EXIT_VALIDATION)

    data = normalize(json.loads(proc.stdout), path)
    if args.keyframes_near is not None:
        if data["video"] is None:
            err(args.json, "VALIDATION", "no video stream; --keyframes-near needs one",
                EXIT_VALIDATION)
        data["keyframes"] = keyframes_near(ffprobe, path, args.keyframes_near)

    findings = []
    if args.doctor:
        findings = doctor(data, path)
        has_warn = any(f["severity"] != "info" for f in findings)
        data["doctor"] = {"findings": findings, "clean": not has_warn}

    if args.json:
        print(json.dumps({"data": data, "meta": {"schema": SCHEMA}}, indent=2))
        if args.doctor and not data["doctor"]["clean"]:
            return EXIT_FINDINGS
        return EXIT_OK

    # Human summary (stdout is still the data product — keep it grep-friendly).
    v = data["video"]
    print(f"file       {data['file']}")
    print(f"container  {data['container']}  "
          f"{data['duration_s']}s  {data['size_bytes']} bytes  "
          f"{data['bitrate_bps'] // 1000} kb/s  {data['stream_count']} streams")
    if v:
        vfr = "  VFR-SUSPECT" if v["vfr_suspect"] else ""
        rot = f"  rotation={v['rotation_deg']}" if v["rotation_deg"] else ""
        print(f"video      {v['codec']} {v['width']}x{v['height']} "
              f"{v['fps']}fps {v['pix_fmt']}{rot}{vfr}")
        if v["color_space"] or v["color_transfer"]:
            print(f"color      space={v['color_space'] or '?'} "
                  f"transfer={v['color_transfer'] or '?'} "
                  f"primaries={v['color_primaries'] or '?'}")
    for a in data["audio"]:
        print(f"audio #{a['index']}   {a['codec']} {a['sample_rate']}Hz "
              f"{a['channels']}ch {a['channel_layout']} lang={a['language'] or '-'}")
    for s in data["subtitles"]:
        print(f"subs  #{s['index']}   {s['codec']} lang={s['language'] or '-'}")
    if "keyframes" in data:
        k = data["keyframes"]
        print(f"keyframes  target={k['target_s']}s "
              f"prev={k['prev_keyframe_s']}s next={k['next_keyframe_s']}s "
              f"copy-cut-drift={k['copy_cut_drift_s']}s")
    if args.doctor:
        if not findings:
            print("doctor     clean — no processing hazards detected")
        for f in findings:
            print(f"doctor     [{f['severity']}] {f['issue']} — {f['why']}")
            if f["fix"]:
                print(f"           fix: {f['fix']}")
        if not data["doctor"]["clean"]:
            return EXIT_FINDINGS
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

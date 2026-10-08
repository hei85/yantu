#!/usr/bin/env python3
"""Objective quality verdict on an encode — VMAF/SSIM/PSNR vs the reference.

Closes the encode loop: "did my compression actually look ok" becomes a number
and an exit code the caller can branch on. Handles the resolution mismatch case
(distorted is auto-scaled to reference dimensions before comparison) and parses
the metric filters' log-text output so the agent never has to.

Usage:   quality-compare.py [--metrics LIST] [--min-vmaf N] [--min-ssim N] [--json]
                            <reference> <distorted>
Input:   reference (original) and distorted (encoded) files as positionals
Output:  stdout = metric lines (or --json envelope,
         schema claude-mods.ffmpeg-ops.quality/v1)
Stderr:  progress, errors
Exit:    0 ok / at-or-above thresholds, 2 usage, 3 input missing,
         4 metric parse failure, 5 ffmpeg missing (or libvmaf absent when
         vmaf requested), 10 BELOW a requested threshold

Guide:   VMAF >= 93 at 1080p ~ visually transparent; 80-93 noticeable on
         inspection; < 80 visibly degraded. SSIM >= 0.98 ~ excellent.

Examples:
  quality-compare.py original.mp4 encoded.mp4
  quality-compare.py original.mp4 encoded.mp4 --metrics vmaf --min-vmaf 90
  quality-compare.py original.mp4 encoded.mp4 --metrics ssim,psnr --min-ssim 0.97
  quality-compare.py original.mp4 encoded.mp4 --metrics vmaf --json | jq '.data.vmaf'
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

SCHEMA = "claude-mods.ffmpeg-ops.quality/v1"
EXIT_OK, EXIT_USAGE, EXIT_NOT_FOUND, EXIT_VALIDATION = 0, 2, 3, 4
EXIT_MISSING_DEP, EXIT_BELOW_THRESHOLD = 5, 10


def err(json_mode: bool, code: str, message: str, exit_code: int) -> NoReturn:
    if json_mode:
        print(json.dumps({"error": {"code": code, "message": message, "details": {}}}))
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(exit_code)


def video_dims(ffprobe: str, path: Path) -> Optional[tuple]:
    proc = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True)
    parts = proc.stdout.strip().split(",")
    if len(parts) == 2 and all(p.isdigit() for p in parts):
        return int(parts[0]), int(parts[1])
    return None


def has_filter(ffmpeg: str, name: str) -> bool:
    proc = subprocess.run([ffmpeg, "-hide_banner", "-filters"],
                          capture_output=True, text=True)
    return bool(re.search(rf"^\s+[A-Z.|]+\s+{re.escape(name)}\s+", proc.stdout,
                          re.MULTILINE))


def run_metric(ffmpeg: str, ref: Path, dist: Path, scale: str,
               metric_filter: str, cwd: Optional[str] = None) -> subprocess.CompletedProcess:
    # libvmaf/ssim/psnr convention: first input = distorted, second = reference.
    # cwd is set for vmaf so log_path can be a bare filename — a full Windows
    # path inside the filter arg hits the drive-colon escaping trap.
    graph = f"[0:v]{scale}[d];[d][1:v]{metric_filter}" if scale \
        else f"[0:v][1:v]{metric_filter}"
    return subprocess.run(
        [ffmpeg, "-hide_banner", "-nostats",
         "-i", str(dist.resolve()), "-i", str(ref.resolve()),
         "-filter_complex", graph, "-f", "null", "-"],
        capture_output=True, text=True, cwd=cwd)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="VMAF/SSIM/PSNR quality verdict: encoded vs reference.",
        epilog="Examples:\n"
               "  quality-compare.py original.mp4 encoded.mp4\n"
               "  quality-compare.py original.mp4 encoded.mp4 --metrics vmaf --min-vmaf 90\n",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("reference", help="original/reference file")
    ap.add_argument("distorted", help="encoded/processed file to judge")
    ap.add_argument("--metrics", default="ssim,psnr",
                    help="comma list of ssim,psnr,vmaf (default ssim,psnr)")
    ap.add_argument("--min-vmaf", type=float, default=None,
                    help="exit 10 if VMAF score is below this")
    ap.add_argument("--min-ssim", type=float, default=None,
                    help="exit 10 if SSIM (All) is below this")
    ap.add_argument("--json", action="store_true", help="emit JSON envelope on stdout")
    args = ap.parse_args()

    metrics = [m.strip().lower() for m in args.metrics.split(",") if m.strip()]
    bad = [m for m in metrics if m not in ("ssim", "psnr", "vmaf")]
    if bad or not metrics:
        err(args.json, "USAGE", f"unknown metric(s): {', '.join(bad) or '(none)'}",
            EXIT_USAGE)
    if args.min_vmaf is not None and "vmaf" not in metrics:
        metrics.append("vmaf")

    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        err(args.json, "MISSING_DEPENDENCY", "ffmpeg/ffprobe not found on PATH",
            EXIT_MISSING_DEP)

    ref, dist = Path(args.reference), Path(args.distorted)
    for p in (ref, dist):
        if not p.is_file():
            err(args.json, "NOT_FOUND", f"file not found: {p}", EXIT_NOT_FOUND)

    if "vmaf" in metrics and not has_filter(ffmpeg, "libvmaf"):
        err(args.json, "MISSING_DEPENDENCY",
            "this ffmpeg build lacks libvmaf (install a full build, e.g. "
            "gyan.dev 'full' on Windows, or use --metrics ssim,psnr)",
            EXIT_MISSING_DEP)

    ref_dims, dist_dims = video_dims(ffprobe, ref), video_dims(ffprobe, dist)
    if not ref_dims or not dist_dims:
        err(args.json, "VALIDATION", "could not read video dimensions from inputs",
            EXIT_VALIDATION)
    scale = ""
    if ref_dims != dist_dims:
        scale = f"scale={ref_dims[0]}:{ref_dims[1]}:flags=bicubic"
        print(f"note: scaling distorted {dist_dims[0]}x{dist_dims[1]} -> "
              f"{ref_dims[0]}x{ref_dims[1]} for comparison", file=sys.stderr)

    results: dict = {}
    for metric in metrics:
        print(f"running {metric}...", file=sys.stderr)
        if metric == "vmaf":
            with tempfile.TemporaryDirectory() as td:
                log = Path(td) / "vmaf.json"
                proc = run_metric(ffmpeg, ref, dist, scale,
                                  "libvmaf=log_fmt=json:log_path=vmaf.json", cwd=td)
                if proc.returncode != 0 or not log.is_file():
                    err(args.json, "VALIDATION",
                        f"vmaf run failed: {(proc.stderr.strip().splitlines() or ['?'])[-1]}",
                        EXIT_VALIDATION)
                vmaf_data = json.loads(log.read_text())
            pooled = vmaf_data.get("pooled_metrics", {}).get("vmaf", {})
            results["vmaf"] = {"mean": round(pooled.get("mean", 0.0), 2),
                               "min": round(pooled.get("min", 0.0), 2),
                               "harmonic_mean": round(pooled.get("harmonic_mean", 0.0), 2)}
        elif metric == "ssim":
            proc = run_metric(ffmpeg, ref, dist, scale, "ssim")
            m = re.search(r"SSIM.*All:([\d.]+)", proc.stderr)
            if not m:
                err(args.json, "VALIDATION", "could not parse SSIM output",
                    EXIT_VALIDATION)
            results["ssim"] = {"all": float(m.group(1))}
        elif metric == "psnr":
            proc = run_metric(ffmpeg, ref, dist, scale, "psnr")
            m = re.search(r"PSNR.*average:([\d.]+|inf)", proc.stderr)
            if not m:
                err(args.json, "VALIDATION", "could not parse PSNR output",
                    EXIT_VALIDATION)
            val = m.group(1)
            results["psnr"] = {"average_db": float("inf") if val == "inf" else float(val)}

    below = []
    if args.min_vmaf is not None and results.get("vmaf", {}).get("mean", 1e9) < args.min_vmaf:
        below.append(f"vmaf {results['vmaf']['mean']} < {args.min_vmaf}")
    if args.min_ssim is not None and results.get("ssim", {}).get("all", 1e9) < args.min_ssim:
        below.append(f"ssim {results['ssim']['all']} < {args.min_ssim}")

    data = {"reference": str(ref), "distorted": str(dist),
            "scaled_for_comparison": bool(scale),
            "thresholds": {"min_vmaf": args.min_vmaf, "min_ssim": args.min_ssim},
            "below_threshold": below, **results}

    if args.json:
        print(json.dumps({"data": data, "meta": {"schema": SCHEMA}}, indent=2))
    else:
        for name, vals in results.items():
            flat = "  ".join(f"{k}={v}" for k, v in vals.items())
            print(f"{name}\t{flat}")
        for b in below:
            print(f"below-threshold\t{b}")

    if below:
        print(f"VERDICT: below threshold ({'; '.join(below)})", file=sys.stderr)
        return EXIT_BELOW_THRESHOLD
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Generate .cube 3D LUT grade variants (+ optional preview stills with HTML chooser).

A .cube LUT is plain ASCII (an N^3 lattice of RGB triples), so grade candidates
can be computed rather than hand-tuned in an NLE. This emits a family of looks —
optionally on top of an S-Log3 -> Rec.709 conversion for log footage — and, with
--previews, renders one still per look plus an index.html so a HUMAN can choose.

THE AGENT NEVER PICKS THE GRADE. Generate, render previews, present the chooser,
wait. Grading is a taste call (see SKILL.md / references/color-grading.md).

Usage:   gen-luts.py [--variants LIST|all] [--size N] [--input-space slog3|rec709]
                     [--out-dir DIR] [--previews MEDIA [--frame-at S]] [--json]
Input:   no positional; --previews takes a video/image to grade stills from
Output:  stdout = one line per written file (or --json manifest envelope,
         schema claude-mods.ffmpeg-ops.luts/v1)
Stderr:  progress, the human-picks-the-grade reminder, errors
Exit:    0 ok, 2 usage, 3 preview source missing, 5 ffmpeg missing (--previews only)

Examples:
  gen-luts.py --variants all --out-dir work/luts
  gen-luts.py --variants warm_filmic,punchy,teal_orange --input-space slog3
  gen-luts.py --variants all --out-dir work/luts --previews footage.mp4 --frame-at 12.5
  gen-luts.py --variants all --json | jq -r '.data.files[]'
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

SCHEMA = "claude-mods.ffmpeg-ops.luts/v1"
EXIT_OK, EXIT_USAGE, EXIT_NOT_FOUND, EXIT_MISSING_DEP = 0, 2, 3, 5

# Each look: white-balance temp (+warm/-cool), lift/gamma/gain (master),
# per-channel gain tweaks, contrast (pivot 0.5), saturation, fade (black lift).
# Optional "mix": a 3x3 channel-mix matrix applied first (rows = output R,G,B
# as weights of input r,g,b) — what makes sepia/Technicolor expressible.
LOOKS = {
    "neutral709":   dict(temp=0.00, lift=0.000, gamma=1.00, gain=1.00,
                         rgb_gain=(1.00, 1.00, 1.00), contrast=1.00, sat=1.00, fade=0.00),
    "warm_filmic":  dict(temp=0.06, lift=0.005, gamma=0.98, gain=1.00,
                         rgb_gain=(1.02, 1.00, 0.97), contrast=1.08, sat=1.05, fade=0.03),
    "punchy":       dict(temp=0.01, lift=-0.010, gamma=1.00, gain=1.02,
                         rgb_gain=(1.00, 1.00, 1.00), contrast=1.22, sat=1.25, fade=0.00),
    "teal_orange":  dict(temp=0.02, lift=0.000, gamma=1.00, gain=1.00,
                         rgb_gain=(1.05, 1.00, 0.94), contrast=1.10, sat=1.10, fade=0.01,
                         shadow_teal=0.04),
    "cool_desat":   dict(temp=-0.05, lift=0.005, gamma=1.00, gain=0.99,
                         rgb_gain=(0.97, 1.00, 1.03), contrast=1.04, sat=0.80, fade=0.02),
    "bleach_bypass": dict(temp=0.00, lift=-0.005, gamma=1.00, gain=0.98,
                          rgb_gain=(1.00, 1.00, 1.00), contrast=1.30, sat=0.45, fade=0.00),
    "film_fade":    dict(temp=0.02, lift=0.010, gamma=1.02, gain=0.99,
                         rgb_gain=(1.01, 1.00, 0.99), contrast=0.96, sat=0.90, fade=0.06),
    "golden_hour":  dict(temp=0.10, lift=0.005, gamma=1.01, gain=1.00,
                         rgb_gain=(1.04, 1.01, 0.95), contrast=1.05, sat=1.08, fade=0.02),
    "pastel":       dict(temp=0.01, lift=0.015, gamma=1.05, gain=0.99,
                         rgb_gain=(1.00, 1.00, 1.00), contrast=0.88, sat=0.72, fade=0.08),
    "noir_bw":      dict(temp=0.00, lift=-0.005, gamma=1.00, gain=1.00,
                         rgb_gain=(1.00, 1.00, 1.00), contrast=1.25, sat=0.00, fade=0.00),
    "sepia":        dict(temp=0.00, lift=0.005, gamma=1.00, gain=1.00,
                         rgb_gain=(1.00, 1.00, 1.00), contrast=1.02, sat=1.00, fade=0.02,
                         mix=((.393, .769, .189), (.349, .686, .168), (.272, .534, .131))),
    "technicolor2": dict(temp=0.00, lift=0.000, gamma=1.00, gain=1.00,
                         rgb_gain=(1.00, 1.00, 1.00), contrast=1.10, sat=1.20, fade=0.00,
                         mix=((1.0, 0.0, 0.0), (0.0, 0.6, 0.4), (0.0, 0.4, 0.6))),
    "matrix_green": dict(temp=0.00, lift=0.005, gamma=1.00, gain=1.00,
                         rgb_gain=(0.97, 1.06, 0.98), contrast=1.10, sat=0.85, fade=0.02),
    # Scope-extracted from reference footage (see look-recipes.md grimdark):
    # warm-ash desat, pulled mids, true-ish blacks, controlled ceiling.
    "grimdark":     dict(temp=0.015, lift=0.000, gamma=0.93, gain=0.97,
                         rgb_gain=(1.02, 1.01, 0.98), contrast=1.04, sat=0.33, fade=0.03),
}

# Tone-map variants: gradient-map luma onto 2 stops (duotone) or 3 stops
# (tritone/monotone: shadow, mid, highlight), all 0..1 RGB. Chroma of the look
# = how far the stops sit from the neutral grey axis - monotones barely leave
# it, poster duotones live far out. "contrast" applies pre-map (widens spread).
_TONE_BASE = dict(temp=0.0, lift=0.0, gamma=1.0, gain=1.0,
                  rgb_gain=(1.0, 1.0, 1.0), contrast=1.05, sat=1.0, fade=0.0)
LOOKS.update({
    # poster-strength duotones
    "duo_navy":      {**_TONE_BASE, "tones": ((.05, .08, .25), (.98, .93, .80))},
    "duo_cyanotype": {**_TONE_BASE, "tones": ((.04, .16, .29), (.92, .96, 1.0))},
    "duo_sunset":    {**_TONE_BASE, "tones": ((.23, .06, .36), (1.0, .78, .34))},
    "duo_forest":    {**_TONE_BASE, "tones": ((.06, .24, .18), (.91, .85, .63))},
    "duo_crimson":   {**_TONE_BASE, "tones": ((.10, .02, .03), (1.0, .88, .86))},
    "duo_synthwave": {**_TONE_BASE, "tones": ((.35, .06, .42), (.42, .91, 1.0))},
    # muted / tertiary duotones
    "duo_ash_rose":         {**_TONE_BASE, "tones": ((.23, .20, .22), (.85, .78, .76))},
    "duo_olive_bone":       {**_TONE_BASE, "tones": ((.18, .20, .14), (.90, .88, .81))},
    "duo_petrol_paper":     {**_TONE_BASE, "tones": ((.12, .23, .24), (.93, .91, .86))},
    "duo_indigo_parchment": {**_TONE_BASE, "tones": ((.16, .23, .33), (.91, .89, .82))},
    "duo_slate_ice":        {**_TONE_BASE, "tones": ((.11, .15, .20), (.95, .97, .98))},
    # monotones (darkroom chemical tones - chroma barely off the grey axis)
    "mono_selenium": {**_TONE_BASE, "tones": ((.05, .04, .07), (.48, .46, .52), (.96, .95, .97))},
    "mono_platinum": {**_TONE_BASE, "tones": ((.07, .07, .06), (.52, .51, .49), (.97, .96, .94))},
    "mono_coffee":   {**_TONE_BASE, "tones": ((.08, .05, .03), (.55, .47, .40), (.96, .92, .87))},
    "mono_steel":    {**_TONE_BASE, "tones": ((.04, .06, .09), (.46, .50, .55), (.94, .96, .98))},
    # tritones (distinct shadow / mid / highlight hues)
    "tri_split_classic": {**_TONE_BASE, "tones": ((.06, .07, .12), (.50, .49, .48), (.98, .94, .86))},
    "tri_tobacco":       {**_TONE_BASE, "tones": ((.05, .04, .02), (.45, .40, .28), (.95, .88, .70))},
    "tri_arctic":        {**_TONE_BASE, "tones": ((.03, .05, .09), (.42, .50, .58), (.93, .97, 1.0))},
})


def err(json_mode: bool, code: str, message: str, exit_code: int) -> NoReturn:
    if json_mode:
        print(json.dumps({"error": {"code": code, "message": message, "details": {}}}))
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(exit_code)


def clamp(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


def slog3_to_linear(x: float) -> float:
    """Sony S-Log3 EOTF (input 0..1 code value -> scene linear)."""
    if x >= 171.2102946929 / 1023.0:
        return (10.0 ** ((x * 1023.0 - 420.0) / 261.5)) * 0.19 - 0.01
    return (x * 1023.0 - 95.0) * 0.01125 / (171.2102946929 - 95.0)


def linear_to_rec709(x: float) -> float:
    """BT.709 OETF with a Reinhard-style shoulder for >1.0 scene values."""
    x = max(0.0, x)
    x = x / (1.0 + 0.35 * x)          # soft highlight roll-off
    if x < 0.018:
        return 4.5 * x
    return 1.099 * (x ** 0.45) - 0.099


def apply_look(r: float, g: float, b: float, p: dict) -> tuple:
    # Channel mix first (sepia/Technicolor-class looks), then white balance.
    mix = p.get("mix")
    if mix:
        r, g, b = (mix[0][0] * r + mix[0][1] * g + mix[0][2] * b,
                   mix[1][0] * r + mix[1][1] * g + mix[1][2] * b,
                   mix[2][0] * r + mix[2][1] * g + mix[2][2] * b)
    t = p["temp"]
    r, b = r * (1.0 + t), b * (1.0 - t)
    # Lift / gamma / gain (master), then per-channel gain.
    out = []
    for c, cg in zip((r, g, b), p["rgb_gain"]):
        c = c * p["gain"] * cg + p["lift"] * (1.0 - c)
        c = clamp(c) ** (1.0 / p["gamma"])
        out.append(c)
    r, g, b = out
    # Teal/orange split-tone: push shadows toward teal (complement of the warm gain).
    st = p.get("shadow_teal", 0.0)
    if st:
        luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
        w = (1.0 - luma) ** 2          # weight shadows only
        r, b = r - st * w, b + st * w
    # Contrast around mid pivot.
    k = p["contrast"]
    r, g, b = (0.5 + (c - 0.5) * k for c in (r, g, b))
    # Tone gradient map (replaces saturation): 2 stops = duotone lerp,
    # 3 stops = piecewise shadow->mid (luma 0..0.5) -> highlight (0.5..1).
    tones = p.get("tones")
    luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    if tones:
        luma = clamp(luma)
        if len(tones) == 3:
            lo, hi = (tones[0], tones[1]) if luma < 0.5 else (tones[1], tones[2])
            f2 = luma * 2 if luma < 0.5 else (luma - 0.5) * 2
        else:
            lo, hi, f2 = tones[0], tones[1], luma
        r, g, b = (lo[i] + f2 * (hi[i] - lo[i]) for i in range(3))
    else:
        s = p["sat"]
        r, g, b = (luma + s * (c - luma) for c in (r, g, b))
    # Fade (lifted blacks).
    f = p["fade"]
    r, g, b = (f + c * (1.0 - f) for c in (r, g, b))
    return clamp(r), clamp(g), clamp(b)


def write_cube(path: Path, name: str, size: int, input_space: str, params: dict) -> None:
    lines = [f'# generated by claude-mods ffmpeg-ops gen-luts.py',
             f'# look={name} input_space={input_space}',
             f'TITLE "{name}"',
             f'LUT_3D_SIZE {size}',
             'DOMAIN_MIN 0.0 0.0 0.0',
             'DOMAIN_MAX 1.0 1.0 1.0']
    n = size - 1
    for bi in range(size):          # .cube order: red varies fastest
        for gi in range(size):
            for ri in range(size):
                r, g, b = ri / n, gi / n, bi / n
                if input_space == "slog3":
                    r, g, b = (linear_to_rec709(slog3_to_linear(c)) for c in (r, g, b))
                r, g, b = apply_look(r, g, b, params)
                lines.append(f"{r:.6f} {g:.6f} {b:.6f}")
    tmp = path.with_suffix(".cube.tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="ascii")
    tmp.replace(path)


def render_previews(ffmpeg: str, media: Path, luts: list, out_dir: Path,
                    frame_at: float) -> list:
    stills = []
    base_png = out_dir / "preview_original.png"
    runs = [(None, base_png)] + [(p, out_dir / f"preview_{p.stem}.png") for p in luts]
    media_abs = str(media.resolve())
    for lut, png in runs:
        cmd = [ffmpeg, "-y", "-v", "error", "-ss", str(frame_at), "-i", media_abs]
        if lut:
            # Run from out_dir and reference the LUT by bare filename — a full
            # path inside the filter arg hits the drive-colon escaping trap
            # ("lut3d=file=C:/..." parses ':' as an option separator).
            cmd += ["-vf", f"lut3d=file={lut.name}:interp=tetrahedral"]
        cmd += ["-frames:v", "1", png.name]
        proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(out_dir))
        if proc.returncode == 0:
            stills.append(png)
        else:
            print(f"warning: preview failed for {lut.name if lut else 'original'}: "
                  f"{(proc.stderr.strip().splitlines() or ['?'])[-1]}", file=sys.stderr)

    cells = "\n".join(
        f'<figure><img src="{p.name}" loading="lazy">'
        f"<figcaption>{p.stem.replace('preview_', '')}</figcaption></figure>"
        for p in stills)
    (out_dir / "index.html").write_text(
        "<!doctype html><meta charset='utf-8'><title>Pick a grade</title>"
        "<style>body{background:#111;color:#eee;font:14px system-ui;margin:24px}"
        "main{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:16px}"
        "img{width:100%;border-radius:6px}figcaption{margin-top:4px;text-align:center}"
        "</style><h1>Pick a grade</h1><main>" + cells + "</main>\n",
        encoding="utf-8")
    return stills


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Generate .cube grade variants; optionally render a preview chooser.",
        epilog="Examples:\n"
               "  gen-luts.py --variants all --out-dir work/luts\n"
               "  gen-luts.py --variants all --previews footage.mp4 --frame-at 12.5\n",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--variants", default="all",
                    help=f"comma list or 'all' of: {', '.join(LOOKS)} (default all)")
    ap.add_argument("--size", type=int, default=33, choices=(17, 33, 65),
                    help="lattice points per axis (default 33)")
    ap.add_argument("--input-space", default="rec709", choices=("rec709", "slog3"),
                    help="source space; slog3 bakes an S-Log3->Rec.709 conversion in")
    ap.add_argument("--out-dir", default="luts", help="output directory (default ./luts)")
    ap.add_argument("--previews", default=None, metavar="MEDIA",
                    help="render a graded still per LUT from this video/image + index.html")
    ap.add_argument("--frame-at", type=float, default=5.0,
                    help="timestamp for the preview frame (default 5.0s)")
    ap.add_argument("--json", action="store_true", help="emit JSON manifest on stdout")
    args = ap.parse_args()

    if args.variants.strip().lower() == "all":
        names = list(LOOKS)
    else:
        names = [v.strip() for v in args.variants.split(",") if v.strip()]
        unknown = [n for n in names if n not in LOOKS]
        if unknown or not names:
            err(args.json, "USAGE",
                f"unknown look(s): {', '.join(unknown) or '(none given)'} "
                f"(available: {', '.join(LOOKS)})", EXIT_USAGE)

    ffmpeg = None
    media = None
    if args.previews:
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            err(args.json, "MISSING_DEPENDENCY",
                "ffmpeg not found on PATH (required for --previews)", EXIT_MISSING_DEP)
        media = Path(args.previews)
        if not media.is_file():
            err(args.json, "NOT_FOUND", f"preview source not found: {media}",
                EXIT_NOT_FOUND)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    written = []
    for name in names:
        path = out_dir / f"{name}.cube"
        print(f"writing {path.name} ({args.size}^3, {args.input_space})...",
              file=sys.stderr)
        write_cube(path, name, args.size, args.input_space, LOOKS[name])
        written.append(path)

    stills = []
    if args.previews and ffmpeg and media:
        print("rendering preview stills...", file=sys.stderr)
        stills = render_previews(ffmpeg, media, written, out_dir, args.frame_at)

    data = {"out_dir": str(out_dir), "size": args.size,
            "input_space": args.input_space,
            "files": [str(p) for p in written],
            "previews": [str(p) for p in stills],
            "chooser": str(out_dir / "index.html") if stills else None}

    if args.json:
        print(json.dumps({"data": data, "meta": {"schema": SCHEMA}}, indent=2))
    else:
        for p in written + stills:
            print(p)
        if stills:
            print(out_dir / "index.html")
    print("REMINDER: present the chooser to the human — never auto-pick a grade.",
          file=sys.stderr)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())

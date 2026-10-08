# Color grading — LUTs, log footage, scopes, the grade workflow

Creative color. Pipeline *correctness* (pix_fmt, HDR, range/matrix tags) is
[color-hdr.md](color-hdr.md) — read that first if colors look *wrong* rather than
*unstyled*. Recipes for *named* looks (teal & orange, pastel, noir, VHS…) and
the Hald-CLUT / scope-matching techniques: [look-recipes.md](look-recipes.md).

## The workflow

1. **Normalize log footage** to Rec.709 (below) — grade on display-referred video.
2. **Generate candidates**, render preview stills, build the chooser:
   ```bash
   python skills/ffmpeg-ops/scripts/gen-luts.py --variants all \
     --out-dir work/luts --previews footage.mp4 --frame-at 12.5
   # -> work/luts/*.cube + preview_*.png + index.html
   ```
3. **The human picks.** Never auto-select a grade — taste is a human gate.
4. **Apply:**
   ```bash
   ffmpeg -i in.mp4 -vf "lut3d=file=work/luts/warm_filmic.cube:interp=tetrahedral" \
     -c:v libx264 -crf 18 -c:a copy graded.mp4
   ```
5. **Check against scopes**, not eyeballs (below).

Order of operations when combining with other work: denoise → normalize log →
grade (LUT) → sharpen → encode. Grading before denoise amplifies chroma noise.

## Log footage ("why does my drone/mirrorless footage look washed out")

Log profiles (S-Log3, V-Log, D-Log, C-Log) pack wide dynamic range into a flat
image; they *require* a conversion to Rec.709. Options:

- `gen-luts.py --input-space slog3` bakes the S-Log3→Rec.709 conversion into every
  generated look (one LUT, one filter pass).
- Camera vendors ship official conversion LUTs (Sony/Panasonic/DJI download pages)
  — highest fidelity; apply the official .cube first, then grade:
  `-vf "lut3d=vendor_to709.cube,lut3d=grade.cube"`.

If footage is HLG/PQ rather than log, that's tonemapping, not grading —
[color-hdr.md](color-hdr.md).

## .cube format (hand-writable, generatable)

Plain ASCII: `TITLE`, `LUT_3D_SIZE N` (17/33/65 — 33 is the sweet spot), optional
`DOMAIN_MIN/MAX`, then N³ lines of `R G B` floats 0–1, **red varying fastest**.
That's why an agent (or `gen-luts.py`) can write one directly. ffmpeg's `lut3d`
reads .cube/.3dl/.dat/.m3d; `interp=tetrahedral` is the quality option.

## Direct-filter grading (no LUT)

For one-off tweaks; safe ranges that don't destroy footage:

```bash
-vf "eq=brightness=0.03:contrast=1.08:saturation=1.1"   # brightness ±0.1, contrast 0.9-1.3, sat 0-1.5
-vf "colortemperature=temperature=5500"                  # WB fix: 4000 warm <-> 7000 cool
-vf "colorbalance=rs=0.05:bs=-0.05"                      # shadows toward orange (rs+) / teal (bs-)
-vf "curves=preset=increase_contrast"                    # also: lighter, darker, vintage
-vf "curves=master='0/0.04 0.5/0.5 1/0.96'"              # custom: gentle film fade
-vf "vibrance=intensity=0.4"                             # saturation that protects skin tones
-vf "unsharp=5:5:0.8"                                    # output sharpen, AFTER grade
```

## Scopes — grade against measurements

ffmpeg ships the same scopes a colorist uses; preview with `ffplay` or render a
scope strip beside the image:

```bash
# waveform (exposure): legal video sits 0-100%; clipping = flat line at top
ffplay -i graded.mp4 -vf "split[a][b];[b]waveform=mode=column:display=stack[w];[a][w]vstack"

# vectorscope (color cast/saturation): cast = trace off-center; skin tones hug
# the I-line (~33° toward red-yellow)
ffplay -i graded.mp4 -vf "split[a][b];[b]vectorscope=mode=color3[v];[a][v]hstack"

# histogram per channel
ffplay -i graded.mp4 -vf "split[a][b];[b]histogram[h];[a][h]hstack"
```

Mechanical checks: blown highlights = waveform pinned at 100% across a region;
crushed blacks = pinned at 0; white-balance error = vectorscope centroid displaced
on the B–R axis.

## Batch consistency

Same grade across a folder = same LUT applied in a loop — this is the point of
LUT-based grading (one decision, n applications):

```bash
for f in clips/*.mp4; do
  ffmpeg -y -i "$f" -vf "lut3d=file=work/luts/warm_filmic.cube:interp=tetrahedral" \
    -c:v libx264 -crf 18 -c:a copy "graded/$(basename "$f")"
done
```

Shot-to-shot exposure differences need a per-clip `eq` *before* the shared LUT —
match waveforms first, then the look lands identically.

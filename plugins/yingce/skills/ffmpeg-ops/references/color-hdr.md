# Color correctness — pix_fmt, HDR→SDR, range and matrix tags

The "colors look *wrong*" file (washed out / too dark / slightly shifted / black
video on Apple devices). For creative grading see
[color-grading.md](color-grading.md).

## Pixel formats

| pix_fmt | Use |
|---|---|
| `yuv420p` | **Every delivery encode.** The only universally-played option |
| `yuv420p10le` | 10-bit: HEVC/AV1 delivery, HDR (mandatory), banding-prone gradients |
| `yuv422p/444p` | Intermediates only — players choke |
| `rgb24 / rgba` | Image outputs, overlays with alpha |

ffmpeg preserves the source format when it can: encode from a screen recording or
PNG sequence without `-pix_fmt yuv420p` and you silently get yuv444p →
black/unplayable on QuickTime/Safari/TVs. **This is the single most common
"ffmpeg broke my video" cause.**

## Range: limited (TV) vs full (PC)

Video is normally limited range (16–235); PC/screen content is full (0–255).
Mis-tagged range = washed-out blacks or crushed shadows *only in some players*.

```bash
# screen recordings (full) -> delivery (limited), tagged correctly:
-vf "scale=in_range=full:out_range=limited" -color_range tv
```

If output looks fine in one player and washed out in another, suspect range tags
before anything else. Probe: `probe-media.py --json | jq '.data.video'`.

## Matrix: BT.601 vs BT.709 (the subtle skin-tone shift)

SD is 601, HD is 709. Scaling SD↔HD without saying so makes the *scaler guess*,
and a wrong guess shifts greens/skin slightly. Force it when crossing the line:

```bash
# SD source upscaled to HD, explicit matrix conversion + tag:
-vf "scale=1920:1080:in_color_matrix=bt601:out_color_matrix=bt709" \
-colorspace bt709 -color_primaries bt709 -color_trc bt709
```

The three `-color*` flags only *tag* (they don't convert); the scale options
*convert*. You usually want both.

## HDR → SDR tonemapping ("phone HDR video looks grey/flat after processing")

iPhone/modern-camera HDR is HLG or PQ (probe shows
`color_transfer=arib-std-b67` or `smpte2084`). Re-encoding without tonemapping
produces the classic grey washed-out look. Convert properly (needs libzimg —
check `capability-scan.sh`):

```bash
ffmpeg -i hdr.mov -vf \
  "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p" \
  -c:v libx264 -crf 20 -c:a copy sdr.mp4
```

Tonemap operators: `hable` (filmic, safe default), `mobius` (preserves mids),
`reinhard` (flat), `linear` (clips). Without libzimg, a rougher fallback:
`-vf "tonemapx=..."` builds vary — prefer installing a full build.

**Keeping HDR:** copy streams (`-c copy`) keeps HDR metadata intact; re-encoding
HDR10 properly requires x265 with `hdr10=1` master-display params — niche; verify
with a probe that `color_transfer=smpte2084` survived.

## Alpha (transparency)

```bash
# video with alpha -> overlay-ready formats:
-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le out.mov   # NLE-grade
-c:v libvpx-vp9 -pix_fmt yuva420p out.webm                     # web
```

MP4/H.264 has **no alpha** — requests for "transparent mp4" need webm or ProRes
4444 (or a separate matte).

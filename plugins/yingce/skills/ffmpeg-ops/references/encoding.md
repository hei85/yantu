# Encoding — codecs, CRF, presets, two-pass, targets

Recipe data lives in [../assets/encoding-presets.json](../assets/encoding-presets.json)
(query it; don't re-derive). This file is the *why* behind those numbers.

## CRF — constant quality, the default rate mode

CRF encodes to a perceptual quality level; size falls where it falls. Use CRF for
everything except a hard size/bandwidth budget (then two-pass, below).

| Encoder | Range | Visually lossless | Good delivery | Small | Notes |
|---|---|---|---|---|---|
| libx264 | 0–51 | 17–18 | 20–23 | 26–28 | +6 ≈ half the size |
| libx265 | 0–51 | 20–21 | 23–26 | 28–30 | x265 CRF ≈ x264 CRF + 3 for similar quality |
| libsvtav1 | 0–63 | 25–28 | 30–35 | 38–45 | scale differs — do not map 1:1 from x264 |
| libvpx-vp9 | 0–63 | 24–28 | 31–36 | 40+ | needs `-b:v 0` for pure CRF mode |

**VP9 trap:** `-crf 32` alone is *constrained* quality; pure CRF needs
`-c:v libvpx-vp9 -crf 32 -b:v 0`.

## Presets — speed vs compression efficiency

Preset changes *size at the same quality*, not the quality itself (CRF pins that).

- **libx264/libx265:** `ultrafast..placebo`. `slow` is the sweet spot for delivery;
  `fast`/`medium` for intermediates; never `placebo` (≈1% gain, 2× time over veryslow).
- **libsvtav1:** numeric `0–13`, lower = slower. `6` balanced, `4` quality-leaning,
  `8–10` for drafts.
- Rule of thumb: if encode time doesn't matter, drop one preset slower rather than
  lowering CRF — better size/quality trade.

## Tune (libx264)

`-tune film` (live action grain), `-tune animation` (flat areas + lines),
`-tune grain` (preserve heavy grain — also consider this for film scans),
`-tune stillimage`, `-tune zerolatency` (streaming only — disables lookahead).
Don't set tune at all when unsure.

## 10-bit

`-pix_fmt yuv420p10le` reduces banding in gradients (skies, dark scenes) even for
8-bit sources, at ~5% size cost. x265 and SVT-AV1 handle it natively; for H.264 it
breaks too many players — keep H.264 8-bit. HDR requires 10-bit
(see [color-hdr.md](color-hdr.md)).

## Two-pass — when you have a size budget

Target bitrate = (size_MB × 8192 ÷ seconds) − audio_kbps.

```bash
# 700 MB target for a 1h video with 128k audio → (700*8192/3600)-128 ≈ 1465k
ffmpeg -y -i in.mp4 -c:v libx264 -b:v 1465k -preset slow -pass 1 -an -f null -
ffmpeg    -i in.mp4 -c:v libx264 -b:v 1465k -preset slow -pass 2 \
  -c:a aac -b:a 128k -movflags +faststart out.mp4
```

Pass 1 writes `ffmpeg2pass-0.log` in the CWD — run both passes from the same
directory. On Windows `-f null -` works in PowerShell; no need for `NUL`.

## Audio codec choice

| Codec | Use | Bitrates |
|---|---|---|
| libopus | Best per-bit; anything not chained to MP4-only players | voice 24–32k mono, music 96–128k stereo |
| aac (native) | MP4 delivery default; fine at ≥128k stereo | 128–192k |
| libmp3lame | Legacy compat only | `-q:a 2` (~190k VBR) |
| flac / pcm_s16le | Archival / editing intermediates | lossless |

Opus-in-MP4 exists but player support is patchy — Opus belongs in webm/mka/opus.

## Intermediates for editing

Long-GOP H.264/HEVC is miserable to scrub/cut repeatedly. For multi-step edit
pipelines, transcode once to an all-intra mezzanine and work on that:

```bash
ffmpeg -i in.mp4 -c:v libx264 -crf 14 -preset fast -g 1 -c:a pcm_s16le mezz.mov
```

(`-g 1` = every frame a keyframe: any cut point is copy-safe, scrubbing is instant.
ProRes via `-c:v prores_ks -profile:v 3` if the destination is an NLE.)

## Archival

FFV1 level 3 in MKV is the preservation standard (lossless, checksummed, seekable):

```bash
ffmpeg -i in.mp4 -c:v ffv1 -level 3 -g 1 -slicecrc 1 -c:a flac archive.mkv
```

Verify the round trip with `-f framemd5` (see
[analysis-validation.md](analysis-validation.md)).

## Hard size caps (upload limits)

CRF first, then check, then two-pass only if over:

```bash
ffmpeg -i in.mp4 -c:v libx264 -crf 23 -preset slow -pix_fmt yuv420p \
  -c:a aac -b:a 128k -movflags +faststart try.mp4
# over budget? compute bitrate for the cap and two-pass (above), or step CRF +2
```

# Restoration — deinterlace, denoise, deband, stabilize, repair

Order of operations: **deinterlace → denoise → deband → stabilize → grade →
sharpen → encode.** (Stabilize after denoise: noise defeats motion estimation.)

## Deinterlace (combing artifacts on motion = interlaced source)

```bash
# probe says field_order=tt/bb (or you see combing):
ffmpeg -i dvd.vob -vf "bwdif=mode=send_field" -c:v libx264 -crf 19 out.mp4
```

`bwdif` beats the older `yadif`; `mode=send_field` doubles frame rate (50i→50p,
correct for sports/motion), `mode=send_frame` keeps it (fine for films).
**Telecined film** (24fps in 30i — duplicate-ish frames in a 3:2 pattern) wants
inverse telecine instead: `-vf "fieldmatch,decimate"`.

## Denoise

```bash
-vf "hqdn3d=4:3:6:4.5"        # fast, general (luma-spatial:chroma-spatial:luma-temporal:chroma-temporal)
-vf "nlmeans=s=4"             # much slower, much better on heavy noise
-vf "atadenoise"              # temporal-only; preserves detail on static shots
```

Start gentle (hqdn3d defaults), inspect at 100% zoom, increase until noise is
acceptable — over-denoising produces the plastic-skin look that's worse than
grain. For *intentional* film grain, don't denoise; encode with
`-tune grain` ([encoding.md](encoding.md)).

## Deband (visible steps in skies/gradients)

```bash
-vf "deband=1thr=0.015:2thr=0.015:3thr=0.015"
# prevention on re-encode: 10-bit output kills most banding at the source
-pix_fmt yuv420p10le   # (HEVC/AV1 — see color-hdr.md)
```

## Stabilize (vidstab two-pass; needs libvidstab — check capability-scan)

```bash
# pass 1: analyze motion -> transforms.trf
ffmpeg -i shaky.mp4 -vf "vidstabdetect=shakiness=6:accuracy=15:result=transforms.trf" -f null -
# pass 2: apply + crop the wobble margin + mild sharpen
ffmpeg -i shaky.mp4 -vf \
  "vidstabtransform=input=transforms.trf:zoom=2:smoothing=24,unsharp=5:5:0.6" \
  -c:v libx264 -crf 19 -c:a copy stable.mp4
```

`smoothing` ≈ frames of camera-path averaging (higher = floatier); `zoom` crops
the edges that stabilization exposes. The single-pass `deshake` filter is a
quick-and-dirty fallback when libvidstab is absent.

## Old/odd footage misc

```bash
# wrong speed (PAL 25fps of a 23.976 film, pitch off): retime v+a together
-filter_complex "[0:v]setpts=PTS*25/23.976[v];[0:a]atempo=0.95904[a]"

# VHS-style chroma bleed: mild chroma denoise + slight desat
-vf "hqdn3d=0:6:0:6,eq=saturation=0.92"

# duplicate-frame removal (bad pulldown, stuttery web rips):
-vf "mpdecimate" -fps_mode vfr
```

## Audio repair

Lives in [audio.md](audio.md) (highpass → afftdn → declick → compand chain). For
damaged *files* (truncated/corrupt) see
[analysis-validation.md](analysis-validation.md) — remux first
(`-c copy -fflags +genpts`), repair second.

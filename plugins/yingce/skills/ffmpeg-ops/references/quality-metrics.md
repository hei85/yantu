# Quality metrics — VMAF, SSIM, PSNR, visual A/B

## The tool

```bash
python skills/ffmpeg-ops/scripts/quality-compare.py original.mp4 encoded.mp4 \
  --metrics vmaf --min-vmaf 90        # exit 10 below threshold -> branch on it
```

Handles resolution mismatch (auto-scales distorted to reference), parses the
filters' log output, returns one envelope. Use it instead of hand-running the
metric filters.

## Reading the numbers

| Metric | Transparent | Good | Visible degradation | Notes |
|---|---|---|---|---|
| **VMAF** | ≥ 93 | 85–93 | < 80 | Perceptual model (Netflix); the one to trust. Trained at 1080p living-room viewing |
| **SSIM** | ≥ 0.99 | 0.97–0.99 | < 0.95 | Structural; cheap, no libvmaf needed |
| **PSNR** | ≥ 45 dB | 38–45 | < 35 | Naive signal ratio; only comparable between encodes of the *same* source |

- Check VMAF **min** (worst moment), not just mean — a 95-mean encode with a
  62-min scene has a visible glitch. `quality-compare.py --json | jq '.data.vmaf'`
  reports mean/min/harmonic_mean.
- VMAF on 4K-viewed-at-4K: use the 4K model variant if available in your build;
  otherwise treat scores as optimistic.
- Comparing two *different sources* with PSNR/SSIM is meaningless; metrics judge
  an encode against *its own* reference.

## Workflow: tune CRF mechanically

Find the highest CRF (smallest file) that stays above your VMAF floor:

```bash
for crf in 20 23 26 29; do
  ffmpeg -y -v error -i ref.mp4 -c:v libx264 -crf $crf -preset slow -an "t$crf.mp4"
  python skills/ffmpeg-ops/scripts/quality-compare.py ref.mp4 "t$crf.mp4" \
    --metrics vmaf --json | jq -r --arg c $crf '"crf=\($c) vmaf=\(.data.vmaf.mean) min=\(.data.vmaf.min)"'
done
```

Encode a representative 60–90 s slice, not the whole file
(`-ss <busy-section> -t 60` on both reference cut and encodes — cut the reference
first so they align).

## Visual A/B (the human half)

```bash
# side-by-side (label which is which!)
ffmpeg -i ref.mp4 -i enc.mp4 -filter_complex \
  "[0:v]drawtext=text='REF':fontsize=36:fontcolor=white:box=1:boxcolor=black@0.5:x=24:y=24[a];
   [1:v]drawtext=text='ENC':fontsize=36:fontcolor=white:box=1:boxcolor=black@0.5:x=24:y=24[b];
   [a][b]hstack" -c:v libx264 -crf 16 -an ab.mp4

# difference view — what the encoder actually changed (grey = identical):
ffmpeg -i ref.mp4 -i enc.mp4 -filter_complex "blend=all_mode=difference,eq=brightness=0.3" -an diff.mp4

# wipe split-screen (left=ref, right=enc, hard seam at 50%):
ffmpeg -i ref.mp4 -i enc.mp4 -filter_complex "[1:v][0:v]overlay=x='-W/2'" -an wipe.mp4
```

Where codecs fail first (look here in the A/B): dark gradients (banding), fast
motion (blocking), fine texture like grass/water (smearing), red saturated areas
(chroma 4:2:0).

## When the numbers and your eyes disagree

Believe your eyes, then find out why: wrong reference alignment (an offset frame
ruins every metric — verify identical frame counts), range/matrix mismatch
([color-hdr.md](color-hdr.md)) penalizing colors uniformly, or grain (encoders
denoise; metrics partially forgive it, viewers notice). Banding specifically is
under-penalized by all three metrics — check dark scenes by eye at viewing
brightness.

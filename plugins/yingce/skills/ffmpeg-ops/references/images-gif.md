# Images, GIFs, frames — thumbnails, sprites, datasets

## Thumbnails

```bash
# at a timestamp (input-side -ss = instant, even 2h into the file):
ffmpeg -ss 00:12:05 -i in.mp4 -frames:v 1 -q:v 2 thumb.jpg

# "a representative frame" — the thumbnail filter scans and picks:
ffmpeg -i in.mp4 -vf "thumbnail=300" -frames:v 1 thumb.jpg

# one per chapter/scene: feed timestamps from detect-segments.py --scenes:
python skills/ffmpeg-ops/scripts/detect-segments.py --scenes --json in.mp4 \
  | jq -r '.data.cuts[]' | while read -r t; do
    ffmpeg -y -v error -ss "$t" -i in.mp4 -frames:v 1 "thumbs/scene_${t}.jpg"
  done
```

`-q:v` for JPEG: 2 ≈ excellent … 31 ≈ awful. PNG/WebP/AVIF by extension
(`-c:v libwebp -quality 85`, AVIF needs libaom/libsvtav1 still support).

## Contact sheets & sprite sheets

```bash
# contact sheet: 1 frame / 10s, 4x3 grid (visual summary of a video):
ffmpeg -i in.mp4 -vf "fps=1/10,scale=320:-2,tile=4x3" -frames:v 1 sheet.png

# scrub-preview sprite sheet for a web player (1/s, 10x10 pages, numbered):
ffmpeg -i in.mp4 -vf "fps=1,scale=160:-2,tile=10x10" sprites_%02d.jpg
# (player WebVTT thumbnail tracks map time -> sheet offset: t seconds = tile t%100)

# GOTCHA: tile fed from an IMAGE-SEQUENCE input (-i seq_%02d.png) partial-fills
# the grid on some builds (observed: ffmpeg 8.0 Windows) even though every
# frame decodes. Deterministic fallback = explicit stack graph:
#   ffmpeg -i a.png -i b.png ... -filter_complex \
#     "[0:v][1:v][2:v]hstack=3[r0];[3:v][4:v][5:v]hstack=3[r1];[r0][r1]vstack=2"
```

## GIF (the palettegen discipline)

GIF is 256 colors with no partial transparency; quality is *entirely* about the
palette and dithering:

```bash
# single-pass via split (fps and scale BEFORE palettegen — palette should be
# computed on the frames that will actually be in the GIF):
ffmpeg -ss 5 -to 8 -i in.mp4 -filter_complex \
  "fps=12,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4" \
  out.gif
```

Size levers, in order of impact: duration → dimensions → fps (8–15 is plenty) →
max_colors → dither (`bayer` smallest, `floyd_steinberg`/`sierra2_4a` prettiest).
`palettegen=stat_mode=diff` helps when only a small region moves.
**Modern check first:** most "GIF" destinations (Slack, GitHub, web) accept MP4 or
animated WebP at a tenth the size — `-c:v libwebp -loop 0 -quality 80 out.webp`.

## Frame extraction

```bash
ffmpeg -i in.mp4 frames/%06d.png                       # every frame
ffmpeg -i in.mp4 -vf "fps=2" frames/%06d.png           # 2 per second
ffmpeg -i in.mp4 -vf "select='eq(pict_type,I)'" -fps_mode vfr keyframes/%04d.png
ffmpeg -ss 12.500 -i in.mp4 -frames:v 1 exact.png      # the frame at 12.5s
```

## ML dataset prep

```bash
# fixed-rate, model-square (center crop), consistent naming:
ffmpeg -i in.mp4 -vf "fps=1,scale=512:512:force_original_aspect_ratio=increase,crop=512:512" \
  ds/vid01_%06d.png

# letterbox instead of crop (keep full frame):
-vf "fps=1,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2"

# dedupe near-identical frames (slideshows, talking heads) before extraction:
-vf "mpdecimate,fps=1" -fps_mode vfr
```

PNG for training (lossless); JPEG `-q:v 2` only when storage forces it. Keep the
source-time mapping recoverable: either fixed fps (frame n ÷ fps = seconds) or
`-frame_pts 1` to name files by PTS.

## Sequences → video

```bash
ffmpeg -framerate 24 -i frames/%06d.png -c:v libx264 -crf 18 -pix_fmt yuv420p out.mp4
ffmpeg -framerate 24 -pattern_type glob -i 'shots/*.png' ...   # unnumbered names (not on Windows cmd)
```

`-framerate` (input, before `-i`) sets how fast stills are read — forgetting it
gives the 25fps default regardless of intent. And `-pix_fmt yuv420p` again: PNG
sources otherwise produce yuv444p output (see [color-hdr.md](color-hdr.md)).

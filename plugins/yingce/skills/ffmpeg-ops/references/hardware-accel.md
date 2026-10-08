# Hardware acceleration — NVENC, QSV, AMF, VideoToolbox, VAAPI

## The one paragraph that prevents most hw-encode mistakes

Hardware encoders are **5–20× faster** and **worse per bit** than libx264/x265 at
slow presets — a dedicated ASIC doing fewer optimization passes. Use them for
batch/draft/realtime work and bump bitrate ~30% to compensate; use CPU for final
masters and size-constrained encodes. And **always verify, never trust the list**:

```bash
bash skills/ffmpeg-ops/scripts/capability-scan.sh          # proof-encodes each hw encoder
```

An encoder appearing in `ffmpeg -encoders` only means it was compiled in; NVENC
fails at runtime on driver/CUDA mismatches, QSV without the right GPU/driver,
VAAPI without a render node. Exit 10 from capability-scan = listed-but-broken.

## NVENC (NVIDIA)

```bash
# quality-targeted VBR (the CRF-like mode; -cq lower = better, ~19-28)
ffmpeg -i in.mp4 -c:v h264_nvenc -preset p5 -tune hq -rc vbr -cq 23 -b:v 0 \
  -pix_fmt yuv420p -c:a copy out.mp4
ffmpeg -i in.mp4 -c:v hevc_nvenc -preset p6 -tune hq -rc vbr -cq 26 -tag:v hvc1 ... 
```

- Presets are `p1`(fast)–`p7`(quality); the old `slow/fast/ll*` names are legacy.
- `-rc vbr -cq N -b:v 0` ≈ constant quality; omit `-b:v 0` and ffmpeg imposes a
  default bitrate cap (classic "why is NVENC output blurry" cause).
- Full decode→encode on GPU: `-hwaccel cuda -hwaccel_output_format cuda` before
  `-i`, GPU-side `scale_cuda`/`scale_npp` for resizing.
- Consumer GeForce caps concurrent NVENC sessions (driver-dependent, typically 5–8).

## QSV (Intel Quick Sync)

```bash
ffmpeg -init_hw_device qsv=hw -i in.mp4 -vf "format=nv12,hwupload" \
  -c:v h264_qsv -global_quality 23 -preset slower -c:a copy out.mp4
```

`-global_quality` is the CRF-analog (ICQ mode). Common failure: iGPU disabled in
BIOS or no Intel media driver — capability-scan catches both.

## AMF (AMD, Windows)

```bash
ffmpeg -i in.mp4 -c:v h264_amf -quality quality -rc cqp -qp_i 22 -qp_p 24 -c:a copy out.mp4
```

Weakest quality-per-bit of the four; prefer CPU unless speed is the whole point.

## VideoToolbox (macOS)

```bash
ffmpeg -i in.mp4 -c:v hevc_videotoolbox -q:v 55 -tag:v hvc1 -c:a copy out.mp4
```

`-q:v` 1–100 (higher = better, ~50–65 typical). Apple Silicon VT is fast and
respectable; still below libx265 slow for size-critical work.

## VAAPI (Linux)

```bash
ffmpeg -vaapi_device /dev/dri/renderD128 -i in.mp4 \
  -vf "format=nv12,hwupload" -c:v h264_vaapi -qp 23 -c:a copy out.mp4
```

Needs a render node and the right driver (iHD for modern Intel, Mesa for AMD).
The `format=nv12,hwupload` dance is mandatory — software frames must be uploaded.

## Hardware DECODE (often the better win)

Decode acceleration helps any pipeline bottlenecked on reading high-res sources
(4K HEVC preview/thumbnail/analysis jobs), independent of encode choice:

```bash
ffmpeg -hwaccel auto -i 4k_hevc.mp4 -vf scale=1280:-2 -c:v libx264 -crf 20 out.mp4
```

`-hwaccel auto` falls back to software silently — safe to include by default.
Caveat: filters run on CPU frames unless you keep the pipeline on-GPU
(`-hwaccel_output_format cuda` + `*_cuda` filters); mixing GPU decode with CPU
filters costs a download/upload round trip and can be *slower* than pure CPU for
filter-heavy graphs. Measure before assuming.

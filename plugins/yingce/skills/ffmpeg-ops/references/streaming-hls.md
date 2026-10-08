# Streaming — HLS/DASH packaging, ABR ladders, live restream

## Single-rendition HLS VOD (the 80% case)

```bash
ffmpeg -i in.mp4 -c:v libx264 -crf 21 -preset slow -pix_fmt yuv420p \
  -g 180 -keyint_min 180 -sc_threshold 0 \
  -c:a aac -b:a 128k -ar 48000 \
  -f hls -hls_time 6 -hls_playlist_type vod \
  -hls_segment_filename 'out/seg_%04d.ts' out/index.m3u8
```

The keyframe rule is the part everyone misses: **segment boundaries must be
keyframes**, so `-g`/`-keyint_min` = fps × hls_time (here 30×6=180) and
`-sc_threshold 0` stops scene-detection from inserting extras. Without this,
segment durations drift and players stall on seeks.

fMP4 segments instead of TS (required for HEVC-in-HLS, nicer for CMAF):
`-hls_segment_type fmp4`.

## ABR ladder (multi-rendition)

Ladder data: [../assets/hls-ladder.json](../assets/hls-ladder.json) — trim to 3
rungs for non-broadcast use. One-command master playlist via
`-var_stream_map`:

```bash
ffmpeg -i in.mp4 \
  -filter_complex "[0:v]split=3[v1][v2][v3];[v1]scale=-2:1080[v1o];[v2]scale=-2:720[v2o];[v3]scale=-2:360[v3o]" \
  -map "[v1o]" -c:v:0 libx264 -b:v:0 6000k -maxrate:v:0 6600k -bufsize:v:0 12000k \
  -map "[v2o]" -c:v:1 libx264 -b:v:1 3000k -maxrate:v:1 3300k -bufsize:v:1 6000k \
  -map "[v3o]" -c:v:2 libx264 -b:v:2 730k  -maxrate:v:2 800k  -bufsize:v:2 1460k \
  -map a:0 -map a:0 -map a:0 -c:a aac -b:a 128k -ar 48000 \
  -preset slow -pix_fmt yuv420p -g 180 -keyint_min 180 -sc_threshold 0 \
  -f hls -hls_time 6 -hls_playlist_type vod \
  -master_pl_name master.m3u8 \
  -var_stream_map "v:0,a:0 v:1,a:1 v:2,a:2" \
  -hls_segment_filename 'out/%v/seg_%04d.ts' 'out/%v/index.m3u8'
```

ABR uses **capped bitrate** (`-b:v` + `-maxrate` + `-bufsize` ≈ 2× maxrate), not
CRF — the ladder's promise to the player is a bandwidth, not a quality.

## DASH

Same encode discipline; `-f dash`:

```bash
ffmpeg -i in.mp4 ... -f dash -seg_duration 6 -use_template 1 -use_timeline 1 out/manifest.mpd
```

For both-HLS-and-DASH from one encode, encode renditions to fMP4 once and package
with a dedicated packager (shaka-packager) rather than encoding twice.

## Live restream (RTMP push)

```bash
# screen/webcam/file -> YouTube/Twitch ingest. zerolatency + CBR-ish + 2s GOP:
ffmpeg -re -i source.mp4 -c:v libx264 -preset veryfast -tune zerolatency \
  -b:v 4500k -maxrate 4500k -bufsize 9000k -pix_fmt yuv420p -g 60 \
  -c:a aac -b:a 128k -ar 44100 \
  -f flv rtmp://a.rtmp.youtube.com/live2/STREAM_KEY
```

`-re` paces a *file* to realtime (never use it for live capture inputs). NVENC
(`h264_nvenc -preset p4 -tune ll`) is the right call here — encode speed matters
more than per-bit quality. Stream keys are secrets: env var, not command line, on
shared machines.

## Serving HLS locally (testing)

Any static server works (`python -m http.server`) — HLS is just files + correct
MIME (`.m3u8` = application/vnd.apple.mpegurl, `.ts` = video/mp2t). Browsers
other than Safari need hls.js; quick check without a page: `ffplay out/index.m3u8`.

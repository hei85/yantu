# Capture — screen and devices, per OS

Capture is the one genuinely platform-specific corner of ffmpeg. Same downstream
processing everywhere; only the input device differs.

## Windows (gdigrab / dshow / ddagrab)

```bash
# full screen (gdigrab — works everywhere, CPU-based):
ffmpeg -f gdigrab -framerate 30 -i desktop -c:v libx264 -preset ultrafast -crf 23 \
  -pix_fmt yuv420p cap.mp4

# region / single window:
ffmpeg -f gdigrab -framerate 30 -offset_x 100 -offset_y 100 -video_size 1280x720 -i desktop ...
ffmpeg -f gdigrab -framerate 30 -i title="Exact Window Title" ...

# modern GPU path (Win10+, much lower overhead, needs d3d11 build):
ffmpeg -f ddagrab -framerate 60 -i 0 -c:v h264_nvenc -cq 23 cap.mp4

# webcam + mic (dshow): FIRST list devices, then use exact names:
ffmpeg -list_devices true -f dshow -i dummy
ffmpeg -f dshow -rtbufsize 256M -i video="HD Webcam":audio="Microphone (Realtek)" \
  -c:v libx264 -preset veryfast -crf 22 -c:a aac cam.mp4

# system audio loopback: ffmpeg has no native WASAPI-loopback input — install
# the VB-Cable/virtual-audio-capturer dshow device, or capture with OBS instead.
```

`-rtbufsize 256M` on dshow prevents the "real-time buffer too full" frame drops.

## macOS (avfoundation)

```bash
ffmpeg -f avfoundation -list_devices true -i ""          # indices change; always list
# screen 1 + default mic ("1:0" = video-index:audio-index):
ffmpeg -f avfoundation -framerate 30 -capture_cursor 1 -i "1:0" \
  -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p cap.mp4
```

Screen Recording permission (System Settings → Privacy) must be granted to the
*terminal* running ffmpeg — the failure is a black recording, not an error.
System-audio capture needs a loopback driver (BlackHole).

## Linux (x11grab / kmsgrab / v4l2 / pulse)

```bash
# X11 screen + pulse audio:
ffmpeg -f x11grab -framerate 30 -video_size 1920x1080 -i :0.0 \
  -f pulse -i default -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p cap.mp4
# webcam:
ffmpeg -f v4l2 -framerate 30 -video_size 1280x720 -i /dev/video0 cam.mp4
```

Wayland blocks x11grab — capture via `pipewiregrab`/`kmsgrab` (build-dependent)
or use OBS as the capture layer.

## Capture-encode discipline (all platforms)

- **Capture cheap, compress later.** `-preset ultrafast -crf 18` (or hardware
  encode) during capture; transcode to delivery settings afterwards
  ([encoding.md](encoding.md)). Dropped frames during capture are unfixable;
  large intermediates are.
- Screen content is **full-range RGB** — the range/matrix tagging trap in
  [color-hdr.md](color-hdr.md) applies to every screen recording.
- Capture is inherently VFR-ish under load: run the normalize recipe before
  editing captures.
- Long captures: `-f segment -segment_time 600 -reset_timestamps 1` so a crash
  loses ten minutes, not three hours.

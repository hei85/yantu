# Visualization — audio-reactive video, audiograms, spectrograms

Turning sound into pixels: podcast clips for social, waveform "audiograms",
debugging audio by looking at it.

## Waveform video (the podcast audiogram)

```bash
# scrolling waveform over a brand background + episode title:
ffmpeg -i episode.mp3 -loop 1 -i bg_1080x1920.png -filter_complex \
  "[0:a]showwaves=s=1080x300:mode=cline:colors=white:rate=30[w];
   [1:v][w]overlay=0:1200:shortest=1,drawtext=text='EP 42 — Title':fontsize=56:fontcolor=white:x=(w-text_w)/2:y=320" \
  -c:v libx264 -crf 21 -preset fast -pix_fmt yuv420p -c:a aac -b:a 128k -shortest audiogram.mp4
```

`shortest=1` on the overlay + `-shortest` at the end stop the looped image from
running forever. `showwaves` modes: `cline` (filled, the podcast look), `line`,
`p2p`, `point`.

## Spectrum styles

```bash
# frequency bars (the "visualizer" look):
"[0:a]showfreqs=s=1280x420:mode=bar:fscale=log[v]"

# scrolling spectrogram (also the debugging view — see below):
"[0:a]showspectrum=s=1280x720:mode=combined:color=intensity:scale=log:slide=scroll[v]"

# musical/CQT spectrum (notes align to rows — lovely for music):
"[0:a]showcqt=s=1280x720[v]"

# minimal volume meter / phase scope:
"[0:a]avectorscope=s=720x720:zoom=1.5[v]"
```

All consume `[0:a]` and produce a video stream — overlay/hstack them like any
other video ([filtergraph.md](filtergraph.md)).

## Static waveform / spectrogram images

```bash
# waveform PNG (one image of the whole file — episode art, quick inspection):
ffmpeg -i in.mp3 -filter_complex "showwavespic=s=1920x480:colors=#3aa3ff" -frames:v 1 wave.png

# spectrogram PNG — the audio-debugging x-ray:
ffmpeg -i in.wav -lavfi "showspectrumpic=s=1920x1080:scale=log" -frames:v 1 spec.png
```

Reading the spectrogram: a hard ceiling at ~16 kHz = the file was once a lossy
128k MP3 regardless of its current extension; mains hum = a solid line at
50/60 Hz (kill with `highpass`); clicks = vertical needles. Faster than ears for
"is this 'lossless' file actually lossless".

## Audio-reactive overlays (beyond fixed shapes)

ffmpeg-only reactivity is limited to the built-in scopes. For brand-grade
audio-reactive motion (pulsing logos, beat-synced glow), render with a
composition tool (hyperframes' audio-reactive bindings or Remotion's `useAudioData`)
and use ffmpeg for the I/O around it: extract the audio (`-vn`), supply stems,
encode/package the rendered result ([encoding.md](encoding.md)).

## Comparison grids (encode A/B, model-output review)

```bash
# 2x2 labelled grid of four variants:
ffmpeg -i a.mp4 -i b.mp4 -i c.mp4 -i d.mp4 -filter_complex \
  "[0:v]drawtext=text='crf20':fontsize=36:fontcolor=white:box=1:boxcolor=black@0.5:x=12:y=12[a];
   [1:v]drawtext=text='crf26':fontsize=36:fontcolor=white:box=1:boxcolor=black@0.5:x=12:y=12[b];
   [2:v]drawtext=text='nvenc':fontsize=36:fontcolor=white:box=1:boxcolor=black@0.5:x=12:y=12[c];
   [3:v]drawtext=text='av1':fontsize=36:fontcolor=white:box=1:boxcolor=black@0.5:x=12:y=12[d];
   [a][b][c][d]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0" -an grid.mp4
```

Inputs must share dimensions (scale first if not). The 2-input case (`hstack` +
difference blend) lives in [quality-metrics.md](quality-metrics.md).

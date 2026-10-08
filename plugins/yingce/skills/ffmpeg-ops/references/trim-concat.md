# Trim & Concat — seek semantics, keyframes, joining

## `-ss` semantics (the most misunderstood flag in ffmpeg)

| Placement | With `-c copy` | With re-encode |
|---|---|---|
| **Before `-i`** (input seek) | Fast; **snaps to the previous keyframe** — start can be seconds early, or players show frozen/black until the first keyframe | Fast **and frame-accurate** (decodes from the prior keyframe, discards up to the target) |
| **After `-i`** (output seek) | Decodes everything from 0:00 then discards — slow, accurate | Slow, accurate — *no advantage* over input seek on modern ffmpeg |

**Modern rule: put `-ss` before `-i` always.** The "put it after for accuracy"
advice predates ffmpeg 2.1 and now only costs time.

`-to` vs `-t`: `-to` = absolute end position, `-t` = duration. **Keep `-ss` and
`-to` on the same side of `-i`.** With input-side `-ss` and *output-side* `-to`,
timestamps have already been reset at the seek point, so `-to 60` means "60s
after the cut start", not "at 60s in the source" — a silent off-by-`ss` error.

## Keyframes and copy cuts

A stream-copied cut can only begin at a keyframe (IDR). Typical delivery files
have keyframes every 2–10 s, so a copy cut at an arbitrary point either:

1. snaps the start earlier (most players), or
2. keeps audio from the requested point but shows frozen video until the next
   keyframe (some players).

Decide mechanically:

```bash
python skills/ffmpeg-ops/scripts/probe-media.py --keyframes-near 92.5 in.mp4
# copy_cut_drift_s tells you how far the copy cut would land from your target
```

Drift acceptable → copy. Not → re-encode just that cut (`-crf 18` keeps it
visually identical). For many cuts from one source, an all-intra mezzanine
(see [encoding.md](encoding.md)) makes *every* point copy-safe.

Always add `-avoid_negative_ts make_zero` to copy cuts — some muxers otherwise
write leading negative timestamps that desync players.

## The three concats

| Method | When | Cost |
|---|---|---|
| **concat demuxer** | Same codec, resolution, fps, timebase (e.g. segments you cut from one source) | zero — stream copy |
| **concat filter** | Different codecs/sizes/fps | full re-encode |
| **concat protocol** | MPEG-TS only (`concat:a.ts\|b.ts`) — rarely what you want | zero |

```bash
# demuxer (the workhorse)
printf "file '%s'\n" a.mp4 b.mp4 c.mp4 > concat.txt
ffmpeg -f concat -safe 0 -i concat.txt -c copy -movflags +faststart out.mp4

# filter (mixed sources) — normalize geometry inline
ffmpeg -i a.mp4 -i b.mov -filter_complex \
  "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30[v0];
   [1:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30[v1];
   [v0][0:a][v1][1:a]concat=n=2:v=1:a=1[v][a]" \
  -map "[v]" -map "[a]" -c:v libx264 -crf 20 -c:a aac out.mp4
```

concat.txt paths are relative **to the concat.txt file**, not the CWD. `-safe 0`
is required for absolute paths. Windows paths work with forward slashes:
`file 'X:/clips/a.mp4'`.

**Audio gotcha:** mismatched sample rates/channel layouts break the demuxer too —
not just video params. When in doubt: probe both, or re-encode via the filter.

## Removing a middle section

Two keeps + concat (simple, recommended), or one command with trim filters:

```bash
# keep 0-60 and 120-end in one pass (re-encode)
ffmpeg -i in.mp4 -filter_complex \
  "[0:v]trim=0:60,setpts=PTS-STARTPTS[v0];[0:a]atrim=0:60,asetpts=PTS-STARTPTS[a0];
   [0:v]trim=start=120,setpts=PTS-STARTPTS[v1];[0:a]atrim=start=120,asetpts=PTS-STARTPTS[a1];
   [v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]" \
  -map "[v]" -map "[a]" -c:v libx264 -crf 18 -c:a aac out.mp4
```

`setpts=PTS-STARTPTS` after every trim is mandatory — trim keeps original
timestamps and the concat misbehaves without the reset.

For 3+ cuts, stop hand-writing graphs: author an EDL and use
`cut-from-edl.py` ([edit-as-code.md](edit-as-code.md)).

## Segmenting (the reverse of concat)

```bash
# split into ~5-minute pieces at keyframes, no re-encode
ffmpeg -i in.mp4 -f segment -segment_time 300 -reset_timestamps 1 -c copy part%03d.mp4
```

Segment boundaries snap to keyframes in copy mode — pieces won't be exactly 300s.

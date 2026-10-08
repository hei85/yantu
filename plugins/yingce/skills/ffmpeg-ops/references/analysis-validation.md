# Analysis & validation — integrity, hashing, metadata, untrusted media

## Corruption / decode check

```bash
ffmpeg -v error -i in.mp4 -f null - 2> errors.log
# exit code alone is NOT the verdict — partial corruption decodes "successfully".
# empty errors.log = clean; lines name the damaged streams/timestamps.
```

Fast container-level check (no full decode): `ffprobe -v error in.mp4` — catches
truncation and broken headers in milliseconds; use it as the cheap first gate in
batch jobs, the full decode as the thorough second.

## Frame hashing — prove pipelines identical

```bash
ffmpeg -i a.mp4 -map 0:v -f framemd5 a.md5
ffmpeg -i b.mp4 -map 0:v -f framemd5 b.md5
diff a.md5 b.md5        # identical = bit-identical decoded frames
```

Use cases: verify a remux didn't touch frames, prove an FFV1 archival round-trip
is lossless, CI-assert a refactored pipeline produces identical output.
`-f streamhash` (one hash per stream) is the cheap whole-file variant.

## Metadata: inspect and strip

```bash
ffprobe -v error -show_format -show_entries format_tags in.mp4   # what's in there

# strip everything (GPS, device model, creation time — privacy before sharing):
ffmpeg -i in.mp4 -map_metadata -1 -map 0 -c copy clean.mp4
```

Two traps: (1) **rotation** — stripping can drop the display matrix on phone
video; probe the output (`probe-media.py`) and re-apply `-display_rotation` if
needed. (2) **chapters** survive `-map_metadata -1`; add `-map_chapters -1` to
drop those too.

```bash
# add useful metadata (chapters from scene detection, title, language):
-metadata title="..." -metadata:s:a:0 language=eng
```

## Untrusted uploads (server-side discipline)

A user-supplied "video" is attacker-controlled input to a large C codebase. The
pattern:

1. **Validate cheaply first** — `ffprobe -v error` with a timeout; reject on any
   error, absurd stream counts, or absurd dimensions/duration vs your product
   limits.
2. **Never trust the extension** — probe reports the real container.
3. **Re-encode, don't copy** — a full decode→encode discards container exploits,
   weird private streams, and metadata payloads in one move (the normalize recipe
   in SKILL.md is the right shape).
4. **Cap resources** — wall-clock timeout per job, `-t <max>` duration cap;
   ffmpeg happily eats a 10-hour 8K input otherwise.
5. Strip metadata on output (`-map_metadata -1`) — it re-encodes *in*, otherwise.

## Scene/content probes

```bash
# scene-change list (chapters, shot logs):
python skills/ffmpeg-ops/scripts/detect-segments.py --scenes --json in.mp4 | jq '.data.cuts'

# black-frame / freeze detection (broken renders, dead air):
ffmpeg -i in.mp4 -vf "blackdetect=d=0.5:pix_th=0.10" -an -f null - 2>&1 | rg black_
ffmpeg -i in.mp4 -vf "freezedetect=n=-60dB:d=2" -an -f null - 2>&1 | rg freeze_

# bitrate-over-time (find the spike that breaks a streaming budget):
ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,size -of csv=p=0 in.mp4 \
  | awk -F, '{b[int($1)]+=$2} END{for(s in b) printf "%d\t%.0f kb/s\n", s, b[s]*8/1000}' | sort -n
```

## CI gates for media artifacts

A render pipeline's test suite, in three asserts: container parses
(`ffprobe -v error`), duration within tolerance
(`format=duration` vs expected), decode clean (`-v error -f null -` with empty
log). Add `quality-compare.py --min-ssim 0.97` against a golden reference when
the pipeline is supposed to be visually stable — see
[quality-metrics.md](quality-metrics.md).

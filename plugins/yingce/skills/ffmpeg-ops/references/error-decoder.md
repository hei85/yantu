# Error decoder — cryptic ffmpeg message → cause → fix

ffmpeg's errors describe the *symptom at the C layer*, not the cause. This table
maps the messages agents actually hit to what went wrong and the move that fixes
it. Match on the quoted fragment (messages vary slightly across versions).

## Container / file errors

| Message fragment | Actual cause | Fix |
|---|---|---|
| `moov atom not found` | MP4 truncated mid-write (crashed recorder, interrupted download, still-recording file) — the index never got written | If the recorder is still running, wait. Else recover with an untruncated reference file from the same device (untrunc) — ffmpeg alone cannot rebuild a missing moov |
| `Invalid data found when processing input` | File isn't what the extension claims, is corrupt, or is encrypted (DRM) | `ffprobe -v error file` to see what it really is; check size > 0; DRM content is out of scope, full stop |
| `Error opening output files: Invalid argument` (output side) | ffmpeg couldn't infer the muxer — usually a non-standard output extension (`.tmp`, no extension) | Name the format explicitly: `-f mp4 out.tmp`, or use a real extension |
| `Unable to choose an output format ... use a standard extension` | Same as above, said more politely | Same fix |
| `Permission denied` on output | Output open in a player (Windows file lock), or writing into a read-only dir | Close the player; write elsewhere; never edit a file in place — write new + rename |
| `No such file or directory` but the path looks right | Shell quoting ate part of the path (spaces, `&`, parentheses), or a filter arg consumed it | Quote the whole path; for paths *inside* filter args see the quoting row below |

## Codec / stream errors

| Message fragment | Actual cause | Fix |
|---|---|---|
| `Filtering and streamcopy cannot be used together` | `-vf`/`-af`/`-filter_complex` combined with `-c copy` on the same stream | Filters require re-encoding — drop `-c copy` (or only copy the *other* stream: `-c:a copy` with a video filter is fine) |
| `height not divisible by 2` (or width) | yuv420p needs even dimensions; a `scale=W:-1` produced an odd size | Use `scale=W:-2` (and `-2` for width too) |
| `Unknown encoder 'libx265'` (libvmaf, libsvtav1, …) | This build doesn't include the library — common with distro/minimal builds | `capability-scan.sh` to see what you have; install a full build (gyan.dev "full" on Windows, BtbN on Linux) |
| `Specified pixel format ... is invalid or not supported` | Hardware encoder fed a CPU pixel format (or 10-bit into an 8-bit-only encoder) | NVENC/QSV need `format=nv12`/hwupload chains — see hardware-accel.md; or drop to a software encoder |
| `No capable devices found` / `Cannot load nvcuda.dll` | NVENC listed in the build but no working NVIDIA driver/GPU | `capability-scan.sh` confirms (listed-but-failed = exit 10); use libx264 or fix the driver |
| `Conversion failed!` as the only error | The real error is 5–20 lines earlier in stderr | Read upward; with `-v error` the first printed line IS the cause |
| `Too many packets buffered for output stream` | Muxer starved — usually one stream much shorter than another in a filter graph | Add `-shortest`, or fix the graph so both streams cover the same span |
| `Non-monotonic DTS` / `non monotonically increasing dts` warnings | Timestamp disorder — VFR source, sloppy cut, or concat of mismatched segments | Usually survivable as a warning; if A/V drifts: re-encode with `-fps_mode cfr`, or remux with `-fflags +genpts` |

## Filter errors

| Message fragment | Actual cause | Fix |
|---|---|---|
| `No such filter: 'xyz'` | Typo, or build-optional filter absent (drawtext needs libfreetype, subtitles needs libass, …) | `ffmpeg -filters \| rg xyz`; full build if missing |
| `Unable to parse option value "..." ` inside a filter | The filter-arg parser ate a `:` or `,` — classically a **Windows drive colon** (`lut3d=file=C:/...`) or a timecode | Escape (`C\:/path`) or — better — `cd` to the asset's directory and use a bare relative filename |
| `Error initializing filter 'subtitles'` / `Unable to open ...srt` | Path escaping (above), or the build lacks libass | Relative filename from the subs' directory; check `capability-scan.sh` |
| `Cannot find a matching stream for unlabeled input pad` | A filtergraph input wasn't connected — wrong `[0:v]` index or a consumed-twice stream | Label every pad explicitly; `split` a stream before feeding two filters |
| `Media type mismatch between the ... filter` | Audio stream wired into a video filter or vice versa (`[0:a]` into `scale`, …) | Check the `[n:v]`/`[n:a]` selectors at each filter boundary |
| `Padded dimensions cannot be smaller than input dimensions` | `pad=` target smaller than the (already-scaled) frame | Scale down first in the same chain, or enlarge the pad target |

## Seek / cut errors

| Message fragment | Actual cause | Fix |
|---|---|---|
| No error at all, but the output is empty/0 bytes | Input-side `-ss` seeked PAST the end of the file — ffmpeg exits 0 having written nothing | Probe duration first (`probe-media.py`); treat empty output as failure in scripts, never trust exit 0 alone for frame extraction |
| `Non full-range YUV is non-standard` then encoder fails (writing .jpg) | The mjpeg encoder refuses full-range input under default strictness — common when grabbing stills from full-range/PC-range sources | Output `.png` instead, or add `-strict unofficial` for jpg |
| Output starts with frozen/black video after a copy cut | Cut point wasn't a keyframe; player shows nothing until the next IDR | `probe-media.py --keyframes-near <t>`; re-encode the cut or move it to a keyframe |
| `-to value smaller than -ss; aborting` | `-ss` input-side + `-to` output-side: timestamps reset at the seek, so your absolute `-to` is now "before" 0 | Keep `-ss`/`-to` on the same side of `-i` |
| First frames of a concat glitch/flash | concat demuxer fed segments with mismatched codec params or timebases | Identical params only for the demuxer; otherwise concat *filter* + re-encode (trim-concat.md) |

## Audio errors

| Message fragment | Actual cause | Fix |
|---|---|---|
| `Invalid audio stream. Exactly one MP3 audio stream is required` | Muxing video (e.g. cover art counts!) or 2+ streams into `.mp3` | `-vn -map 0:a:0` for mp3; or use a real container (m4a/mka) |
| Output much quieter than inputs after `amix` | amix normalizes (divides) by input count by default | `amix=...:normalize=0` + explicit `volume=` per input |
| `The encoder 'aac' is experimental` (very old builds) | Ancient ffmpeg | Upgrade; (historic workaround was `-strict -2`) — if you see this, the build is too old to trust for anything |

## Reading errors efficiently

```bash
ffmpeg -v error -i in.mp4 ... 2>&1 | head -5    # first error line = the cause
ffmpeg -v verbose ...                            # when error mode hides context
ffmpeg -h filter=scale                           # option ranges when "Invalid argument" comes from a filter
```

The single most useful habit: when a long command fails, re-run with `-v error`
and **read the first line, not the last** — ffmpeg prints the root cause first
and generic wrappers ("Conversion failed!", "Error while processing") last.

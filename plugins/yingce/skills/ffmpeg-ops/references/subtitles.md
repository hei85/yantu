# Subtitles — burn vs soft, styling, extraction

## Decision

| Need | Method |
|---|---|
| Toggleable, instant, preserves quality | **Soft** (mux as a stream, `-c copy`) |
| Always visible (social video, players without sub support) | **Burn-in** (re-encode, `subtitles` filter) |
| Styled karaoke/positioned text | ASS soft in MKV, or burn |

## Soft subtitles (mux)

```bash
ffmpeg -i in.mp4 -i subs.srt -map 0 -map 1 -c copy -c:s mov_text out.mp4    # mp4
ffmpeg -i in.mkv -i subs.srt -map 0 -map 1 -c copy -c:s srt out.mkv         # mkv (srt/ass)
# language tag + default flag (players auto-select):
... -metadata:s:s:0 language=eng -disposition:s:0 default
```

MP4 only carries `mov_text` (and loses ASS styling); MKV carries srt/ass/pgs
natively. WebVTT for web (`-c:s webvtt`, .vtt).

## Burn-in

```bash
# cd to the subtitle's directory first — the filter's path escaping is the worst
# quoting trap in ffmpeg (a Windows drive colon needs C\\:/ escaping INSIDE the arg)
ffmpeg -i in.mp4 -vf "subtitles=subs.srt" -c:v libx264 -crf 20 -c:a copy out.mp4

# styled burn (libass force_style; fontconfig resolves the family name):
-vf "subtitles=subs.srt:force_style='FontName=Arial,FontSize=28,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,MarginV=40'"

# burn the EMBEDDED subtitle track of an mkv (note: input path, stream index si):
-vf "subtitles=in.mkv:si=0"
# bitmap subs (PGS/dvd_subtitle) cannot go through `subtitles` — overlay them:
-filter_complex "[0:v][0:s:0]overlay"
```

`force_style` colors are ASS `&HAABBGGRR` (blue-green-red, not RGB; alpha 00 =
opaque).

## Extract / convert

```bash
ffprobe -v error -show_entries stream=index,codec_name:stream_tags=language \
  -select_streams s -of csv=p=0 in.mkv          # what sub tracks exist
ffmpeg -i in.mkv -map 0:s:0 subs.srt            # extract first text track
ffmpeg -i subs.srt subs.vtt                     # srt <-> vtt <-> ass conversion
```

Bitmap tracks (pgs, dvd_subtitle) can't convert to text via ffmpeg — that's an
OCR job (external tooling).

## Timing repair

```bash
# subs 2.5s late -> shift earlier:
ffmpeg -itsoffset -2.5 -i subs.srt -c copy shifted.srt
```

For *rate* drift (23.976 vs 25 fps subs), retiming = multiply timestamps —
external tools or regenerate from STT ([stt-whisper.md](stt-whisper.md)).

## From STT

Whisper-family engines emit SRT/VTT directly; the round trip (extract audio →
transcribe → mux back) is in [stt-whisper.md](stt-whisper.md). Caption-quality
rule for generated subs: ≤ 2 lines, ≤ ~42 chars/line, segments split on the
word-level timestamps at phrase boundaries — not the engine's raw 30-word blobs.

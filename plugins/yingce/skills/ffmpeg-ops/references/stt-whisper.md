# STT / Whisper prep — audio in, transcripts out

ffmpeg is the universal front-end for Whisper-family transcription; the prep step
is where transcription quality is silently won or lost.

## The canonical extraction

Whisper models consume 16 kHz mono. Resampling in ffmpeg (not in the STT tool) is
faster and deterministic:

```bash
ffmpeg -i in.mp4 -vn -ac 1 -ar 16000 -c:a pcm_s16le stt.wav

# no temp file — pipe raw PCM straight in (whisper.cpp shown):
ffmpeg -v error -i in.mp4 -vn -ac 1 -ar 16000 -f s16le - | whisper-cli -m model.bin -f -
```

## Pre-cleanup: what helps and what hurts

| Filter | Effect on STT accuracy |
|---|---|
| `loudnorm` / `dynaudnorm` | Helps quiet/uneven recordings — Whisper mis-segments very quiet audio |
| `highpass=f=100` | Helps rumble/handling noise; harmless otherwise |
| `afftdn` (denoise) | Helps **only** on genuinely noisy audio; on clean audio it smears consonants and *hurts* |
| Aggressive `silenceremove` | **Hurts** — Whisper uses silence for sentence segmentation; removing it merges sentences and breaks timestamps relative to the original media |

Rule: normalize loudness, high-pass at 100 Hz, denoise only when you can hear the
noise. Never strip silence from audio you'll want timestamps against.

## Chunking long audio

Chunk **on silence boundaries, never mid-word** — and overlap is unnecessary when
the boundaries are real silences:

```bash
python skills/ffmpeg-ops/scripts/detect-segments.py --silence --min-silence 0.6 \
  --json long.mp4 | jq -r '.data.speech[] | "\(.start) \(.end)"' |
while read -r s e; do
  ffmpeg -v error -ss "$s" -to "$e" -i long.mp4 -vn -ac 1 -ar 16000 \
    -c:a pcm_s16le "chunks/chunk_${s}.wav"
done
```

Chunk filenames carry the source offset, so chunk-local timestamps convert back to
source time by adding `s`. Group speech segments into ~5–10 min batches for
parallel transcription (one agent/process per batch).

## The transcript-JSON contract

Normalize every engine's output into this shape (the WhisperX word form) — it is
the contract that shot selection ([edit-as-code.md](edit-as-code.md)), cut
verification, caption timing, and overlay placement all read:

```json
{ "words": [
    { "word": "Hey",   "start": 1.02, "end": 1.50 },
    { "word": "it's",  "start": 1.90, "end": 2.04 }
  ],
  "segments": [ { "text": "Hey it's ...", "start": 1.02, "end": 3.38 } ] }
```

**ASR spelling is unreliable; timings are the product.** A name misheard as "Sark"
still carries correct timestamps — match phrases fuzzily, trust the times.

## Engine notes

- **whisper.cpp** — local, fast, no Python; word timestamps approximate (segment
  cross-fade heuristics).
- **faster-whisper** — local Python (CTranslate2), `word_timestamps=True`; good
  default.
- **WhisperX** — adds wav2vec2 forced alignment on top of Whisper: word timestamps
  to ±50 ms (vanilla Whisper ≈ ±500 ms), plus VAD pre-filter and optional
  diarization. **Use when timestamps drive cuts or captions.**
- Managed APIs (ElevenLabs, Deepgram, AssemblyAI) — fine; normalize their response
  into the contract above.

## Round trip to subtitles

STT output → SRT/VTT → mux or burn ([subtitles.md](subtitles.md)):

```bash
# most engines emit SRT directly; converting is one command anyway:
ffmpeg -i transcript.vtt captions.srt
ffmpeg -i in.mp4 -i captions.srt -map 0 -map 1 -c copy -c:s mov_text captioned.mp4
```

## The summarisation pipeline (daily-driver workflow)

```
source (file or ytdlp audio-only) 
  → ffmpeg 16k mono extraction (above)
  → transcribe (engine of choice, word JSON)
  → THE AGENT summarises the transcript      ← ffmpeg's job ended one step ago
  → optional visual pass: detect-segments.py --scenes + a contact sheet
    (images-gif.md) → chapter list with thumbnails
```

For downloaded sources, prefer `yt-dlp -x --audio-format opus URL` (or
`--download-sections` for a time range) so you never pull video bytes you only
needed audio from.

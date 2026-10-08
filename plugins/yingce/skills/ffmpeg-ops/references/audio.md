# Audio — loudness, mixing, channels, repair

## Loudness (EBU R128)

Targets: **-14 LUFS** streaming platforms, **-16** podcasts, **-23** broadcast.
True peak ceiling -1.5 dBTP (-2 for lossy delivery).

One-pass `loudnorm` is *dynamic* mode (a compressor — pumps quiet passages). For
anything that ships, use two-pass **linear** mode; the measurement dance is
automated:

```bash
python skills/ffmpeg-ops/scripts/loudnorm-scan.py -I -16 in.mp4 --json \
  | jq -r '.data.pass2_command'
# prints the exact pass-2 ffmpeg command with measured_* values filled in
```

Check where you stand without changing anything:

```bash
ffmpeg -i in.mp4 -af ebur128 -f null - 2>&1 | tail -12   # integrated I, LRA, peaks
```

`loudnorm` outputs 192 kHz internally — always pair with `-ar 48000`.

## Mixing and ducking

```bash
# voice over music, music ducked 12dB whenever voice is present (sidechain):
ffmpeg -i voice.wav -i music.mp3 -filter_complex \
  "[1:a][0:a]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=400[duck];
   [0:a][duck]amix=inputs=2:duration=first:normalize=0[a]" \
  -map "[a]" -c:a aac mixed.m4a

# plain mix at set levels (amix halves inputs unless normalize=0):
-filter_complex "[1:a]volume=0.25[m];[0:a][m]amix=inputs=2:duration=first:normalize=0[a]"

# concatenate audio files losslessly (same codec) / with re-encode:
ffmpeg -f concat -safe 0 -i list.txt -c copy out.mp3
-filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[a]"
```

## Channels

```bash
# stereo -> mono (downmix), mono -> "stereo" (duplicate):
-ac 1                                  # downmix
-ac 2                                  # duplicate mono to both

# keep ONE channel of a stereo file (e.g. lav mic on left only):
-af "pan=mono|c0=c0"                   # left;  c0=c1 for right

# swap channels / manual stereo from two mono files:
-af "pan=stereo|c0=c1|c1=c0"
ffmpeg -i L.wav -i R.wav -filter_complex "[0:a][1:a]join=inputs=2:channel_layout=stereo[a]" -map "[a]" out.wav

# pick the 3rd audio track from a multi-track recording (OBS etc.):
-map 0:a:2
```

## Sync repair

```bash
# audio late by 300ms -> advance it (itsoffset on the AUDIO input):
ffmpeg -i in.mp4 -itsoffset -0.3 -i in.mp4 -map 0:v -map 1:a -c copy fixed.mp4
# constant drift (audio runs long) -> resample-stretch:
-af "atempo=1.001"      # tune factor = video_duration / audio_duration
```

## Repair & cleanup

```bash
-af "highpass=f=100"                              # rumble/handling noise
-af "afftdn=nf=-25"                               # broadband denoise (use ears; see stt-whisper.md caveat)
-af "adeclick"                                    # vinyl/mouth clicks
-af "deesser"                                     # sibilance
-af "compand=attacks=0.05:decays=0.3:points=-80/-80|-45/-15|-27/-9|0/-7|20/-7"  # leveler for speech
-af "alimiter=limit=0.97"                         # brickwall before lossy encode
```

Order matters: **subtractive first** (highpass → denoise → declick), then dynamics
(compand), then loudness (loudnorm), limiter last.

## Format notes

- Sample rate: keep 48 kHz for video work (44.1 kHz is a music-CD convention;
  mixing the two invites resample drift in long files).
- `aresample=async=1` repairs streams with small timestamp gaps (common in
  screen-recorder output) — add it when concat output crackles at boundaries.
- Bit depth: `pcm_s16le` for interchange, `pcm_s24le` when the source is 24-bit;
  never "upgrade" 16→24 (it's free silence).

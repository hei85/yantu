# Edit-as-Code — EDL-driven editing

The pattern behind Anthropic's Fable launch video (edited entirely through Claude
Code — transcription → shot-selection JSON → ffmpeg → LUTs, no NLE): **the edit is
files, not timeline state.** Every stage's output is a reviewable, rerunnable,
diffable artifact.

## The pipeline

```
raw takes (+ script if scripted)
  │
  ▼ 1 TRANSCRIBE   word-level JSON per take          → work/transcripts/*.json
  ▼ 2 SELECT       reason over transcripts            → work/final-edit.json (EDL)
  ▼ 3 CUT          cut-from-edl.py --execute          → work/edl-cuts/ + final.mp4
  ▼ 4 VERIFY       re-transcribe the output           → no clipped words, no filler
  ▼ 5 GRADE        gen-luts.py + HUMAN picks          → graded.mp4
  ▼ 6 PACKAGE      loudnorm pass-2, faststart, gates  → deliverable
```

Stages 5–6 are [color-grading.md](color-grading.md) and
[audio.md](audio.md)/[quality-metrics.md](quality-metrics.md); transcription is
[stt-whisper.md](stt-whisper.md). This file owns stages 2–4.

## The EDL is the deliverable artifact

Schema: [../assets/edl-schema.json](../assets/edl-schema.json). The load-bearing
field is `selection_rationale` — *why* each take won, written down:

```json
{
  "scene": 1,
  "title": "Part 1: Intro",
  "candidate_takes": ["C001", "C002", "C003", "C017 (re-shoot)"],
  "selection_rationale": "C017 disqualified - 5.8s dead pause mid-sentence. C003 is the cleanest complete take: zero ums, clean ending.",
  "clips": [{ "file": "takes/A004C003.mp4", "start": 1.89, "end": 60.81,
              "first_words": "Hey everyone, it's..." }]
}
```

A reviewer reads the rationale instead of scrubbing footage. Git diffs of the EDL
*are* the edit history. Re-running `cut-from-edl.py` regenerates the output
identically.

## Shot-selection heuristics (multi-take footage)

The agent reasons over **transcripts, not frames** — it cannot watch video. Per
scene, read every candidate take's transcript and apply:

- **Fewest filler words** ("um", "uh", restarts) wins, all else equal.
- **Prefer later takes** — speakers warm up; the last full take is usually best.
- **Disqualify** takes with dead pauses > ~2 s mid-sentence or that never complete
  the scripted line.
- **Trim warm-up openers** ("Hey [name]…" used to start a sentence warm): cut at
  the silent gap *after* the warm-up, never mid-word.
- Record disqualifications in the rationale too — the search space is part of the
  review.

For many scenes, fan out one agent per scene (each reads only its candidates) and
have a verifier pass check the assembled EDL — this maps directly onto the
Workflow tool's pipeline+verify pattern.

## The two verification rules

**1. Every cut boundary must land in silence.** Words are clipped by cuts that
"look right" numerically. Mechanically check each in/out against measured silence:

```bash
python skills/ffmpeg-ops/scripts/detect-segments.py --silence --json take.mp4 \
  | jq --argjson t 60.81 '.data.silences[] | select(.start <= $t and .end >= $t)'
# empty result = the proposed cut at 60.81 is NOT in silence — move it
```

**2. Re-transcribe the output.** After `cut-from-edl.py --execute`, run the final
video back through transcription and assert: every scene's `first_words` appears,
no filler words survived, no sentence is truncated at a boundary. This catches
off-by-keyframe and timestamp-unit errors that no amount of EDL review will.

## Cut mode choice

`cut-from-edl.py` re-encodes by default (frame-accurate, normalizes mixed sources,
concat always safe). Use `--copy` only when the EDL was authored against measured
keyframes (`probe-media.py --keyframes-near` for every in-point) — e.g. when the
source is an all-intra mezzanine ([encoding.md](encoding.md)).

## Human gates

Taste calls stay human: the grade pick ([color-grading.md](color-grading.md)),
final timing, sound design. The agent's job ends at presenting options with
evidence — never auto-select past these gates.

# Filtergraphs — syntax, labels, chains, and the patterns that need them

## Grammar in 60 seconds

```
-vf  "f1=a=1:b=2,f2"                 simple: one video chain, commas join filters
-af  "f1,f2"                          same for audio
-filter_complex "[0:v]f1[x];[x][1:v]f2[out]"   multiple inputs/outputs need labels
```

- `,` chains filters; `;` separates parallel chains.
- `[0:v]` `[1:a]` = input file 0's video, file 1's audio. `[label]` = your wire.
- Every labeled output must be consumed (or `-map`ped). Unconsumed = error.
- One stream cannot feed two filters — `split`/`asplit` it first.
- `-vf`/`-af` and `-filter_complex` are mutually exclusive per stream; filters and
  `-c copy` are mutually exclusive, full stop.

**Escaping (three layers deep):** the filter arg parser eats `:` and `,`, the
graph parser eats `;` and `[]`, then your shell takes a pass. Inside a filter
argument, escape with `\` (e.g. `drawtext=text='1\:30'`). Avoid the whole topic
where possible: relative paths for files, single-quoted graphs (bash *and*
PowerShell), no spaces in asset names.

## split — the fan-out primitive

```bash
# blurred-background vertical (one decode, two consumers):
-filter_complex "[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20[bg];[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2"
```

## Common graph patterns

```bash
# picture-in-picture, top-right, 1/4 size
-filter_complex "[1:v]scale=iw/4:-1[pip];[0:v][pip]overlay=W-w-24:24"

# overlay visible only between 5s and 12s
-filter_complex "[0:v][1:v]overlay=24:24:enable='between(t,5,12)'"

# crossfade two clips (1s, starting at 4s into clip A) — video and audio
-filter_complex "[0:v][1:v]xfade=transition=fade:duration=1:offset=4[v];[0:a][1:a]acrossfade=d=1[a]"

# side-by-side A/B (heights must match; scale first if not)
-filter_complex "[0:v][1:v]hstack"
# 2x2 grid
-filter_complex "[0:v][1:v][2:v][3:v]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0"
```

## Time manipulation

```bash
# constant speed: video PTS x factor, audio atempo (0.5-100; chain for <0.5)
-filter_complex "[0:v]setpts=0.5*PTS[v];[0:a]atempo=2.0[a]"      # 2x
-filter_complex "[0:v]setpts=4*PTS[v];[0:a]atempo=0.5,atempo=0.5[a]"  # 0.25x

# speed RAMP (slow-mo a highlight 10-12s, normal speed around it): cut three
# ranges with trim/atrim, retime the middle, concat — see trim-concat.md's
# remove-middle pattern with setpts=2*PTS added to the middle chain.

# interpolated 60fps slow-mo (synthesizes frames; slow, occasionally wobbly
# around fast motion — check the output)
-vf "minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:vsbmc=1,setpts=2*PTS" -an
```

## Expressions

Filter args accept expressions: `t` (seconds), `n` (frame), `w/h`/`iw/ih` (sizes),
`main_w/overlay_w` in overlay. Useful forms:

```bash
overlay=x='if(gte(t,3),24,-w)'         # slide in at t=3
drawtext=...:x=(w-text_w)/2:y=h-th-40  # centered lower third
select='not(mod(n,30))'                # every 30th frame
fade=t=in:st=0:d=1,fade=t=out:st=9:d=1 # fade in/out (10s clip)
```

## Per-filter docs without leaving the terminal

```bash
ffmpeg -h filter=xfade        # all options + ranges for one filter
ffmpeg -filters | rg blur     # discover what this build has
```

Niche corners worth knowing exist: `v360` (360°/VR re-projection), `geq` (per-pixel
expressions), `sendcmd` (timed parameter changes), `zmq` (live parameter control).

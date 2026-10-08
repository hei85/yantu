# Look recipes — matching named aesthetics

Known-good starting points for recognizable looks, plus the two techniques for
matching a look you can *see* but can't name (Hald-CLUT, scope-matching).
Workflow, scopes, and LUT machinery: [color-grading.md](color-grading.md) —
normalize log footage to Rec.709 FIRST, grade second.

Two delivery forms per look: **LUT** (consistent, reusable —
`gen-luts.py --variants <name>` where a parametric variant exists) and
**direct filter chain** (tweakable per shot). Values are starting points for
normal-exposure Rec.709; expect ±30% adjustment. `colorbalance` options are
per-band per-channel: `rs/gs/bs` shadows, `rm/gm/bm` midtones, `rh/gh/bh`
highlights, each −1..1.

**Skin-tone caveat** (verified on the Kodak test portraits): looks that deepen
shadows — kodachrome, noir, bleach bypass, day-for-night, horror — crush
facial detail in darker skin. Lift midtones first (`eq=gamma=1.05` to `1.15`
before the look) and verify on the waveform that face luma stays in the
~25–65% band. Always test a grade on the *darkest-skinned* person in the
footage, not the lightest.

**Contents:** [Film stocks & processes](#film-stocks--processes) ·
[Signature movie grades](#signature-movie-grades) ·
[Era looks](#era-looks) · [Genre & mood](#genre--mood) ·
[Stylized effects](#stylized-effects) ·
[Matching techniques](#matching-a-look-you-can-see-but-cant-name) ·
[At scale](#applying-any-of-this-at-scale)

## Film stocks & processes

### Kodachrome
High contrast that deepens in the shadows, warm reds, glowing skin — the
mid-century slide look:
```bash
-vf "curves=master='0/0 0.25/0.20 0.75/0.78 1/0.98',colorbalance=rh=.04:rm=.02,eq=saturation=1.15:contrast=1.08"
```
Scope: shadows genuinely DARK (waveform floor at 0), skin warm of the I-line.

### CineStill 800T (with halation)
Tungsten-cool base + the signature red-orange glow bleeding around bright
lights. The glow is a composite, not a color shift — extract highlights, blur,
tint red, screen-blend back:
```bash
# Three load-bearing details, all visually verified: (1) format=rgb24 pins the
# split — float filters like colortemperature push the negotiated format past
# 8-bit and the branch's auto-conversions then corrupt into a full-frame
# magenta wash; (2) the threshold is maxval-relative so it survives any bit
# depth; (3) u/v are forced neutral so only luminance carries into the halo.
# Scale sigma with resolution (~14 at 1080p); raise rr toward 1.5 for a
# stronger glow.
-filter_complex "[0:v]colortemperature=temperature=7800,eq=saturation=0.95,format=rgb24,split[a][b];[b]lutyuv=y='if(gt(val,0.78*maxval),val,0)':u='(maxval+minval)/2':v='(maxval+minval)/2',gblur=sigma=14,colorchannelmixer=rr=1:gg=0.3:bb=0.15[halo];[a][halo]blend=all_mode=screen"
```
Only reads as 800T on footage WITH point lights/neon in frame. Scope: cool
centroid, but red channel spikes hugging every highlight.

### Technicolor 2-strip (1920s)
The whole world collapses onto a red↔cyan axis (no blue/yellow existed):
```bash
-vf "colorchannelmixer=rr=1:gg=.6:gb=.4:bg=.4:bb=.6,eq=saturation=1.2:contrast=1.1"
```
LUT form: `gen-luts.py --variants technicolor2`. Skies go teal, lips go
lipstick-red, yellows die — that's correct, that's the look.

### Technicolor 3-strip (glorious era)
Lush saturated primaries, marble-glow skin, no cast:
```bash
-vf "vibrance=intensity=0.35,eq=contrast=1.12,curves=master='0/0.01 1/0.99'"
```
`vibrance` (not `eq=saturation`) is the point — it boosts muted colors while
protecting already-saturated skin.

### Fuji Eterna
The modern "cinema flat" — low saturation, low contrast, long highlight roll:
```bash
-vf "eq=saturation=0.82:contrast=0.92,curves=master='0/0.05 0.7/0.66 1/0.93'"
```

### Cross-process (E6-in-C41)
Green-yellow highlights, cyan-blue shadows, punchy contrast — the skate-video
look:
```bash
-vf "curves=r='0/0 0.5/0.42 1/0.95':g='0/0.03 0.5/0.52 1/1':b='0/0.12 0.5/0.50 1/0.85',eq=saturation=1.2:contrast=1.1"
```

### Sepia (the real matrix, not a tint)
```bash
-vf "colorchannelmixer=rr=.393:rg=.769:rb=.189:gr=.349:gg=.686:gb=.168:br=.272:bg=.534:bb=.131"
```
LUT form: `gen-luts.py --variants sepia`. For *toned* B&W instead (sepia
highlights, neutral shadows): `hue=s=0,colorbalance=rh=.12:gh=.06`.

### Vintage film fade (Kodachrome-adjacent print fade)
`gen-luts.py --variants film_fade`, or built-in `curves=preset=vintage`.
Waveform floor ~5–8%, never 0. Sell it with `,noise=alls=6:allf=t+u`.

## Signature movie grades

### Blockbuster teal & orange (Transformers-era default)
Skin warm, shadows teal — complementary separation. `gen-luts.py --variants
teal_orange`, or:
```bash
-vf "colorbalance=rs=-.06:bs=.08:rm=.04:bm=-.03:rh=.05:bh=-.06,eq=saturation=1.12"
```
Vectorscope: two lobes, skin ON the I-line. Fails on faceless footage and
tungsten interiors.

### Mad Max: Fury Road (graphic-novel chrome)
Not bleached apocalypse — the opposite: hyper-saturated teal/orange, crunchy
contrast, sharpened grit:
```bash
-vf "eq=saturation=1.4:contrast=1.25,colorbalance=rs=-.08:bs=.10:rm=.06:rh=.08:bh=-.08,unsharp=5:5:0.8"
```
(Night scenes in the film are graded BLUE day-for-night — combine with that
recipe below.)

### The Matrix (digital green)
Green pushed into midtones+shadows, slightly sick skin, crushed-but-readable:
```bash
-vf "colorbalance=gs=.05:gm=.08:gh=.03,eq=saturation=0.85:contrast=1.10,curves=master='0/0.02 1/0.95'"
```
LUT form: `gen-luts.py --variants matrix_green`.

### Fincher (Se7en/Gone Girl murk)
Cool, green-yellow undertone, HIGHLIGHTS PULLED DOWN (nothing ever blooms),
shadow detail retained:
```bash
-vf "colortemperature=temperature=6800,colorbalance=gs=.02:gm=.03:bh=-.04,eq=saturation=0.90:contrast=1.08,curves=master='0/0.01 0.8/0.72 1/0.90'"
```
Scope: waveform ceiling ~90%, never 100 — the pulled highlight IS the look.

### O Brother, Where Art Thou? (sepia wasteland)
The first full-DI grade: desaturated, golden-burnt, green grass turned hay:
```bash
-vf "eq=saturation=0.65,colorbalance=rm=.08:gm=.04:bm=-.08:rh=.06:bh=-.06,curves=master='0/0.03 1/0.95'"
```

### Amélie (golden Paris)
Warm gold + a deliberate green undertone, high saturation, cozy:
```bash
-vf "colorbalance=rm=.06:gm=.05:bm=-.06:gs=.04,eq=saturation=1.25:contrast=1.08"
```

### Blade Runner 2049 (orange smog)
A monochromatic orange ENVELOPE — everything breathes the same dust:
```bash
-vf "colorbalance=rm=.10:gm=.03:bm=-.12:rh=.08:bh=-.10,eq=saturation=0.90:contrast=1.05,curves=master='0/0.04 1/0.96'"
```
The interior-neon scenes are the [neon night](#neon-night--cyberpunk) recipe
instead — the film alternates the two.

### Twilight (melodrama blue)
The heavy blue wash:
```bash
-vf "colortemperature=temperature=9500,colorbalance=bs=.08:bm=.06,eq=saturation=0.75:contrast=1.05"
```

### In the Mood for Love (crimson & emerald)
Reds and greens saturated past realism, everything else muted — color as
character:
```bash
-vf "vibrance=intensity=0.5:rbal=1.6:gbal=1.2:bbal=0.4,eq=contrast=1.10,curves=master='0/0.02 1/0.97'"
```

### Fantastic Mr. Fox (autumn box)
The whole frame inside yellows/browns/oranges, cool tones nearly banned:
```bash
-vf "colorbalance=rm=.07:gm=.04:bm=-.10:rs=.03:bs=-.06:bh=-.08,eq=saturation=1.1:contrast=1.05"
```

## Era looks

### Golden hour / filmic warm
`gen-luts.py --variants golden_hour` (or `warm_filmic` subtler), or:
```bash
-vf "colortemperature=temperature=4400,colorbalance=rh=.05:rm=.03:bh=-.03,eq=saturation=1.08,curves=master='0/0.02 1/0.97'"
```
Whites stay ≤ ~10% off-center on the vectorscope; highlights unclipped.

### Pastel (Wes Anderson)
`gen-luts.py --variants pastel`, or:
```bash
-vf "eq=saturation=0.72:contrast=0.88:brightness=0.04,curves=master='0/0.08 1/0.92'"
```
Half art-direction — only reads on composed frames. Waveform lives in 8–92%.

### 70s cinema (warm faded New Hollywood)
Film-fade plus era warmth and soft contrast:
```bash
-vf "curves=master='0/0.06 1/0.92',colorbalance=rm=.05:gm=.02:bh=-.04,eq=saturation=0.92:contrast=0.96,noise=alls=7:allf=t+u"
```

### VHS / camcorder
Color is a third of it — softness and chroma error carry it:
```bash
-vf "eq=saturation=0.85:contrast=0.95,curves=master='0/0.06 1/0.94',gblur=sigma=0.6,chromashift=cbh=2:crh=-2,noise=alls=10:allf=t"
```
Full commitment: `scale=640:480,setsar=1` + `-ar 32000` audio.

## Genre & mood

### Film noir (B&W)
```bash
-vf "hue=s=0,eq=contrast=1.25:brightness=-0.02,vignette=PI/5"
```
LUT: `gen-luts.py --variants noir_bw` (+ `vignette` at apply time — spatial
ops don't fit in a LUT). Red-filter sky drama: `colorchannelmixer=.7:.2:.1`
before `hue=s=0`. Waveform must use the FULL range — noir is contrast.

### Bleach bypass (war grit)
`gen-luts.py --variants bleach_bypass`, or
`eq=saturation=0.45:contrast=1.3,unsharp=5:5:0.4`.

### Horror sick-green
Desaturated, green-poisoned shadows, everything slightly too dark:
```bash
-vf "colorbalance=gs=.05:gm=.04:rs=-.03,eq=saturation=0.70:contrast=1.15:brightness=-0.05"
```

### Grimdark battlefield (worked scope-extraction example)
Extracted from a real graded reference (a 1080p fantasy-series trailer) with
the [scope-matching ladder](#scope-matching-align-to-a-reference-clip-by-numbers)
run in reverse — measure the reference with `signalstats`, then tune until
your footage's numbers land in the same band. Measured (1,261 frames, cleaned
per the caveats below): **SATAVG ≈ 7** (vivid footage runs 30–60),
**UAVG 125.6 / VAVG 129.8** (a *warm-ash* cast — not blue), day exteriors
**YAVG ≈ 110** with global ≈ 58 (night scenes), blacks ≈ 7:
```bash
-vf "eq=saturation=0.33,colorbalance=rm=.02:gm=.012:bm=-.02,curves=master='0/0.03 0.5/0.42 1/0.95'"
```
LUT form: `gen-luts.py --variants grimdark` (calibrated to the day-exterior
key; deepen `curves` mids toward `0.5/0.30` for the night cluster). vs Nordic
noir: grimdark is warm-ash; Nordic is cool and flatter.

**Measuring a trailer (or any edited reference) honestly:**
1. **Crop the letterbox first** (`cropdetect`, then `crop=`) — baked bars drag
   every luma stat down.
2. **Drop fades/title cards**: filter per-frame stats to `YAVG > 25` before
   averaging, else cut transitions poison the mean.
3. **Expect scene clusters**: shows grade per scene-type (this reference's
   banquet interiors are warm amber, nothing like its exteriors). The
   *chroma fingerprint* (SATAVG + U/V cast) is usually consistent — transfer
   that globally; match *key* (YAVG) per scene-type, never to the global mean.
4. Verify a transfer by re-measuring the graded result:
   `ffmpeg -i graded.mp4 -vf signalstats,metadata=print:file=- -f null -`.

### Nordic noir (Scandinavian bleak)
Desaturated, cool, FLAT — the anti-blockbuster:
```bash
-vf "colortemperature=temperature=7500,eq=saturation=0.65:contrast=0.95,curves=master='0/0.04 1/0.90'"
```
vs Twilight blue: this one is low-contrast and barely saturated; Twilight is
a saturated blue *wash*.

### Romance soft glow
Warm, lifted, gentle bloom on highlights:
```bash
-filter_complex "[0:v]colorbalance=rh=.04:rm=.02,eq=saturation=1.05:contrast=0.94,curves=master='0/0.05 1/0.97'[base];[base]split[a][b];[b]gblur=sigma=8[soft];[a][soft]blend=all_mode=screen:all_opacity=0.18"
```

### Neon night / cyberpunk
```bash
-vf "eq=saturation=1.25:contrast=1.1,colorbalance=bs=.15:bm=.05:rs=-.05,curves=b='0/0.08 1/1':r='0/0 1/0.95'"
```
Needs practicals/neon in frame; on daylight it's just a bad cool cast.

### Day-for-night
```bash
-vf "eq=brightness=-0.15:saturation=0.55,colorbalance=bs=0.25:bm=0.12,curves=master='0/0 0.7/0.45 1/0.8'"
```
No visible sky/sun, no blown highlights, or it never sells.

## Stylized effects

### Sin City selective color
Everything monochrome EXCEPT one hue (`colorhold` keeps a color, greys the
rest):
```bash
-vf "colorhold=color=red:similarity=0.35:blend=0.1,eq=contrast=1.3"
```
Works for any anchor color (`color=0x00a0ff` etc.). High-contrast B&W base is
what makes the held color violent.

### Tone maps: monotone / duotone / tritone
One mechanism, three intensities: desaturate, then re-map the tonal axis onto
2 or 3 color stops with per-channel curves. **Chroma of the look = how far the
stops sit from the neutral grey axis** — monotones barely leave it (darkroom
chemical tones), muted duotones use tertiary/greyed pairs, poster duotones
live far out. Every variant below is also a parametric LUT:
`gen-luts.py --variants mono_selenium,tri_tobacco --previews footage.mp4`.

The chain template (3 stops; drop the `0.5/` midpoints for a 2-stop duotone —
stop values are the color's channels /255):
```bash
-vf "hue=s=0,curves=r='0/<Rs> 0.5/<Rm> 1/<Rh>':g='0/<Gs> 0.5/<Gm> 1/<Gh>':b='0/<Bs> 0.5/<Bm> 1/<Bh>'"
# worked example — selenium monotone:
-vf "hue=s=0,curves=r='0/0.05 0.5/0.48 1/0.96':g='0/0.04 0.5/0.46 1/0.95':b='0/0.07 0.5/0.52 1/0.97'"
```

| Variant | Stops (shadow → [mid →] highlight) | Use |
|---|---|---|
| **Monotones** (single chemical tone, near-grey chroma) | | |
| `mono_selenium` | (.05,.04,.07) → (.48,.46,.52) → (.96,.95,.97) | Fine-print B&W with the cool violet selenium whisper |
| `mono_platinum` | (.07,.07,.06) → (.52,.51,.49) → (.97,.96,.94) | Warm-neutral platinum print; the most archival-looking B&W |
| `mono_coffee` | (.08,.05,.03) → (.55,.47,.40) → (.96,.92,.87) | Warm brown tone, gentler than sepia |
| `mono_steel` | (.04,.06,.09) → (.46,.50,.55) → (.94,.96,.98) | Cool documentary B&W |
| **Muted duotones** (tertiary pairs) | | |
| `duo_ash_rose` | (.23,.20,.22) → (.85,.78,.76) | Fashion/editorial soft; flattering on skin |
| `duo_olive_bone` | (.18,.20,.14) → (.90,.88,.81) | Field/military/heritage |
| `duo_petrol_paper` | (.12,.23,.24) → (.93,.91,.86) | Calm tech/industrial editorial |
| `duo_indigo_parchment` | (.16,.23,.33) → (.91,.89,.82) | Faded-cyanotype archival — the muted cousin of `duo_cyanotype` |
| `duo_slate_ice` | (.11,.15,.20) → (.95,.97,.98) | Corporate/tech-keynote neutral |
| **Poster duotones** (high chroma, deliberate) | | |
| `duo_navy` | (.05,.08,.25) → (.98,.93,.80) | Editorial/magazine classic |
| `duo_cyanotype` | (.04,.16,.29) → (.92,.96,1.0) | Blueprint/architectural |
| `duo_sunset` | (.23,.06,.36) → (1.0,.78,.34) | Festival poster |
| `duo_forest` | (.06,.24,.18) → (.91,.85,.63) | Organic/outdoor brand |
| `duo_crimson` | (.10,.02,.03) → (1.0,.88,.86) | Sports/thriller key art |
| `duo_synthwave` | (.35,.06,.42) → (.42,.91,1.0) | Retro-tech/vaporwave |
| **Tritones** (distinct shadow/mid/highlight hues) | | |
| `tri_split_classic` | (.06,.07,.12) → (.50,.49,.48) → (.98,.94,.86) | THE darkroom split: cool shadows, neutral mids, warm highlights |
| `tri_tobacco` | (.05,.04,.02) → (.45,.40,.28) → (.95,.88,.70) | Western/whiskey-ad warmth with real blacks |
| `tri_arctic` | (.03,.05,.09) → (.42,.50,.58) → (.93,.97,1.0) | Expedition/documentary cold |

Tuning rules: contrast BEFORE the map widens the spread
(`eq=contrast=1.1,hue=s=0,...`); to mute any variant, pull its stops toward
the grey diagonal (average each stop with its own luma); the mid stop is where
skin lives — keep it near-neutral unless the face *is* the poster.

## Matching a look you can see but can't name

### Hald-CLUT: grade one frame anywhere, get a video LUT for free
A Hald image is a LUT unrolled into a PNG — any **global** color edit applied
to it becomes applicable to video:

```bash
# 1. identity Hald (level 8 = 64^3 lattice)
ffmpeg -f lavfi -i haldclutsrc=8 -frames:v 1 hald.png
# 2. open hald.png in ANY photo editor with a still from your footage; design
#    the look on the still; apply the IDENTICAL adjustments to hald.png
# 3. the edited Hald IS your LUT:
ffmpeg -i in.mp4 -i hald_graded.png -filter_complex "[0:v][1:v]haldclut" \
  -c:v libx264 -crf 18 -c:a copy graded.mp4
```

**Stealing a look**: any editor preset / Lightroom recipe / .acv curve applied
to the Hald identity is thereby extracted as a LUT. Photoshop curves apply
directly too: `curves=psfile=their_grade.acv`.

**The one rule**: only GLOBAL color ops survive — curves, levels, WB, HSL,
balance, saturation. Spatial ops (vignette, sharpen, local contrast, dehaze,
grain, healing) corrupt the lattice; do those in the filter chain.

Fidelity note: visually identical, not bit-identical — the 8-bit lattice
quantizes (measured SSIM ≈ 0.95 vs the same chain applied directly). For very
steep curves prefer the direct chain or a 16-bit TIFF Hald.

### Scope-matching: align to a reference clip by numbers
ffmpeg has no automatic shot-matcher. **The governing rule: transfer the
chroma fingerprint (SATAVG + U/V cast) globally — it's what stays constant
across a graded work; match key (YAVG) per scene-type, never to the global
mean** (night scenes drag any edited reference's average far below what a
day scene should hit — see the grimdark example's measurement checklist).
The manual ladder (scope views from [color-grading.md](color-grading.md),
reference and target side-by-side via `hstack`):

1. **Black/white points** (waveform): `curves=master='0/<floor> 1/<ceil>'`.
2. **Midtone brightness** (waveform mass): `eq=gamma=`.
3. **Cast** (vectorscope centroid): `colortemperature` + `colorbalance`.
4. **Saturation** (vectorscope spread): `eq=saturation=`.
5. **Verify on skin**: both clips' faces hug the I-line equally.

Order matters — each step changes the reading of the ones after it; never
start with saturation.

## Applying any of this at scale

One look across a project = bake the chain into a LUT once (`gen-luts.py`
variant, or render the chain through a Hald identity and use `haldclut`
everywhere). Match per-clip exposure FIRST with `eq`, apply the shared look
second — the batch-consistency section of [color-grading.md](color-grading.md).
Composite looks (halation, bloom) keep their spatial half in the filter chain;
only their color half bakes into the LUT.

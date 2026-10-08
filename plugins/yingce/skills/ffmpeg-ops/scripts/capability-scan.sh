#!/usr/bin/env bash
# What can THIS ffmpeg build actually do — encoders, hwaccels, key filters.
#
# Listing an encoder is not the same as it working: hardware encoders (NVENC/QSV/
# AMF/VideoToolbox/VAAPI) routinely appear in `-encoders` yet fail at runtime on
# driver/device mismatches. Default mode therefore PROOF-ENCODES 10 frames of
# lavfi testsrc2 through every present hw encoder; --quick skips that (list-only).
#
# Usage:   capability-scan.sh [--quick] [--json] [-q]
# Input:   none (inspects the ffmpeg on PATH)
# Output:  stdout = TSV records (kind, name, listed, verified), or --json envelope
#          (schema claude-mods.ffmpeg-ops.capability/v1)
# Stderr:  headers, progress, errors
# Exit:    0 ok, 2 usage, 5 ffmpeg missing (jq missing for --json),
#          10 at least one LISTED hw encoder FAILED its proof-encode
#
# Examples:
#   capability-scan.sh
#   capability-scan.sh --quick
#   capability-scan.sh --json | jq '.data.encoders[] | select(.hw and .listed)'
#   capability-scan.sh --json | jq -r '.data.recommended_hw // "none"'

set -uo pipefail

EXIT_OK=0; EXIT_USAGE=2; EXIT_MISSING_DEP=5; EXIT_FAILED_VERIFY=10
SCHEMA="claude-mods.ffmpeg-ops.capability/v1"

QUICK=0; JSON=0; QUIET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick)    QUICK=1 ;;
    --json)     JSON=1 ;;
    -q|--quiet) QUIET=1 ;;
    -h|--help)  sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit "$EXIT_OK" ;;
    *) echo "ERROR: unknown argument: $1 (try --help)" >&2; exit "$EXIT_USAGE" ;;
  esac
  shift
done

command -v ffmpeg >/dev/null 2>&1 || {
  [[ "$JSON" -eq 1 ]] && echo '{"error":{"code":"MISSING_DEPENDENCY","message":"ffmpeg not on PATH"}}'
  echo "ERROR: ffmpeg not found on PATH" >&2; exit "$EXIT_MISSING_DEP"; }
HAS_JQ=0; command -v jq >/dev/null 2>&1 && HAS_JQ=1
[[ "$JSON" -eq 1 && "$HAS_JQ" -eq 0 ]] && {
  echo '{"error":{"code":"MISSING_DEPENDENCY","message":"jq required for --json"}}'
  echo "ERROR: jq required for --json" >&2; exit "$EXIT_MISSING_DEP"; }

emit() { [[ "$QUIET" -eq 1 ]] && return 0; printf '%s\n' "$1" >&2; }

VERSION="$(ffmpeg -hide_banner -version 2>/dev/null | head -1)"
ENCODERS_RAW="$(ffmpeg -hide_banner -encoders 2>/dev/null)"
HWACCELS="$(ffmpeg -hide_banner -hwaccels 2>/dev/null | tail -n +2 | tr -d ' ' | grep -v '^$' || true)"
FILTERS_RAW="$(ffmpeg -hide_banner -filters 2>/dev/null)"

emit "== capability-scan: $VERSION"

# Hardware encoders worth knowing about, in rough preference order per vendor.
HW_ENCODERS=(h264_nvenc hevc_nvenc av1_nvenc
             h264_qsv hevc_qsv av1_qsv
             h264_amf hevc_amf av1_amf
             h264_videotoolbox hevc_videotoolbox
             h264_vaapi hevc_vaapi av1_vaapi)
# Software encoders + filters the cookbook leans on.
SW_ENCODERS=(libx264 libx265 libsvtav1 libaom-av1 libvpx-vp9 aac libopus libmp3lame ffv1)
KEY_FILTERS=(scale crop pad overlay drawtext subtitles loudnorm silencedetect
             silenceremove lut3d curves eq zscale tonemap minterpolate vidstabdetect
             vidstabtransform bwdif hqdn3d nlmeans palettegen paletteuse libvmaf
             ssim psnr xstack showwaves showspectrum)

# Flags-column width varies across ffmpeg majors (3 chars <=7.x, 2 in 8.x).
listed_encoder() { grep -qE "^ [A-Z.]{6} +$1 " <<<"$ENCODERS_RAW"; }
listed_filter()  { grep -qE "^ +[A-Z.|]+ +$1 +" <<<"$FILTERS_RAW"; }

proof_encode() { # $1 = encoder name; returns 0 verified, 1 failed
  local enc="$1" extra=()
  case "$enc" in
    *_vaapi) extra=(-vaapi_device /dev/dri/renderD128 -vf format=nv12,hwupload) ;;
    *_qsv)   extra=(-vf format=nv12) ;;
  esac
  ffmpeg -v error -y -f lavfi -i testsrc2=duration=1:size=640x360:rate=30 \
    "${extra[@]+"${extra[@]}"}" -frames:v 10 -c:v "$enc" -f null - >/dev/null 2>&1
}

failed_verify=0
ROWS=()           # tsv rows for stdout
JSON_ENC=()       # jq-built objects
RECOMMENDED=""

for enc in "${HW_ENCODERS[@]}"; do
  listed=false verified=null
  if listed_encoder "$enc"; then
    listed=true
    if [[ "$QUICK" -eq 1 ]]; then
      verified=null
      emit "   hw  $enc  listed (proof-encode skipped: --quick)"
    elif proof_encode "$enc"; then
      verified=true
      [[ -z "$RECOMMENDED" ]] && RECOMMENDED="$enc"
      emit "   hw  $enc  VERIFIED"
    else
      verified=false; failed_verify=1
      emit "   hw  $enc  LISTED BUT FAILED proof-encode (driver/device mismatch?)"
    fi
  fi
  ROWS+=("$(printf 'encoder\t%s\thw\t%s\t%s' "$enc" "$listed" "$verified")")
  [[ "$HAS_JQ" -eq 1 ]] && JSON_ENC+=("$(jq -cn --arg n "$enc" --argjson l "$listed" \
      --argjson v "$verified" '{name:$n, hw:true, listed:$l, verified:$v}')")
done

for enc in "${SW_ENCODERS[@]}"; do
  listed=false; listed_encoder "$enc" && listed=true
  ROWS+=("$(printf 'encoder\t%s\tsw\t%s\tnull' "$enc" "$listed")")
  [[ "$HAS_JQ" -eq 1 ]] && JSON_ENC+=("$(jq -cn --arg n "$enc" --argjson l "$listed" \
      '{name:$n, hw:false, listed:$l, verified:null}')")
done

JSON_FILT=()
missing_filters=()
for f in "${KEY_FILTERS[@]}"; do
  present=false; listed_filter "$f" && present=true
  [[ "$present" == false ]] && missing_filters+=("$f")
  ROWS+=("$(printf 'filter\t%s\t-\t%s\tnull' "$f" "$present")")
  [[ "$HAS_JQ" -eq 1 ]] && JSON_FILT+=("$(jq -cn --arg n "$f" --argjson p "$present" \
      '{name:$n, present:$p}')")
done

[[ ${#missing_filters[@]} -gt 0 ]] && \
  emit "   note: filters not in this build: ${missing_filters[*]}"

if [[ "$JSON" -eq 1 ]]; then
  printf '%s\n' "${JSON_ENC[@]}" | jq -s \
    --arg version "$VERSION" --arg schema "$SCHEMA" \
    --arg rec "$RECOMMENDED" --argjson quick "$([[ $QUICK -eq 1 ]] && echo true || echo false)" \
    --argjson hwaccels "$(printf '%s\n' $HWACCELS | jq -Rn '[inputs | select(length>0)]')" \
    --argjson filters "$(printf '%s\n' "${JSON_FILT[@]}" | jq -s '.')" \
    '{data:{version:$version, quick:$quick, hwaccels:$hwaccels, encoders:.,
            filters:$filters, recommended_hw:(if $rec=="" then null else $rec end)},
      meta:{schema:$schema}}'
else
  printf '%s\n' "${ROWS[@]}"
fi

[[ "$failed_verify" -eq 1 ]] && exit "$EXIT_FAILED_VERIFY"
exit "$EXIT_OK"

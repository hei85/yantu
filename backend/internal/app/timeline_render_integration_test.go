package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestTimelineRenderGraphEmbedsAudioAndSubtitleAtRequestedRatio(t *testing.T) {
	ffmpeg := requireCommand(t, "ffmpeg")
	ffprobe := requireCommand(t, "ffprobe")
	dir := t.TempDir()
	source := filepath.Join(dir, "source.mp4")
	runCommand(t, ffmpeg,
		"-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=24:d=2",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source)

	plan := buildRenderPlan(renderProject{
		Version:     2,
		AudioPolicy: "independent",
		Tracks:      []renderTrack{{ID: "video", Kind: "video"}, {ID: "audio", Kind: "audio"}, {ID: "subtitle", Kind: "subtitle"}},
		Clips: []renderClip{
			renderClipFixture("shot-1", "video", "video", 0, 2000, "resource:fixture"),
			{ID: "voice", Kind: "audio", TrackID: "audio", StartMs: 250, DurationMs: 1200, Volume: float64Fixture(0.5), DirectMedia: &struct {
				ID         string `json:"id"`
				Kind       string `json:"kind"`
				StorageKey string `json:"storageKey"`
			}{ID: "voice", Kind: "audio", StorageKey: "resource:fixture"}},
			{ID: "dialogue-subtitle", Kind: "subtitle", TrackID: "subtitle", StartMs: 250, DurationMs: 1200, Text: "你好，世界。"},
		},
		DurationMs: 2000,
	}, renderOutputSpec{Width: 360, Height: 640, FPSNumerator: 24, FPSDenominator: 1, SampleRate: 48000})
	if plan.Error != "" {
		t.Fatalf("plan error: %s", plan.Error)
	}
	plan.Segments[0].Source = &renderSource{ResourceID: "fixture", Path: source, HasAudio: true}
	for index := range plan.Audio {
		plan.Audio[index].Source = &renderSource{ResourceID: "fixture", Path: source, HasAudio: true}
	}
	if err := probePlanAudio(context.Background(), ffprobe, &plan); err != nil {
		t.Fatalf("probe audio policy: %v", err)
	}
	if len(plan.Audio) != 1 || plan.Audio[0].Clip.ID != "voice" {
		t.Fatalf("independent mix contains embedded video audio: %#v", plan.Audio)
	}
	if len(plan.AudioObservations) != 2 || !plan.AudioObservations[0].HasAudio || plan.AudioObservations[0].IncludedInMix || !plan.AudioObservations[1].IncludedInMix {
		t.Fatalf("audio observations = %#v", plan.AudioObservations)
	}
	output := filepath.Join(dir, "out.mp4")
	subtitlePath := filepath.Join(dir, "subtitles.srt")
	if err := os.WriteFile(subtitlePath, []byte(plan.SubtitleSRT), 0o600); err != nil {
		t.Fatalf("write subtitles: %v", err)
	}
	args, err := buildRenderFFmpegArgs(plan, output, subtitlePath)
	if err != nil {
		t.Fatalf("build args: %v", err)
	}
	runCommand(t, ffmpeg, args...)
	report, err := probeMediaFile(context.Background(), ffprobe, output)
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if report.VideoStreams != 1 || report.AudioStreams != 1 || report.SubtitleStreams != 1 {
		t.Fatalf("streams = video:%d audio:%d subtitle:%d, want 1/1/1", report.VideoStreams, report.AudioStreams, report.SubtitleStreams)
	}
	if report.Width != 360 || report.Height != 640 {
		t.Fatalf("size = %dx%d, want 360x640", report.Width, report.Height)
	}
	if report.DurationMs < 1850 || report.DurationMs > 2100 {
		t.Fatalf("duration = %dms, want about 2000ms", report.DurationMs)
	}
}

func TestResourceProbeDecodesVideoStartMiddleAndEndSamples(t *testing.T) {
	ffmpeg := requireCommand(t, "ffmpeg")
	dir := t.TempDir()
	source := filepath.Join(dir, "sample.mp4")
	runCommand(t, ffmpeg,
		"-v", "error", "-f", "lavfi", "-i", "color=c=green:s=160x90:r=24:d=2",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", source)

	samples, err := decodeVideoFrameSamples(context.Background(), ffmpeg, source, dir, 2000)
	if err != nil {
		t.Fatalf("decode video samples: %v", err)
	}
	wantPositions := []string{"start", "middle", "end"}
	if len(samples) != len(wantPositions) {
		t.Fatalf("samples = %#v, want %d positions", samples, len(wantPositions))
	}
	for index, sample := range samples {
		if sample.Position != wantPositions[index] || !sample.Decoded || sample.ImageBytes <= 8 {
			t.Fatalf("sample[%d] = %#v, want decoded %s frame", index, sample, wantPositions[index])
		}
	}
}

func TestTimelineRenderGraphTreatsVolumeZeroAsIntentionalSilence(t *testing.T) {
	plan := buildRenderPlan(renderProject{
		Version: 2,
		Tracks:  []renderTrack{{ID: "video", Kind: "video"}, {ID: "audio", Kind: "audio", Muted: true}},
		Clips: []renderClip{
			renderClipFixture("shot-1", "video", "video", 0, 1000, "resource:fixture"),
			{ID: "silent", Kind: "audio", TrackID: "audio", StartMs: 0, DurationMs: 1000, Volume: float64Fixture(0), DirectMedia: &struct {
				ID         string `json:"id"`
				Kind       string `json:"kind"`
				StorageKey string `json:"storageKey"`
			}{ID: "silent", Kind: "audio", StorageKey: "resource:fixture"}},
		},
	}, renderOutputSpec{})
	if plan.Error != "" {
		t.Fatalf("plan error: %s", plan.Error)
	}
	for _, audio := range plan.Audio {
		if audio.Clip.ID == "silent" {
			t.Fatalf("volume=0 clip entered audio mix: %#v", audio)
		}
	}
}

func TestTimelineAudioPolicySeparatesIndependentAndMixedAudio(t *testing.T) {
	video := renderClipFixture("shot-1", "video", "video", 0, 1000, "resource:video")
	voice := renderClipFixture("voice-1", "audio", "audio", 0, 1000, "resource:voice")
	independent := buildRenderPlan(renderProject{
		Version: 2, AudioPolicy: "independent",
		Tracks: []renderTrack{{ID: "video", Kind: "video"}, {ID: "audio", Kind: "audio"}},
		Clips:  []renderClip{video, voice}, DurationMs: 1000,
	}, renderOutputSpec{})
	if independent.Error != "" || len(independent.Audio) != 1 || independent.Audio[0].Clip.ID != "voice-1" {
		t.Fatalf("independent audio plan = %#v", independent)
	}

	mixed := buildRenderPlan(renderProject{
		Version: 2, AudioPolicy: "mixed", RequireNativeAudio: true,
		Tracks: []renderTrack{{ID: "video", Kind: "video"}, {ID: "audio", Kind: "audio"}},
		Clips:  []renderClip{video, voice}, DurationMs: 1000,
	}, renderOutputSpec{})
	if mixed.Error != "" || len(mixed.Audio) != 2 || !mixed.RequireNativeAudio {
		t.Fatalf("mixed audio plan = %#v", mixed)
	}
}

func TestTimelineAudioProbeUsesObservedStreamsAndRequiresPlannedNativeAudio(t *testing.T) {
	ffmpeg := requireCommand(t, "ffmpeg")
	ffprobe := requireCommand(t, "ffprobe")
	dir := t.TempDir()
	source := filepath.Join(dir, "silent-video.mp4")
	runCommand(t, ffmpeg,
		"-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=24:d=1",
		"-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", source)

	makeVideoClip := func(id string, startMs int64) renderClip {
		return renderClipFixture(id, "video", "video", startMs, 500, "resource:silent")
	}
	project := renderProject{
		Version: 2, AudioPolicy: "native", RequireNativeAudio: true,
		Tracks: []renderTrack{{ID: "video", Kind: "video"}},
		Clips:  []renderClip{makeVideoClip("shot-1", 0)}, DurationMs: 500,
	}
	plan := buildRenderPlan(project, renderOutputSpec{})
	plan.Segments[0].Source = &renderSource{ResourceID: "silent", Path: source}
	plan.Audio[0].Source = &renderSource{ResourceID: "silent", Path: source}
	if err := probePlanAudio(context.Background(), ffprobe, &plan); err == nil || !strings.Contains(err.Error(), "没有实测音频流") {
		t.Fatalf("missing planned native audio err = %v", err)
	}

	// Reusing one silent resource across several shots must reuse the measured
	// no-audio result, not mark later clips as audio-bearing.
	optional := buildRenderPlan(renderProject{
		Version: 2, Tracks: []renderTrack{{ID: "video", Kind: "video"}},
		Clips: []renderClip{makeVideoClip("shot-1", 0), makeVideoClip("shot-2", 500)}, DurationMs: 1000,
	}, renderOutputSpec{})
	for index := range optional.Segments {
		optional.Segments[index].Source = &renderSource{ResourceID: "silent", Path: source}
	}
	for index := range optional.Audio {
		optional.Audio[index].Source = &renderSource{ResourceID: "silent", Path: source}
	}
	if err := probePlanAudio(context.Background(), ffprobe, &optional); err != nil {
		t.Fatalf("optional embedded audio probe: %v", err)
	}
	if len(optional.Audio) != 0 {
		t.Fatalf("audio-less source clips remained in audio mix: %#v", optional.Audio)
	}
	for _, segment := range optional.Segments {
		if segment.Source == nil || segment.Source.HasAudio {
			t.Fatalf("reused source probe was not preserved: %#v", segment.Source)
		}
	}
}

func requireCommand(t *testing.T, name string) string {
	t.Helper()
	path, err := exec.LookPath(name)
	if err != nil {
		t.Skipf("%s is unavailable", name)
	}
	return path
}

func runCommand(t *testing.T, name string, args ...string) {
	t.Helper()
	cmd := exec.Command(name, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %s failed: %v\n%s", name, strings.Join(args, " "), err, output)
	}
}

package app

import (
	"strings"
	"testing"
)

func float64Fixture(value float64) *float64 { return &value }

func renderClipFixture(id string, kind string, trackID string, startMs int64, durationMs int64, storageKey string) renderClip {
	clip := renderClip{ID: id, Kind: kind, TrackID: trackID, StartMs: startMs, DurationMs: durationMs, Volume: float64Fixture(1)}
	if storageKey != "" {
		clip.DirectMedia = &struct {
			ID         string `json:"id"`
			Kind       string `json:"kind"`
			StorageKey string `json:"storageKey"`
		}{ID: "media-" + id, Kind: kind, StorageKey: storageKey}
	}
	return clip
}

func TestBuildRenderPlanExpandsGapAndSorts(t *testing.T) {
	project := renderProject{
		Version: 2,
		Tracks:  []renderTrack{{ID: "track-video-1", Kind: "video"}},
		Clips: []renderClip{
			renderClipFixture("clip-b", "video", "track-video-1", 3000, 2000, "resource:res-b"),
			renderClipFixture("clip-a", "video", "track-video-1", 0, 2000, "resource:res-a"),
			renderClipFixture("clip-sub", "subtitle", "track-subtitle-1", 0, 1000, ""),
		},
	}
	plan := buildRenderPlan(project, renderOutputSpec{})
	if !plan.HasMedia {
		t.Fatal("HasMedia = false, want true")
	}
	// 前 0–3000ms 被 clip-a(0-2000) 覆盖后仍有 1000ms 空隙，应展开为黑场段。
	if len(plan.Segments) != 3 {
		t.Fatalf("segments = %d, want 3 (clip-a, gap, clip-b)", len(plan.Segments))
	}
	if plan.Segments[0].Kind != "video" || plan.Segments[0].Clip.ID != "clip-a" {
		t.Fatalf("seg0 = %s/%s, want video/clip-a", plan.Segments[0].Kind, plan.Segments[0].Clip.ID)
	}
	if plan.Segments[1].Kind != "gap" || plan.Segments[1].DurationMs != 1000 {
		t.Fatalf("seg1 = %s/%dms, want gap/1000ms", plan.Segments[1].Kind, plan.Segments[1].DurationMs)
	}
	if plan.Segments[2].Clip.ID != "clip-b" {
		t.Fatalf("seg2 = %s, want clip-b (sorted by startMs)", plan.Segments[2].Clip.ID)
	}
}

func TestBuildRenderPlanSkipsHiddenTrack(t *testing.T) {
	hidden := false
	project := renderProject{
		Version: 2,
		Tracks:  []renderTrack{{ID: "track-hidden", Kind: "video", Visible: &hidden}},
		Clips:   []renderClip{renderClipFixture("clip-hidden", "video", "track-hidden", 0, 1000, "resource:res-x")},
	}
	plan := buildRenderPlan(project, renderOutputSpec{})
	if len(plan.Segments) != 0 {
		t.Fatalf("segments = %d, want 0 (hidden track skipped)", len(plan.Segments))
	}
	if plan.HasMedia {
		t.Fatal("HasMedia = true, want false for hidden-only timeline")
	}
}

func TestBuildRenderSubtitleSRT(t *testing.T) {
	project := renderProject{
		Version: 2,
		Clips: []renderClip{
			{ID: "sub-b", Kind: "subtitle", StartMs: 2000, DurationMs: 1000, Text: "第二条"},
			{ID: "sub-a", Kind: "subtitle", StartMs: 0, DurationMs: 1000, Text: "第一条"},
			{ID: "sub-blank", Kind: "subtitle", StartMs: 5000, DurationMs: 1000, Text: "   "},
		},
	}
	srt := buildRenderSubtitleSRT(project)
	want := "1\n00:00:00,000 --> 00:00:01,000\n第一条\n\n2\n00:00:02,000 --> 00:00:03,000\n第二条\n\n"
	if srt != want {
		t.Fatalf("srt mismatch:\n got %q\nwant %q", srt, want)
	}
	if buildRenderSubtitleSRT(renderProject{Version: 2}) != "" {
		t.Fatal("srt for empty timeline: want empty string")
	}
}

func TestBuildRenderPlanRejectsSubtitleOutsideTimeline(t *testing.T) {
	project := renderProject{
		Version:    2,
		DurationMs: 1000,
		Tracks:     []renderTrack{{ID: "video", Kind: "video"}, {ID: "subtitle", Kind: "subtitle"}},
		Clips: []renderClip{
			renderClipFixture("shot", "video", "video", 0, 1000, "resource:video"),
			{ID: "late-subtitle", Kind: "subtitle", TrackID: "subtitle", StartMs: 900, DurationMs: 200, Text: "超出片尾"},
		},
	}
	plan := buildRenderPlan(project, renderOutputSpec{})
	if plan.Error == "" || !strings.Contains(plan.Error, "字幕片段超出") {
		t.Fatalf("out-of-range subtitle was not rejected: %+v", plan)
	}
}

func TestBuildRenderFFmpegArgsLayout(t *testing.T) {
	plan := buildRenderPlan(renderProject{
		Version: 2,
		Tracks:  []renderTrack{{ID: "track-video-1", Kind: "video"}},
		Clips: []renderClip{
			renderClipFixture("clip-a", "video", "track-video-1", 0, 2000, "resource:res-a"),
			renderClipFixture("clip-b", "video", "track-video-1", 5000, 1000, "resource:res-b"),
		},
	}, renderOutputSpec{})
	plan.Segments[0].Source = &renderSource{ResourceID: "res-a", Path: "src-0.mp4", HasAudio: true}
	plan.Segments[1].Source = &renderSource{ResourceID: "res-a", Path: "src-0.mp4", HasAudio: true}
	plan.Segments[2].Source = &renderSource{ResourceID: "res-b", Path: "src-1.mp4", HasAudio: true}

	args, err := buildRenderFFmpegArgs(plan, "render-output.mp4", "")
	if err != nil {
		t.Fatalf("build args: %v", err)
	}
	joined := strings.Join(args, " ")
	if len(args) == 0 {
		t.Fatal("args empty, want ffmpeg arguments")
	}
	for _, want := range []string{
		"-filter_complex",
		"concat=n=3:v=1:a=0",
		"[vout]", "[aout]",
		"libx264", "aac",
		"color=c=black:s=1920x1080:r=30/1",
		"aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo",
		"render-output.mp4",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("args missing %q: %s", want, joined)
		}
	}
	if _, err := buildRenderFFmpegArgs(renderPlan{}, "out.mp4", ""); err == nil {
		t.Fatal("args for empty plan: want error")
	}
}

func TestBuildRenderFFmpegArgsAppliesMuteAndZeroVolume(t *testing.T) {
	plan := buildRenderPlan(renderProject{
		Version: 2,
		Tracks:  []renderTrack{{ID: "track-video-1", Kind: "video"}, {ID: "track-audio-1", Kind: "audio"}},
		Clips: []renderClip{
			renderClipFixture("clip-video", "video", "track-video-1", 0, 1000, "resource:res-v"),
			{ID: "clip-audio", Kind: "audio", TrackID: "track-audio-1", StartMs: 0, DurationMs: 1000, Volume: float64Fixture(0), DirectMedia: &struct {
				ID         string `json:"id"`
				Kind       string `json:"kind"`
				StorageKey string `json:"storageKey"`
			}{ID: "audio", Kind: "audio", StorageKey: "resource:res-a"}},
		},
	}, renderOutputSpec{})
	plan.Segments[0].Source = &renderSource{ResourceID: "res-v", Path: "src-v.mp4", HasAudio: true}
	if len(plan.Audio) != 1 {
		t.Fatalf("audio segments = %d, want only non-zero video audio", len(plan.Audio))
	}
	args, err := buildRenderFFmpegArgs(plan, "out.mp4", "")
	if err != nil {
		t.Fatalf("build args: %v", err)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "volume=1.0000") {
		t.Fatalf("video audio volume missing: %s", joined)
	}
	if strings.Contains(joined, "volume=0.0000") {
		t.Fatalf("volume=0 audio clip must not enter mix: %s", joined)
	}
}
func TestMediaResourceID(t *testing.T) {
	clip := renderClipFixture("a", "video", "track-1", 0, 1000, "resource:res-42")
	if id, ok := mediaResourceID(clip); !ok || id != "res-42" {
		t.Fatalf("mediaResourceID = %q/%v, want res-42/true", id, ok)
	}
	if _, ok := mediaResourceID(renderClip{}); ok {
		t.Fatal("mediaResourceID for clip without directMedia: want false")
	}
	if _, ok := mediaResourceID(renderClipFixture("a", "video", "track-1", 0, 1000, "https://example.com/a.mp4")); ok {
		t.Fatal("mediaResourceID for http storage key: want false")
	}
}

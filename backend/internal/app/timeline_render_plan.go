package app

import (
	"fmt"
	"sort"
	"strings"
)

// 时间线渲染把前端 TimelineProject v2 展开为确定性 ffmpeg 过滤图。
// ProductionRun 的音频策略决定是否混入视频自带音频；字幕单独导出 SRT。
type renderClip struct {
	ID               string   `json:"id"`
	Kind             string   `json:"kind"`
	TrackID          string   `json:"trackId"`
	StoryboardRowID  string   `json:"storyboardRowId"`
	SegmentID        string   `json:"segmentId"`
	StartMs          int64    `json:"startMs"`
	DurationMs       int64    `json:"durationMs"`
	SourceStartMs    int64    `json:"sourceStartMs"`
	SourceDurationMs int64    `json:"sourceDurationMs"`
	Volume           *float64 `json:"volume"`
	FadeInMs         int64    `json:"fadeInMs"`
	FadeOutMs        int64    `json:"fadeOutMs"`
	Text             string   `json:"text"`
	DirectMedia      *struct {
		ID         string `json:"id"`
		Kind       string `json:"kind"`
		StorageKey string `json:"storageKey"`
	} `json:"directMedia"`
}

type renderTrack struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Visible *bool  `json:"visible"`
	Muted   bool   `json:"muted"`
}

type renderProject struct {
	Version            int           `json:"version"`
	Tracks             []renderTrack `json:"tracks"`
	Clips              []renderClip  `json:"clips"`
	DurationMs         int64         `json:"durationMs"`
	AudioPolicy        string        `json:"audioPolicy,omitempty"`
	RequireNativeAudio bool          `json:"requireNativeAudio,omitempty"`
}

type renderOutputSpec struct {
	Width          int    `json:"width"`
	Height         int    `json:"height"`
	FPSNumerator   int    `json:"fpsNumerator"`
	FPSDenominator int    `json:"fpsDenominator"`
	SampleRate     int    `json:"sampleRate"`
	VideoCodec     string `json:"videoCodec"`
	AudioCodec     string `json:"audioCodec"`
	CRF            int    `json:"crf"`
	Preset         string `json:"preset"`
}

type renderSource struct {
	ResourceID string
	Clip       renderClip
	Path       string
	Ext        string
	HasAudio   bool
}

type renderSegment struct {
	Kind       string
	DurationMs int64
	GapMs      int64
	Clip       renderClip
	Source     *renderSource
}

type renderAudioSegment struct {
	Clip     renderClip
	StartMs  int64
	Duration int64
	Source   *renderSource
}

type renderAudioObservation struct {
	ClipID          string `json:"clipId"`
	StoryboardRowID string `json:"storyboardRowId,omitempty"`
	SegmentID       string `json:"segmentId,omitempty"`
	TrackID         string `json:"trackId"`
	ResourceID      string `json:"resourceId,omitempty"`
	SourceKind      string `json:"sourceKind"`
	HasAudio        bool   `json:"hasAudio"`
	IncludedInMix   bool   `json:"includedInMix"`
	AudioPolicy     string `json:"audioPolicy,omitempty"`
	Decision        string `json:"decision"`
}

type renderPlan struct {
	Segments           []renderSegment
	Audio              []renderAudioSegment
	AudioObservations  []renderAudioObservation
	SubtitleSRT        string
	HasMedia           bool
	AudioPolicy        string
	RequireNativeAudio bool
	Output             renderOutputSpec
	DurationMs         int64
	Error              string
}

func defaultRenderOutput() renderOutputSpec {
	return renderOutputSpec{Width: 1920, Height: 1080, FPSNumerator: 30, FPSDenominator: 1, SampleRate: 48000, VideoCodec: "libx264", AudioCodec: "aac", CRF: 23, Preset: "veryfast"}
}

func normalizeRenderOutput(input renderOutputSpec) (renderOutputSpec, error) {
	output := defaultRenderOutput()
	if input.Width != 0 {
		output.Width = input.Width
	}
	if input.Height != 0 {
		output.Height = input.Height
	}
	if input.FPSNumerator != 0 {
		output.FPSNumerator = input.FPSNumerator
	}
	if input.FPSDenominator != 0 {
		output.FPSDenominator = input.FPSDenominator
	}
	if input.SampleRate != 0 {
		output.SampleRate = input.SampleRate
	}
	if input.VideoCodec != "" {
		output.VideoCodec = input.VideoCodec
	}
	if input.AudioCodec != "" {
		output.AudioCodec = input.AudioCodec
	}
	if input.CRF != 0 {
		output.CRF = input.CRF
	}
	if input.Preset != "" {
		output.Preset = input.Preset
	}
	if output.Width < 2 || output.Height < 2 || output.Width > 7680 || output.Height > 7680 || output.Width%2 != 0 || output.Height%2 != 0 {
		return output, fmt.Errorf("输出宽高必须是 2-7680 之间的偶数")
	}
	if output.FPSNumerator <= 0 || output.FPSDenominator <= 0 || output.FPSNumerator > 240000 || output.FPSDenominator > 1001 {
		return output, fmt.Errorf("输出帧率无效")
	}
	if output.SampleRate < 8000 || output.SampleRate > 192000 {
		return output, fmt.Errorf("输出采样率无效")
	}
	if output.CRF < 0 || output.CRF > 51 {
		return output, fmt.Errorf("输出 CRF 无效")
	}
	return output, nil
}

func buildRenderPlan(project renderProject, requested renderOutputSpec) renderPlan {
	output, outputErr := normalizeRenderOutput(requested)
	if outputErr != nil {
		return renderPlan{Output: defaultRenderOutput(), Error: outputErr.Error()}
	}
	tracks := make(map[string]renderTrack, len(project.Tracks))
	for _, track := range project.Tracks {
		tracks[track.ID] = track
	}
	visible := func(trackID string) bool {
		track, ok := tracks[trackID]
		return !ok || track.Visible == nil || *track.Visible
	}
	videoClips := make([]renderClip, 0, len(project.Clips))
	audioClips := make([]renderAudioSegment, 0, len(project.Clips))
	for _, clip := range project.Clips {
		if clip.DurationMs <= 0 {
			continue
		}
		track := tracks[clip.TrackID]
		if !visible(clip.TrackID) || track.Muted {
			continue
		}
		if clip.Kind == "video" || clip.Kind == "image" {
			videoClips = append(videoClips, clip)
			if clip.Kind == "video" && audioEnabled(clip) && project.AudioPolicy != "none" && project.AudioPolicy != "independent" {
				audioClips = append(audioClips, renderAudioSegment{Clip: clip, StartMs: clip.StartMs, Duration: clip.DurationMs})
			}
		}
		if clip.Kind == "audio" && audioEnabled(clip) {
			audioClips = append(audioClips, renderAudioSegment{Clip: clip, StartMs: clip.StartMs, Duration: clip.DurationMs})
		}
	}
	sort.SliceStable(videoClips, func(i, j int) bool { return lessClip(videoClips[i], videoClips[j]) })
	sort.SliceStable(audioClips, func(i, j int) bool { return lessClip(audioClips[i].Clip, audioClips[j].Clip) })
	plan := renderPlan{Output: output, AudioPolicy: project.AudioPolicy, RequireNativeAudio: project.RequireNativeAudio}
	cursor := int64(0)
	for _, clip := range videoClips {
		if clip.StartMs < cursor {
			plan.Error = "可见视频/图片片段存在重叠；当前导出合同不支持直接叠加，请先拆分或调整时间线"
			return plan
		}
		if gap := clip.StartMs - cursor; gap > 0 {
			plan.Segments = append(plan.Segments, renderSegment{Kind: "gap", DurationMs: gap, GapMs: gap})
		}
		plan.Segments = append(plan.Segments, renderSegment{Kind: clip.Kind, DurationMs: clip.DurationMs, Clip: clip})
		cursor = clip.StartMs + clip.DurationMs
	}
	for _, segment := range plan.Segments {
		if _, ok := mediaResourceID(segment.Clip); ok {
			plan.HasMedia = true
			break
		}
	}
	plan.Audio = audioClips
	for _, audio := range audioClips {
		if end := audio.StartMs + audio.Duration; end > plan.DurationMs {
			plan.DurationMs = end
		}
	}
	if cursor > plan.DurationMs {
		plan.DurationMs = cursor
	}
	if project.DurationMs > plan.DurationMs {
		plan.DurationMs = project.DurationMs
	}
	if plan.DurationMs <= 0 {
		plan.Error = "时间线总时长必须大于 0"
		return plan
	}
	for _, clip := range project.Clips {
		if clip.Kind != "subtitle" || !visible(clip.TrackID) || tracks[clip.TrackID].Muted || strings.TrimSpace(clip.Text) == "" {
			continue
		}
		if clip.StartMs < 0 || clip.DurationMs <= 0 || clip.StartMs > plan.DurationMs || clip.DurationMs > plan.DurationMs-clip.StartMs {
			plan.Error = "字幕片段超出时间线时长"
			return plan
		}
	}
	plan.SubtitleSRT = buildRenderSubtitleSRT(project)
	return plan
}

func lessClip(left renderClip, right renderClip) bool {
	if left.StartMs == right.StartMs {
		return left.ID < right.ID
	}
	return left.StartMs < right.StartMs
}

func audioEnabled(clip renderClip) bool {
	if clip.Volume != nil && *clip.Volume <= 0 {
		return false
	}
	return true
}

func volumeFor(clip renderClip) float64 {
	if clip.Volume == nil {
		return 1
	}
	if *clip.Volume < 0 {
		return 0
	}
	if *clip.Volume > 8 {
		return 8
	}
	return *clip.Volume
}

func mediaResourceID(clip renderClip) (string, bool) {
	if clip.DirectMedia == nil {
		return "", false
	}
	key := strings.TrimSpace(clip.DirectMedia.StorageKey)
	if !strings.HasPrefix(key, "resource:") {
		return "", false
	}
	id := strings.TrimSpace(strings.TrimPrefix(key, "resource:"))
	return id, id != ""
}

func buildRenderSubtitleSRT(project renderProject) string {
	tracks := make(map[string]renderTrack, len(project.Tracks))
	for _, track := range project.Tracks {
		tracks[track.ID] = track
	}
	subtitle := make([]renderClip, 0, len(project.Clips))
	for _, clip := range project.Clips {
		if clip.Kind != "subtitle" || strings.TrimSpace(clip.Text) == "" || clip.DurationMs <= 0 {
			continue
		}
		track, exists := tracks[clip.TrackID]
		if exists && ((track.Visible != nil && !*track.Visible) || track.Muted) {
			continue
		}
		subtitle = append(subtitle, clip)
	}
	sort.SliceStable(subtitle, func(i, j int) bool { return lessClip(subtitle[i], subtitle[j]) })
	if len(subtitle) == 0 {
		return ""
	}
	var out strings.Builder
	for i, clip := range subtitle {
		fmt.Fprintf(&out, "%d\n%s --> %s\n%s\n\n", i+1, formatSRTTimestamp(clip.StartMs), formatSRTTimestamp(clip.StartMs+clip.DurationMs), strings.TrimSpace(clip.Text))
	}
	return out.String()
}

// buildRenderFFmpegArgs 只生成固定 argv，不经过 shell。每个媒体输入独占一个参数下标，
// 视频 concat 与音频 amix 共用同一输出时长，避免“音轨登记了但没进入成片”。
func buildRenderFFmpegArgs(plan renderPlan, target string, subtitlePath string) ([]string, error) {
	if plan.Error != "" {
		return nil, fmt.Errorf("%s", plan.Error)
	}
	if len(plan.Segments) == 0 {
		return nil, fmt.Errorf("时间线没有可渲染的画面片段")
	}
	if plan.SubtitleSRT != "" && strings.TrimSpace(subtitlePath) == "" {
		return nil, fmt.Errorf("时间线包含字幕，但没有提供字幕输入文件")
	}
	output := plan.Output
	args := []string{"-nostdin", "-y"}
	videoLabels := make([]string, 0, len(plan.Segments))
	audioLabels := make([]string, 0, len(plan.Audio)+len(plan.Segments))
	filters := make([]string, 0, len(plan.Segments)*2+len(plan.Audio)*2+3)
	nextInput := 0
	cursorMs := int64(0)
	scale := fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2", output.Width, output.Height, output.Width, output.Height)
	for index, segment := range plan.Segments {
		seconds := secondsString(segment.DurationMs)
		videoInput := nextInput
		switch segment.Kind {
		case "gap":
			args = append(args, "-f", "lavfi", "-t", seconds, "-i", fmt.Sprintf("color=c=black:s=%dx%d:r=%d/%d", output.Width, output.Height, output.FPSNumerator, output.FPSDenominator))
			nextInput++
		case "image":
			if segment.Source == nil {
				args = append(args, "-f", "lavfi", "-t", seconds, "-i", fmt.Sprintf("color=c=black:s=%dx%d:r=%d/%d", output.Width, output.Height, output.FPSNumerator, output.FPSDenominator))
			} else {
				args = append(args, "-loop", "1", "-t", seconds, "-i", segment.Source.Path)
			}
			nextInput++
		default:
			if segment.Source == nil {
				args = append(args, "-f", "lavfi", "-t", seconds, "-i", fmt.Sprintf("color=c=black:s=%dx%d:r=%d/%d", output.Width, output.Height, output.FPSNumerator, output.FPSDenominator))
			} else {
				if segment.Clip.SourceStartMs > 0 {
					args = append(args, "-ss", secondsString(segment.Clip.SourceStartMs))
				}
				args = append(args, "-t", seconds, "-i", segment.Source.Path)
			}
			nextInput++
		}
		label := fmt.Sprintf("v%d", index)
		filters = append(filters, fmt.Sprintf("[%d:v]fps=%d/%d,%s,setsar=1,format=yuv420p[%s]", videoInput, output.FPSNumerator, output.FPSDenominator, scale, label))
		videoLabels = append(videoLabels, label)
		cursorMs += segment.DurationMs
	}
	for index, audio := range plan.Audio {
		input := nextInput
		args = append(args, "-t", secondsString(audio.Duration))
		if audio.Clip.SourceStartMs > 0 {
			args = append(args, "-ss", secondsString(audio.Clip.SourceStartMs))
		}
		args = append(args, "-i", audio.SourcePath())
		nextInput++
		label := fmt.Sprintf("a%d", index)
		filter := fmt.Sprintf("[%d:a]aformat=sample_fmts=fltp:sample_rates=%d:channel_layouts=stereo,atrim=0:%s,asetpts=N/SR/TB,volume=%.4f", input, output.SampleRate, secondsString(audio.Duration), volumeFor(audio.Clip))
		filter += fadeFilters(audio.Clip, audio.Duration)
		if audio.StartMs > 0 {
			filter += fmt.Sprintf(",adelay=%d|%d", audio.StartMs, audio.StartMs)
		}
		filter += fmt.Sprintf("[%s]", label)
		filters = append(filters, filter)
		audioLabels = append(audioLabels, label)
	}
	subtitleInput := -1
	if plan.SubtitleSRT != "" {
		args = append(args, "-f", "srt", "-i", subtitlePath)
		subtitleInput = nextInput
		nextInput++
	}
	if len(videoLabels) == 1 {
		filters = append(filters, "[v0]null[vout]")
	} else {
		var inputs strings.Builder
		for _, label := range videoLabels {
			fmt.Fprintf(&inputs, "[%s]", label)
		}
		filters = append(filters, fmt.Sprintf("%sconcat=n=%d:v=1:a=0[vout]", inputs.String(), len(videoLabels)))
	}
	if len(audioLabels) == 0 {
		filters = append(filters, fmt.Sprintf("anullsrc=r=%d:cl=stereo:d=%s[aout]", output.SampleRate, secondsString(plan.DurationMs)))
	} else if len(audioLabels) == 1 {
		filters = append(filters, fmt.Sprintf("[%s]atrim=0:%s,apad=whole_dur=%s[aout]", audioLabels[0], secondsString(plan.DurationMs), secondsString(plan.DurationMs)))
	} else {
		var inputs strings.Builder
		for _, label := range audioLabels {
			fmt.Fprintf(&inputs, "[%s]", label)
		}
		filters = append(filters, fmt.Sprintf("%samix=inputs=%d:duration=longest:normalize=0,atrim=0:%s,apad=whole_dur=%s[aout]", inputs.String(), len(audioLabels), secondsString(plan.DurationMs), secondsString(plan.DurationMs)))
	}
	args = append(args,
		"-filter_complex", strings.Join(filters, ";"),
		"-map", "[vout]", "-map", "[aout]",
		"-c:v", output.VideoCodec, "-preset", output.Preset, "-crf", fmt.Sprintf("%d", output.CRF), "-pix_fmt", "yuv420p",
		"-r", fmt.Sprintf("%d/%d", output.FPSNumerator, output.FPSDenominator),
		"-c:a", output.AudioCodec, "-b:a", "192k", "-ar", fmt.Sprintf("%d", output.SampleRate), "-ac", "2")
	if subtitleInput >= 0 {
		args = append(args, "-map", fmt.Sprintf("%d:s:0", subtitleInput), "-c:s", "mov_text")
	}
	args = append(args, "-movflags", "+faststart", "-t", secondsString(plan.DurationMs), target)
	return args, nil
}

func fadeFilters(clip renderClip, durationMs int64) string {
	var out strings.Builder
	if clip.FadeInMs > 0 {
		end := clip.FadeInMs
		if end > durationMs {
			end = durationMs
		}
		out.WriteString(fmt.Sprintf(",afade=t=in:st=0:d=%s", secondsString(end)))
	}
	if clip.FadeOutMs > 0 {
		end := clip.FadeOutMs
		if end > durationMs {
			end = durationMs
		}
		start := durationMs - end
		if start < 0 {
			start = 0
		}
		out.WriteString(fmt.Sprintf(",afade=t=out:st=%s:d=%s", secondsString(start), secondsString(end)))
	}
	return out.String()
}

func (segment renderAudioSegment) SourcePath() string {
	if segment.Source == nil {
		return ""
	}
	return segment.Source.Path
}

func secondsString(ms int64) string {
	if ms <= 0 {
		return "0.000"
	}
	return fmt.Sprintf("%.3f", float64(ms)/1000)
}

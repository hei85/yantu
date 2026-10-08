package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
)

const renderFfmpegEnv = "CANVAS_FFMPEG_PATH"
const renderFfprobeEnv = "CANVAS_FFPROBE_PATH"

type mediaStreamReport struct {
	Index      int    `json:"index"`
	CodecType  string `json:"codec_type"`
	CodecName  string `json:"codec_name"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	SampleRate string `json:"sample_rate"`
	Channels   int    `json:"channels"`
	Duration   string `json:"duration"`
}

type mediaProbeReport struct {
	Format struct {
		Duration string `json:"duration"`
		Size     string `json:"size"`
	} `json:"format"`
	Streams           []mediaStreamReport     `json:"streams"`
	FileSizeBytes     int64                   `json:"fileSizeBytes"`
	DurationMs        int64                   `json:"durationMs"`
	VideoStreams      int                     `json:"videoStreams"`
	AudioStreams      int                     `json:"audioStreams"`
	SubtitleStreams   int                     `json:"subtitleStreams"`
	Width             int                     `json:"width"`
	Height            int                     `json:"height"`
	VideoFrameSamples []mediaVideoFrameSample `json:"videoFrameSamples,omitempty"`
	Decoded           bool                    `json:"decoded"`
}

type mediaVideoFrameSample struct {
	Position    string `json:"position"`
	TimestampMs int64  `json:"timestampMs"`
	Decoded     bool   `json:"decoded"`
	ImageBytes  int64  `json:"imageBytes"`
}

func (w *taskWorkerCoordinator) processTimelineRender(task *model.Task, ctx context.Context) error {
	s := w.service
	ffmpegBin, err := renderFfmpegBinary()
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}
	ffprobeBin, err := renderFfprobeBinary()
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}
	var input timelineRenderInput
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		return w.failTimelineTask(task, "渲染失败", "任务缺少有效的时间线快照")
	}
	plan := buildRenderPlan(input.Timeline, input.Output)
	if plan.Error != "" {
		return w.failTimelineTask(task, "渲染失败", plan.Error)
	}
	if !plan.HasMedia {
		return w.failTimelineTask(task, "渲染失败", "时间线没有可渲染的媒体片段")
	}
	if err := w.progress(task, "准备媒体…", 10); err != nil {
		return err
	}
	workDir, cleanup, err := materializeRenderSources(ctx, s, task.UserID, &plan)
	if cleanup != nil {
		defer cleanup()
	}
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}
	if err := probePlanAudio(ctx, ffprobeBin, &plan); err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}
	outputPath := filepath.Join(workDir, "render-output.mp4")
	subtitlePath := ""
	if plan.SubtitleSRT != "" {
		subtitlePath = filepath.Join(workDir, "render-subtitles.srt")
		if err := os.WriteFile(subtitlePath, []byte(plan.SubtitleSRT), 0o600); err != nil {
			return w.failTimelineTask(task, "渲染失败", "写入字幕文件失败")
		}
	}
	args, err := buildRenderFFmpegArgs(plan, outputPath, subtitlePath)
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}
	if err := w.progress(task, "正在渲染…", 30); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, ffmpegBin, args...)
	cmd.Dir = workDir
	output, runErr := cmd.CombinedOutput()
	if runErr != nil {
		detail := strings.TrimSpace(string(output))
		if len(detail) > 600 {
			detail = detail[len(detail)-600:]
		}
		return w.failTimelineTask(task, "渲染失败", fmt.Sprintf("ffmpeg 渲染失败：%s", detail))
	}
	if err := w.progress(task, "完整解码检查…", 78); err != nil {
		return err
	}
	if err := decodeMediaFully(ctx, ffmpegBin, outputPath); err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}
	probe, err := probeMediaFile(ctx, ffprobeBin, outputPath)
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}
	if probe.VideoStreams < 1 {
		return w.failTimelineTask(task, "渲染失败", "成片没有视频流")
	}
	if probe.AudioStreams < 1 {
		return w.failTimelineTask(task, "渲染失败", "成片没有音频流")
	}
	if err := validateRenderedDuration(plan, probe); err != nil {
		return w.failTimelineTask(task, "渲染失败", err.Error())
	}
	if err := w.progress(task, "写入资源…", 90); err != nil {
		return err
	}
	file, err := os.Open(outputPath)
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", "读取渲染产物失败")
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || stat.Size() == 0 {
		return w.failTimelineTask(task, "渲染失败", "渲染产物为空")
	}
	fileName := fmt.Sprintf("timeline-render-%s.mp4", time.Now().Format("20060102-150405"))
	width, height := probe.Width, probe.Height
	if width <= 0 {
		width = plan.Output.Width
	}
	if height <= 0 {
		height = plan.Output.Height
	}
	resource, _, err := s.storeResource(task.UserID, "media", fileName, "video/mp4", stat.Size(), width, height, probe.DurationMs, file, nil, false)
	if err != nil || resource == nil {
		return w.failTimelineTask(task, "渲染失败", "保存渲染产物失败")
	}
	result := timelineRenderResult{ResourceID: resource.ID, FileName: fileName, Size: stat.Size(), DurationMs: probe.DurationMs, SubtitleSRT: plan.SubtitleSRT, Probe: &probe, AudioObservations: plan.AudioObservations, Output: plan.Output}
	payload, err := json.Marshal(result)
	if err != nil {
		return w.failTimelineTask(task, "渲染失败", "渲染结果序列化失败")
	}
	task.Status = model.TaskStatusSucceeded
	task.Stage = "渲染完成"
	task.Progress = 100
	task.ResultJSON = string(payload)
	completedAt := time.Now()
	task.CompletedAt = &completedAt
	if err := s.repo.SaveTaskCompletion(task, model.TaskStatusRunning, nil); err != nil {
		return fmt.Errorf("写入渲染完成态失败: %w", err)
	}
	s.logInfo(task.UserID, task.ID, fmt.Sprintf("时间线渲染完成，实测 %.3fs", float64(probe.DurationMs)/1000), "")
	return nil
}

func renderFfmpegBinary() (string, error) {
	if configured := strings.TrimSpace(os.Getenv(renderFfmpegEnv)); configured != "" {
		return configured, nil
	}
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		return "", fmt.Errorf("渲染依赖未安装（需要 ffmpeg，可通过 %s 指定）", renderFfmpegEnv)
	}
	return path, nil
}

func renderFfprobeBinary() (string, error) {
	if configured := strings.TrimSpace(os.Getenv(renderFfprobeEnv)); configured != "" {
		return configured, nil
	}
	path, err := exec.LookPath("ffprobe")
	if err != nil {
		return "", fmt.Errorf("媒体探测依赖未安装（需要 ffprobe，可通过 %s 指定）", renderFfprobeEnv)
	}
	return path, nil
}

func materializeRenderSources(ctx context.Context, s *Service, userID string, plan *renderPlan) (string, func(), error) {
	tmpDir, err := os.MkdirTemp("", "yingce-render-*")
	if err != nil {
		return "", nil, fmt.Errorf("创建临时目录失败: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(tmpDir) }
	cache := map[string]*renderSource{}
	readSource := func(clip renderClip) (*renderSource, error) {
		resourceID, ok := mediaResourceID(clip)
		if !ok {
			return nil, nil
		}
		if cached, exists := cache[resourceID]; exists {
			return cached, nil
		}
		resource, reader, err := s.OpenResource(userID, resourceID)
		if err != nil || reader == nil {
			return nil, fmt.Errorf("无法读取时间线引用的媒体，可能已被删除")
		}
		defer reader.Close()
		ext := extForMime(resource.MimeType)
		if ext == "" {
			ext = ".bin"
		}
		path := filepath.Join(tmpDir, fmt.Sprintf("src-%d%s", len(cache), ext))
		file, err := os.Create(path)
		if err != nil {
			return nil, fmt.Errorf("写入临时媒体失败: %w", err)
		}
		if _, err := io.Copy(file, reader); err != nil {
			file.Close()
			return nil, fmt.Errorf("读取时间线媒体失败: %w", err)
		}
		if err := file.Close(); err != nil {
			return nil, err
		}
		value := &renderSource{ResourceID: resourceID, Clip: clip, Path: path, Ext: ext}
		cache[resourceID] = value
		return value, nil
	}
	for i := range plan.Segments {
		source, err := readSource(plan.Segments[i].Clip)
		if err != nil {
			cleanup()
			return "", nil, err
		}
		plan.Segments[i].Source = source
	}
	for i := range plan.Audio {
		source, err := readSource(plan.Audio[i].Clip)
		if err != nil {
			cleanup()
			return "", nil, err
		}
		if source == nil {
			cleanup()
			return "", nil, fmt.Errorf("音轨片段缺少可读资源")
		}
		plan.Audio[i].Source = source
	}
	return tmpDir, cleanup, nil
}

func probePlanAudio(ctx context.Context, ffprobeBin string, plan *renderPlan) error {
	seen := map[string]bool{}
	probe := func(source *renderSource) error {
		if source == nil {
			return fmt.Errorf("音频片段缺少可读资源")
		}
		key := source.ResourceID
		if key == "" {
			key = source.Path
		}
		if hasAudio, ok := seen[key]; ok {
			source.HasAudio = hasAudio
			return nil
		}
		hasAudio, err := probeHasAudioStream(ctx, ffprobeBin, source.Path)
		if err != nil {
			return err
		}
		source.HasAudio = hasAudio
		seen[key] = hasAudio
		return nil
	}
	plan.AudioObservations = nil
	videoObservationIndex := map[string]int{}
	for i := range plan.Segments {
		segment := &plan.Segments[i]
		source := segment.Source
		if source == nil || segment.Kind != "video" {
			continue
		}
		if err := probe(source); err != nil {
			return err
		}
		observation := renderAudioObservation{
			ClipID: segment.Clip.ID, StoryboardRowID: segment.Clip.StoryboardRowID, SegmentID: segment.Clip.SegmentID,
			TrackID: segment.Clip.TrackID, ResourceID: source.ResourceID, SourceKind: "video",
			HasAudio: source.HasAudio, AudioPolicy: plan.AudioPolicy,
			Decision: "视频自带音频未进入最终混音",
		}
		if plan.AudioPolicy != "none" && plan.AudioPolicy != "independent" && audioEnabled(segment.Clip) && source.HasAudio {
			observation.IncludedInMix = true
			observation.Decision = "按时间线音量与 ProductionPlan 音频策略混入原生音频"
		} else if source.HasAudio && (plan.AudioPolicy == "none" || plan.AudioPolicy == "independent") {
			observation.Decision = "实测存在音频流；按静音或独立音轨策略排除视频自带音频"
		}
		videoObservationIndex[segment.Clip.ID] = len(plan.AudioObservations)
		plan.AudioObservations = append(plan.AudioObservations, observation)
	}
	usableAudio := make([]renderAudioSegment, 0, len(plan.Audio))
	for i := range plan.Audio {
		audio := plan.Audio[i]
		if err := probe(audio.Source); err != nil {
			return err
		}
		if !audio.Source.HasAudio {
			if audio.Clip.Kind == "video" {
				if plan.RequireNativeAudio {
					return fmt.Errorf("视频片段 %s 没有实测音频流，不能满足 ProductionPlan 原生音频策略", audio.Clip.ID)
				}
				if observationIndex, ok := videoObservationIndex[audio.Clip.ID]; ok {
					plan.AudioObservations[observationIndex].Decision = "未检测到视频自带音频流，不加入混音"
				}
				continue
			}
			return fmt.Errorf("独立音轨 %s 的资源没有实测音频流", audio.Clip.ID)
		}
		if audio.Clip.Kind == "video" {
			if observationIndex, ok := videoObservationIndex[audio.Clip.ID]; ok {
				plan.AudioObservations[observationIndex].IncludedInMix = true
				plan.AudioObservations[observationIndex].Decision = "视频自带音频已探测并进入最终混音"
			}
		} else {
			plan.AudioObservations = append(plan.AudioObservations, renderAudioObservation{
				ClipID: audio.Clip.ID, StoryboardRowID: audio.Clip.StoryboardRowID, TrackID: audio.Clip.TrackID,
				ResourceID: audio.Source.ResourceID, SourceKind: audio.Clip.Kind, HasAudio: true,
				IncludedInMix: true, AudioPolicy: plan.AudioPolicy, Decision: "独立音轨实测有音频流并进入最终混音",
			})
		}
		usableAudio = append(usableAudio, audio)
	}
	plan.Audio = usableAudio
	return nil
}

func probeHasAudioStream(ctx context.Context, ffprobeBin string, path string) (bool, error) {
	cmd := exec.CommandContext(ctx, ffprobeBin, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", path)
	output, runErr := cmd.Output()
	if runErr != nil {
		return false, fmt.Errorf("探测媒体音频流失败: %w", runErr)
	}
	return strings.TrimSpace(string(output)) != "", nil
}

func decodeMediaFully(ctx context.Context, ffmpegBin string, path string) error {
	cmd := exec.CommandContext(ctx, ffmpegBin, "-v", "error", "-i", path, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-")
	output, err := cmd.CombinedOutput()
	if err != nil {
		detail := strings.TrimSpace(string(output))
		if len(detail) > 600 {
			detail = detail[len(detail)-600:]
		}
		return fmt.Errorf("成片完整解码失败：%s", detail)
	}
	return nil
}

func probeMediaFile(ctx context.Context, ffprobeBin string, path string) (mediaProbeReport, error) {
	cmd := exec.CommandContext(ctx, ffprobeBin, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path)
	output, err := cmd.Output()
	if err != nil {
		return mediaProbeReport{}, fmt.Errorf("ffprobe 读取成片失败")
	}
	var report mediaProbeReport
	if err := json.Unmarshal(output, &report); err != nil {
		return report, fmt.Errorf("ffprobe 输出无效")
	}
	for _, stream := range report.Streams {
		switch stream.CodecType {
		case "video":
			report.VideoStreams++
			if report.Width == 0 {
				report.Width, report.Height = stream.Width, stream.Height
			}
		case "audio":
			report.AudioStreams++
		case "subtitle":
			report.SubtitleStreams++
		}
	}
	duration, _ := strconv.ParseFloat(strings.TrimSpace(report.Format.Duration), 64)
	report.DurationMs = int64(math.Round(duration * 1000))
	if size, sizeErr := strconv.ParseInt(strings.TrimSpace(report.Format.Size), 10, 64); sizeErr == nil {
		report.FileSizeBytes = size
	}
	return report, nil
}

func validateRenderedDuration(plan renderPlan, probe mediaProbeReport) error {
	if probe.DurationMs <= 0 {
		return fmt.Errorf("成片实测时长无效")
	}
	tolerance := int64(math.Ceil(1000*float64(plan.Output.FPSDenominator)/float64(plan.Output.FPSNumerator))) + 120
	if diff := probe.DurationMs - plan.DurationMs; diff > tolerance || diff < -tolerance {
		return fmt.Errorf("成片实测时长 %dms 与时间线目标 %dms 偏差超过 {%d}ms", probe.DurationMs, plan.DurationMs, tolerance)
	}
	return nil
}

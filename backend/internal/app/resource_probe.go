package app

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
)

type ResourceProbeResult struct {
	ResourceID string           `json:"resourceId"`
	MediaType  string           `json:"mediaType"`
	Probe      mediaProbeReport `json:"probe"`
}

func (s *Service) ProbeResource(userID, resourceID string, fullDecode bool) (*ResourceProbeResult, error) {
	resource, reader, err := s.OpenResource(userID, resourceID)
	if err != nil || reader == nil {
		return nil, BadAuthRequest("资源不存在或尚不可读取")
	}
	defer reader.Close()
	ffprobeBin, err := renderFfprobeBinary()
	if err != nil {
		return nil, err
	}
	tmpDir, err := os.MkdirTemp("", "yingce-probe-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmpDir)
	ext := extForMime(resource.MimeType)
	if ext == ".bin" {
		ext = filepath.Ext(resource.ObjectKey)
	}
	if ext == "" {
		ext = ".bin"
	}
	path := filepath.Join(tmpDir, "resource"+ext)
	file, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(file, reader); err != nil {
		file.Close()
		return nil, err
	}
	if err := file.Close(); err != nil {
		return nil, err
	}
	probe, err := probeMediaFile(context.Background(), ffprobeBin, path)
	if err != nil {
		return nil, err
	}
	if fullDecode {
		ffmpegBin, err := renderFfmpegBinary()
		if err != nil {
			return nil, err
		}
		if err := decodeResourceFully(context.Background(), ffmpegBin, path); err != nil {
			return nil, err
		}
		// ffprobe also exposes still images as a video stream. Temporal samples
		// belong to actual videos; PNG/JPEG do not have a duration to seek into.
		if probe.VideoStreams > 0 && mediaTypeForResource(resource) == "video" {
			probe.VideoFrameSamples, err = decodeVideoFrameSamples(context.Background(), ffmpegBin, path, tmpDir, probe.DurationMs)
			if err != nil {
				return nil, err
			}
		}
		probe.Decoded = true
	}
	if fullDecode && mediaTypeForResource(resource) == "video" {
		s.recordProbedVideoOutput(userID, resource.ID, probe)
	}
	return &ResourceProbeResult{ResourceID: resource.ID, MediaType: mediaTypeForResource(resource), Probe: probe}, nil
}

// probeMediaBytesMetadata 只用于补齐生成结果的宽高/时长元数据。
// 上游已回传数值或探测不可用时保持原值，不影响“生成成功”这一事实。
func probeMediaBytesMetadata(data []byte, mimeType string) (int, int, int64) {
	if len(data) == 0 {
		return 0, 0, 0
	}
	ffprobeBin, err := renderFfprobeBinary()
	if err != nil {
		return 0, 0, 0
	}
	tmpDir, err := os.MkdirTemp("", "yingce-media-meta-*")
	if err != nil {
		return 0, 0, 0
	}
	defer os.RemoveAll(tmpDir)
	path := filepath.Join(tmpDir, "media"+extForMime(mimeType))
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return 0, 0, 0
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	probe, err := probeMediaFile(ctx, ffprobeBin, path)
	if err != nil {
		return 0, 0, 0
	}
	return probe.Width, probe.Height, probe.DurationMs
}

func decodeVideoFrameSamples(ctx context.Context, ffmpegBin, path, outputDir string, durationMs int64) ([]mediaVideoFrameSample, error) {
	if durationMs <= 0 {
		return nil, BadAuthRequest("视频没有有效时长，不能抽取首中尾帧")
	}
	endOffsetMs := min(int64(250), max(int64(1), durationMs/20))
	points := []mediaVideoFrameSample{
		{Position: "start", TimestampMs: 0},
		{Position: "middle", TimestampMs: durationMs / 2},
		{Position: "end", TimestampMs: max(int64(0), durationMs-endOffsetMs)},
	}
	for index := range points {
		point := &points[index]
		outputPath := filepath.Join(outputDir, "video-sample-"+point.Position+".png")
		seconds := fmt.Sprintf("%.3f", float64(point.TimestampMs)/1000)
		cmd := exec.CommandContext(ctx, ffmpegBin,
			"-v", "error", "-y", "-ss", seconds, "-i", path,
			"-map", "0:v:0", "-frames:v", "1", "-an", "-f", "image2", "-vcodec", "png", outputPath,
		)
		output, err := cmd.CombinedOutput()
		if err != nil {
			detail := strings.TrimSpace(string(output))
			if len(detail) > 600 {
				detail = detail[len(detail)-600:]
			}
			return nil, BadAuthRequest(fmt.Sprintf("视频%s帧解码失败：%s", point.Position, detail))
		}
		info, err := os.Stat(outputPath)
		if err != nil || info.Size() <= 8 {
			return nil, BadAuthRequest("视频" + point.Position + "帧未产生有效图像")
		}
		point.Decoded = true
		point.ImageBytes = info.Size()
	}
	return points, nil
}

func decodeResourceFully(ctx context.Context, ffmpegBin string, path string) error {
	cmd := exec.CommandContext(ctx, ffmpegBin, "-v", "error", "-i", path, "-f", "null", "-")
	output, err := cmd.CombinedOutput()
	if err != nil {
		detail := strings.TrimSpace(string(output))
		if len(detail) > 600 {
			detail = detail[len(detail)-600:]
		}
		return BadAuthRequest("媒体完整解码失败：" + detail)
	}
	return nil
}

func mediaTypeForResource(resource *model.Resource) string {
	kind := strings.ToLower(strings.TrimSpace(resource.Kind))
	if kind != "" {
		return kind
	}
	switch {
	case strings.HasPrefix(resource.MimeType, "video/"):
		return "video"
	case strings.HasPrefix(resource.MimeType, "audio/"):
		return "audio"
	case strings.HasPrefix(resource.MimeType, "image/"):
		return "image"
	default:
		return "file"
	}
}

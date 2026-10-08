package app

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/model"
)

var channelVideoOutputObservationLock sync.Mutex

// Actual dimensions are parameter evidence, not a content-quality pass. A
// mismatch never silently removes an option, retries a paid job, or replaces media.
func videoOutputObservation(taskID, revision, ratio, resolution, resourceID string, width, height int) *CapabilityObservation {
	if taskID == "" || resourceID == "" || width <= 0 || height <= 0 {
		return nil
	}
	details := map[string]any{"taskId": taskID, "resourceId": resourceID, "capabilityRevision": revision,
		"requestedRatio": ratio, "requestedResolution": resolution, "outputWidth": width, "outputHeight": height,
		"fullDecodePassed": false}
	mismatch := false
	if parts := strings.Split(ratio, ":"); len(parts) == 2 {
		w, e1 := strconv.ParseFloat(parts[0], 64)
		h, e2 := strconv.ParseFloat(parts[1], 64)
		if e1 == nil && e2 == nil && w > 0 && h > 0 && !math.IsInf(w, 0) && !math.IsInf(h, 0) {
			matched := math.Abs((float64(width)/float64(height))/(w/h)-1) <= 0.03
			details["aspectRatioMatched"] = matched
			mismatch = mismatch || !matched
		}
	}
	// Opaque relay tiers such as "768p横" have no universal numeric meaning.
	// Keep them unknown rather than manufacturing a resolution verdict.
	resolutionToken := strings.ToLower(strings.TrimSpace(resolution))
	explicitTier := resolutionToken != "" && resolutionToken != "auto" && resolutionToken != "default" && resolutionToken != "medium" && resolutionToken != "high"
	if tier, err := strconv.Atoi(strings.TrimSuffix(strings.ToLower(normalizeVideoResolution(resolution)), "p")); err == nil && tier > 0 && explicitTier {
		matched := min(width, height) == tier
		if resolutionToken == "2k" {
			matched = min(width, height) >= 1440 && max(width, height) >= 2048
		}
		if resolutionToken == "4k" {
			matched = min(width, height) >= 2160 && max(width, height) >= 3840
		}
		details["resolutionMatched"] = matched
		mismatch = mismatch || !matched
	}
	verdict, reason := "observed_dimensions", "已读取实际视频尺寸；尚未完整解码或进行内容验收"
	if mismatch {
		verdict, reason = "observed_mismatch", "实际视频尺寸与请求参数不一致；需核对软件适配和渠道参数映射"
	}
	return &CapabilityObservation{Feature: "resolution", Verdict: verdict, Reason: reason,
		Source: "generation_output:" + strings.ToLower(resolution), At: time.Now().UTC().Format(time.RFC3339), Details: details}
}

func (s *Service) recordVideoOutputObservation(task model.Task, result map[string]interface{}, fullDecode ...bool) {
	if s == nil || s.repo == nil || task.Type != "canvas_video" || task.RouteID != "" {
		// A logical-model route must be associated with its actual chosen provider.
		// Do not attribute a routed result to the user's original model key.
		return
	}
	raw, err := s.decryptTaskInputJSON(task.InputJSON)
	if err != nil {
		return
	}
	var input struct {
		Config providerConfig `json:"config"`
	}
	if json.Unmarshal([]byte(raw), &input) != nil {
		return
	}
	evidenceSource := "task_input"
	if input.Config.ChannelID == "" {
		// Completed tasks deliberately discard provider configuration. Actual
		// owned submission logs can recover only these non-secret wire fields.
		if task.Status != model.TaskStatusSucceeded {
			return
		}
		root, err := s.repo.VideoAPICallRoot(model.ApiCallLog{TaskID: task.ID})
		if err != nil || root.UserID != task.UserID || root.ChannelID == "" || root.Status != model.ApiCallStatusSucceeded {
			return
		}
		var fields map[string]any
		if json.Unmarshal([]byte(root.RequestBody), &fields) != nil {
			return
		}
		fieldString := func(key string) string {
			value, _ := fields[key].(string)
			return strings.TrimSpace(value)
		}
		ratio := firstNonEmpty(fieldString("aspect_ratio"), fieldString("aspectRatio"))
		if ratio == "" && strings.Contains(fieldString("size"), ":") {
			ratio = fieldString("size")
		}
		input.Config = providerConfig{ChannelID: root.ChannelID, Model: root.Model, Size: ratio,
			VQuality: firstNonEmpty(fieldString("resolution_name"), fieldString("resolution"))}
		evidenceSource = "provider_request_log"
	}
	video, ok := result["video"].(map[string]interface{})
	if !ok {
		return
	}
	resourceID, _ := video["resourceId"].(string)
	observation := videoOutputObservation(task.ID, task.CapabilityRevision, input.Config.Size, input.Config.VQuality,
		resourceID, int(numberValue(video["width"])), int(numberValue(video["height"])))
	if observation == nil {
		return
	}
	decoded := len(fullDecode) > 0 && fullDecode[0]
	observation.Details["fullDecodePassed"] = decoded
	observation.Details["requestEvidenceSource"] = evidenceSource
	if decoded && observation.Verdict != "observed_mismatch" {
		observation.Reason = "完整解码通过，已核对实际尺寸；不代表内容、音质或口型验收通过"
		if observation.Details["resolutionMatched"] == true && observation.Details["aspectRatioMatched"] == true {
			observation.Verdict = "supported"
		}
	}
	channelVideoOutputObservationLock.Lock()
	defer channelVideoOutputObservationLock.Unlock()
	item, err := s.repo.ChannelModelByKey(input.Config.ChannelID, providerChannelModelKey(input.Config))
	if err != nil && task.CapabilityRevision != "" {
		if split := strings.LastIndex(task.CapabilityRevision, ":"); split > 0 {
			item, err = s.repo.ChannelModelByID(input.Config.ChannelID, task.CapabilityRevision[:split])
		}
	}
	if err != nil || item == nil {
		return
	}
	if task.CapabilityRevision != "" && task.CapabilityRevision != channelModelCapabilityRevision(*item) {
		return
	}
	config, err := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
	if err != nil || config == nil || config.Video == nil {
		return
	}
	for _, existing := range config.Observed {
		if existing.Details["taskId"] == task.ID {
			if !decoded || existing.Details["fullDecodePassed"] == true {
				return
			}
		} else if decoded && existing.Source == observation.Source {
			// Reviewing an old clip must not overwrite a more recent test.
			return
		}
	}
	config.Observed = mergeCapabilityObservations(config.Observed, []CapabilityObservation{*observation})
	encoded, err := json.Marshal(config)
	if err != nil {
		return
	}
	// Only change evidence, never stale model settings or its capability revision.
	if changed, err := s.repo.SaveChannelModelObservedEvidence(item.ID, item.CapabilityVersion, item.CapabilityConfigJSON, string(encoded)); err == nil && changed {
		s.invalidateRouteCatalog()
	}
}

func (s *Service) recordProbedVideoOutput(userID, resourceID string, probe mediaProbeReport) {
	if s == nil || s.repo == nil || !probe.Decoded || probe.Width <= 0 || probe.Height <= 0 {
		return
	}
	task, err := s.repo.SucceededVideoTaskForResource(userID, resourceID)
	if err != nil || task == nil {
		return
	}
	var original struct {
		Video struct {
			ResourceID string `json:"resourceId"`
		} `json:"video"`
	}
	if json.Unmarshal([]byte(task.ResultJSON), &original) != nil || original.Video.ResourceID != resourceID {
		return
	}
	s.recordVideoOutputObservation(*task, map[string]interface{}{"video": map[string]interface{}{"resourceId": resourceID, "width": probe.Width, "height": probe.Height}}, true)
}

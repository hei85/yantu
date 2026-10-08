package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

const productionReconcileInterval = 5 * time.Second

func (s *Service) startProductionReconciler(ctx context.Context) {
	s.runWorkerLoop(func(workerCtx context.Context) {
		ticker := time.NewTicker(productionReconcileInterval)
		defer ticker.Stop()
		for {
			select {
			case <-workerCtx.Done():
				return
			case <-ticker.C:
				_ = s.ReconcileProductionRunsOnce()
			}
		}
	})
}

// ReconcileProductionRunsOnce 把已提交 GenerationTask 的终态投影回 ProductionStep/Attempt。
// 它只执行确定性状态推进，不创建新的开放式创作判断，也不自动重发付费请求。
func (s *Service) ReconcileProductionRunsOnce() error {
	attempts, err := s.repo.ActiveProductionAttempts(100)
	if err != nil {
		return err
	}
	for index := range attempts {
		attempt := attempts[index]
		if attempt.GenerationTaskID == "" {
			continue
		}
		task, err := s.repo.Task(attempt.GenerationTaskID)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		if err := s.reconcileProductionAttempt(attempt, *task); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) reconcileProductionAttempt(attempt model.ProductionAttempt, task model.Task) error {
	videoQuality, err := s.inspectProductionVideoTask(attempt, task)
	if err != nil {
		return err
	}
	return s.applyProductionAttemptObservation(attempt, task, videoQuality)
}

func (s *Service) applyProductionAttemptObservation(attempt model.ProductionAttempt, task model.Task, videoQuality *productionVideoQualityObservation) error {
	return s.repo.Transaction(func(repo *repository.Repository) error {
		run, err := repo.ProductionRunByID(attempt.RunID)
		if err != nil {
			return err
		}
		currentAttempt, err := repo.ProductionAttemptByID(attempt.RunID, attempt.ID)
		if err != nil {
			return err
		}
		step, err := repo.ProductionStep(attempt.RunID, attempt.StepID)
		if err != nil {
			return err
		}
		desiredState, desiredStepStatus := productionStateFromTask(task.Status)
		// 迟到结果保护：旧 attempt 不能覆盖已经开始的更新尝试（当前 fence）。
		lateAttempt := currentAttempt.AttemptNumber < step.AttemptCount
		if !lateAttempt && videoQuality != nil && !videoQuality.Passed {
			desiredState = "quality_failed"
			desiredStepStatus = "failed"
		}
		if !lateAttempt && currentAttempt.State == desiredState && step.Status == desiredStepStatus {
			return nil
		}
		currentAttempt.State = desiredState
		currentAttempt.ProviderTaskID = firstNonEmpty(currentAttempt.ProviderTaskID, task.ProviderRequestID)
		currentAttempt.ErrorCode = ""
		if task.Status == model.TaskStatusFailed {
			currentAttempt.ErrorCode = "generation_failed"
		}
		if !lateAttempt && videoQuality != nil && !videoQuality.Passed {
			currentAttempt.ErrorCode = "video_quality_failed"
		}
		if task.Status == model.TaskStatusCancelled {
			currentAttempt.ErrorCode = "cancellation_unsettled"
		}
		settlement, settledMicros := settleProductionAttemptCost(run, currentAttempt, task.Status)
		if err := repo.SaveProductionAttempt(currentAttempt); err != nil {
			return err
		}
		if lateAttempt {
			run.Revision++
			if err := repo.AppendProductionEvent(run, "attempt_late_observed", currentAttempt.ID, int64(currentAttempt.AttemptNumber), mapJSON(map[string]any{
				"taskId":        task.ID,
				"taskStatus":    task.Status,
				"attemptId":     currentAttempt.ID,
				"attemptState":  desiredState,
				"settlement":    settlement,
				"settledMicros": settledMicros,
				"late":          true,
			})); err != nil {
				return err
			}
			return repo.SaveProductionRun(run)
		}
		step.Status = desiredStepStatus
		step.BlockingReason = ""
		if task.Status == model.TaskStatusFailed {
			step.BlockingReason = firstNonEmpty(task.Error, task.Stage, "生成任务失败")
		}
		if !lateAttempt && videoQuality != nil && !videoQuality.Passed {
			step.BlockingReason = videoQuality.Reason
		}
		if task.Status == model.TaskStatusSucceeded {
			step.OutputArtifactJSON = mapJSON(productionTaskArtifacts(task))
		}
		step.Revision++
		step.LeaseOwner = ""
		step.LeaseExpiresAt = nil
		if err := repo.SaveProductionStep(step); err != nil {
			return err
		}
		steps, err := repo.ProductionSteps(run.ID)
		if err != nil {
			return err
		}
		allSucceeded := true
		activeSteps := 0
		for index := range steps {
			if steps[index].ID == step.ID {
				steps[index] = *step
			}
			if steps[index].Superseded {
				continue
			}
			activeSteps++
			if steps[index].Status != "succeeded" {
				allSucceeded = false
			}
		}
		if activeSteps == 0 {
			allSucceeded = false
		}
		for index := range steps {
			if steps[index].Superseded || steps[index].Status != "pending" {
				continue
			}
			ready := true
			for _, dependencyID := range decodeStringList(steps[index].DependsOnJSON) {
				dependencyReady := false
				for _, candidate := range steps {
					if candidate.StepKey == dependencyID && !candidate.Superseded && candidate.Status == "succeeded" {
						dependencyReady = true
						break
					}
				}
				if !dependencyReady {
					ready = false
					break
				}
			}
			if !ready {
				continue
			}
			steps[index].Status = "ready"
			steps[index].Revision++
			if err := repo.SaveProductionStep(&steps[index]); err != nil {
				return err
			}
		}
		features := s.ProductionFeatures()
		switch run.Status {
		case "cancelled", "paused":
			// 已取消或暂停的制作不会被后台观察擅自恢复；只记录真实任务事实与费用。
		default:
			switch task.Status {
			case model.TaskStatusSucceeded:
				if videoQuality != nil && !videoQuality.Passed {
					if features.AutoRepair {
						run.Status = "repairing"
						run.CurrentStage = "video_quality_failed"
					} else {
						run.Status = "waiting_agent"
						run.CurrentStage = "waiting_agent"
					}
				} else {
					run.Status = "running"
					run.CurrentStage = step.Kind + "_completed"
				}
			case model.TaskStatusFailed, model.TaskStatusCancelled:
				if features.AutoRepair {
					run.Status = "repairing"
					run.CurrentStage = step.Kind + "_failed"
				} else {
					// 自动修复关闭时，需要新判断的步骤停在 WAITING_AGENT，
					// 由同一外部 Codex/MCP 路线继续，而不是偷偷启用第二套 Agent。
					run.Status = "waiting_agent"
					run.CurrentStage = "waiting_agent"
				}
			default:
				run.Status = "running"
				run.CurrentStage = step.Kind
			}
			if allSucceeded {
				run.Status = "verifying"
				run.CurrentStage = "delivery_check"
			}
		}
		run.Revision++
		eventType := "step_observed"
		eventPayload := map[string]any{
			"taskId":        task.ID,
			"taskStatus":    task.Status,
			"attemptId":     attempt.ID,
			"attemptState":  desiredState,
			"settlement":    settlement,
			"settledMicros": settledMicros,
		}
		if !lateAttempt && videoQuality != nil {
			eventPayload["videoQuality"] = videoQuality
			if !videoQuality.Passed {
				eventType = "step_quality_failed"
			}
		}
		if err := repo.AppendProductionEvent(run, eventType, step.ID, step.Revision, mapJSON(eventPayload)); err != nil {
			return err
		}
		return repo.SaveProductionRun(run)
	})
}

type productionVideoQualityObservation struct {
	ArtifactIDs       []string                          `json:"artifactIds"`
	TargetAspectRatio string                            `json:"targetAspectRatio"`
	Media             []ResourceProbeResult             `json:"media"`
	Audio             []productionVideoAudioObservation `json:"audio"`
	Passed            bool                              `json:"passed"`
	Reason            string                            `json:"reason,omitempty"`
}

type productionVideoAudioObservation struct {
	AudioMode              string `json:"audioMode"`
	ResourceID             string `json:"resourceId"`
	RequestedGenerateAudio string `json:"requestedGenerateAudio,omitempty"`
	ObservedAudioStreams   int    `json:"observedAudioStreams"`
	Status                 string `json:"status"`
	Reason                 string `json:"reason"`
}

func (s *Service) inspectProductionVideoTask(attempt model.ProductionAttempt, task model.Task) (*productionVideoQualityObservation, error) {
	if task.Status != model.TaskStatusSucceeded {
		return nil, nil
	}
	run, err := s.repo.ProductionRunByID(attempt.RunID)
	if err != nil {
		return nil, err
	}
	step, err := s.repo.ProductionStep(attempt.RunID, attempt.StepID)
	if err != nil {
		return nil, err
	}
	if step.Kind != "video" || attempt.AttemptNumber < step.AttemptCount {
		return nil, nil
	}
	contract := productionDeliveryContractForRun(*run)
	observation := &productionVideoQualityObservation{
		ArtifactIDs:       productionTaskArtifacts(task),
		TargetAspectRatio: contract.TargetAspectRatio,
		Media:             []ResourceProbeResult{},
		Audio:             []productionVideoAudioObservation{},
		Passed:            true,
	}
	if len(observation.ArtifactIDs) == 0 {
		observation.Passed = false
		observation.Reason = "视频任务已成功，但结果没有绑定可追踪的视频资源"
		return observation, nil
	}
	videoArtifactIDs := productionTaskVideoArtifacts(task)
	if len(videoArtifactIDs) == 0 {
		observation.Passed = false
		observation.Reason = "视频任务结果没有可探测的视频资源"
		return observation, nil
	}
	if _, _, valid := parseAspectRatio(contract.TargetAspectRatio); !valid {
		observation.Passed = false
		observation.Reason = "制作计划没有有效的目标画幅比例，无法验收视频片段"
		return observation, nil
	}
	for _, resourceID := range videoArtifactIDs {
		media, probeErr := s.ProbeResource(run.UserID, resourceID, false)
		if probeErr != nil {
			observation.Passed = false
			observation.Reason = "生成视频资源无法读取或探测，不能标记镜头质量通过"
			continue
		}
		observation.Media = append(observation.Media, *media)
		observation.Audio = append(observation.Audio, observeProductionVideoAudio(run.AudioMode, task, *media))
		if reason := productionVideoProbeFailure(*media, contract.TargetAspectRatio); reason != "" {
			observation.Passed = false
			observation.Reason = firstNonEmpty(observation.Reason, reason)
		}
	}
	return observation, nil
}

func observeProductionVideoAudio(audioMode string, task model.Task, media ResourceProbeResult) productionVideoAudioObservation {
	mode, modeErr := normalizeProductionAudioMode(audioMode)
	if modeErr != nil {
		mode = ""
	}
	var input canvasGenerationInput
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil {
		return productionVideoAudioObservation{
			AudioMode:  mode,
			ResourceID: media.ResourceID, ObservedAudioStreams: media.Probe.AudioStreams,
			Status: "request_unreadable", Reason: "无法读取视频请求中的原生音频参数；保留实测音轨数量供后续处理",
		}
	}
	requested := strings.ToLower(strings.TrimSpace(input.Config.VideoGenerateAudio))
	observed := media.Probe.AudioStreams
	result := productionVideoAudioObservation{
		AudioMode: mode, ResourceID: media.ResourceID, RequestedGenerateAudio: requested, ObservedAudioStreams: observed,
	}
	if mode == model.ProductionAudioModeNative {
		if observed > 0 {
			result.Status = "native_audio_preserved"
			result.Reason = "NATIVE_AUDIO 保留实测到的视频原生音轨；不会调用 MiMo 覆盖"
		} else {
			result.Status = "native_audio_absent"
			result.Reason = "NATIVE_AUDIO 未探测到视频原生音轨；不会自动改用 MiMo 覆盖"
		}
		return result
	}
	if mode == model.ProductionAudioModeRebuild {
		if observed > 0 {
			result.Status = "native_audio_discarded"
			result.Reason = "REBUILD_AUDIO 将在 Timeline 中静音此视频原生音轨，只保留独立音轨"
		} else {
			result.Status = "native_audio_absent"
			result.Reason = "REBUILD_AUDIO 未探测到视频原生音轨；最终使用独立音轨"
		}
		return result
	}
	switch requested {
	case "true":
		if observed > 0 {
			result.Status = "requested_audio_present"
			result.Reason = "请求启用原生音频，实测包含音轨"
		} else {
			result.Status = "requested_audio_missing"
			result.Reason = "请求启用原生音频，但实测没有音轨"
		}
	case "false":
		if observed > 0 {
			result.Status = "unexpected_audio_present"
			result.Reason = "请求关闭原生音频，但实测包含音轨；须按整片音频策略决定保留、静音或混音"
		} else {
			result.Status = "audio_disabled_as_requested"
			result.Reason = "请求关闭原生音频，实测没有音轨"
		}
	default:
		result.Status = "request_unspecified"
		result.Reason = "请求未明确声明原生音频开关；按实测音轨数量处理"
	}
	return result
}

func productionVideoProbeFailure(media ResourceProbeResult, targetAspectRatio string) string {
	if media.MediaType != "video" || media.Probe.VideoStreams < 1 {
		return "生成产物没有可用的视频流"
	}
	if media.Probe.Width <= 0 || media.Probe.Height <= 0 {
		return "视频流没有有效的实测宽高"
	}
	if !ratioMatches(media.Probe.Width, media.Probe.Height, targetAspectRatio, productionAspectRatioTolerance) {
		return fmt.Sprintf("实测画幅 %d:%d 不符合制作计划要求 %s", media.Probe.Width/gcd(media.Probe.Width, media.Probe.Height), media.Probe.Height/gcd(media.Probe.Width, media.Probe.Height), targetAspectRatio)
	}
	return ""
}

// settleProductionAttemptCost 把预留金额转为已花费、释放或保持未结算。
// 供应商已成功的尝试转为 spent；明确失败释放预留；取消能否避免费用取决于上游事实，
// 因此保持预留并标记 cancellation_unsettled，不把未结算成本伪造成零。
func settleProductionAttemptCost(run *model.ProductionRun, attempt *model.ProductionAttempt, status model.TaskStatus) (string, int64) {
	amount := attempt.ReservedCostMicros
	if amount <= 0 {
		return "", 0
	}
	switch status {
	case model.TaskStatusSucceeded:
		run.Reserved -= amount
		if run.Reserved < 0 {
			run.Reserved = 0
		}
		run.Spent += amount
		attempt.ReservedCostMicros = 0
		return "settled", amount
	case model.TaskStatusFailed:
		run.Reserved -= amount
		if run.Reserved < 0 {
			run.Reserved = 0
		}
		attempt.ReservedCostMicros = 0
		attempt.ErrorCode = firstNonEmpty(attempt.ErrorCode, "generation_failed")
		return "released", amount
	case model.TaskStatusCancelled:
		attempt.ErrorCode = "cancellation_unsettled"
		return "unsettled", amount
	default:
		return "", 0
	}
}

func productionStateFromTask(status model.TaskStatus) (string, string) {
	switch status {
	case model.TaskStatusSucceeded:
		return "succeeded", "succeeded"
	case model.TaskStatusFailed:
		return "failed", "failed"
	case model.TaskStatusCancelled:
		return "cancelled", "cancelled"
	case model.TaskStatusQueued:
		return "running", "submitting"
	default:
		return "running", "running"
	}
}

func productionTaskArtifacts(task model.Task) []string {
	return collectProductionArtifactIDs(decodeMap(task.ResultJSON))
}

func productionTaskVideoArtifacts(task model.Task) []string {
	result := decodeMap(task.ResultJSON)
	if video, ok := result["video"]; ok {
		if ids := collectProductionArtifactIDs(video); len(ids) > 0 {
			return ids
		}
	}
	return productionTaskArtifacts(task)
}

func collectProductionArtifactIDs(value any) []string {
	ids := make([]string, 0, 4)
	var walk func(any)
	walk = func(value any) {
		switch item := value.(type) {
		case map[string]any:
			for key, nested := range item {
				switch key {
				case "resourceId", "resource_id", "outputResourceId":
					if id := stringValue(nested); id != "" {
						ids = append(ids, id)
					}
				case "artifactIds", "outputArtifactIds", "resourceIds":
					if values, ok := nested.([]any); ok {
						for _, candidate := range values {
							if id := stringValue(candidate); id != "" {
								ids = append(ids, id)
							}
						}
					} else if id := stringValue(nested); id != "" {
						ids = append(ids, id)
					}
				}
				walk(nested)
			}
		case []any:
			for _, nested := range item {
				walk(nested)
			}
		}
	}
	walk(value)
	return uniqueProductionStrings(ids)
}

func uniqueProductionStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	output := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		output = append(output, value)
	}
	return output
}

package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

const maxProductionStepEvidenceBytes = 64 << 10

type ProductionStepResultRequest struct {
	ExpectedRevision int64          `json:"expectedRevision"`
	StepID           string         `json:"stepId"`
	Evidence         map[string]any `json:"evidence"`
}

// RecordProductionStepResult records the evidence produced by an existing checker.
// It does not perform the check or turn missing semantic evidence into a pass.
func (s *Service) RecordProductionStepResult(userID, runID string, req ProductionStepResultRequest) (*ProductionRunOutput, error) {
	req.StepID = strings.TrimSpace(req.StepID)
	if req.StepID == "" || len(req.StepID) > 120 {
		return nil, BadAuthRequest("缺少有效的制作步骤 ID")
	}
	if run, err := s.repo.ProductionRunForUser(userID, runID); err == nil {
		if step, stepErr := s.repo.ProductionStep(runID, req.StepID); stepErr == nil && step.Kind == "reuse_media" {
			return s.recordProductionMediaReuse(userID, run, step, req)
		}
	}
	evidence, outcome, err := normalizeProductionStepEvidence(req.Evidence)
	if err != nil {
		return nil, BadAuthRequest(err.Error())
	}

	err = s.repo.MutateProductionRun(userID, runID, func(run *model.ProductionRun, repo *repository.Repository) error {
		if run.Revision != req.ExpectedRevision {
			return repository.ErrProductionConflict
		}
		if run.Status == "planning" || run.Status == "paused" || run.Status == "cancelled" || run.Status == "completed" {
			return productionConflict("当前制作状态不能记录质检结果")
		}
		if !policyAuthorized(run.PolicyJSON) {
			return productionConflict("制作计划尚未授权")
		}
		step, err := repo.ProductionStep(runID, req.StepID)
		if err != nil {
			return err
		}
		if step.Superseded || (step.Kind != "check" && step.Kind != "verify") {
			return productionConflict("只有当前计划中的 check/verify 步骤可以记录质检结果")
		}
		if step.Status != "pending" && step.Status != "ready" && step.Status != "failed" && step.Status != "uncertain" && step.Status != "waiting_agent" {
			return productionConflict("步骤当前状态不允许覆盖质检结果")
		}
		if err := ensureProductionDependenciesReady(repo, runID, step); err != nil {
			return err
		}
		if err := validateAndFingerprintProductionSkillApplications(run.PlanJSON, *step, evidence); err != nil {
			return BadAuthRequest(err.Error())
		}
		stageOutcome, err := validateFullFilmStageEvidence(repo, run, step, evidence)
		if err != nil {
			return BadAuthRequest(err.Error())
		}
		outcome = stricterProductionStepOutcome(outcome, stageOutcome)
		coverageOutcome, err := validateProductionSelfCheckEvidence(repo, run, step, evidence)
		if err != nil {
			return BadAuthRequest(err.Error())
		}
		outcome = stricterProductionStepOutcome(outcome, coverageOutcome)
		if strings.HasPrefix(step.StepKey, "quality:") || strings.HasPrefix(step.StepKey, "continuity:") {
			semanticOutcome, err := productionSemanticReviewOutcome(evidence)
			if err != nil {
				return BadAuthRequest(err.Error())
			}
			outcome = stricterProductionStepOutcome(outcome, semanticOutcome)
		}

		step.Status = productionStepStatusForEvidence(outcome)
		step.BlockingReason = ""
		if outcome != "passed" {
			step.BlockingReason = firstString(stringValue(evidence["reason"]), "质检结果为"+outcome+"；需要复核或修复")
		}
		step.Revision++
		if err := repo.SaveProductionStep(step); err != nil {
			return err
		}

		quality := decodeMap(run.QualityJSON)
		results := productionRecord(quality["stepResults"])
		result := map[string]any{
			"stepId": step.ID, "stepKey": step.StepKey, "status": outcome,
			"evidence": evidence, "stepRevision": step.Revision,
			"recordedAt": time.Now().UTC().Format(time.RFC3339Nano),
		}
		results[step.StepKey] = result
		quality["stepResults"] = results
		run.QualityJSON = mapJSON(quality)

		steps, err := repo.ProductionSteps(runID)
		if err != nil {
			return err
		}
		if err := unlockReadyProductionSteps(repo, steps); err != nil {
			return err
		}
		if outcome == "passed" {
			run.Status = "running"
			run.CurrentStage = step.Kind + "_completed"
		} else {
			run.Status = "waiting_agent"
			run.CurrentStage = "waiting_agent"
		}
		if productionStepsReadyExceptDelivery(steps) {
			run.Status = "verifying"
			run.CurrentStage = "delivery_check"
		}
		run.Revision++
		return repo.AppendProductionEvent(run, "step_result_recorded", step.ID, step.Revision, mapJSON(result))
	})
	if err != nil {
		return nil, productionError(err)
	}
	return s.GetProductionRun(userID, runID, 0)
}

// Stage evidence can make a result stricter, but it cannot turn a failed or
// uncertain check into a pass. An empty stage outcome means the check is not a
// stage gate (or legacy workflow) and leaves the normalized checks unchanged.
func stricterProductionStepOutcome(checksOutcome, stageOutcome string) string {
	if stageOutcome == "" {
		return checksOutcome
	}
	if checksOutcome == "failed" || stageOutcome == "failed" {
		return "failed"
	}
	if checksOutcome == "uncertain" || stageOutcome == "uncertain" {
		return "uncertain"
	}
	return "passed"
}

func (s *Service) recordProductionMediaReuse(userID string, run *model.ProductionRun, step *model.ProductionStep, req ProductionStepResultRequest) (*ProductionRunOutput, error) {
	if run == nil || step == nil || step.Kind != "reuse_media" || step.Superseded {
		return nil, productionConflict("现有媒体复用步骤不存在或已失效")
	}
	if len(req.Evidence) != 1 {
		return nil, BadAuthRequest("现有媒体复用只接受 manifest 已绑定的 resourceId；探测证据由服务器生成")
	}
	resourceID := strings.TrimSpace(stringValue(req.Evidence["resourceId"]))
	if resourceID == "" || len(resourceID) > 36 {
		return nil, BadAuthRequest("现有媒体复用缺少有效 resourceId")
	}
	if run.Revision != req.ExpectedRevision {
		return nil, productionConflict("制作版本已变化，请读取最新 revision 后复用媒体")
	}
	if run.Status == "planning" || run.Status == "paused" || run.Status == "cancelled" || run.Status == "completed" || !policyAuthorized(run.PolicyJSON) {
		return nil, productionConflict("制作尚未授权或当前状态不能复用媒体")
	}
	binding, manifest, err := productionReuseBindingForStep(run.PlanJSON, *step)
	if err != nil {
		return nil, productionConflict(err.Error())
	}
	if resourceID != strings.TrimSpace(stringValue(binding["resourceId"])) {
		return nil, productionConflict("resourceId 与分镜片段已锁定的现有媒体绑定不一致")
	}
	spanDurationMs := productionManifestSpanDurationMs(manifest, productionSegmentTraceKey(step.StoryboardRowID, step.SegmentID))
	if spanDurationMs <= 0 {
		return nil, productionConflict("分镜片段缺少有效的已锁定时间线时长")
	}
	media, err := s.ProbeResource(userID, resourceID, true)
	if err != nil {
		return nil, productionError(err)
	}
	if media.MediaType != "video" || !media.Probe.Decoded || media.Probe.VideoStreams < 1 || media.Probe.DurationMs < spanDurationMs {
		return nil, productionConflict("复用视频必须属于当前用户、完整解码且至少覆盖该 SegmentBinding 时长")
	}
	contract := productionDeliveryContractForRun(*run)
	if !ratioMatches(media.Probe.Width, media.Probe.Height, contract.TargetAspectRatio, productionAspectRatioTolerance) {
		return nil, productionConflict("复用视频实测画幅不符合该 ProductionRun 的 Brief 合同")
	}
	requireNativeAudio := (contract.RequireAudio || boolValue(manifest["requireAudio"])) && run.AudioMode == model.ProductionAudioModeNative
	if requireNativeAudio && media.Probe.AudioStreams < 1 {
		return nil, productionConflict("NATIVE_AUDIO 且 Brief 要求音频，但复用视频没有可检测的原生音轨")
	}
	sourceTaskID := strings.TrimSpace(stringValue(binding["sourceTaskId"]))
	if sourceTaskID != "" {
		task, taskErr := s.repo.TaskForUser(userID, sourceTaskID)
		artifacts := []string(nil)
		if task != nil {
			artifacts = productionTaskVideoArtifacts(*task)
		}
		if taskErr != nil || task == nil || task.Status != model.TaskStatusSucceeded || len(artifacts) != 1 || artifacts[0] != resourceID {
			return nil, productionConflict("复用视频的来源任务未成功或没有产出绑定的实际资源")
		}
	}
	evidence := map[string]any{
		"resourceId": resourceID, "sourceTaskId": sourceTaskID, "sourceNodeId": strings.TrimSpace(stringValue(binding["sourceNodeId"])),
		"segmentDurationMs": spanDurationMs, "briefAspectRatio": contract.TargetAspectRatio,
		"probe": map[string]any{
			"decoded": media.Probe.Decoded, "durationMs": media.Probe.DurationMs, "width": media.Probe.Width, "height": media.Probe.Height,
			"videoStreams": media.Probe.VideoStreams, "audioStreams": media.Probe.AudioStreams,
		},
		"checks": []any{
			map[string]any{"name": "resource_owner_and_ready", "status": "passed"},
			map[string]any{"name": "video_stream_and_full_decode", "status": "passed"},
			map[string]any{"name": "segment_duration", "status": "passed"},
			map[string]any{"name": "brief_aspect_ratio", "status": "passed"},
		},
	}
	if sourceTaskID != "" {
		evidence["checks"] = append(evidence["checks"].([]any), map[string]any{"name": "source_task_output_binding", "status": "passed"})
	}
	if requireNativeAudio {
		evidence["checks"] = append(evidence["checks"].([]any), map[string]any{"name": "required_native_audio_stream", "status": "passed"})
	}

	err = s.repo.MutateProductionRun(userID, run.ID, func(locked *model.ProductionRun, repo *repository.Repository) error {
		if locked.Revision != req.ExpectedRevision {
			return repository.ErrProductionConflict
		}
		current, e := repo.ProductionStep(run.ID, step.ID)
		if e != nil {
			return e
		}
		if current.Superseded || current.Kind != "reuse_media" || current.AttemptCount != 0 || current.Status == "succeeded" || current.Status == "running" {
			return productionConflict("现有媒体复用步骤已完成、已付费或状态不允许更新")
		}
		currentBinding, _, e := productionReuseBindingForStep(locked.PlanJSON, *current)
		if e != nil || stringValue(currentBinding["resourceId"]) != resourceID {
			return productionConflict("复用媒体绑定在探测期间发生变化")
		}
		if e := ensureProductionDependenciesReady(repo, run.ID, current); e != nil {
			return e
		}
		current.Status = "succeeded"
		current.BlockingReason = ""
		current.OutputArtifactJSON = mapJSON([]string{resourceID})
		current.Revision++
		if e := repo.SaveProductionStep(current); e != nil {
			return e
		}
		quality := decodeMap(locked.QualityJSON)
		results := productionRecord(quality["stepResults"])
		result := map[string]any{"stepId": current.ID, "stepKey": current.StepKey, "status": "passed", "evidence": evidence, "stepRevision": current.Revision, "recordedAt": time.Now().UTC().Format(time.RFC3339Nano)}
		results[current.StepKey] = result
		quality["stepResults"] = results
		locked.QualityJSON = mapJSON(quality)
		steps, e := repo.ProductionSteps(run.ID)
		if e != nil {
			return e
		}
		if e := unlockReadyProductionSteps(repo, steps); e != nil {
			return e
		}
		locked.Status = "running"
		locked.CurrentStage = "media_reused"
		if productionStepsReadyExceptDelivery(steps) {
			locked.Status = "verifying"
			locked.CurrentStage = "delivery_check"
		}
		locked.Revision++
		return repo.AppendProductionEvent(locked, "media_reused", current.ID, current.Revision, mapJSON(result))
	})
	if err != nil {
		return nil, productionError(err)
	}
	return s.GetProductionRun(userID, run.ID, 0)
}

func productionReuseBindingForStep(planJSON string, step model.ProductionStep) (map[string]any, map[string]any, error) {
	executionManifest, ok := decodeMap(planJSON)["executionManifest"].(map[string]any)
	if !ok {
		return nil, nil, fmt.Errorf("制作计划缺少现有媒体复用清单")
	}
	for _, binding := range productionManifestRecords(executionManifest["reusedMediaBindings"]) {
		if strings.TrimSpace(stringValue(binding["stepKey"])) == step.StepKey && strings.TrimSpace(stringValue(binding["storyboardRowId"])) == step.StoryboardRowID && strings.TrimSpace(stringValue(binding["segmentId"])) == step.SegmentID {
			return binding, executionManifest, nil
		}
	}
	return nil, executionManifest, fmt.Errorf("ProductionStep 没有匹配的现有媒体资源绑定")
}

func validateAndFingerprintProductionSkillApplications(planJSON string, step model.ProductionStep, evidence map[string]any) error {
	if !strings.HasPrefix(step.StepKey, "continuity:") {
		return nil
	}
	strategyPrefix, selectedSkills, hasStrategy := strings.Cut(strings.TrimSpace(step.SelectedStrategyID), ":")
	if !hasStrategy || strategyPrefix != "continuity" {
		selectedSkills = ""
	}
	expected := map[string]bool{}
	for _, skillID := range strings.Split(selectedSkills, ",") {
		if skillID = strings.TrimSpace(skillID); skillID != "" {
			if expected[skillID] {
				return fmt.Errorf("连续性步骤重复选择技能 %s", skillID)
			}
			expected[skillID] = true
		}
	}
	applications := productionManifestRecords(evidence["skillApplications"])
	if len(expected) == 0 {
		if len(applications) != 0 {
			return fmt.Errorf("连续性步骤未声明技能，不能写入技能应用证据")
		}
		return nil
	}
	if len(applications) != len(expected) {
		return fmt.Errorf("连续性步骤必须为每个已选技能提交一条 skillApplications 证据")
	}

	manifest, ok := decodeMap(planJSON)["executionManifest"].(map[string]any)
	if !ok {
		return fmt.Errorf("制作计划缺少技能读取证据")
	}
	readEvidence := productionManifestRecords(manifest["skillEvidence"])
	seen := map[string]bool{}
	for _, application := range applications {
		skillID := strings.TrimSpace(stringValue(application["skillId"]))
		versionID := strings.TrimSpace(stringValue(application["versionId"]))
		contentHash := strings.TrimSpace(stringValue(application["contentHash"]))
		rowID := strings.TrimSpace(stringValue(application["storyboardRowId"]))
		inputFingerprint := strings.TrimSpace(stringValue(application["inputFingerprint"]))
		outputSummary := strings.TrimSpace(stringValue(application["outputSummary"]))
		if !expected[skillID] || seen[skillID] {
			return fmt.Errorf("连续性技能应用与已选技能不一致或重复：%s", skillID)
		}
		if rowID == "" || rowID != step.StoryboardRowID || inputFingerprint == "" || inputFingerprint != step.InputFingerprint || outputSummary == "" {
			return fmt.Errorf("技能 %s 的应用证据必须绑定当前分镜行、输入指纹和实际输出摘要", skillID)
		}
		readMatches := false
		for _, prepared := range readEvidence {
			if stringValue(prepared["skillId"]) == skillID &&
				stringValue(prepared["versionId"]) == versionID &&
				stringValue(prepared["contentHash"]) == contentHash &&
				strings.TrimSpace(stringValue(prepared["phase"])) != "" {
				readMatches = true
				break
			}
		}
		if !readMatches {
			return fmt.Errorf("技能 %s 的版本与当前制作计划读取证据不一致", skillID)
		}
		digest := sha256.Sum256([]byte(outputSummary))
		application["outputFingerprint"] = "sha256:" + hex.EncodeToString(digest[:])
		seen[skillID] = true
	}
	return nil
}

func normalizeProductionStepEvidence(input map[string]any) (map[string]any, string, error) {
	if input == nil {
		return nil, "", fmt.Errorf("缺少质检证据")
	}
	encoded, err := json.Marshal(input)
	if err != nil || len(encoded) > maxProductionStepEvidenceBytes {
		return nil, "", fmt.Errorf("质检证据无效或超过 64 KiB")
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var evidence map[string]any
	if err := decoder.Decode(&evidence); err != nil || evidence == nil {
		return nil, "", fmt.Errorf("质检证据必须是 JSON 对象")
	}
	if err := validateProductionEvidenceValue(evidence, 0); err != nil {
		return nil, "", err
	}
	checks := productionManifestRecords(evidence["checks"])
	if len(checks) == 0 || len(checks) > 200 {
		return nil, "", fmt.Errorf("质检证据必须包含 1 到 200 项检查")
	}
	outcome := "passed"
	for _, check := range checks {
		if strings.TrimSpace(stringValue(check["name"])) == "" {
			return nil, "", fmt.Errorf("每项质检都必须提供 name")
		}
		status := stringValue(check["status"])
		switch status {
		case "passed":
		case "failed":
			outcome = "failed"
		case "uncertain":
			if outcome == "passed" {
				outcome = "uncertain"
			}
		default:
			return nil, "", fmt.Errorf("质检状态只能是 passed、failed 或 uncertain")
		}
	}
	return evidence, outcome, nil
}

func validateProductionEvidenceValue(value any, depth int) error {
	if depth > 10 {
		return fmt.Errorf("质检证据嵌套层级过深")
	}
	switch item := value.(type) {
	case map[string]any:
		if len(item) > 100 {
			return fmt.Errorf("质检证据单个对象字段过多")
		}
		for key, child := range item {
			lower := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "_", ""), "-", ""))
			for _, forbidden := range []string{"apikey", "secret", "token", "cookie", "authorization", "password", "credential", "dataurl", "presigned", "privatekey"} {
				if strings.Contains(lower, forbidden) {
					return fmt.Errorf("质检证据不能包含凭证字段")
				}
			}
			if strings.Contains(lower, "url") || strings.Contains(lower, "uri") {
				return fmt.Errorf("质检证据不能保存媒体 URL")
			}
			if err := validateProductionEvidenceValue(child, depth+1); err != nil {
				return err
			}
		}
	case []any:
		if len(item) > 200 {
			return fmt.Errorf("质检证据数组项目过多")
		}
		for _, child := range item {
			if err := validateProductionEvidenceValue(child, depth+1); err != nil {
				return err
			}
		}
	case string:
		if len(item) > 5000 || strings.Contains(strings.ToLower(item), "data:") || strings.Contains(strings.ToLower(item), "http://") || strings.Contains(strings.ToLower(item), "https://") {
			return fmt.Errorf("质检证据文本过长或包含内嵌/远程媒体数据")
		}
	}
	return nil
}

func productionStepStatusForEvidence(outcome string) string {
	switch outcome {
	case "passed":
		return "succeeded"
	case "failed":
		return "failed"
	default:
		return "uncertain"
	}
}

func unlockReadyProductionSteps(repo *repository.Repository, steps []model.ProductionStep) error {
	completed := map[string]bool{}
	for _, step := range steps {
		completed[step.StepKey] = !step.Superseded && step.Status == "succeeded"
	}
	for index := range steps {
		step := &steps[index]
		if step.Superseded || step.Status != "pending" {
			continue
		}
		ready := true
		for _, dependency := range decodeStringList(step.DependsOnJSON) {
			if !completed[dependency] {
				ready = false
				break
			}
		}
		if ready {
			step.Status = "ready"
			step.Revision++
			if err := repo.SaveProductionStep(step); err != nil {
				return err
			}
		}
	}
	return nil
}

func productionStepsReadyExceptDelivery(steps []model.ProductionStep) bool {
	active := 0
	for _, step := range steps {
		if step.Superseded || step.Kind == "delivery_check" {
			continue
		}
		active++
		if step.Status != "succeeded" {
			return false
		}
	}
	return active > 0
}

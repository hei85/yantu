package app

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

const productionAspectRatioTolerance = 0.03

type ProductionDeliveryContract struct {
	TargetDurationMs      int64  `json:"targetDurationMs"`
	TargetAspectRatio     string `json:"targetAspectRatio"`
	MinWidth              int    `json:"minWidth,omitempty"`
	MinHeight             int    `json:"minHeight,omitempty"`
	MaxWidth              int    `json:"maxWidth,omitempty"`
	MaxHeight             int    `json:"maxHeight,omitempty"`
	DurationToleranceMs   int64  `json:"durationToleranceMs"`
	RequireVideo          bool   `json:"requireVideo"`
	RequireAudio          bool   `json:"requireAudio"`
	RequireSubtitle       bool   `json:"requireSubtitle"`
	RequireFullDecode     bool   `json:"requireFullDecode"`
	BriefVersion          string `json:"briefVersion,omitempty"`
	ApprovedChangeVersion string `json:"approvedChangeVersion,omitempty"`
}

type ProductionDeliveryVerificationRequest struct {
	ExpectedRevision    int64  `json:"expectedRevision"`
	ResourceID          string `json:"resourceId"`
	ExpectedDurationMs  *int64 `json:"expectedDurationMs,omitempty"`
	ExpectedAspectRatio string `json:"expectedAspectRatio,omitempty"`
	ExpectedWidth       *int   `json:"expectedWidth,omitempty"`
	ExpectedHeight      *int   `json:"expectedHeight,omitempty"`
	RequireVideo        *bool  `json:"requireVideo,omitempty"`
	RequireAudio        *bool  `json:"requireAudio,omitempty"`
	RequireSubtitle     *bool  `json:"requireSubtitle,omitempty"`
}

type ProductionDeliveryCheck struct {
	Name                 string `json:"name"`
	OriginalRequirement  any    `json:"originalRequirement"`
	EffectiveRequirement any    `json:"effectiveRequirement"`
	Measured             any    `json:"measured"`
	Status               string `json:"status"`
	Reason               string `json:"reason"`
}

type ProductionDeliveryVerificationOutput struct {
	DeliveryStatus string                    `json:"deliveryStatus"`
	Checks         []ProductionDeliveryCheck `json:"checks"`
	Media          *ResourceProbeResult      `json:"media,omitempty"`
	Completed      bool                      `json:"completed"`
	Run            *ProductionRunOutput      `json:"run,omitempty"`
}

func normalizeProductionDeliveryContract(input ProductionDeliveryContract, brief map[string]any, requestedDuration int64) (ProductionDeliveryContract, error) {
	briefContract := productionRecord(brief["deliveryContract"])
	if requestedDuration < 0 || input.TargetDurationMs < 0 || input.DurationToleranceMs < 0 || input.MinWidth < 0 || input.MinHeight < 0 || input.MaxWidth < 0 || input.MaxHeight < 0 {
		return ProductionDeliveryContract{}, fmt.Errorf("Brief 交付参数不能为负数")
	}
	briefDuration, err := consistentPositiveInt64("targetDurationMs", requestedDuration, input.TargetDurationMs, int64Value(briefContract["targetDurationMs"]), int64Value(brief["targetDurationMs"]))
	if err != nil {
		return ProductionDeliveryContract{}, err
	}
	tolerance, err := consistentPositiveInt64("durationToleranceMs", input.DurationToleranceMs, int64Value(briefContract["durationToleranceMs"]), int64Value(brief["durationToleranceMs"]))
	if err != nil {
		return ProductionDeliveryContract{}, err
	}
	input.TargetDurationMs = briefDuration
	input.DurationToleranceMs = tolerance
	briefRatios := []string{stringValue(briefContract["targetAspectRatio"]), stringValue(brief["targetAspectRatio"]), stringValue(brief["aspectRatio"])}
	briefRatio := firstString(briefRatios...)
	for _, candidate := range briefRatios {
		if candidate != "" && normalizeAspectRatio(candidate) != normalizeAspectRatio(briefRatio) {
			return ProductionDeliveryContract{}, fmt.Errorf("Brief 中的目标画幅比例字段相互冲突")
		}
		if candidate != "" && input.TargetAspectRatio != "" && normalizeAspectRatio(input.TargetAspectRatio) != normalizeAspectRatio(candidate) {
			return ProductionDeliveryContract{}, fmt.Errorf("Brief 与交付合同中的目标画幅比例不一致")
		}
	}
	input.TargetAspectRatio = firstString(input.TargetAspectRatio, briefRatio)
	if input.TargetAspectRatio != "" {
		if _, _, ok := parseAspectRatio(input.TargetAspectRatio); !ok {
			return ProductionDeliveryContract{}, fmt.Errorf("目标画幅比例必须是有效的宽:高，例如 16:9")
		}
	}
	if input.DurationToleranceMs == 0 {
		input.DurationToleranceMs = int64Value(briefContract["durationToleranceMs"])
	}
	if input.DurationToleranceMs == 0 {
		input.DurationToleranceMs = int64Value(brief["durationToleranceMs"])
	}
	if input.DurationToleranceMs == 0 {
		input.DurationToleranceMs = min(int64(1000), input.TargetDurationMs/10)
	}
	if input.DurationToleranceMs < 0 || (input.TargetDurationMs > 0 && input.DurationToleranceMs > input.TargetDurationMs/10) {
		return ProductionDeliveryContract{}, fmt.Errorf("时长容差必须在 0 到目标时长的 10%% 之间")
	}
	input.MinWidth, err = consistentPositiveInt("minWidth", input.MinWidth, intValue(briefContract["minWidth"]), intValue(brief["minWidth"]))
	if err != nil {
		return ProductionDeliveryContract{}, err
	}
	input.MinHeight, err = consistentPositiveInt("minHeight", input.MinHeight, intValue(briefContract["minHeight"]), intValue(brief["minHeight"]))
	if err != nil {
		return ProductionDeliveryContract{}, err
	}
	input.MaxWidth, err = consistentPositiveInt("maxWidth", input.MaxWidth, intValue(briefContract["maxWidth"]), intValue(brief["maxWidth"]))
	if err != nil {
		return ProductionDeliveryContract{}, err
	}
	input.MaxHeight, err = consistentPositiveInt("maxHeight", input.MaxHeight, intValue(briefContract["maxHeight"]), intValue(brief["maxHeight"]))
	if err != nil {
		return ProductionDeliveryContract{}, err
	}
	if input.MinWidth < 0 || input.MinHeight < 0 || input.MaxWidth < 0 || input.MaxHeight < 0 || (input.MinWidth > 0 && input.MaxWidth > 0 && input.MinWidth > input.MaxWidth) || (input.MinHeight > 0 && input.MaxHeight > 0 && input.MinHeight > input.MaxHeight) {
		return ProductionDeliveryContract{}, fmt.Errorf("目标分辨率范围无效")
	}
	input.RequireVideo = true
	input.RequireAudio = input.RequireAudio || boolValue(briefContract["requireAudio"]) || boolValue(brief["requireAudio"]) ||
		productionAudioPolicyRequiresTrack(briefContract["audioPolicy"]) || productionAudioPolicyRequiresTrack(brief["audioPolicy"])
	input.RequireSubtitle = input.RequireSubtitle || boolValue(briefContract["requireSubtitle"]) || boolValue(brief["requireSubtitle"])
	input.RequireFullDecode = true
	input.BriefVersion = firstString(input.BriefVersion, stringValue(briefContract["briefVersion"]), stringValue(brief["briefVersion"]))
	input.ApprovedChangeVersion = firstString(input.ApprovedChangeVersion, stringValue(briefContract["approvedChangeVersion"]), stringValue(brief["approvedChangeVersion"]))
	return input, nil
}

func productionAudioPolicyRequiresTrack(value any) bool {
	policy := strings.ToLower(strings.TrimSpace(stringValue(value)))
	if policy == "" {
		return false
	}
	normalized := strings.NewReplacer(" ", "", "\t", "", "\r", "", "\n", "", "-", "", "_", "", "/", "", "\\", "", ".", "", ",", "", "，", "", "。", "", ":", "", "：", "", "(", "", ")", "", "（", "", "）", "", "！", "", "!", "").Replace(policy)
	for _, noAudioPolicy := range []string{
		"none", "noaudio", "nosound", "silent", "silence", "muted", "mute", "off",
		"静音", "无声", "无音频", "无音轨", "不需要音频", "不需要音轨", "不要音频", "不要音轨",
	} {
		if normalized == noAudioPolicy {
			return false
		}
	}
	// A non-empty policy such as music/ambience only or no dialogue still
	// requires an audio stream; only an explicit no-audio policy opts out.
	return true
}

func productionDeliveryContractForRun(run model.ProductionRun) ProductionDeliveryContract {
	contract := ProductionDeliveryContract{}
	_ = json.Unmarshal([]byte(run.DeliveryContractJSON), &contract)
	brief := decodeMap(run.BriefJSON)
	normalized, err := normalizeProductionDeliveryContract(contract, brief, run.TargetDurationMs)
	if err == nil {
		return normalized
	}
	return contract
}

func (s *Service) VerifyProductionDelivery(userID, id string, req ProductionDeliveryVerificationRequest) (*ProductionDeliveryVerificationOutput, error) {
	req.ResourceID = strings.TrimSpace(req.ResourceID)
	if req.ResourceID == "" {
		return nil, BadAuthRequest("缺少最终资源 ID")
	}
	run, err := s.repo.ProductionRunForUser(userID, id)
	if err != nil {
		return nil, productionError(err)
	}
	if run.Revision != req.ExpectedRevision {
		return nil, productionConflict("制作版本已变化，请重新读取 run 后再验收")
	}
	if run.Status == "cancelled" || run.Status == "completed" {
		return nil, productionConflict("已取消或已完成的制作不能重复验收")
	}
	contract := productionDeliveryContractForRun(*run)
	media, probeErr := s.ProbeResource(userID, req.ResourceID, true)
	checks := make([]ProductionDeliveryCheck, 0, 12)
	if probeErr != nil {
		checks = append(checks, ProductionDeliveryCheck{
			Name: "resource_probe", OriginalRequirement: "最终资源必须可打开并完整解码", EffectiveRequirement: "必须能从当前用户资源库读取并执行完整解码",
			Measured: nil, Status: "failed", Reason: probeErr.Error(),
		})
	} else {
		checks = append(checks, evaluateProductionDelivery(contract, *run, media.Probe, req)...)
	}
	steps, err := s.repo.ProductionSteps(id)
	if err != nil {
		return nil, err
	}
	attempts, err := s.repo.ProductionAttempts(id, "")
	if err != nil {
		return nil, err
	}
	manifestAudit := inspectProductionManifest(run.PlanJSON, contract, steps, attempts, run.QualityJSON)
	taskTraceIssues := productionManifestTaskIssues(run.ID, userID, manifestAudit, func(taskID string) (*model.Task, error) {
		return s.repo.TaskForUser(userID, taskID)
	})
	manifestIssues := append(append([]string{}, manifestAudit.Issues...), taskTraceIssues...)
	traceStatus := "passed"
	traceReason := "分镜行、片段、模型版本、任务、时间线、技能和质检均有一致证据"
	if len(manifestIssues) > 0 {
		traceStatus = "failed"
		traceReason = "计划清单与持久化步骤、任务或交付证据不一致"
	}
	checks = append(checks, ProductionDeliveryCheck{
		Name: "production_trace", OriginalRequirement: "整片中的行、段、音轨、模型、技能、任务、时间线与质检都可追踪",
		EffectiveRequirement: "持久 executionManifest 与完成步骤、模型能力版本、生成任务和媒体时间线逐项一致",
		Measured:             map[string]any{"segmentCount": len(manifestAudit.Segments), "issues": manifestIssues, "warnings": manifestAudit.Warnings}, Status: traceStatus, Reason: traceReason,
	})
	stepsReady := productionStepsReadyExceptDelivery(steps)
	resourceLinked := productionResourceLinkedToRun(steps, req.ResourceID)
	stepStatus := "passed"
	stepReason := "交付前的制作步骤均已成功；交付合同由本次真实资源核验完成"
	if !stepsReady {
		stepStatus = "failed"
		stepReason = "仍有未完成、失败或缺失的交付前制作步骤"
	}
	checks = append(checks, ProductionDeliveryCheck{Name: "production_steps", OriginalRequirement: "整片计划中的交付前步骤完成", EffectiveRequirement: "除由本次核验写回的 delivery_check 外，所有活动 ProductionStep 均为 succeeded", Measured: map[string]any{"total": len(steps)}, Status: stepStatus, Reason: stepReason})
	linkedStatus := "passed"
	linkedReason := "最终资源来自本制作运行的成功渲染/交付步骤"
	if !resourceLinked {
		linkedStatus = "failed"
		linkedReason = "资源未登记为本 run 成功渲染/交付步骤的产物"
	}
	checks = append(checks, ProductionDeliveryCheck{Name: "run_resource_binding", OriginalRequirement: req.ResourceID, EffectiveRequirement: "资源必须绑定到本 run 的成功渲染/交付 step", Measured: map[string]any{"resourceId": req.ResourceID, "linkedToRun": resourceLinked}, Status: linkedStatus, Reason: linkedReason})
	status := deliveryStatus(checks)
	completed := status == "passed"
	evidence := map[string]any{"resourceId": req.ResourceID, "deliveryStatus": status, "checks": checks, "contract": contract, "probedAt": time.Now().UTC().Format(time.RFC3339Nano)}
	err = s.repo.MutateProductionRun(userID, id, func(locked *model.ProductionRun, repo *repository.Repository) error {
		if locked.Revision != req.ExpectedRevision {
			return repository.ErrProductionConflict
		}
		quality := decodeMap(locked.QualityJSON)
		quality["deliveryVerification"] = evidence
		stepResults := productionRecord(quality["stepResults"])
		stepResults["delivery:contract"] = map[string]any{"stepKey": "delivery:contract", "status": status, "evidence": evidence, "recordedAt": evidence["probedAt"]}
		quality["stepResults"] = stepResults
		locked.QualityJSON = mapJSON(quality)
		locked.Revision++
		var deliveryStep *model.ProductionStep
		lockedSteps, err := repo.ProductionSteps(id)
		if err != nil {
			return err
		}
		for index := range lockedSteps {
			if !lockedSteps[index].Superseded && lockedSteps[index].StepKey == "delivery:contract" && lockedSteps[index].Kind == "delivery_check" {
				deliveryStep = &lockedSteps[index]
				break
			}
		}
		if deliveryStep != nil {
			deliveryStep.Status = productionStepStatusForEvidence(status)
			deliveryStep.BlockingReason = ""
			deliveryStep.OutputArtifactJSON = "[]"
			if status == "passed" {
				deliveryStep.OutputArtifactJSON = mapJSON([]string{req.ResourceID})
			} else {
				deliveryStep.BlockingReason = "最终媒体未通过 Brief 交付核验：" + status
			}
			deliveryStep.Revision++
			if err := repo.SaveProductionStep(deliveryStep); err != nil {
				return err
			}
		}
		if completed {
			locked.FinalResourceID = req.ResourceID
			locked.Status = "completed"
			locked.CurrentStage = "completed"
		} else {
			locked.Status = "waiting_agent"
			locked.CurrentStage = "delivery_" + status
		}
		if err := repo.AppendProductionEvent(locked, "delivery_verified", req.ResourceID, locked.Revision, mapJSON(evidence)); err != nil {
			return err
		}
		if deliveryStep != nil {
			if err := repo.AppendProductionEvent(locked, "step_result_recorded", deliveryStep.ID, deliveryStep.Revision, mapJSON(stepResults["delivery:contract"])); err != nil {
				return err
			}
		}
		if completed {
			if err := repo.AppendProductionEvent(locked, "completed", req.ResourceID, locked.Revision, mapJSON(map[string]any{"resourceId": req.ResourceID, "deliveryVerification": evidence})); err != nil {
				return err
			}
		}
		return repo.SaveProductionRun(locked)
	})
	if err != nil {
		return nil, productionError(err)
	}
	updated, err := s.GetProductionRun(userID, id, 0)
	if err != nil {
		return nil, err
	}
	return &ProductionDeliveryVerificationOutput{DeliveryStatus: status, Checks: checks, Media: media, Completed: completed, Run: updated}, nil
}

func evaluateProductionDelivery(contract ProductionDeliveryContract, run model.ProductionRun, probe mediaProbeReport, req ProductionDeliveryVerificationRequest) []ProductionDeliveryCheck {
	checks := make([]ProductionDeliveryCheck, 0, 10)
	brief := decodeMap(run.BriefJSON)
	originalDuration := firstNonNil(brief["targetDurationMs"], brief["targetDuration"], contract.TargetDurationMs)
	if contract.TargetDurationMs <= 0 {
		checks = append(checks, ProductionDeliveryCheck{Name: "duration_contract", OriginalRequirement: originalDuration, EffectiveRequirement: "正数毫秒的 Brief 目标时长", Measured: probe.DurationMs, Status: "failed", Reason: "run 未固化有效的目标时长"})
	} else {
		low := max(int64(0), contract.TargetDurationMs-contract.DurationToleranceMs)
		high := contract.TargetDurationMs + contract.DurationToleranceMs
		passed := probe.DurationMs > 0 && probe.DurationMs >= low && probe.DurationMs <= high
		reason := "实测时长在 Brief 允许范围内"
		if !passed {
			reason = "实测时长未达到 Brief 目标；调用者参数不能缩短 run 的时长合同"
		}
		checks = append(checks, ProductionDeliveryCheck{Name: "duration_contract", OriginalRequirement: originalDuration, EffectiveRequirement: map[string]any{"targetDurationMs": contract.TargetDurationMs, "toleranceMs": contract.DurationToleranceMs, "minMs": low, "maxMs": high}, Measured: probe.DurationMs, Status: passFail(passed), Reason: reason})
	}
	if req.ExpectedDurationMs != nil {
		want := *req.ExpectedDurationMs
		passed := want > 0 && probe.DurationMs > 0 && absInt64(probe.DurationMs-want) <= 300
		checks = append(checks, ProductionDeliveryCheck{Name: "caller_duration_constraint", OriginalRequirement: want, EffectiveRequirement: map[string]any{"expectedDurationMs": want, "toleranceMs": 300}, Measured: probe.DurationMs, Status: passFail(passed), Reason: "调用者时长只能增加约束，不能替代 run 的 Brief 时长"})
	}
	actualRatio := ""
	if probe.Width > 0 && probe.Height > 0 {
		actualRatio = fmt.Sprintf("%d:%d", probe.Width/gcd(probe.Width, probe.Height), probe.Height/gcd(probe.Width, probe.Height))
	}
	if _, _, valid := parseAspectRatio(contract.TargetAspectRatio); !valid {
		checks = append(checks, ProductionDeliveryCheck{Name: "aspect_ratio_contract", OriginalRequirement: firstNonNil(brief["targetAspectRatio"], brief["aspectRatio"]), EffectiveRequirement: "有效的 Brief 目标画幅比例，例如 16:9", Measured: map[string]any{"width": probe.Width, "height": probe.Height, "ratio": actualRatio}, Status: "failed", Reason: "run 未固化有效的目标画幅比例"})
	} else {
		passed := ratioMatches(probe.Width, probe.Height, contract.TargetAspectRatio, productionAspectRatioTolerance)
		reason := "实测宽高比在 Brief 目标的 3% 容差内"
		if !passed {
			reason = "实测宽高比偏离 Brief 目标超过 3%"
		}
		checks = append(checks, ProductionDeliveryCheck{Name: "aspect_ratio_contract", OriginalRequirement: firstNonNil(brief["targetAspectRatio"], brief["aspectRatio"], contract.TargetAspectRatio), EffectiveRequirement: contract.TargetAspectRatio, Measured: map[string]any{"width": probe.Width, "height": probe.Height, "ratio": actualRatio}, Status: passFail(passed), Reason: reason})
	}
	if contract.MinWidth > 0 || contract.MinHeight > 0 || contract.MaxWidth > 0 || contract.MaxHeight > 0 {
		passed := probe.Width > 0 && probe.Height > 0 && (contract.MinWidth == 0 || probe.Width >= contract.MinWidth) && (contract.MinHeight == 0 || probe.Height >= contract.MinHeight) && (contract.MaxWidth == 0 || probe.Width <= contract.MaxWidth) && (contract.MaxHeight == 0 || probe.Height <= contract.MaxHeight)
		checks = append(checks, ProductionDeliveryCheck{Name: "resolution_contract", OriginalRequirement: map[string]any{"minWidth": contract.MinWidth, "minHeight": contract.MinHeight, "maxWidth": contract.MaxWidth, "maxHeight": contract.MaxHeight}, EffectiveRequirement: map[string]any{"minWidth": contract.MinWidth, "minHeight": contract.MinHeight, "maxWidth": contract.MaxWidth, "maxHeight": contract.MaxHeight}, Measured: map[string]any{"width": probe.Width, "height": probe.Height}, Status: passFail(passed), Reason: "实测分辨率必须落在已保存范围内"})
	}
	if req.ExpectedAspectRatio != "" {
		passed := ratioMatches(probe.Width, probe.Height, req.ExpectedAspectRatio, productionAspectRatioTolerance)
		checks = append(checks, ProductionDeliveryCheck{Name: "caller_aspect_ratio_constraint", OriginalRequirement: req.ExpectedAspectRatio, EffectiveRequirement: map[string]any{"aspectRatio": req.ExpectedAspectRatio, "relativeTolerance": productionAspectRatioTolerance}, Measured: actualRatio, Status: passFail(passed), Reason: "调用者画幅参数只能增加约束；按 3% 容差比较"})
	}
	if req.ExpectedWidth != nil || req.ExpectedHeight != nil {
		passed := probe.Width > 0 && probe.Height > 0 && (req.ExpectedWidth == nil || probe.Width == *req.ExpectedWidth) && (req.ExpectedHeight == nil || probe.Height == *req.ExpectedHeight)
		checks = append(checks, ProductionDeliveryCheck{Name: "caller_resolution_constraint", OriginalRequirement: map[string]any{"width": req.ExpectedWidth, "height": req.ExpectedHeight}, EffectiveRequirement: map[string]any{"width": req.ExpectedWidth, "height": req.ExpectedHeight}, Measured: map[string]any{"width": probe.Width, "height": probe.Height}, Status: passFail(passed), Reason: "调用者分辨率参数只能增加约束"})
	}
	checks = append(checks,
		ProductionDeliveryCheck{Name: "non_empty", OriginalRequirement: "非空最终媒体", EffectiveRequirement: "文件字节数必须大于 0", Measured: probe.FileSizeBytes, Status: passFail(probe.FileSizeBytes > 0), Reason: "最终资源不能是空文件"},
		ProductionDeliveryCheck{Name: "video_stream", OriginalRequirement: true, EffectiveRequirement: true, Measured: probe.VideoStreams, Status: passFail(probe.VideoStreams > 0), Reason: "整片交付必须包含视频流"},
	)
	decodeStatus := "passed"
	decodeReason := "完整解码完成"
	if !probe.Decoded {
		decodeStatus = "uncertain"
		decodeReason = "没有完整解码证据，不能标记交付通过"
	}
	checks = append(checks, ProductionDeliveryCheck{Name: "full_decode", OriginalRequirement: true, EffectiveRequirement: true, Measured: probe.Decoded, Status: decodeStatus, Reason: decodeReason})
	samplesPassed := len(probe.VideoFrameSamples) == 3
	for _, sample := range probe.VideoFrameSamples {
		if !sample.Decoded || sample.ImageBytes <= 8 {
			samplesPassed = false
		}
	}
	for _, required := range []string{"start", "middle", "end"} {
		found := false
		for _, sample := range probe.VideoFrameSamples {
			if sample.Position == required && sample.Decoded && sample.ImageBytes > 8 {
				found = true
				break
			}
		}
		if !found {
			samplesPassed = false
		}
	}
	sampleStatus := "uncertain"
	sampleReason := "缺少首、中、尾视频帧的实际解码证据"
	if samplesPassed {
		sampleStatus = "passed"
		sampleReason = "首、中、尾帧均已实际解码并生成图像样本"
	}
	checks = append(checks, ProductionDeliveryCheck{Name: "video_frame_samples", OriginalRequirement: []string{"start", "middle", "end"}, EffectiveRequirement: []string{"start", "middle", "end"}, Measured: probe.VideoFrameSamples, Status: sampleStatus, Reason: sampleReason})
	requireAudio := contract.RequireAudio || (req.RequireAudio != nil && *req.RequireAudio)
	audioStatus := "passed"
	audioReason := "Brief 没有要求音轨"
	if requireAudio {
		audioStatus = passFail(probe.AudioStreams > 0)
		audioReason = "Brief 要求音轨，按实测音频流判断"
	}
	checks = append(checks, ProductionDeliveryCheck{Name: "audio_stream", OriginalRequirement: contract.RequireAudio, EffectiveRequirement: requireAudio, Measured: probe.AudioStreams, Status: audioStatus, Reason: audioReason})
	requireSubtitle := contract.RequireSubtitle || (req.RequireSubtitle != nil && *req.RequireSubtitle)
	subtitleStatus := "passed"
	subtitleReason := "Brief 没有要求内嵌字幕轨"
	if requireSubtitle {
		subtitleStatus = passFail(probe.SubtitleStreams > 0)
		subtitleReason = "Brief 要求内嵌字幕轨，按实测字幕流判断"
	}
	checks = append(checks, ProductionDeliveryCheck{Name: "subtitle_stream", OriginalRequirement: contract.RequireSubtitle, EffectiveRequirement: requireSubtitle, Measured: probe.SubtitleStreams, Status: subtitleStatus, Reason: subtitleReason})
	return checks
}

func deliveryStatus(checks []ProductionDeliveryCheck) string {
	status := "passed"
	for _, check := range checks {
		if check.Status == "failed" {
			return "failed"
		}
		if check.Status == "uncertain" {
			status = "uncertain"
		}
	}
	return status
}

func passFail(passed bool) string {
	if passed {
		return "passed"
	}
	return "failed"
}

func parseAspectRatio(value string) (float64, float64, bool) {
	parts := strings.Split(strings.TrimSpace(value), ":")
	if len(parts) != 2 {
		return 0, 0, false
	}
	w, errW := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
	h, errH := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
	return w, h, errW == nil && errH == nil && w > 0 && h > 0 && !math.IsInf(w, 0) && !math.IsInf(h, 0)
}

func ratioMatches(width, height int, expected string, tolerance float64) bool {
	w, h, valid := parseAspectRatio(expected)
	if !valid || width <= 0 || height <= 0 {
		return false
	}
	actualRatio := float64(width) / float64(height)
	wantRatio := w / h
	return math.Abs(actualRatio-wantRatio)/wantRatio <= tolerance
}

func normalizeAspectRatio(value string) string {
	parts := strings.Split(strings.TrimSpace(value), ":")
	if len(parts) != 2 {
		return strings.TrimSpace(value)
	}
	w, errW := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64)
	h, errH := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64)
	if errW != nil || errH != nil || w <= 0 || h <= 0 {
		return strings.TrimSpace(value)
	}
	return strconv.FormatFloat(w/h, 'f', 6, 64)
}

func gcd(a, b int) int {
	for b != 0 {
		a, b = b, a%b
	}
	if a < 0 {
		return -a
	}
	return a
}

func absInt64(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}

func firstPositiveInt64(values ...int64) int64 {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func consistentPositiveInt64(field string, values ...int64) (int64, error) {
	selected := firstPositiveInt64(values...)
	for _, value := range values {
		if value > 0 && selected > 0 && value != selected {
			return 0, fmt.Errorf("Brief 与交付合同中的 %s 不一致，不能自动改写", field)
		}
	}
	return selected, nil
}

func productionRecord(value any) map[string]any {
	if record, ok := value.(map[string]any); ok && record != nil {
		return record
	}
	return map[string]any{}
}

func firstPositiveInt(values ...int) int {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func consistentPositiveInt(field string, values ...int) (int, error) {
	selected := firstPositiveInt(values...)
	for _, value := range values {
		if value > 0 && selected > 0 && value != selected {
			return 0, fmt.Errorf("Brief 与交付合同中的 %s 不一致，不能自动改写", field)
		}
	}
	return selected, nil
}

func int64Value(value any) int64 {
	switch number := value.(type) {
	case int:
		return int64(number)
	case int64:
		return number
	case float64:
		return int64(number)
	case json.Number:
		parsed, _ := number.Int64()
		return parsed
	default:
		return 0
	}
}

func boolValue(value any) bool {
	flag, _ := value.(bool)
	return flag
}

func firstString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func firstNonNil(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func productionResourceLinkedToRun(steps []model.ProductionStep, resourceID string) bool {
	for _, step := range steps {
		if step.Superseded || step.Status != "succeeded" || (!strings.Contains(strings.ToLower(step.Kind), "render") && !strings.Contains(strings.ToLower(step.Kind), "delivery")) {
			continue
		}
		for _, artifactID := range decodeStringList(step.OutputArtifactJSON) {
			if artifactID == resourceID {
				return true
			}
		}
	}
	return false
}

func productionStepsReady(steps []model.ProductionStep) bool {
	activeSteps := 0
	for _, step := range steps {
		if step.Superseded {
			continue
		}
		activeSteps++
		if step.Status != "succeeded" {
			return false
		}
	}
	return activeSteps > 0
}

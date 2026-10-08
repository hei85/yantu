package app

import (
	"encoding/json"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/model"
)

type productionRenderTaskLookup func(string) (*model.Task, error)
type productionRenderResourceLookup func(string) (*model.Resource, error)
type productionRenderProbe func(string) (*ResourceProbeResult, error)

func applyProductionRenderAudioPolicy(run model.ProductionRun, timeline renderProject) (renderProject, map[string]any) {
	audioMode, _ := normalizeProductionAudioMode(run.AudioMode)
	policy := "native"
	if audioMode == model.ProductionAudioModeRebuild {
		policy = "independent"
	}
	timeline.AudioPolicy = policy
	timeline.RequireNativeAudio = productionDeliveryContractForRun(run).RequireAudio && audioMode == model.ProductionAudioModeNative
	mutedVideoClips := make([]string, 0)
	if audioMode == model.ProductionAudioModeRebuild {
		for index := range timeline.Clips {
			clip := &timeline.Clips[index]
			if clip.Kind != "video" || clip.Volume != nil && *clip.Volume <= 0 {
				continue
			}
			muted := 0.0
			clip.Volume = &muted
			mutedVideoClips = append(mutedVideoClips, clip.ID)
		}
	}
	mode := "preserve_embedded_video_audio"
	reason := "ProductionPlan 允许视频片段自带音频；渲染前会核对必需音频流。"
	if audioMode == model.ProductionAudioModeRebuild {
		mode = "mute_embedded_video_audio"
		reason = "REBUILD_AUDIO 已选定；视频原生音轨会静音，最终只使用独立音轨。"
	}
	return timeline, map[string]any{
		"audioMode":                 audioMode,
		"policy":                    policy,
		"mode":                      mode,
		"mutedEmbeddedVideoClipIds": mutedVideoClips,
		"requireNativeAudio":        timeline.RequireNativeAudio,
		"reason":                    reason,
	}
}

func productionRenderManifestIssues(issues []string, steps []model.ProductionStep) []string {
	activeByKey := map[string]model.ProductionStep{}
	for _, step := range steps {
		if !step.Superseded {
			activeByKey[step.StepKey] = step
		}
	}
	out := make([]string, 0, len(issues))
	for _, issue := range issues {
		switch issue {
		case "master_timeline_step_missing":
			if step, ok := activeByKey["timeline:master"]; ok && step.Kind == "render" {
				continue // This is the step currently being submitted.
			}
		case "full_film_quality_step_missing":
			if step, ok := activeByKey["quality:full-film"]; ok && step.Kind == "verify" {
				continue // Full-film QA depends on the render submitted here.
			}
		}
		out = append(out, issue)
	}
	return out
}

func validateProductionRenderTimeline(
	run model.ProductionRun,
	steps []model.ProductionStep,
	attempts []model.ProductionAttempt,
	timeline renderProject,
	taskForUser productionRenderTaskLookup,
	resourceForUser productionRenderResourceLookup,
	probeResource ...productionRenderProbe,
) error {
	manifest, ok := decodeMap(run.PlanJSON)["executionManifest"].(map[string]any)
	if !ok || len(manifest) == 0 {
		return productionConflict("制作计划缺少 executionManifest，不能提交主时间线渲染")
	}

	activeByKey := map[string]model.ProductionStep{}
	activeByTrace := map[string]model.ProductionStep{}
	for _, step := range steps {
		if step.Superseded {
			continue
		}
		activeByKey[step.StepKey] = step
		if (step.Kind == "video" || step.Kind == "reuse_media") && step.StoryboardRowID != "" && step.SegmentID != "" {
			key := productionSegmentTraceKey(step.StoryboardRowID, step.SegmentID)
			if _, exists := activeByTrace[key]; exists {
				return productionConflict("制作计划中同一分镜片段绑定了多个视频步骤")
			}
			activeByTrace[key] = step
		}
	}

	fps := productionRecord(manifest["timelineTimebase"])
	fpsNumerator := int64Value(fps["fpsNumerator"])
	fpsDenominator := int64Value(fps["fpsDenominator"])
	totalFrames := int64Value(fps["totalFrames"])
	if fpsNumerator <= 0 || fpsDenominator <= 0 || totalFrames <= 0 {
		return productionConflict("制作计划的时间线帧率或总帧数无效")
	}
	frameToleranceMs := (1000*fpsDenominator + fpsNumerator - 1) / fpsNumerator
	toMs := func(frame int64) int64 {
		return (frame*1000*fpsDenominator + fpsNumerator/2) / fpsNumerator
	}
	plannedDurationMs := int64Value(fps["durationMs"])
	if plannedDurationMs <= 0 || timeline.DurationMs < 0 || timeline.DurationMs > 0 && absInt64(timeline.DurationMs-plannedDurationMs) > frameToleranceMs {
		return productionConflict("时间线总时长与 ProductionPlan 固化的 Brief 帧时基不一致")
	}

	spans := productionManifestRecords(manifest["timelineSpans"])
	if len(spans) == 0 || len(spans) != len(productionManifestStrings(manifest["videoStepKeys"])) {
		return productionConflict("分镜片段与时间线计划数量不一致")
	}
	spanByTrace := map[string]map[string]any{}
	rowBounds := map[string][2]int64{}
	for _, span := range spans {
		rowID := strings.TrimSpace(stringValue(span["storyboardRowId"]))
		segmentID := strings.TrimSpace(stringValue(span["segmentId"]))
		startFrame := int64Value(span["startFrame"])
		durationFrames := int64Value(span["durationFrames"])
		trace := productionSegmentTraceKey(rowID, segmentID)
		if rowID == "" || segmentID == "" || durationFrames <= 0 || startFrame < 0 || startFrame+durationFrames > totalFrames || spanByTrace[trace] != nil {
			return productionConflict("制作计划包含无效或重复的分镜片段时间范围")
		}
		spanByTrace[trace] = span
		startMs, endMs := toMs(startFrame), toMs(startFrame+durationFrames)
		bounds, exists := rowBounds[rowID]
		if !exists || startMs < bounds[0] {
			bounds[0] = startMs
		}
		if !exists || endMs > bounds[1] {
			bounds[1] = endMs
		}
		rowBounds[rowID] = bounds
	}
	if len(spanByTrace) != len(activeByTrace) {
		return productionConflict("当前有效视频步骤与制作计划的分镜片段不一致")
	}

	tracks := map[string]renderTrack{}
	for _, track := range timeline.Tracks {
		if strings.TrimSpace(track.ID) == "" || tracks[track.ID].ID != "" {
			return productionConflict("时间线包含无效或重复的轨道 ID")
		}
		tracks[track.ID] = track
	}
	visibleTrack := func(trackID, wantKind string) bool {
		track, exists := tracks[trackID]
		return exists && track.Kind == wantKind && (track.Visible == nil || *track.Visible) && !track.Muted
	}
	usedSegments := map[string]bool{}
	audioMode, modeErr := normalizeProductionAudioMode(run.AudioMode)
	manifestAudioMode, manifestModeErr := normalizeProductionAudioMode(stringValue(manifest["audioMode"]))
	if modeErr != nil || manifestModeErr != nil || audioMode != manifestAudioMode {
		return productionConflict("ProductionRun 与执行清单的 audioMode 不一致")
	}
	wantPolicy := "native"
	if audioMode == model.ProductionAudioModeRebuild {
		wantPolicy = "independent"
	}
	if stringValue(manifest["audioPolicy"]) != wantPolicy || timeline.AudioPolicy != wantPolicy {
		return productionConflict("主时间线音频策略与 ProductionRun audioMode 不一致")
	}
	requireNativeAudio := timeline.RequireNativeAudio || (productionDeliveryContractForRun(run).RequireAudio && audioMode == model.ProductionAudioModeNative)
	for _, clip := range timeline.Clips {
		switch clip.Kind {
		case "video":
			trace := productionSegmentTraceKey(clip.StoryboardRowID, clip.SegmentID)
			span := spanByTrace[trace]
			step, exists := activeByTrace[trace]
			if span == nil || !exists || usedSegments[trace] {
				return productionConflict("时间线包含未规划或重复的视频分镜片段")
			}
			if !visibleTrack(clip.TrackID, "video") {
				return productionConflict("分镜视频片段必须放在可见且未静音的视频轨道")
			}
			if audioMode == model.ProductionAudioModeRebuild && (clip.Volume == nil || *clip.Volume > 0) {
				return productionConflict("REBUILD_AUDIO 必须静音所有视频片段的原生音轨")
			}
			if requireNativeAudio && clip.Volume != nil && *clip.Volume <= 0 {
				return productionConflict("Brief 要求模型原生音频，但视频片段在时间线中被静音")
			}
			wantStart := toMs(int64Value(span["startFrame"]))
			wantDuration := toMs(int64Value(span["startFrame"])+int64Value(span["durationFrames"])) - wantStart
			if clip.StartMs < 0 || absInt64(clip.StartMs-wantStart) > frameToleranceMs || absInt64(clip.DurationMs-wantDuration) > frameToleranceMs {
				return productionConflict("分镜视频片段的位置或时长偏离 ProductionPlan 帧范围")
			}
			resourceID := ""
			if step.Kind == "reuse_media" {
				var probe productionRenderProbe
				if len(probeResource) > 0 {
					probe = probeResource[0]
				}
				var err error
				resourceID, err = validateProductionReuseOutputBinding(run, step, attempts, manifest, wantDuration, requireNativeAudio, taskForUser, resourceForUser, probe)
				if err != nil {
					return err
				}
			} else {
				var err error
				resourceID, err = validateProductionOutputBinding(run, step, attempts, "video", "", taskForUser, resourceForUser)
				if err != nil {
					return err
				}
				// 能力声明可能滞后于中转渠道的真实输出，这里用实测音轨做最终判定。
				if requireNativeAudio && len(probeResource) > 0 && probeResource[0] != nil {
					probe, probeErr := probeResource[0](resourceID)
					if probeErr != nil || probe == nil || probe.Probe.AudioStreams < 1 {
						return productionConflict("Brief 要求模型原生音频，但该片段实测没有可检测音轨")
					}
				}
			}
			if mediaResourceIDForProductionClip(clip) != resourceID || strings.ToLower(clip.DirectMedia.Kind) != "video" {
				return productionConflict("视频时间线片段没有绑定该分镜计划的实际视频资源")
			}
			usedSegments[trace] = true
		case "image":
			return productionConflict("主时间线不能用图片片段替代 ProductionPlan 中的视频分镜片段")
		case "audio", "subtitle":
			// Validated against their row/track bindings below.
		default:
			return productionConflict("主制作时间线包含不支持的片段类型")
		}
	}
	if len(usedSegments) != len(spanByTrace) {
		return productionConflict("时间线缺少一个或多个已规划的分镜视频片段")
	}

	audioBindings := productionManifestRecords(manifest["audioTrackBindings"])
	if audioMode == model.ProductionAudioModeRebuild && len(audioBindings) == 0 {
		return productionConflict("Brief 要求独立音轨，但 ProductionPlan 没有音轨绑定")
	}
	usedAudio := map[string]bool{}
	for _, clip := range timeline.Clips {
		if clip.Kind != "audio" {
			continue
		}
		bindingIndex := -1
		for index, binding := range audioBindings {
			if strings.TrimSpace(stringValue(binding["storyboardRowId"])) == clip.StoryboardRowID && strings.TrimSpace(stringValue(binding["trackId"])) == clip.TrackID {
				bindingIndex = index
				break
			}
		}
		if bindingIndex < 0 || usedAudio[clip.StoryboardRowID+"\x00"+clip.TrackID] {
			return productionConflict("时间线音频片段没有唯一的分镜行与 ProductionPlan 音轨绑定")
		}
		binding := audioBindings[bindingIndex]
		if !visibleTrack(clip.TrackID, "audio") || clip.Volume != nil && *clip.Volume <= 0 {
			return productionConflict("ProductionPlan 音轨必须放在可听见的音频轨道")
		}
		bounds, exists := rowBounds[clip.StoryboardRowID]
		if !exists {
			return productionConflict("音轨绑定引用了不存在的分镜行")
		}
		rowStart := int64Value(binding["rowStartMs"])
		rowDuration := int64Value(binding["rowDurationMs"])
		if rowDuration > 0 {
			bounds = [2]int64{rowStart, rowStart + rowDuration}
		}
		if clip.DurationMs <= 0 || absInt64(clip.StartMs-bounds[0]) > frameToleranceMs || clip.StartMs+clip.DurationMs > bounds[1]+frameToleranceMs {
			return productionConflict("分镜音轨必须从所属分镜行开始，且不能越过该行的计划范围")
		}
		step, exists := activeByKey[strings.TrimSpace(stringValue(binding["stepKey"]))]
		if !exists || step.Kind != "audio" || step.StoryboardRowID != clip.StoryboardRowID || step.TrackID != clip.TrackID {
			return productionConflict("ProductionPlan 音轨没有对应的有效音频步骤")
		}
		resourceID, err := validateProductionOutputBinding(run, step, attempts, "audio", clip.TrackID, taskForUser, resourceForUser)
		if err != nil {
			return err
		}
		if mediaResourceIDForProductionClip(clip) != resourceID || strings.ToLower(clip.DirectMedia.Kind) != "audio" {
			return productionConflict("音轨没有绑定该分镜音频任务的实际资源")
		}
		usedAudio[clip.StoryboardRowID+"\x00"+clip.TrackID] = true
	}
	if len(usedAudio) != len(audioBindings) {
		return productionConflict("时间线缺少一个或多个 ProductionPlan 音轨")
	}

	subtitleCues := productionManifestRecords(manifest["subtitleCues"])
	usedCues := map[int]bool{}
	for _, clip := range timeline.Clips {
		if clip.Kind != "subtitle" {
			continue
		}
		if !visibleTrack(clip.TrackID, "subtitle") || strings.TrimSpace(clip.Text) == "" {
			return productionConflict("字幕必须放在可见字幕轨道并包含文本")
		}
		matched := -1
		for index, cue := range subtitleCues {
			if usedCues[index] || strings.TrimSpace(stringValue(cue["storyboardRowId"])) != clip.StoryboardRowID {
				continue
			}
			if int64Value(cue["startMs"]) == clip.StartMs && int64Value(cue["durationMs"]) == clip.DurationMs && strings.TrimSpace(stringValue(cue["text"])) == strings.TrimSpace(clip.Text) {
				matched = index
				break
			}
		}
		if matched < 0 {
			return productionConflict("时间线字幕没有匹配到该分镜行的计划字幕内容和时间范围")
		}
		usedCues[matched] = true
	}
	if len(usedCues) != len(subtitleCues) {
		return productionConflict("时间线缺少一个或多个 ProductionPlan 字幕")
	}

	return nil
}

func validateProductionReuseOutputBinding(
	run model.ProductionRun,
	step model.ProductionStep,
	attempts []model.ProductionAttempt,
	manifest map[string]any,
	wantDurationMs int64,
	requireNativeAudio bool,
	taskForUser productionRenderTaskLookup,
	resourceForUser productionRenderResourceLookup,
	probeResource productionRenderProbe,
) (string, error) {
	if step.Status != "succeeded" || step.AttemptCount != 0 || step.Kind != "reuse_media" {
		return "", productionConflict("复用媒体 ProductionStep 尚未通过服务器探测，或错误创建了生成 attempt")
	}
	for _, attempt := range attempts {
		if attempt.StepID == step.ID {
			return "", productionConflict("复用媒体步骤不能创建任何生成 attempt")
		}
	}
	var binding map[string]any
	for _, item := range productionManifestRecords(manifest["reusedMediaBindings"]) {
		if stringValue(item["storyboardRowId"]) == step.StoryboardRowID && stringValue(item["segmentId"]) == step.SegmentID && stringValue(item["stepKey"]) == step.StepKey {
			if binding != nil {
				return "", productionConflict("同一复用媒体片段出现重复资源绑定")
			}
			binding = item
		}
	}
	if binding == nil {
		return "", productionConflict("复用媒体步骤缺少 executionManifest 资源绑定")
	}
	resourceID := strings.TrimSpace(stringValue(binding["resourceId"]))
	if resourceID == "" || step.SelectedStrategyID != "existing-media:"+resourceID || !containsString(productionManifestStrings(decodeJSONAny(step.OutputArtifactJSON)), resourceID) {
		return "", productionConflict("复用媒体资源与步骤的已记录产物不一致")
	}
	resource, err := resourceForUser(resourceID)
	if err != nil || resource == nil || resource.Status != model.ResourceStatusReady || (resource.Kind != "video" && !strings.HasPrefix(strings.ToLower(resource.MimeType), "video/")) {
		return "", productionConflict("复用媒体不存在、未就绪或不是当前用户可读的视频")
	}
	if taskID := strings.TrimSpace(stringValue(binding["sourceTaskId"])); taskID != "" {
		task, taskErr := taskForUser(taskID)
		artifacts := []string(nil)
		if task != nil {
			artifacts = productionTaskVideoArtifacts(*task)
		}
		if taskErr != nil || task == nil || task.UserID != run.UserID || task.Status != model.TaskStatusSucceeded || len(artifacts) != 1 || artifacts[0] != resourceID {
			return "", productionConflict("复用媒体来源任务与实际视频资源不一致")
		}
	}
	if probeResource == nil {
		return "", productionConflict("渲染前必须重新完整探测复用视频资源")
	}
	media, err := probeResource(resourceID)
	if err != nil || media == nil || media.MediaType != "video" || !media.Probe.Decoded || media.Probe.VideoStreams < 1 || media.Probe.DurationMs < wantDurationMs || !ratioMatches(media.Probe.Width, media.Probe.Height, productionDeliveryContractForRun(run).TargetAspectRatio, productionAspectRatioTolerance) {
		return "", productionConflict("渲染前复用视频未通过 Brief 画幅、片段时长或全程解码复核")
	}
	if requireNativeAudio && media.Probe.AudioStreams < 1 {
		return "", productionConflict("NATIVE_AUDIO 复用视频缺少 Brief 要求的原生音轨")
	}
	return resourceID, nil
}

func validateProductionOutputBinding(
	run model.ProductionRun,
	step model.ProductionStep,
	attempts []model.ProductionAttempt,
	mediaKind string,
	trackID string,
	taskForUser productionRenderTaskLookup,
	resourceForUser productionRenderResourceLookup,
) (string, error) {
	if step.Status != "succeeded" || step.AttemptCount <= 0 {
		return "", productionConflict("渲染依赖步骤尚未成功完成")
	}
	var latest *model.ProductionAttempt
	for index := range attempts {
		attempt := &attempts[index]
		if attempt.StepID != step.ID {
			continue
		}
		if latest == nil || attempt.AttemptNumber > latest.AttemptNumber {
			latest = attempt
		} else if attempt.AttemptNumber == latest.AttemptNumber {
			return "", productionConflict("步骤最新 attempt 编号重复，不能确定实际生成资源")
		}
	}
	if latest == nil || latest.AttemptNumber != step.AttemptCount || latest.State != "succeeded" || latest.GenerationTaskID == "" {
		return "", productionConflict("渲染依赖步骤没有已结清的最新成功 attempt")
	}
	task, err := taskForUser(latest.GenerationTaskID)
	if err != nil || task == nil {
		return "", productionConflict("渲染依赖的生成任务不存在或不可读取")
	}
	if task.Status != model.TaskStatusSucceeded || task.ProductionRunID != run.ID || task.ProductionStepID != step.ID || task.ProductionAttemptID != latest.ID || task.StoryboardRowID != step.StoryboardRowID {
		return "", productionConflict("生成任务状态或分镜追踪关系与 ProductionStep 不一致")
	}
	if mediaKind == "video" && task.SegmentID != step.SegmentID {
		return "", productionConflict("视频任务没有绑定到计划中的 SegmentBinding")
	}
	if mediaKind == "audio" && task.TrackID != trackID {
		return "", productionConflict("音频任务没有绑定到 ProductionPlan 音轨")
	}
	resourceIDs := productionTaskArtifacts(*task)
	if mediaKind == "video" {
		resourceIDs = productionTaskVideoArtifacts(*task)
	}
	if len(resourceIDs) != 1 {
		return "", productionConflict("生成任务必须有且只有一个可确定的主媒体资源")
	}
	resourceID := resourceIDs[0]
	if !containsString(productionManifestStrings(decodeJSONAny(step.OutputArtifactJSON)), resourceID) {
		return "", productionConflict("ProductionStep 的已记录产物与最新任务真实资源不一致")
	}
	resource, err := resourceForUser(resourceID)
	if err != nil || resource == nil {
		return "", productionConflict("生成任务的实际媒体资源不存在或不属于当前用户")
	}
	if resource.Status != model.ResourceStatusReady {
		return "", productionConflict("生成任务的实际媒体资源尚未就绪")
	}
	wantMime := mediaKind + "/"
	if resource.Kind != mediaKind && !strings.HasPrefix(strings.ToLower(strings.TrimSpace(resource.MimeType)), wantMime) {
		return "", productionConflict(fmt.Sprintf("生成任务资源类型不是 %s", mediaKind))
	}
	return resourceID, nil
}

func mediaResourceIDForProductionClip(clip renderClip) string {
	if clip.DirectMedia == nil {
		return ""
	}
	key := strings.TrimSpace(clip.DirectMedia.StorageKey)
	if !strings.HasPrefix(key, "resource:") {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(key, "resource:"))
}

func validateProductionRenderOutput(run model.ProductionRun, requested renderOutputSpec) error {
	output, err := normalizeRenderOutput(requested)
	if err != nil {
		return BadAuthRequest(err.Error())
	}
	contract := productionDeliveryContractForRun(run)
	if _, _, valid := parseAspectRatio(contract.TargetAspectRatio); !valid || !ratioMatches(output.Width, output.Height, contract.TargetAspectRatio, productionAspectRatioTolerance) {
		return productionConflict("渲染输出画幅不符合 ProductionRun 固化的 Brief 合同")
	}
	if contract.MinWidth > 0 && output.Width < contract.MinWidth || contract.MinHeight > 0 && output.Height < contract.MinHeight || contract.MaxWidth > 0 && output.Width > contract.MaxWidth || contract.MaxHeight > 0 && output.Height > contract.MaxHeight {
		return productionConflict("渲染输出分辨率不符合 ProductionRun 固化的 Brief 合同")
	}
	manifest := productionRecord(decodeMap(run.PlanJSON)["executionManifest"])
	timebase := productionRecord(manifest["timelineTimebase"])
	wantNumerator := int(int64Value(timebase["fpsNumerator"]))
	wantDenominator := int(int64Value(timebase["fpsDenominator"]))
	if wantNumerator <= 0 || wantDenominator <= 0 || output.FPSNumerator != wantNumerator || output.FPSDenominator != wantDenominator {
		return productionConflict("渲染帧率与 ProductionPlan 时间基准不一致")
	}
	return nil
}

func decodeJSONAny(raw string) any {
	var value any
	if raw == "" || json.Unmarshal([]byte(raw), &value) != nil {
		return nil
	}
	return value
}

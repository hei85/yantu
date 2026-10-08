package app

import (
	"encoding/json"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/model"
)

type productionSegmentRequirement struct {
	StoryboardRowID    string
	SegmentID          string
	StepKey            string
	StepKind           string
	Model              string
	CapabilityRevision string
	Operation          string
	ResourceID         string
	SourceTaskID       string
	SourceNodeID       string
}

type productionAudioTrackRequirement struct {
	StoryboardRowID    string
	TrackID            string
	StepKey            string
	Kind               string
	Model              string
	CapabilityRevision string
}

type productionManifestAudit struct {
	Issues          []string
	Warnings        []string
	Segments        []productionSegmentRequirement
	AudioTracks     []productionAudioTrackRequirement
	AttemptsByTrace map[string]model.ProductionAttempt
	AudioAttempts   map[string]model.ProductionAttempt
}

func inspectProductionManifest(planJSON string, contract ProductionDeliveryContract, steps []model.ProductionStep, attempts []model.ProductionAttempt, qualityJSON ...string) productionManifestAudit {
	audit := productionManifestAudit{AttemptsByTrace: map[string]model.ProductionAttempt{}, AudioAttempts: map[string]model.ProductionAttempt{}}
	executionManifest, ok := decodeMap(planJSON)["executionManifest"].(map[string]any)
	if !ok || len(executionManifest) == 0 {
		return productionManifestAudit{Issues: []string{"execution_manifest_missing"}, AttemptsByTrace: map[string]model.ProductionAttempt{}, AudioAttempts: map[string]model.ProductionAttempt{}}
	}
	issueSet := map[string]bool{}
	addIssue := func(issue string) {
		if issue != "" && !issueSet[issue] {
			issueSet[issue] = true
			audit.Issues = append(audit.Issues, issue)
		}
	}
	warningSet := map[string]bool{}
	// 警告只用于报告，不阻断：拿不到实测证据时不能用能力声明代替实测。
	addWarning := func(warning string) {
		if warning != "" && !warningSet[warning] {
			warningSet[warning] = true
			audit.Warnings = append(audit.Warnings, warning)
		}
	}
	activeByKey := map[string]model.ProductionStep{}
	for _, step := range steps {
		if !step.Superseded {
			activeByKey[step.StepKey] = step
		}
	}
	quality := ""
	if len(qualityJSON) > 0 {
		quality = qualityJSON[0]
	}
	qualityStepResults := productionRecord(decodeMap(quality)["stepResults"])
	if int64Value(executionManifest["targetDurationMs"]) != contract.TargetDurationMs {
		addIssue("manifest_duration_mismatch")
	}
	if normalizeAspectRatio(stringValue(executionManifest["targetAspectRatio"])) != normalizeAspectRatio(contract.TargetAspectRatio) {
		addIssue("manifest_aspect_ratio_mismatch")
	}
	videoKeys := productionManifestStrings(executionManifest["videoStepKeys"])
	audioKeys := productionManifestStrings(executionManifest["audioStepKeys"])
	sharedAssetKeys := productionManifestStrings(executionManifest["sharedAssetStepKeys"])
	videoKeySet := map[string]bool{}
	for _, key := range videoKeys {
		if key == "" || videoKeySet[key] {
			addIssue("manifest_video_step_key_invalid")
			continue
		}
		videoKeySet[key] = true
		step, exists := activeByKey[key]
		if !exists || step.Kind != "video" && step.Kind != "reuse_media" {
			addIssue("manifest_video_step_missing:" + key)
		}
	}
	reusedBindings := productionManifestRecords(executionManifest["reusedMediaBindings"])
	reusedByTrace := map[string]map[string]any{}
	for _, binding := range reusedBindings {
		rowID := strings.TrimSpace(stringValue(binding["storyboardRowId"]))
		segmentID := strings.TrimSpace(stringValue(binding["segmentId"]))
		stepKey := strings.TrimSpace(stringValue(binding["stepKey"]))
		resourceID := strings.TrimSpace(stringValue(binding["resourceId"]))
		trace := productionSegmentTraceKey(rowID, segmentID)
		step, exists := activeByKey[stepKey]
		if rowID == "" || segmentID == "" || resourceID == "" || len(resourceID) > 36 || stepKey == "" || !videoKeySet[stepKey] || !exists || step.Kind != "reuse_media" || step.StoryboardRowID != rowID || step.SegmentID != segmentID || step.SelectedStrategyID != "existing-media:"+resourceID || reusedByTrace[trace] != nil {
			addIssue("manifest_reused_media_binding_invalid:" + segmentID)
			continue
		}
		reusedByTrace[trace] = binding
	}
	audioKeySet := map[string]bool{}
	for _, key := range audioKeys {
		if key == "" || audioKeySet[key] {
			addIssue("manifest_audio_step_key_invalid")
			continue
		}
		audioKeySet[key] = true
		step, exists := activeByKey[key]
		if !exists || step.Kind != "audio" {
			addIssue("manifest_audio_step_missing:" + key)
		}
	}
	audioBindings := productionManifestRecords(executionManifest["audioTrackBindings"])
	seenAudioTracks := map[string]bool{}
	seenAudioSteps := map[string]bool{}
	for _, binding := range audioBindings {
		rowID := strings.TrimSpace(stringValue(binding["storyboardRowId"]))
		trackID := strings.TrimSpace(stringValue(binding["trackId"]))
		stepKey := strings.TrimSpace(stringValue(binding["stepKey"]))
		traceKey := productionAudioTrackTraceKey(rowID, trackID)
		if rowID == "" || trackID == "" || stepKey == "" || seenAudioTracks[traceKey] || seenAudioSteps[stepKey] {
			addIssue("manifest_audio_track_binding_invalid")
			continue
		}
		seenAudioTracks[traceKey] = true
		seenAudioSteps[stepKey] = true
		step, exists := activeByKey[stepKey]
		if !audioKeySet[stepKey] || !exists || step.Kind != "audio" || step.StoryboardRowID != rowID || step.TrackID != trackID {
			addIssue("manifest_audio_track_step_mismatch:" + trackID)
			continue
		}
		kind := strings.TrimSpace(stringValue(binding["kind"]))
		modelName := strings.TrimSpace(stringValue(binding["model"]))
		capabilityRevision := strings.TrimSpace(stringValue(binding["capabilityRevision"]))
		requirement := productionAudioTrackRequirement{
			StoryboardRowID: rowID, TrackID: trackID, StepKey: stepKey, Kind: kind,
			Model: modelName, CapabilityRevision: capabilityRevision,
		}
		if !productionAudioTrackKindValid(kind) {
			addIssue("manifest_audio_track_kind_invalid:" + trackID)
		}
		wantModel := modelName
		if wantModel == "" {
			wantModel = "auto"
		}
		wantRevision := capabilityRevision
		if wantRevision == "" {
			wantRevision = "unversioned"
		}
		if step.SelectedStrategyID != kind+":"+wantModel+"@"+wantRevision {
			addIssue("manifest_audio_track_strategy_mismatch:" + trackID)
		}
		audit.AudioTracks = append(audit.AudioTracks, requirement)
	}
	if len(audioBindings) != len(audioKeySet) || len(seenAudioSteps) != len(audioKeySet) {
		addIssue("manifest_audio_track_steps_mismatch")
	}
	for _, key := range sharedAssetKeys {
		step, exists := activeByKey[key]
		if key == "" || !exists || step.Kind != "image" {
			addIssue("manifest_shared_asset_step_missing:" + key)
		}
	}

	selectedModels := map[string]map[string]any{}
	for _, raw := range productionManifestRecords(executionManifest["selectedModelsBySegment"]) {
		rowID := stringValue(raw["storyboardRowId"])
		segmentID := stringValue(raw["segmentId"])
		traceKey := productionSegmentTraceKey(rowID, segmentID)
		if rowID == "" || segmentID == "" || selectedModels[traceKey] != nil {
			addIssue("manifest_model_selection_invalid")
			continue
		}
		selectedModels[traceKey] = raw
	}

	rowBindings := productionManifestRecords(executionManifest["rowAssetBindings"])
	rowIDs := map[string]bool{}
	segmentKeys := map[string]bool{}
	for _, row := range rowBindings {
		rowID := stringValue(row["storyboardRowId"])
		if rowID == "" || rowIDs[rowID] {
			addIssue("manifest_storyboard_row_invalid")
			continue
		}
		rowIDs[rowID] = true
		segments := productionManifestStrings(row["segmentIds"])
		if len(segments) == 0 {
			addIssue("manifest_storyboard_row_has_no_segments:" + rowID)
		}
		for _, segmentID := range segments {
			traceKey := productionSegmentTraceKey(rowID, segmentID)
			if segmentID == "" || segmentKeys[traceKey] {
				addIssue("manifest_segment_binding_invalid:" + rowID)
				continue
			}
			segmentKeys[traceKey] = true
			var boundStep *model.ProductionStep
			for _, step := range steps {
				if !step.Superseded && (step.Kind == "video" || step.Kind == "reuse_media") && step.StoryboardRowID == rowID && step.SegmentID == segmentID {
					copy := step
					if boundStep != nil {
						addIssue("manifest_segment_step_ambiguous:" + segmentID)
					}
					boundStep = &copy
				}
			}
			if boundStep == nil || !videoKeySet[boundStep.StepKey] {
				addIssue("manifest_segment_step_missing:" + segmentID)
				continue
			}
			requirement := productionSegmentRequirement{StoryboardRowID: rowID, SegmentID: segmentID, StepKey: boundStep.StepKey, StepKind: boundStep.Kind}
			if boundStep.Kind == "reuse_media" {
				binding := reusedByTrace[traceKey]
				if binding == nil || stringValue(binding["stepKey"]) != boundStep.StepKey || selectedModels[traceKey] != nil {
					addIssue("manifest_reused_media_manifest_mismatch:" + segmentID)
				} else {
					requirement.ResourceID = strings.TrimSpace(stringValue(binding["resourceId"]))
					requirement.SourceTaskID = strings.TrimSpace(stringValue(binding["sourceTaskId"]))
					requirement.SourceNodeID = strings.TrimSpace(stringValue(binding["sourceNodeId"]))
					if boundStep.Status != "succeeded" || boundStep.AttemptCount != 0 || !containsString(productionManifestStrings(decodeJSONAny(boundStep.OutputArtifactJSON)), requirement.ResourceID) {
						addIssue("manifest_reused_media_step_incomplete:" + segmentID)
					}
					result := productionRecord(qualityStepResults[boundStep.StepKey])
					evidence := productionRecord(result["evidence"])
					probe := productionRecord(evidence["probe"])
					spanDurationMs := productionManifestSpanDurationMs(executionManifest, traceKey)
					if stringValue(result["status"]) != "passed" || stringValue(evidence["resourceId"]) != requirement.ResourceID || stringValue(evidence["sourceTaskId"]) != requirement.SourceTaskID || stringValue(evidence["sourceNodeId"]) != requirement.SourceNodeID || !boolValue(probe["decoded"]) || intValue(probe["videoStreams"]) < 1 || int64Value(probe["durationMs"]) < spanDurationMs || !ratioMatches(intValue(probe["width"]), intValue(probe["height"]), contract.TargetAspectRatio, productionAspectRatioTolerance) {
						addIssue("manifest_reused_media_probe_missing_or_invalid:" + segmentID)
					}
					if (boolValue(executionManifest["requireAudio"]) || contract.RequireAudio) && stringValue(executionManifest["audioMode"]) == model.ProductionAudioModeNative && intValue(probe["audioStreams"]) < 1 {
						addIssue("manifest_reused_media_native_audio_missing:" + segmentID)
					}
				}
			} else {
				selection := selectedModels[traceKey]
				if selection == nil {
					addIssue("manifest_segment_model_missing:" + segmentID)
					continue
				}
				requirement.Model = stringValue(selection["model"])
				requirement.CapabilityRevision = stringValue(selection["capabilityRevision"])
				requirement.Operation = stringValue(selection["operation"])
				if requirement.Model == "" || requirement.CapabilityRevision == "" || requirement.Operation == "" {
					addIssue("manifest_segment_model_trace_incomplete:" + segmentID)
				}
				wantStrategy := requirement.Model + "@" + requirement.CapabilityRevision + ":" + requirement.Operation
				if wantStrategy != boundStep.SelectedStrategyID {
					addIssue("manifest_segment_strategy_mismatch:" + segmentID)
				}
			}
			audit.Segments = append(audit.Segments, requirement)
			if !productionHasStoryboardStep(steps, rowID, "quality:shot:") {
				addIssue("storyboard_quality_step_missing:" + rowID)
			}
			if !productionHasStoryboardStep(steps, rowID, "continuity:") {
				addIssue("storyboard_continuity_step_missing:" + rowID)
			}
		}
	}
	if len(rowBindings) == 0 || len(segmentKeys) != len(videoKeySet) {
		addIssue("manifest_video_rows_steps_mismatch")
	}
	for traceKey := range selectedModels {
		if !segmentKeys[traceKey] || reusedByTrace[traceKey] != nil {
			addIssue("manifest_unbound_model_selection")
		}
	}
	if len(reusedByTrace) != len(reusedBindings) {
		addIssue("manifest_reused_media_bindings_mismatch")
	}

	if !productionStepKeyReady(activeByKey, "timeline:master", "render") {
		addIssue("master_timeline_step_missing")
	}
	if !productionStepKeyReady(activeByKey, "quality:full-film", "verify") {
		addIssue("full_film_quality_step_missing")
	}
	if !productionStepKeyExists(activeByKey, "delivery:contract", "delivery_check") {
		addIssue("delivery_contract_step_missing")
	}

	spans := productionManifestRecords(executionManifest["timelineSpans"])
	if len(spans) != len(segmentKeys) {
		addIssue("manifest_timeline_segment_count_mismatch")
	}
	spanKeys := map[string]bool{}
	for _, span := range spans {
		traceKey := productionSegmentTraceKey(stringValue(span["storyboardRowId"]), stringValue(span["segmentId"]))
		if !segmentKeys[traceKey] || spanKeys[traceKey] || int64Value(span["durationFrames"]) <= 0 {
			addIssue("manifest_timeline_span_invalid")
		}
		spanKeys[traceKey] = true
	}
	sort.Slice(spans, func(i, j int) bool { return int64Value(spans[i]["startFrame"]) < int64Value(spans[j]["startFrame"]) })
	fpsNumerator := int64Value(productionRecord(executionManifest["timelineTimebase"])["fpsNumerator"])
	fpsDenominator := int64Value(productionRecord(executionManifest["timelineTimebase"])["fpsDenominator"])
	totalFrames := int64Value(productionRecord(executionManifest["timelineTimebase"])["totalFrames"])
	frameCursor := int64(0)
	for _, span := range spans {
		if int64Value(span["startFrame"]) != frameCursor {
			addIssue("manifest_timeline_gap_or_overlap")
		}
		frameCursor += int64Value(span["durationFrames"])
	}
	if fpsNumerator <= 0 || fpsDenominator <= 0 || totalFrames <= 0 || frameCursor != totalFrames {
		addIssue("manifest_timeline_timebase_invalid")
	} else {
		measuredDuration := (totalFrames*1000*fpsDenominator + fpsNumerator/2) / fpsNumerator
		manifestDuration := int64Value(productionRecord(executionManifest["timelineTimebase"])["durationMs"])
		frameTolerance := (1000*fpsDenominator + fpsNumerator - 1) / fpsNumerator
		if manifestDuration <= 0 || absInt64(manifestDuration-measuredDuration) > 1 || absInt64(measuredDuration-contract.TargetDurationMs) > contract.DurationToleranceMs+frameTolerance {
			addIssue("manifest_timeline_duration_mismatch")
		}
	}

	audioMode, audioModeErr := normalizeProductionAudioMode(stringValue(executionManifest["audioMode"]))
	if audioModeErr != nil || strings.TrimSpace(stringValue(executionManifest["audioMode"])) == "" {
		addIssue("manifest_audio_mode_invalid")
	}
	audioPolicy := stringValue(executionManifest["audioPolicy"])
	audioGaps := productionManifestRecords(executionManifest["audioCapabilityGaps"])
	requireAudio := boolValue(executionManifest["requireAudio"]) || contract.RequireAudio
	requireNativeAudio := requireAudio && audioMode == model.ProductionAudioModeNative
	if audioPolicy == "mixed" || audioMode == model.ProductionAudioModeNative && audioPolicy != "native" || audioMode == model.ProductionAudioModeRebuild && audioPolicy != "independent" {
		addIssue("manifest_audio_mode_policy_conflict")
	}
	if audioMode == model.ProductionAudioModeNative && (len(audioKeys) > 0 || len(audioBindings) > 0) {
		addIssue("manifest_native_audio_has_generated_tracks")
	}
	if audioMode == model.ProductionAudioModeRebuild && len(audioKeys) == 0 && len(audioBindings) == 0 && len(audioGaps) == 0 {
		addIssue("manifest_rebuild_audio_tracks_missing")
	}
	seenAudioGapTracks := map[string]bool{}
	for _, gap := range audioGaps {
		rowID := strings.TrimSpace(stringValue(gap["storyboardRowId"]))
		trackID := strings.TrimSpace(stringValue(gap["trackId"]))
		kind := strings.TrimSpace(stringValue(gap["kind"]))
		capability := strings.TrimSpace(stringValue(gap["capability"]))
		trackKey := productionAudioTrackTraceKey(rowID, trackID)
		if rowID == "" || trackID == "" || !productionAudioTrackKindValid(kind) || capability != productionAudioCapabilityForTrackKind(kind) || stringValue(gap["status"]) != "unavailable" || strings.TrimSpace(stringValue(gap["reason"])) == "" || seenAudioGapTracks[trackKey] || seenAudioTracks[trackKey] {
			addIssue("manifest_audio_capability_gap_invalid")
			continue
		}
		seenAudioGapTracks[trackKey] = true
		if audioMode != model.ProductionAudioModeRebuild {
			addIssue("manifest_native_audio_has_generated_tracks")
		}
		if boolValue(gap["required"]) {
			addIssue("manifest_audio_capability_missing:" + rowID + ":" + trackID + ":" + capability)
		}
		if kind == "dialogue" || kind == "voiceover" {
			if strings.TrimSpace(stringValue(gap["lineId"])) == "" || strings.TrimSpace(stringValue(gap["text"])) == "" {
				addIssue("manifest_audio_capability_gap_speech_binding_invalid:" + trackID)
			}
		}
	}
	if requireAudio {
		if audioMode == model.ProductionAudioModeRebuild {
			if len(audioKeys) == 0 {
				addIssue("manifest_audio_track_missing")
			}
		}
	}
	if requireNativeAudio {
		// 能力声明只是线索：中转渠道可能未声明原生音频但实际返回了音轨。这里优先采信
		// 片段实际产物的音轨探测，拿不到证据时才回退到声明判定，避免用声明代替实测。
		for _, selection := range selectedModels {
			if boolValue(selection["generateAudio"]) && boolValue(selection["supportsNativeAudio"]) {
				continue
			}
			rowID := strings.TrimSpace(stringValue(selection["storyboardRowId"]))
			segmentID := strings.TrimSpace(stringValue(selection["segmentId"]))
			streams, evidenced := productionManifestNativeAudioStreams(qualityStepResults, steps, rowID, segmentID)
			if !evidenced {
				// 尚无实测证据：声明不一致只入报告，等渲染前的真实探测和交付时的成片探测定论。
				addWarning("manifest_native_audio_declaration_unsupported:" + rowID + ":" + segmentID)
				continue
			}
			if streams < 1 {
				addIssue("manifest_native_audio_stream_missing:" + rowID + ":" + segmentID)
			}
		}
	}
	if contract.RequireSubtitle || boolValue(executionManifest["requireSubtitle"]) {
		cues := productionManifestRecords(executionManifest["subtitleCues"])
		if len(cues) == 0 {
			addIssue("manifest_subtitle_cues_missing")
		}
		for _, cue := range cues {
			if !rowIDs[stringValue(cue["storyboardRowId"])] || int64Value(cue["startMs"]) < 0 || int64Value(cue["durationMs"]) <= 0 || strings.TrimSpace(stringValue(cue["text"])) == "" {
				addIssue("manifest_subtitle_cue_invalid")
			}
		}
	}
	skills := productionManifestRecords(executionManifest["skillEvidence"])
	if len(skills) == 0 {
		addIssue("manifest_skill_evidence_missing")
	}
	for _, skill := range skills {
		if stringValue(skill["skillId"]) == "" || stringValue(skill["versionId"]) == "" || stringValue(skill["contentHash"]) == "" || stringValue(skill["phase"]) == "" {
			addIssue("manifest_skill_evidence_incomplete")
		}
	}

	latestAttempts := map[string]model.ProductionAttempt{}
	for _, attempt := range attempts {
		current, exists := latestAttempts[attempt.StepID]
		if !exists || attempt.AttemptNumber > current.AttemptNumber {
			latestAttempts[attempt.StepID] = attempt
		}
	}
	for _, segment := range audit.Segments {
		if segment.StepKind == "reuse_media" {
			continue
		}
		step := activeByKey[segment.StepKey]
		attempt, exists := latestAttempts[step.ID]
		traceKey := productionSegmentTraceKey(segment.StoryboardRowID, segment.SegmentID)
		if !exists || attempt.AttemptNumber != step.AttemptCount || attempt.State != "succeeded" || attempt.GenerationTaskID == "" {
			addIssue("manifest_segment_attempt_incomplete:" + segment.SegmentID)
			continue
		}
		if attempt.CapabilityRevision != segment.CapabilityRevision {
			addIssue("manifest_segment_attempt_capability_mismatch:" + segment.SegmentID)
		}
		audit.AttemptsByTrace[traceKey] = attempt
	}
	for _, track := range audit.AudioTracks {
		step := activeByKey[track.StepKey]
		attempt, exists := latestAttempts[step.ID]
		traceKey := productionAudioTrackTraceKey(track.StoryboardRowID, track.TrackID)
		if !exists || attempt.AttemptNumber != step.AttemptCount || attempt.State != "succeeded" || attempt.GenerationTaskID == "" {
			addIssue("manifest_audio_attempt_incomplete:" + track.TrackID)
			continue
		}
		if track.CapabilityRevision != "" && attempt.CapabilityRevision != track.CapabilityRevision {
			addIssue("manifest_audio_attempt_capability_mismatch:" + track.TrackID)
		}
		audit.AudioAttempts[traceKey] = attempt
	}
	return audit
}

func productionManifestSpanDurationMs(manifest map[string]any, traceKey string) int64 {
	fps := productionRecord(manifest["timelineTimebase"])
	numerator := int64Value(fps["fpsNumerator"])
	denominator := int64Value(fps["fpsDenominator"])
	if numerator <= 0 || denominator <= 0 {
		return 0
	}
	for _, span := range productionManifestRecords(manifest["timelineSpans"]) {
		if productionSegmentTraceKey(stringValue(span["storyboardRowId"]), stringValue(span["segmentId"])) != traceKey {
			continue
		}
		frames := int64Value(span["durationFrames"])
		if frames <= 0 {
			return 0
		}
		return (frames*1000*denominator + numerator/2) / numerator
	}
	return 0
}

func productionManifestTaskIssues(runID string, userID string, audit productionManifestAudit, loadTask func(string) (*model.Task, error)) []string {
	issues := []string{}
	for _, segment := range audit.Segments {
		if segment.StepKind == "reuse_media" {
			if segment.SourceTaskID == "" {
				continue
			}
			task, err := loadTask(segment.SourceTaskID)
			if err != nil || task == nil {
				issues = append(issues, "manifest_reused_media_source_task_missing:"+segment.SegmentID)
				continue
			}
			if task.UserID != userID || task.Status != model.TaskStatusSucceeded || !containsString(productionTaskVideoArtifacts(*task), segment.ResourceID) {
				issues = append(issues, "manifest_reused_media_source_task_mismatch:"+segment.SegmentID)
			}
			continue
		}
		traceKey := productionSegmentTraceKey(segment.StoryboardRowID, segment.SegmentID)
		attempt, ok := audit.AttemptsByTrace[traceKey]
		if !ok || attempt.GenerationTaskID == "" {
			continue
		}
		task, err := loadTask(attempt.GenerationTaskID)
		if err != nil || task == nil {
			issues = append(issues, "manifest_segment_task_missing:"+segment.SegmentID)
			continue
		}
		if task.UserID != userID || task.ProductionRunID != runID || task.ProductionStepID != attempt.StepID || task.ProductionAttemptID != attempt.ID || task.StoryboardRowID != segment.StoryboardRowID || task.SegmentID != segment.SegmentID {
			issues = append(issues, "manifest_segment_task_binding_mismatch:"+segment.SegmentID)
		}
		if task.Status != model.TaskStatusSucceeded || task.Model != segment.Model || !productionTaskOperationMatches(*task, segment.Operation) || task.CapabilityRevision != segment.CapabilityRevision {
			issues = append(issues, "manifest_segment_task_evidence_mismatch:"+segment.SegmentID)
		}
	}
	for _, track := range audit.AudioTracks {
		traceKey := productionAudioTrackTraceKey(track.StoryboardRowID, track.TrackID)
		attempt, ok := audit.AudioAttempts[traceKey]
		if !ok || attempt.GenerationTaskID == "" {
			continue
		}
		task, err := loadTask(attempt.GenerationTaskID)
		if err != nil || task == nil {
			issues = append(issues, "manifest_audio_task_missing:"+track.TrackID)
			continue
		}
		if task.UserID != userID || task.ProductionRunID != runID || task.ProductionStepID != attempt.StepID || task.ProductionAttemptID != attempt.ID || task.StoryboardRowID != track.StoryboardRowID || task.TrackID != track.TrackID {
			issues = append(issues, "manifest_audio_task_binding_mismatch:"+track.TrackID)
		}
		modelMismatch := track.Model != "" && !strings.EqualFold(track.Model, "auto") && task.Model != track.Model
		revisionMismatch := track.CapabilityRevision != "" && task.CapabilityRevision != track.CapabilityRevision
		if task.Status != model.TaskStatusSucceeded || strings.TrimSpace(task.Model) == "" || strings.TrimSpace(task.Operation) == "" || strings.TrimSpace(task.CapabilityRevision) == "" || attempt.CapabilityRevision != task.CapabilityRevision || modelMismatch || revisionMismatch {
			issues = append(issues, "manifest_audio_task_evidence_mismatch:"+track.TrackID)
		}
	}
	return issues
}

// Older canvas tasks did not persist the inferred operation; completion also
// compacted reference inputs. Do not invent that lost field or modify history.
// Accept only this legacy shape, after the caller checks exact run/step/attempt,
// row/segment, model and capability bindings. Explicit mismatches still fail.
func productionTaskOperationMatches(task model.Task, expected string) bool {
	if task.Operation != "" {
		return task.Operation == expected
	}
	if task.Type != "canvas_video" || task.Status != model.TaskStatusSucceeded {
		return false
	}
	var input map[string]any
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil || stringValue(input["mode"]) != "video" {
		return false
	}
	if len(input) != 2 || input["metadata"] == nil {
		return false
	}
	metadata := productionRecord(input["metadata"])
	return stringValue(metadata["productionRunId"]) == task.ProductionRunID && task.ProductionRunID != "" &&
		stringValue(metadata["storyboardRowId"]) == task.StoryboardRowID && task.StoryboardRowID != "" &&
		stringValue(metadata["segmentId"]) == task.SegmentID && task.SegmentID != "" &&
		(expected == "image_to_video" || expected == "text_to_video" || expected == "video_to_video")
}

func productionManifestStrings(value any) []string {
	items, _ := value.([]any)
	result := make([]string, 0, len(items))
	for _, item := range items {
		if value := strings.TrimSpace(stringValue(item)); value != "" {
			result = append(result, value)
		}
	}
	return result
}

func productionManifestRecords(value any) []map[string]any {
	items, _ := value.([]any)
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if record, ok := item.(map[string]any); ok {
			result = append(result, record)
		}
	}
	return result
}

// productionManifestNativeAudioStreams 返回某个分镜片段实际产物的音轨数量。
// 复用媒体步骤直接在自证据里探测；新生成视频的探测证据记在 quality:shot:<rowId> 上。
// 证据不存在或无法对应片段产物时返回 evidenced=false，调用方退回能力声明判定。
func productionManifestNativeAudioStreams(stepResults map[string]any, steps []model.ProductionStep, rowID, segmentID string) (int, bool) {
	if rowID == "" || segmentID == "" {
		return 0, false
	}
	var boundStep *model.ProductionStep
	for index := range steps {
		step := steps[index]
		if step.Superseded || step.StoryboardRowID != rowID || step.SegmentID != segmentID || step.Kind != "video" && step.Kind != "reuse_media" {
			continue
		}
		if boundStep != nil {
			return 0, false
		}
		copy := step
		boundStep = &copy
	}
	if boundStep == nil {
		return 0, false
	}
	if boundStep.Kind == "reuse_media" {
		result := productionRecord(stepResults[boundStep.StepKey])
		probe := productionRecord(productionRecord(result["evidence"])["probe"])
		if probe == nil {
			return 0, false
		}
		if _, ok := probe["audioStreams"]; !ok {
			return 0, false
		}
		return intValue(probe["audioStreams"]), true
	}
	quality := productionRecord(stepResults["quality:shot:"+rowID])
	media := productionRecord(productionRecord(quality["evidence"])["media"])
	probe := productionRecord(media["probe"])
	if media == nil || probe == nil {
		return 0, false
	}
	if _, ok := probe["audioStreams"]; !ok {
		return 0, false
	}
	// 质检证据必须指向该片段已登记的产物，避免拿别的片段或道具探测结果冒充。
	resourceID := strings.TrimSpace(stringValue(media["resourceId"]))
	if resourceID == "" || !containsString(productionManifestStrings(decodeJSONAny(boundStep.OutputArtifactJSON)), resourceID) {
		return 0, false
	}
	return intValue(probe["audioStreams"]), true
}

func productionSegmentTraceKey(rowID string, segmentID string) string {
	return strings.TrimSpace(rowID) + "\x00" + strings.TrimSpace(segmentID)
}

func productionAudioTrackTraceKey(rowID string, trackID string) string {
	return strings.TrimSpace(rowID) + "\x00" + strings.TrimSpace(trackID)
}

func productionHasStoryboardStep(steps []model.ProductionStep, rowID string, prefix string) bool {
	for _, step := range steps {
		if !step.Superseded && step.Status == "succeeded" && step.StoryboardRowID == rowID && step.Kind == "check" && strings.HasPrefix(step.StepKey, prefix) {
			return true
		}
	}
	return false
}

func productionStepKeyReady(steps map[string]model.ProductionStep, key string, kind string) bool {
	step, ok := steps[key]
	return ok && step.Status == "succeeded" && step.Kind == kind
}

func productionStepKeyExists(steps map[string]model.ProductionStep, key string, kind string) bool {
	step, ok := steps[key]
	return ok && step.Kind == kind
}

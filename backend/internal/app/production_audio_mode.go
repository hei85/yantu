package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func normalizeProductionAudioMode(value string) (string, error) {
	mode := strings.ToUpper(strings.TrimSpace(value))
	if mode == "" {
		return model.ProductionAudioModeNative, nil
	}
	switch mode {
	case model.ProductionAudioModeNative, model.ProductionAudioModeRebuild:
		return mode, nil
	default:
		return "", fmt.Errorf("audioMode 只支持 NATIVE_AUDIO 或 REBUILD_AUDIO")
	}
}

// normalizeProductionPlanAudioMode locks the manifest's renderer policy to the
// run-level choice. Legacy "mixed" plans fail closed because they can duplicate
// the same dialogue in native and generated tracks.
func normalizeProductionPlanAudioMode(plan map[string]any, audioMode string) error {
	if plan == nil {
		return nil
	}
	manifest, ok := plan["executionManifest"].(map[string]any)
	if !ok {
		return nil
	}
	if raw := strings.TrimSpace(stringValue(manifest["audioMode"])); raw != "" {
		declared, err := normalizeProductionAudioMode(raw)
		if err != nil || declared != audioMode {
			return fmt.Errorf("ProductionRun audioMode 与 executionManifest.audioMode 不一致")
		}
	}
	policy := strings.ToLower(strings.TrimSpace(stringValue(manifest["audioPolicy"])))
	if policy == "mixed" {
		return fmt.Errorf("音频模式必须互斥，不能使用 mixed")
	}
	if policy == "native" && audioMode != model.ProductionAudioModeNative || policy == "independent" && audioMode != model.ProductionAudioModeRebuild {
		return fmt.Errorf("ProductionRun audioMode 与 executionManifest.audioPolicy 不一致")
	}
	audioKeys := productionManifestStrings(manifest["audioStepKeys"])
	audioGaps := productionManifestRecords(manifest["audioCapabilityGaps"])
	if audioMode == model.ProductionAudioModeNative {
		if len(audioKeys) > 0 || len(productionManifestRecords(manifest["audioTrackBindings"])) > 0 || len(audioGaps) > 0 {
			return fmt.Errorf("NATIVE_AUDIO 禁止创建独立对白、旁白、音效或音乐生成步骤")
		}
		manifest["audioPolicy"] = "native"
	} else {
		bindings := productionManifestRecords(manifest["audioTrackBindings"])
		if len(audioKeys) == 0 && len(bindings) == 0 && len(audioGaps) == 0 {
			return fmt.Errorf("REBUILD_AUDIO 必须绑定至少一条独立音轨")
		}
		seenLineIDs := map[string]bool{}
		seenTrackIDs := map[string]bool{}
		for _, binding := range bindings {
			rowID := strings.TrimSpace(stringValue(binding["storyboardRowId"]))
			trackID := strings.TrimSpace(stringValue(binding["trackId"]))
			trackKey := productionAudioTrackTraceKey(rowID, trackID)
			if rowID != "" && trackID != "" && seenTrackIDs[trackKey] {
				return fmt.Errorf("REBUILD_AUDIO 音轨绑定重复：%s", trackID)
			}
			if rowID != "" && trackID != "" {
				seenTrackIDs[trackKey] = true
			}
			kind := strings.TrimSpace(stringValue(binding["kind"]))
			if kind != "dialogue" && kind != "voiceover" {
				continue
			}
			lineID := strings.TrimSpace(stringValue(binding["lineId"]))
			if lineID == "" {
				return fmt.Errorf("REBUILD_AUDIO 的对白/旁白必须绑定稳定 lineId")
			}
			if strings.TrimSpace(stringValue(binding["text"])) == "" {
				return fmt.Errorf("REBUILD_AUDIO 的对白/旁白必须绑定分镜台词文本")
			}
			if seenLineIDs[lineID] {
				return fmt.Errorf("REBUILD_AUDIO 同一句对白/旁白不能重复生成：%s", lineID)
			}
			seenLineIDs[lineID] = true
		}
		for _, gap := range audioGaps {
			rowID := strings.TrimSpace(stringValue(gap["storyboardRowId"]))
			trackID := strings.TrimSpace(stringValue(gap["trackId"]))
			kind := strings.TrimSpace(stringValue(gap["kind"]))
			capability := strings.TrimSpace(stringValue(gap["capability"]))
			if rowID == "" || trackID == "" || stringValue(gap["status"]) != "unavailable" || strings.TrimSpace(stringValue(gap["reason"])) == "" || !productionAudioTrackKindValid(kind) || capability != productionAudioCapabilityForTrackKind(kind) {
				return fmt.Errorf("REBUILD_AUDIO 能力缺口记录不完整或用途不匹配")
			}
			trackKey := productionAudioTrackTraceKey(rowID, trackID)
			if seenTrackIDs[trackKey] {
				return fmt.Errorf("REBUILD_AUDIO 音轨绑定与能力缺口重复：%s", trackID)
			}
			seenTrackIDs[trackKey] = true
			if kind != "dialogue" && kind != "voiceover" {
				continue
			}
			lineID := strings.TrimSpace(stringValue(gap["lineId"]))
			if lineID == "" || strings.TrimSpace(stringValue(gap["text"])) == "" {
				return fmt.Errorf("REBUILD_AUDIO 缺少能力的对白/旁白仍必须绑定稳定 lineId 和固定台词文本")
			}
			if seenLineIDs[lineID] {
				return fmt.Errorf("REBUILD_AUDIO 同一句对白/旁白不能重复登记：%s", lineID)
			}
			seenLineIDs[lineID] = true
		}
		manifest["audioPolicy"] = "independent"
	}
	if audioMode == model.ProductionAudioModeRebuild {
		for _, selection := range productionManifestRecords(manifest["selectedModelsBySegment"]) {
			if boolValue(selection["generateAudio"]) {
				return fmt.Errorf("REBUILD_AUDIO 禁止请求视频模型生成原生音轨")
			}
		}
	}
	manifest["audioMode"] = audioMode
	return nil
}

func (s *Service) prepareProductionAudioTask(userID string, run *model.ProductionRun, step *model.ProductionStep, req *ProductionSubmitRequest) error {
	if run == nil || step == nil || req == nil {
		return BadAuthRequest("制作音频步骤上下文不完整")
	}
	mode, err := normalizeProductionAudioMode(run.AudioMode)
	if err != nil {
		return productionConflict("ProductionRun audioMode 无效")
	}
	input := req.Task.Input
	if input == nil {
		input = map[string]any{}
	}
	requestMode := strings.ToLower(strings.TrimSpace(stringValue(input["mode"])))
	if requestMode == "audio" {
		if mode != model.ProductionAudioModeRebuild || step.Kind != "audio" {
			return productionConflict("NATIVE_AUDIO 禁止提交 MiMo 或其他独立音频生成任务")
		}
		manifest, _ := decodeMap(run.PlanJSON)["executionManifest"].(map[string]any)
		binding, ok := productionAudioBindingForStep(manifest, step.StepKey)
		if !ok {
			return productionConflict("独立音频步骤没有对应的制作音轨绑定")
		}
		if err := s.validateProductionSpeechCharacterVoice(userID, run, binding); err != nil {
			return err
		}
		if voiceVersionID := strings.TrimSpace(stringValue(binding["voiceVersionId"])); voiceVersionID != "" {
			version, lookupErr := s.repo.VoiceProfileVersion(voiceVersionID)
			if lookupErr != nil {
				return productionConflict("分镜引用的 VoiceVersion 不存在")
			}
			if version.Status != "ready" {
				return productionConflict("分镜引用的 VoiceVersion 尚未具备可复用的模型能力")
			}
			if strings.TrimSpace(stringValue(binding["characterId"])) == "" || version.CharacterAssetID != strings.TrimSpace(stringValue(binding["characterId"])) {
				return productionConflict("VoiceVersion 与分镜角色身份不匹配")
			}
			profile, profileErr := s.repo.VoiceProfileForUser(userID, version.VoiceProfileID)
			if profileErr != nil || profile.Status != "active" {
				return productionConflict("分镜 VoiceVersion 所属声音档案不可用")
			}
			if !productionVoiceProfileAllowsModel(profile, strings.TrimSpace(stringValue(binding["model"]))) {
				return productionConflict("实际音频模型不在 VoiceProfile 兼容模型目录中")
			}
			if version.VoiceStrategy == "voice_reference" {
				if !version.ReferenceAudioAuthorized || version.ReferenceAudioResourceID == "" {
					return productionConflict("VoiceVersion 缺少合法参考音频确认")
				}
				resource, resourceErr := s.repo.ResourceForUser(userID, version.ReferenceAudioResourceID)
				if resourceErr != nil || resource.Kind != "audio" || resource.Status != model.ResourceStatusReady {
					return productionConflict("VoiceVersion 参考音频资源不可用")
				}
			}
			if version.VoiceModel != "" && version.VoiceModel != strings.TrimSpace(stringValue(binding["model"])) {
				return productionConflict("分镜尝试替换了角色 VoiceVersion 锁定的音频模型")
			}
			if version.CapabilityRevision != "" && version.CapabilityRevision != strings.TrimSpace(stringValue(binding["capabilityRevision"])) {
				return productionConflict("角色 VoiceVersion 的模型能力版本已变化")
			}
			binding = cloneProductionRecord(binding)
			binding["voiceStrategy"] = version.VoiceStrategy
			binding["voiceModel"] = firstNonEmpty(version.VoiceModel, stringValue(binding["model"]))
			binding["voiceId"] = firstNonEmpty(version.VoiceID, profile.VoiceKey)
			binding["referenceAudioResourceId"] = version.ReferenceAudioResourceID
			binding["tone"] = version.Tone
			binding["emotionStyle"] = version.EmotionStyle
			binding["speakingRate"] = version.SpeakingRate
			binding["language"] = version.Language
			binding["accent"] = version.Accent
		}
		if runModel := strings.TrimSpace(stringValue(binding["model"])); runModel != "" {
			if req.Task.Model != "" && req.Task.Model != runModel {
				return productionConflict("音频任务模型与能力目录中锁定的 Voice Router 选择不一致")
			}
			req.Task.Model = runModel
		}
		config, ok := input["config"].(map[string]any)
		if !ok {
			return BadAuthRequest("独立音频任务缺少模型配置")
		}
		if modelName := strings.TrimSpace(stringValue(binding["model"])); modelName != "" {
			config["model"] = modelName
		}
		kind := strings.TrimSpace(stringValue(binding["kind"]))
		speechTrack := kind == "dialogue" || kind == "voiceover"
		plannedText := strings.TrimSpace(stringValue(binding["text"]))
		if speechTrack && plannedText == "" {
			return productionConflict("ProductionPlan 的对白/旁白音轨缺少固定台词文本")
		}
		voiceStrategy := strings.TrimSpace(stringValue(binding["voiceStrategy"]))
		voiceID := strings.TrimSpace(stringValue(binding["voiceId"]))
		config["audioVoice"] = ""
		if speechTrack && voiceStrategy != "voice_reference" && voiceID != "" {
			config["audioVoice"] = voiceID
		}
		if speechTrack {
			config["audioSpeed"] = fmt.Sprint(parseFloat(stringValue(binding["speakingRate"]), 1))
		} else {
			config["audioSpeed"] = ""
		}
		delete(config, "audioInstructions")
		if plannedText != "" {
			req.Task.Prompt = plannedText
		}
		// The persisted plan is authoritative. Rebuild metadata from its binding so
		// caller-supplied voice IDs or references cannot shadow a temporary speaker
		// or a pinned VoiceVersion.
		metadata := map[string]any{}
		for _, key := range []string{"storyboardRowId", "trackId", "lineId", "lineIdentity", "kind", "characterId", "voiceVersionId", "voiceStrategy", "voiceModel", "voiceId", "referenceAudioResourceId", "tone", "emotionStyle", "speakingRate", "language", "accent", "text"} {
			if value, exists := binding[key]; exists {
				metadata[key] = value
			}
		}
		metadata["productionAudioMode"] = mode
		input["metadata"] = metadata
		if resourceID := strings.TrimSpace(stringValue(binding["referenceAudioResourceId"])); resourceID != "" {
			input["referenceAudios"] = []any{map[string]any{"id": resourceID, "name": "角色参考声音", "type": "audio", "storageKey": "resource:" + resourceID}}
		} else {
			delete(input, "referenceAudios")
		}
	} else if requestMode == "video" {
		if step.Kind != "video" {
			return productionConflict("ProductionStep 类型与视频生成任务不匹配")
		}
		config, _ := input["config"].(map[string]any)
		if config == nil {
			return BadAuthRequest("视频生成任务缺少模型配置")
		}
		generateAudio := false
		if mode == model.ProductionAudioModeNative {
			manifest, _ := decodeMap(run.PlanJSON)["executionManifest"].(map[string]any)
			selection, ok := productionSelectedSegment(manifest, step.StoryboardRowID, step.SegmentID)
			if !ok {
				return productionConflict("视频步骤没有匹配的分镜行/片段能力绑定")
			}
			generateAudio = boolValue(selection["generateAudio"])
			if generateAudio && !boolValue(selection["supportsNativeAudio"]) {
				return productionConflict("分镜片段要求原生音频，但锁定的视频模型能力不支持")
			}
		}
		config["videoGenerateAudio"] = fmt.Sprint(generateAudio)
	} else if step.Kind == "audio" || step.Kind == "video" || mode == model.ProductionAudioModeNative && strings.Contains(strings.ToLower(req.Task.Type), "audio") {
		return productionConflict("ProductionRun 音频模式与任务类型冲突")
	}
	req.Task.Input = input
	return nil
}

func (s *Service) validateProductionSpeechCharacterVoice(userID string, run *model.ProductionRun, binding map[string]any) error {
	kind := strings.TrimSpace(stringValue(binding["kind"]))
	if kind != "dialogue" && kind != "voiceover" {
		return nil
	}
	characterID := strings.TrimSpace(stringValue(binding["characterId"]))
	voiceVersionID := strings.TrimSpace(stringValue(binding["voiceVersionId"]))
	if characterID == "" {
		if voiceVersionID != "" {
			return productionConflict("VoiceVersion 必须通过明确的 characterId 绑定，临时说话人不能借用角色声音身份")
		}
		return nil
	}
	asset, err := s.repo.AssetForUser(userID, characterID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil // An unregistered speaker ID is a temporary voice identity.
	}
	if err != nil {
		return err
	}
	if asset.Category != model.AssetCategoryCharacter {
		return nil
	}
	if run.DomainProjectID != "" {
		if _, err := s.repo.ProjectCharacterAsset(userID, run.DomainProjectID, characterID); err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return productionConflict("对白/旁白角色未绑定到当前 ProductionRun 项目")
			}
			return err
		}
	}
	if voiceVersionID == "" {
		return productionConflict("固定项目角色的对白/旁白必须引用已保存的 VoiceProfile/VoiceVersion")
	}
	return nil
}

func productionSelectedSegment(manifest map[string]any, rowID, segmentID string) (map[string]any, bool) {
	for _, selection := range productionManifestRecords(manifest["selectedModelsBySegment"]) {
		if strings.TrimSpace(stringValue(selection["storyboardRowId"])) == strings.TrimSpace(rowID) && strings.TrimSpace(stringValue(selection["segmentId"])) == strings.TrimSpace(segmentID) {
			return selection, true
		}
	}
	return nil, false
}

func productionAudioTrackKindValid(kind string) bool {
	switch strings.TrimSpace(kind) {
	case "dialogue", "voiceover", "ambient", "sfx", "music":
		return true
	default:
		return false
	}
}

func productionAudioCapabilityForTrackKind(kind string) string {
	switch strings.TrimSpace(kind) {
	case "dialogue", "voiceover":
		return "tts"
	case "ambient":
		return "ambientSound"
	case "sfx":
		return "soundEffects"
	case "music":
		return "music"
	default:
		return ""
	}
}

func cloneProductionRecord(value map[string]any) map[string]any {
	cloned := make(map[string]any, len(value))
	for key, item := range value {
		cloned[key] = item
	}
	return cloned
}

func productionAudioBindingForStep(manifest map[string]any, stepKey string) (map[string]any, bool) {
	for _, binding := range productionManifestRecords(manifest["audioTrackBindings"]) {
		if strings.TrimSpace(stringValue(binding["stepKey"])) == stepKey {
			return binding, true
		}
	}
	return nil, false
}

func validatePreparedProductionAudioTask(run *model.ProductionRun, step *model.ProductionStep, task *model.Task) error {
	if run == nil || step == nil || task == nil {
		return BadAuthRequest("制作音频任务验证上下文不完整")
	}
	mode, err := normalizeProductionAudioMode(run.AudioMode)
	if err != nil {
		return productionConflict("ProductionRun audioMode 无效")
	}
	input := decodeMap(task.InputJSON)
	requestMode := strings.ToLower(strings.TrimSpace(stringValue(input["mode"])))
	if requestMode == "audio" {
		if mode != model.ProductionAudioModeRebuild || step.Kind != "audio" {
			return productionConflict("NATIVE_AUDIO 不允许独立 TTS 或音效任务")
		}
		manifest, _ := decodeMap(run.PlanJSON)["executionManifest"].(map[string]any)
		binding, ok := productionAudioBindingForStep(manifest, step.StepKey)
		if !ok {
			return productionConflict("音频任务没有对应 ProductionPlan 音轨")
		}
		if !productionPreparedTaskMatchesModel(input, binding) {
			return productionConflict("实际音频任务模型与分镜音轨绑定不一致")
		}
		if expected := strings.TrimSpace(stringValue(binding["capabilityRevision"])); expected == "" || expected != task.CapabilityRevision {
			return productionConflict("实际音频模型能力版本与 Voice Router 锁定版本不一致")
		}
		config, _ := input["config"].(map[string]any)
		capabilityConfig, _ := config["capabilityConfig"].(map[string]any)
		audio, _ := capabilityConfig["audio"].(map[string]any)
		kind := strings.TrimSpace(stringValue(binding["kind"]))
		feature := productionAudioCapabilityForTrackKind(kind)
		if feature == "" {
			return productionConflict("制作音轨用途无效，不能通过通用 TTS 路由")
		}
		if stringValue(audio[feature]) != "configured" {
			return productionConflict("音频模型能力目录未声明当前音轨用途：" + feature)
		}
		strategy := strings.TrimSpace(stringValue(binding["voiceStrategy"]))
		if (kind == "dialogue" || kind == "voiceover") && strategy != "voice_reference" {
			voiceID := strings.TrimSpace(stringValue(binding["voiceId"]))
			if voiceID == "" {
				return productionConflict("对白/旁白没有绑定 VoiceVersion 或能力目录默认 Voice ID")
			}
			voiceIDs := productionManifestStrings(audio["voiceIds"])
			defaultVoiceID := strings.TrimSpace(stringValue(audio["defaultVoiceId"]))
			voiceIDParameter := strings.TrimSpace(stringValue(audio["voiceIdParameter"]))
			if len(voiceIDs) > 0 && !productionStringSliceContains(voiceIDs, voiceID) {
				return productionConflict("对白/旁白 Voice ID 不在当前模型能力目录中")
			}
			if len(voiceIDs) == 0 && voiceID != defaultVoiceID && voiceIDParameter == "" {
				return productionConflict("当前音频模型未声明可路由该 Voice ID 的能力目录参数")
			}
		}
		if strategy == "voice_design" && (stringValue(audio["voiceDesign"]) != "configured" || strings.TrimSpace(stringValue(audio["voiceIdParameter"])) == "") {
			return productionConflict("音频模型没有配置 voice design / voice ID 参数")
		}
		if strategy == "voice_reference" && (stringValue(audio["voiceReference"]) != "configured" || strings.TrimSpace(stringValue(audio["referenceAudioParameter"])) == "") {
			return productionConflict("音频模型没有配置参考声音能力 / 上游参数")
		}
		if strings.TrimSpace(stringValue(binding["voiceId"])) != "" && strategy != "standard_tts" && strings.TrimSpace(stringValue(audio["voiceIdParameter"])) == "" {
			return productionConflict("VoiceVersion 提供了 voiceId，但该模型没有声明 voiceIdParameter")
		}
		if strings.TrimSpace(stringValue(binding["referenceAudioResourceId"])) != "" && strings.TrimSpace(stringValue(audio["referenceAudioParameter"])) == "" {
			return productionConflict("VoiceVersion 提供了参考声音，但该模型没有声明 referenceAudioParameter")
		}
		if prompt := strings.TrimSpace(stringValue(binding["text"])); prompt != "" && strings.TrimSpace(task.Prompt) != prompt {
			return productionConflict("音频任务对白与已锁定的分镜音轨文本不一致")
		}
		for _, item := range []struct{ field, parameter string }{
			{"tone", "toneParameter"}, {"emotionStyle", "emotionStyleParameter"},
			{"language", "languageParameter"}, {"accent", "accentParameter"},
		} {
			if strings.TrimSpace(stringValue(binding[item.field])) != "" && strings.TrimSpace(stringValue(audio[item.parameter])) == "" {
				return productionConflict("VoiceVersion 包含 " + item.field + "，但音频模型没有声明对应上游参数")
			}
		}
		if binding["speakingRate"] != nil && parseFloat(stringValue(binding["speakingRate"]), 1) != 1 && strategy != "standard_tts" && strings.TrimSpace(stringValue(audio["speakingRateParameter"])) == "" {
			return productionConflict("VoiceVersion 包含语速，但音频模型没有声明 speakingRateParameter")
		}
	} else if requestMode == "video" {
		if step.Kind != "video" {
			return productionConflict("ProductionStep 类型与视频生成任务不匹配")
		}
		config, _ := input["config"].(map[string]any)
		want := "false"
		if mode == model.ProductionAudioModeNative {
			manifest, _ := decodeMap(run.PlanJSON)["executionManifest"].(map[string]any)
			selection, ok := productionSelectedSegment(manifest, step.StoryboardRowID, step.SegmentID)
			if !ok {
				return productionConflict("视频任务没有对应的分镜行/片段能力声明")
			}
			if boolValue(selection["generateAudio"]) {
				want = "true"
				if !boolValue(selection["supportsNativeAudio"]) {
					return productionConflict("ProductionPlan 选择了不支持原生音频的视频模型")
				}
			}
		}
		if strings.ToLower(strings.TrimSpace(stringValue(config["videoGenerateAudio"]))) != want {
			return productionConflict("视频任务原生音轨开关与分镜能力计划不一致")
		}
	} else if step.Kind == "audio" || step.Kind == "video" || mode == model.ProductionAudioModeNative && strings.Contains(strings.ToLower(task.Type), "audio") {
		return productionConflict("ProductionRun 音频模式与任务类型冲突")
	}
	return nil
}

func productionStringSliceContains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func productionVoiceProfileAllowsModel(profile *model.VoiceProfile, selectedModel string) bool {
	if profile == nil {
		return false
	}
	raw := strings.TrimSpace(profile.CompatibleModelsJSON)
	if raw == "" {
		return true
	}
	var compatibleModels []string
	if err := json.Unmarshal([]byte(raw), &compatibleModels); err != nil {
		return false
	}
	return len(compatibleModels) == 0 || productionStringSliceContains(compatibleModels, selectedModel)
}

func productionPreparedTaskMatchesModel(input, binding map[string]any) bool {
	configured := strings.TrimSpace(stringValue(binding["model"]))
	if configured == "" {
		return false
	}
	config, _ := input["config"].(map[string]any)
	if channel, modelKey, found := strings.Cut(configured, "::"); found {
		return strings.TrimSpace(stringValue(config["channelId"])) == channel && strings.TrimSpace(stringValue(config["channelModelKey"])) == modelKey
	}
	return strings.TrimSpace(stringValue(config["channelModelKey"])) == configured || strings.TrimSpace(stringValue(config["model"])) == configured
}

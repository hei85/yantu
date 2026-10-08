package app

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

var fullFilmStageKeys = []string{
	"stage:brief", "stage:script_breakdown", "stage:visual_design", "stage:rough_storyboard",
	"stage:asset_package", "stage:sound_plan", "stage:locked_storyboard", "stage:pilot", "stage:postproduction",
}

func productionWorkflowVersion(plan map[string]any) (int64, int64) {
	spec := productionRecord(plan["productionSpec"])
	manifest := productionRecord(plan["executionManifest"])
	return int64Value(spec["workflowVersion"]), int64Value(manifest["workflowVersion"])
}

// validateProductionWorkflowPlan is deliberately opt-in: legacy ProductionRuns
// and ordinary canvas tasks keep their existing behavior. The official new
// full-film path stamps v2 into both the persisted spec and execution manifest.
func validateProductionWorkflowPlan(plan map[string]any, steps []ProductionStepInput, targetDurationMs int64, fpsNumerator, fpsDenominator int) error {
	specVersion, manifestVersion := productionWorkflowVersion(plan)
	if specVersion != 2 && manifestVersion != 2 {
		return nil
	}
	if specVersion != 2 || manifestVersion != 2 {
		return fmt.Errorf("全片流程版本必须同时在 productionSpec 与 executionManifest 中声明为 2")
	}
	if len(steps) == 0 {
		return fmt.Errorf("workflowVersion 2 全片计划缺少阶段步骤")
	}
	productionSpec := productionRecord(plan["productionSpec"])
	preproduction := productionRecord(productionSpec["preproduction"])
	manifest := productionRecord(plan["executionManifest"])
	if err := validateFullFilmPreproduction(preproduction, productionSpec, manifest, targetDurationMs, fpsNumerator, fpsDenominator); err != nil {
		return err
	}

	stepByKey := make(map[string]ProductionStepInput, len(steps))
	for _, step := range steps {
		stepByKey[strings.TrimSpace(step.StepKey)] = step
	}
	contracts := productionManifestRecords(manifest["stageContracts"])
	if len(contracts) != len(fullFilmStageKeys) {
		return fmt.Errorf("workflowVersion 2 必须包含完整的 9 项阶段合同")
	}
	contractByKey := make(map[string]map[string]any, len(contracts))
	for _, contract := range contracts {
		key := strings.TrimSpace(stringValue(contract["stepKey"]))
		if key == "" || contractByKey[key] != nil {
			return fmt.Errorf("阶段合同 stepKey 缺失或重复：%s", key)
		}
		contractByKey[key] = contract
	}
	for _, key := range fullFilmStageKeys {
		step, ok := stepByKey[key]
		if !ok || step.Kind != "check" {
			return fmt.Errorf("workflowVersion 2 缺少阶段检查步骤 %s", key)
		}
		contract, ok := contractByKey[key]
		if !ok || strings.TrimSpace(stringValue(contract["inputFingerprint"])) == "" || contract["inputFingerprint"] != step.InputFingerprint {
			return fmt.Errorf("阶段 %s 的 inputFingerprint 与执行计划不一致", key)
		}
		wantArtifacts, wantInputs := fullFilmStageArtifactRefs(key, preproduction)
		if !sameProductionArtifactRefs(productionManifestRecords(contract["artifactRefs"]), wantArtifacts) ||
			!sameProductionArtifactRefs(productionManifestRecords(contract["inputArtifactRefs"]), wantInputs) {
			return fmt.Errorf("阶段 %s 的 artifact/version 引用与 preproduction 不一致", key)
		}
		if err := validateStageContractDetails(key, contract, preproduction); err != nil {
			return err
		}
	}

	for key, dependencies := range map[string][]string{
		"stage:script_breakdown":  {"stage:brief"},
		"stage:visual_design":     {"stage:script_breakdown"},
		"stage:rough_storyboard":  {"stage:script_breakdown"},
		"stage:asset_package":     {"stage:visual_design", "stage:rough_storyboard"},
		"stage:sound_plan":        {"stage:script_breakdown", "stage:visual_design", "stage:rough_storyboard"},
		"stage:locked_storyboard": {"stage:rough_storyboard", "stage:asset_package", "stage:sound_plan"},
		"stage:pilot":             {"stage:locked_storyboard", "stage:asset_package", "stage:sound_plan"},
		"stage:postproduction":    {"timeline:master", "quality:full-film"},
	} {
		if err := requireProductionDependencies(stepByKey, key, dependencies); err != nil {
			return err
		}
	}

	sharedAssets := productionManifestRecords(productionSpec["sharedAssets"])
	assetIDs := make([]string, 0, len(sharedAssets))
	generatedAssetKeys := make([]string, 0, len(sharedAssets))
	for _, asset := range sharedAssets {
		assetID := strings.TrimSpace(stringValue(asset["assetId"]))
		if assetID == "" {
			return fmt.Errorf("共享资产缺少 assetId")
		}
		assetIDs = append(assetIDs, assetID)
		if boolValue(asset["generate"]) {
			assetKey := "asset:" + productionSafePlanKey(assetID)
			assetStep, ok := stepByKey[assetKey]
			if !ok || assetStep.Kind != "image" {
				return fmt.Errorf("资产 %s 缺少真实生成步骤 %s", assetID, assetKey)
			}
			if err := requireProductionDependencies(stepByKey, assetKey, []string{"stage:visual_design", "stage:rough_storyboard"}); err != nil {
				return err
			}
			generatedAssetKeys = append(generatedAssetKeys, assetKey)
		} else if strings.TrimSpace(stringValue(asset["assetVersionId"])) == "" || strings.TrimSpace(stringValue(asset["resourceId"])) == "" {
			return fmt.Errorf("复用资产 %s 缺少 assetVersionId/resourceId", assetID)
		}
	}
	if !sameStringSet(productionManifestStrings(productionRecord(preproduction["assetPackage"])["assetIds"]), assetIDs) {
		return fmt.Errorf("assetPackage.assetIds 必须准确覆盖 sharedAssets")
	}
	if err := requireProductionDependencies(stepByKey, "stage:asset_package", generatedAssetKeys); err != nil {
		return err
	}

	rowIDs := productionManifestStrings(productionRecord(preproduction["lockedStoryboard"])["rowIds"])
	if !sameOrderedStrings(productionManifestStrings(manifest["lockedStoryboardRowIds"]), rowIDs) ||
		!sameOrderedStrings(productionManifestStrings(manifest["pilotRowIds"]), productionManifestStrings(productionRecord(preproduction["pilot"])["sampleRowIds"])) {
		return fmt.Errorf("executionManifest 的锁定分镜/样片行 ID 与 preproduction 不一致")
	}
	for _, rowID := range rowIDs {
		key := "storyboard:" + productionSafePlanKey(rowID)
		rowCheck, ok := stepByKey[key]
		if !ok || rowCheck.Kind != "check" || rowCheck.StoryboardRowID != rowID {
			return fmt.Errorf("锁定分镜行 %s 缺少对应的 storyboard check", rowID)
		}
		if err := requireProductionDependencies(stepByKey, key, []string{"stage:locked_storyboard"}); err != nil {
			return err
		}
	}

	pilotRows := productionManifestStrings(productionRecord(preproduction["pilot"])["sampleRowIds"])
	if err := validateFullFilmPilotDependencies(stepByKey, pilotRows); err != nil {
		return err
	}
	for _, step := range steps {
		if step.Kind != "video" && step.Kind != "reuse_media" {
			continue
		}
		if step.StoryboardRowID == "" {
			return fmt.Errorf("全片视频步骤 %s 缺少 storyboardRowId", step.StepKey)
		}
		for _, gate := range []string{"stage:asset_package", "stage:sound_plan", "stage:locked_storyboard"} {
			if !containsString(step.DependsOn, gate) {
				return fmt.Errorf("全片视频步骤 %s 必须直接依赖 %s", step.StepKey, gate)
			}
		}
		isPilot := containsString(pilotRows, step.StoryboardRowID)
		if isPilot && containsString(step.DependsOn, "stage:pilot") {
			return fmt.Errorf("样片步骤 %s 不能依赖自身的 stage:pilot 门", step.StepKey)
		}
		if !isPilot && !containsString(step.DependsOn, "stage:pilot") {
			return fmt.Errorf("非样片视频步骤 %s 必须直接依赖 stage:pilot", step.StepKey)
		}
	}
	if err := requireProductionDependencies(stepByKey, "timeline:master", []string{"stage:pilot"}); err != nil {
		return err
	}
	if err := requireProductionDependencies(stepByKey, "delivery:contract", []string{"stage:postproduction"}); err != nil {
		return err
	}
	return nil
}

func validateFullFilmPreproduction(preproduction, spec, manifest map[string]any, targetDurationMs int64, fpsNumerator, fpsDenominator int) error {
	for _, key := range []string{"sourceScript", "brief", "scriptBreakdown", "visualDesign", "roughStoryboard", "assetPackage", "soundPlan", "lockedStoryboard", "pilot"} {
		if err := validateProductionArtifactRef(productionRecord(preproduction[key]), "preproduction."+key); err != nil {
			return err
		}
	}
	rows := productionManifestRecords(spec["storyboardRows"])
	if len(rows) == 0 {
		return fmt.Errorf("workflowVersion 2 缺少正式 storyboardRows")
	}
	rowIDs := make([]string, 0, len(rows))
	seenRows := map[string]bool{}
	for _, row := range rows {
		rowID := strings.TrimSpace(stringValue(row["rowId"]))
		if rowID == "" || seenRows[rowID] {
			return fmt.Errorf("正式分镜行 rowId 缺失或重复")
		}
		seenRows[rowID] = true
		rowIDs = append(rowIDs, rowID)
	}
	for _, key := range []string{"roughStoryboard", "lockedStoryboard"} {
		if !sameOrderedStrings(productionManifestStrings(productionRecord(preproduction[key])["rowIds"]), rowIDs) {
			return fmt.Errorf("preproduction.%s.rowIds 必须与 productionSpec.storyboardRows 顺序完全一致", key)
		}
	}
	assets := productionManifestRecords(spec["sharedAssets"])
	assetIDs := make([]string, 0, len(assets))
	seenAssets := map[string]bool{}
	for _, asset := range assets {
		assetID := strings.TrimSpace(stringValue(asset["assetId"]))
		if assetID == "" || seenAssets[assetID] {
			return fmt.Errorf("sharedAssets.assetId 缺失或重复")
		}
		seenAssets[assetID] = true
		assetIDs = append(assetIDs, assetID)
	}
	if !sameStringSet(productionManifestStrings(productionRecord(preproduction["assetPackage"])["assetIds"]), assetIDs) {
		return fmt.Errorf("preproduction.assetPackage.assetIds 必须准确覆盖 sharedAssets")
	}
	if fpsNumerator <= 0 || fpsDenominator <= 0 || targetDurationMs <= 0 {
		return fmt.Errorf("workflowVersion 2 缺少有效的 Brief 目标时长/帧率")
	}
	targetFrames := int64(math.Round(float64(targetDurationMs) * float64(fpsNumerator) / (1000 * float64(fpsDenominator))))
	lockedFrames := int64Value(productionRecord(preproduction["lockedStoryboard"])["durationFrames"])
	if targetFrames <= 0 || lockedFrames != targetFrames {
		return fmt.Errorf("锁定分镜 durationFrames 必须严格等于 Brief 目标帧数 %d", targetFrames)
	}
	timebase := productionRecord(manifest["timelineTimebase"])
	if int64Value(timebase["totalFrames"]) != targetFrames || int64Value(timebase["fpsNumerator"]) != int64(fpsNumerator) || int64Value(timebase["fpsDenominator"]) != int64(fpsDenominator) {
		return fmt.Errorf("executionManifest timelineTimebase 必须严格匹配锁定分镜和目标帧率")
	}
	if manifestDuration := int64Value(manifest["targetDurationMs"]); manifestDuration != targetDurationMs {
		return fmt.Errorf("executionManifest.targetDurationMs 与正式 Brief 不一致")
	}
	pilotRows := productionManifestStrings(productionRecord(preproduction["pilot"])["sampleRowIds"])
	if len(pilotRows) == 0 || hasDuplicateStrings(pilotRows) {
		return fmt.Errorf("preproduction.pilot.sampleRowIds 必须动态选择一个或多个唯一分镜行")
	}
	for _, rowID := range pilotRows {
		if !seenRows[rowID] {
			return fmt.Errorf("样片行 %s 不在锁定分镜中", rowID)
		}
	}
	voiceIDs := make([]string, 0)
	for _, row := range rows {
		for _, character := range productionManifestRecords(row["characters"]) {
			if voiceID := strings.TrimSpace(stringValue(character["voiceVersionId"])); voiceID != "" {
				voiceIDs = append(voiceIDs, voiceID)
			}
		}
		for _, track := range productionManifestRecords(row["audioTracks"]) {
			if voiceID := strings.TrimSpace(stringValue(track["voiceVersionId"])); voiceID != "" {
				voiceIDs = append(voiceIDs, voiceID)
			}
		}
	}
	if !sameStringSet(productionManifestStrings(productionRecord(preproduction["soundPlan"])["voiceVersionIds"]), uniqueProductionStrings(voiceIDs)) {
		return fmt.Errorf("preproduction.soundPlan.voiceVersionIds 必须准确覆盖分镜中的 VoiceVersion")
	}
	return nil
}

func validateProductionArtifactRef(ref map[string]any, label string) error {
	for _, field := range []string{"artifactId", "versionId", "inputFingerprint", "outputFingerprint"} {
		if strings.TrimSpace(stringValue(ref[field])) == "" {
			return fmt.Errorf("%s 缺少 %s", label, field)
		}
	}
	return nil
}

func fullFilmStageArtifactRefs(stageKey string, preproduction map[string]any) ([]map[string]any, []map[string]any) {
	refs := map[string]map[string]any{
		"sourceScript": productionRecord(preproduction["sourceScript"]), "brief": productionRecord(preproduction["brief"]),
		"scriptBreakdown": productionRecord(preproduction["scriptBreakdown"]), "visualDesign": productionRecord(preproduction["visualDesign"]),
		"roughStoryboard": productionRecord(preproduction["roughStoryboard"]), "assetPackage": productionRecord(preproduction["assetPackage"]),
		"soundPlan": productionRecord(preproduction["soundPlan"]), "lockedStoryboard": productionRecord(preproduction["lockedStoryboard"]),
		"pilot": productionRecord(preproduction["pilot"]),
	}
	outputs, inputs := map[string][]string{
		"stage:brief": {"brief"}, "stage:script_breakdown": {"scriptBreakdown"}, "stage:visual_design": {"visualDesign"},
		"stage:rough_storyboard": {"roughStoryboard"}, "stage:asset_package": {"assetPackage"}, "stage:sound_plan": {"soundPlan"},
		"stage:locked_storyboard": {"lockedStoryboard"}, "stage:pilot": {"pilot"}, "stage:postproduction": {},
	}, map[string][]string{
		"stage:brief": {"sourceScript"}, "stage:script_breakdown": {"brief"}, "stage:visual_design": {"scriptBreakdown"},
		"stage:rough_storyboard": {"scriptBreakdown"}, "stage:asset_package": {"visualDesign", "roughStoryboard"},
		"stage:sound_plan":        {"scriptBreakdown", "visualDesign", "roughStoryboard"},
		"stage:locked_storyboard": {"roughStoryboard", "assetPackage", "soundPlan"},
		"stage:pilot":             {"lockedStoryboard", "assetPackage", "soundPlan"}, "stage:postproduction": {},
	}
	toRefs := func(keys []string) []map[string]any {
		result := make([]map[string]any, 0, len(keys))
		for _, key := range keys {
			result = append(result, refs[key])
		}
		return result
	}
	return toRefs(outputs[stageKey]), toRefs(inputs[stageKey])
}

func sameProductionArtifactRefs(actual, expected []map[string]any) bool {
	if len(actual) != len(expected) {
		return false
	}
	fields := []string{"artifactId", "versionId", "inputFingerprint", "outputFingerprint"}
	for index := range expected {
		for _, field := range fields {
			if stringValue(actual[index][field]) != stringValue(expected[index][field]) {
				return false
			}
		}
	}
	return true
}

func validateStageContractDetails(stageKey string, contract, preproduction map[string]any) error {
	switch stageKey {
	case "stage:rough_storyboard":
		if !sameOrderedStrings(productionManifestStrings(contract["rowIds"]), productionManifestStrings(productionRecord(preproduction["roughStoryboard"])["rowIds"])) {
			return fmt.Errorf("粗分镜 stageContract.rowIds 与 preproduction 不一致")
		}
	case "stage:asset_package":
		if !sameStringSet(productionManifestStrings(contract["assetIds"]), productionManifestStrings(productionRecord(preproduction["assetPackage"])["assetIds"])) {
			return fmt.Errorf("资产包 stageContract.assetIds 与 preproduction 不一致")
		}
	case "stage:sound_plan":
		if !sameStringSet(productionManifestStrings(contract["voiceVersionIds"]), productionManifestStrings(productionRecord(preproduction["soundPlan"])["voiceVersionIds"])) {
			return fmt.Errorf("声音方案 stageContract.voiceVersionIds 与 preproduction 不一致")
		}
	case "stage:locked_storyboard":
		want := productionRecord(preproduction["lockedStoryboard"])
		if !sameOrderedStrings(productionManifestStrings(contract["rowIds"]), productionManifestStrings(want["rowIds"])) || int64Value(contract["durationFrames"]) != int64Value(want["durationFrames"]) {
			return fmt.Errorf("锁镜 stageContract.rowIds/durationFrames 与 preproduction 不一致")
		}
	case "stage:pilot":
		want := productionManifestStrings(productionRecord(preproduction["pilot"])["sampleRowIds"])
		if !sameOrderedStrings(productionManifestStrings(contract["rowIds"]), want) || !sameOrderedStrings(productionManifestStrings(contract["sampleRowIds"]), want) {
			return fmt.Errorf("pilot stageContract.sampleRowIds 与 preproduction 不一致")
		}
	case "stage:postproduction":
		if stringValue(contract["outputKind"]) != "timeline_master" {
			return fmt.Errorf("后期 stageContract 必须验收 timeline_master")
		}
	}
	return nil
}

func requireProductionDependencies(byKey map[string]ProductionStepInput, stepKey string, required []string) error {
	step, ok := byKey[stepKey]
	if !ok {
		return fmt.Errorf("全片阶段图缺少步骤 %s", stepKey)
	}
	for _, key := range required {
		if !containsString(step.DependsOn, key) {
			return fmt.Errorf("全片阶段 %s 缺少强制依赖 %s", stepKey, key)
		}
	}
	return nil
}

func validateFullFilmPilotDependencies(byKey map[string]ProductionStepInput, pilotRows []string) error {
	for _, rowID := range pilotRows {
		videoKeys := make([]string, 0)
		for _, step := range byKey {
			if (step.Kind == "video" || step.Kind == "reuse_media") && step.StoryboardRowID == rowID {
				videoKeys = append(videoKeys, step.StepKey)
			}
		}
		if len(videoKeys) == 0 {
			return fmt.Errorf("样片行 %s 没有视频/复用媒体步骤", rowID)
		}
		for _, required := range []string{"quality:shot:" + productionSafePlanKey(rowID), "continuity:" + productionSafePlanKey(rowID)} {
			check, ok := byKey[required]
			if !ok || check.Kind != "check" || check.StoryboardRowID != rowID {
				return fmt.Errorf("样片行 %s 缺少 QC 检查 %s", rowID, required)
			}
			for _, videoKey := range videoKeys {
				if !containsString(check.DependsOn, videoKey) {
					return fmt.Errorf("样片 QC %s 缺少视频依赖 %s", required, videoKey)
				}
			}
			if err := requireProductionDependencies(byKey, "stage:pilot", []string{required}); err != nil {
				return err
			}
		}
		audioKeys := make([]string, 0)
		for _, step := range byKey {
			if step.Kind == "audio" && step.StoryboardRowID == rowID {
				audioKeys = append(audioKeys, step.StepKey)
			}
		}
		if len(audioKeys) > 0 {
			audioCheckKey := "quality:pilot-audio:" + productionSafePlanKey(rowID)
			audioCheck, ok := byKey[audioCheckKey]
			if !ok || audioCheck.Kind != "check" || audioCheck.StoryboardRowID != rowID {
				return fmt.Errorf("样片行 %s 有声音步骤但缺少音频 QC", rowID)
			}
			for _, audioKey := range audioKeys {
				if !containsString(audioCheck.DependsOn, audioKey) {
					return fmt.Errorf("样片音频 QC %s 缺少音频依赖 %s", audioCheckKey, audioKey)
				}
			}
			if err := requireProductionDependencies(byKey, "stage:pilot", []string{audioCheckKey}); err != nil {
				return err
			}
		}
	}
	return nil
}

func productionSafePlanKey(value string) string {
	var output strings.Builder
	lastDash := false
	for _, char := range strings.TrimSpace(value) {
		allowed := char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char == '_' || char == '.' || char == '-'
		if allowed {
			output.WriteRune(char)
			lastDash = false
		} else if !lastDash {
			output.WriteByte('-')
			lastDash = true
		}
	}
	return strings.Trim(output.String(), "-")
}

func sameOrderedStrings(actual, expected []string) bool {
	if len(actual) != len(expected) {
		return false
	}
	for index := range expected {
		if actual[index] != expected[index] {
			return false
		}
	}
	return true
}

func sameStringSet(actual, expected []string) bool {
	if len(actual) != len(expected) || hasDuplicateStrings(actual) {
		return false
	}
	a, b := append([]string(nil), actual...), append([]string(nil), expected...)
	sort.Strings(a)
	sort.Strings(b)
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}

func hasDuplicateStrings(values []string) bool {
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		if value == "" || seen[value] {
			return true
		}
		seen[value] = true
	}
	return false
}

func productionStepInputs(steps []model.ProductionStep) []ProductionStepInput {
	result := make([]ProductionStepInput, 0, len(steps))
	for _, step := range steps {
		result = append(result, ProductionStepInput{
			StepKey: step.StepKey, Kind: step.Kind, SceneID: step.SceneID, ShotID: step.ShotID,
			StoryboardRowID: step.StoryboardRowID, SegmentID: step.SegmentID, SegmentOrder: step.SegmentOrder,
			TrackID: step.TrackID, DependsOn: decodeStringList(step.DependsOnJSON), InputFingerprint: step.InputFingerprint,
			SelectedStrategyID: step.SelectedStrategyID, EstimatedCostMicros: step.EstimatedCostMicros,
		})
	}
	return result
}

func validateFullFilmStageEvidence(repo *repository.Repository, run *model.ProductionRun, step *model.ProductionStep, evidence map[string]any) (string, error) {
	specVersion, manifestVersion := productionWorkflowVersion(decodeMap(run.PlanJSON))
	if specVersion != 2 && manifestVersion != 2 {
		return "", nil
	}
	if specVersion != 2 || manifestVersion != 2 {
		return "", fmt.Errorf("workflowVersion 2 阶段证据与 ProductionSpec 不一致")
	}
	if !strings.HasPrefix(step.StepKey, "stage:") {
		return "", nil
	}
	plan := decodeMap(run.PlanJSON)
	preproduction := productionRecord(productionRecord(plan["productionSpec"])["preproduction"])
	manifest := productionRecord(plan["executionManifest"])
	var contract map[string]any
	for _, item := range productionManifestRecords(manifest["stageContracts"]) {
		if stringValue(item["stepKey"]) == step.StepKey {
			contract = item
			break
		}
	}
	if contract == nil {
		return "", fmt.Errorf("持久计划缺少 %s 阶段合同", step.StepKey)
	}
	stage := productionRecord(evidence["stageEvidence"])
	if int64Value(stage["workflowVersion"]) != 2 || stringValue(stage["stageKey"]) != step.StepKey || stringValue(stage["inputFingerprint"]) != step.InputFingerprint {
		return "", fmt.Errorf("stageEvidence 的 workflowVersion/stageKey/inputFingerprint 与当前步骤不一致")
	}
	wantArtifacts, wantInputs := fullFilmStageArtifactRefs(step.StepKey, preproduction)
	artifactRefsMatch := sameProductionArtifactRefs(productionManifestRecords(stage["artifacts"]), wantArtifacts)
	if step.StepKey == "stage:postproduction" {
		artifactRefsMatch = len(productionManifestRecords(stage["artifacts"])) > 0
	}
	if !artifactRefsMatch || !sameProductionArtifactRefs(productionManifestRecords(stage["inputArtifacts"]), wantInputs) {
		return "", fmt.Errorf("%s 的阶段产物或输入 artifact/version 引用与锁定计划不一致", step.StepKey)
	}
	if rowIds, ok := contract["rowIds"]; ok && !sameOrderedStrings(productionManifestStrings(stage["rowIds"]), productionManifestStrings(rowIds)) {
		return "", fmt.Errorf("%s 的 rowIds 与锁定阶段计划不一致", step.StepKey)
	}
	if frames, ok := contract["durationFrames"]; ok && int64Value(stage["durationFrames"]) != int64Value(frames) {
		return "", fmt.Errorf("锁镜阶段证据 durationFrames 与目标帧数不一致")
	}
	if assetIDs, ok := contract["assetIds"]; ok && !sameStringSet(productionManifestStrings(stage["assetIds"]), productionManifestStrings(assetIDs)) {
		return "", fmt.Errorf("资产验收 evidence.assetIds 与锁定资产包不一致")
	}
	if voiceIDs, ok := contract["voiceVersionIds"]; ok && !sameStringSet(productionManifestStrings(stage["voiceVersionIds"]), productionManifestStrings(voiceIDs)) {
		return "", fmt.Errorf("声音方案 voiceVersionIds 与锁定版本不一致")
	}
	if sampleRows, ok := contract["sampleRowIds"]; ok && !sameOrderedStrings(productionManifestStrings(stage["sampleRowIds"]), productionManifestStrings(sampleRows)) {
		return "", fmt.Errorf("样片 sampleRowIds 与锁定计划不一致")
	}
	if step.StepKey == "stage:asset_package" {
		if err := validateFullFilmAssetOutputs(repo, run, plan, step, stage); err != nil {
			return "", err
		}
	}
	if step.StepKey == "stage:pilot" {
		if err := validateFullFilmPilotOutputs(repo, run, step, stage); err != nil {
			return "", err
		}
	}
	if step.StepKey == "stage:postproduction" {
		if err := validateFullFilmPostproductionOutputs(repo, run, step, stage); err != nil {
			return "", err
		}
	}
	semantic := productionRecord(evidence["semanticQuality"])
	status := strings.TrimSpace(stringValue(semantic["status"]))
	if status == "failed" {
		return "failed", nil
	}
	if status != "passed" && status != "uncertain" && status != "unavailable" {
		return "uncertain", nil
	}
	if status != "passed" || strings.TrimSpace(stringValue(semantic["model"])) == "" || strings.TrimSpace(stringValue(semantic["summary"])) == "" {
		return "uncertain", nil
	}
	return "passed", nil
}

func validateFullFilmAssetOutputs(repo *repository.Repository, run *model.ProductionRun, plan map[string]any, step *model.ProductionStep, stage map[string]any) error {
	assets := productionManifestRecords(productionRecord(plan["productionSpec"])["sharedAssets"])
	outputs := productionManifestRecords(stage["assetOutputs"])
	if len(outputs) != len(assets) {
		return fmt.Errorf("资产验收必须逐项提供 sharedAssets 的实际版本/resource 输出")
	}
	byAsset := make(map[string]map[string]any, len(outputs))
	for _, output := range outputs {
		assetID := strings.TrimSpace(stringValue(output["assetId"]))
		if assetID == "" || byAsset[assetID] != nil {
			return fmt.Errorf("资产验收 assetOutputs 的 assetId 缺失或重复")
		}
		byAsset[assetID] = output
	}
	for _, asset := range assets {
		assetID := strings.TrimSpace(stringValue(asset["assetId"]))
		output := byAsset[assetID]
		if output == nil {
			return fmt.Errorf("资产验收缺少资产 %s", assetID)
		}
		resourceID := strings.TrimSpace(stringValue(output["resourceId"]))
		if resourceID == "" {
			return fmt.Errorf("资产 %s 缺少实际 resourceId", assetID)
		}
		if boolValue(asset["generate"]) {
			assetStep, err := repo.ProductionStepByKey(run.ID, "asset:"+productionSafePlanKey(assetID))
			if err != nil || assetStep.Status != "succeeded" || !containsString(decodeStringList(assetStep.OutputArtifactJSON), resourceID) {
				return fmt.Errorf("资产 %s 的 resourceId 未出现在成功生成步骤的服务端输出中", assetID)
			}
		} else {
			assetVersionID := strings.TrimSpace(stringValue(asset["assetVersionId"]))
			if stringValue(output["assetVersionId"]) != assetVersionID || stringValue(output["resourceId"]) != stringValue(asset["resourceId"]) {
				return fmt.Errorf("复用资产 %s 的 assetVersionId/resourceId 与计划不一致", assetID)
			}
			var version *model.AssetVersion
			var err error
			if run.DomainProjectID != "" {
				version, err = repo.AssetVersionForProject(run.DomainProjectID, assetVersionID)
			} else {
				version, err = repo.AssetVersion(assetVersionID)
			}
			if err != nil || version.AssetID != assetID || version.Status != model.AssetVersionStatusConfirmed {
				return fmt.Errorf("复用资产 %s 的版本不存在、未确认或不属于该 assetId", assetID)
			}
			assetModel, assetErr := repo.AssetForUser(run.UserID, assetID)
			if assetErr != nil || assetModel.UserID != run.UserID {
				return fmt.Errorf("复用资产 %s 不属于当前用户", assetID)
			}
			if _, err := repo.ResourceForUser(run.UserID, resourceID); err != nil {
				return fmt.Errorf("复用资产 %s 的 resourceId 不属于当前用户", assetID)
			}
			representations, repErr := repo.AssetRepresentations(assetVersionID)
			found := false
			for _, representation := range representations {
				if representation.ResourceID == resourceID {
					found = true
					break
				}
			}
			if repErr != nil || !found {
				return fmt.Errorf("复用资产 %s 的 resourceId 未绑定到指定 AssetVersion", assetID)
			}
		}
		resource, err := repo.ResourceForUser(run.UserID, resourceID)
		if err != nil || resource.Status != model.ResourceStatusReady || resource.Kind != "image" {
			return fmt.Errorf("资产 %s 的资源尚未就绪或不是图片", assetID)
		}
	}
	return nil
}

func validateFullFilmPilotOutputs(repo *repository.Repository, run *model.ProductionRun, _ *model.ProductionStep, stage map[string]any) error {
	outputs := productionManifestRecords(stage["mediaArtifacts"])
	if len(outputs) == 0 {
		return fmt.Errorf("pilot 阶段必须引用实际样片视频输出")
	}
	steps, err := repo.ProductionSteps(run.ID)
	if err != nil {
		return err
	}
	actual := map[string]bool{}
	for _, step := range steps {
		if (step.Kind != "video" && step.Kind != "reuse_media") || step.Status != "succeeded" || step.StoryboardRowID == "" {
			continue
		}
		for _, resourceID := range decodeStringList(step.OutputArtifactJSON) {
			actual[step.StoryboardRowID+"\x00"+step.SegmentID+"\x00"+resourceID] = true
		}
	}
	seen := map[string]bool{}
	for _, output := range outputs {
		rowID := strings.TrimSpace(stringValue(output["storyboardRowId"]))
		segmentID := strings.TrimSpace(stringValue(output["segmentId"]))
		resourceID := strings.TrimSpace(stringValue(output["resourceId"]))
		key := rowID + "\x00" + segmentID + "\x00" + resourceID
		if rowID == "" || segmentID == "" || resourceID == "" || !actual[key] || seen[key] {
			return fmt.Errorf("pilot mediaArtifacts 必须逐项对应成功分镜/片段步骤的实际 resource 输出")
		}
		if _, err := repo.ResourceForUser(run.UserID, resourceID); err != nil {
			return fmt.Errorf("样片 resourceId 不属于当前用户")
		}
		seen[key] = true
	}
	return nil
}

func validateFullFilmPostproductionOutputs(repo *repository.Repository, run *model.ProductionRun, _ *model.ProductionStep, stage map[string]any) error {
	outputs := productionManifestRecords(stage["artifacts"])
	if len(outputs) == 0 {
		return fmt.Errorf("后期阶段必须引用 timeline:master 的实际输出版本")
	}
	timelineStep, err := repo.ProductionStepByKey(run.ID, "timeline:master")
	if err != nil {
		return err
	}
	actual := decodeStringList(timelineStep.OutputArtifactJSON)
	for _, output := range outputs {
		resourceID := strings.TrimSpace(stringValue(output["versionId"]))
		if stringValue(output["artifactId"]) != "timeline:master" || stringValue(output["inputFingerprint"]) != timelineStep.InputFingerprint ||
			strings.TrimSpace(stringValue(output["outputFingerprint"])) == "" || !containsString(actual, resourceID) {
			return fmt.Errorf("后期 artifact/version 未与 timeline:master 的真实输出绑定")
		}
		resource, err := repo.ResourceForUser(run.UserID, resourceID)
		if err != nil || resource.Status != model.ResourceStatusReady || resource.Kind != "video" {
			return fmt.Errorf("后期阶段引用的成片资源尚未就绪或不属于当前用户")
		}
	}
	return nil
}

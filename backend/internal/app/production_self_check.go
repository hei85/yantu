package app

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"
)

// Validate coverage against real outputs, not the requester's list of checked resources.
// Content observations still come from an actual reviewer; this gate never invents them.
func validateProductionSelfCheckEvidence(repo *repository.Repository, run *model.ProductionRun, step *model.ProductionStep, evidence map[string]any) (string, error) {
	manifest := productionRecord(decodeMap(run.PlanJSON)["executionManifest"])
	if int64Value(manifest["selfCheckVersion"]) != 1 {
		return "", nil
	}
	var contract map[string]any
	for _, item := range productionManifestRecords(manifest["selfCheckContracts"]) {
		if stringValue(item["stepKey"]) == step.StepKey {
			contract = item
			break
		}
	}
	if contract == nil {
		if strings.HasPrefix(step.StepKey, "quality:shot:") || strings.HasPrefix(step.StepKey, "continuity:") || strings.HasPrefix(step.StepKey, "storyboard:") || step.StepKey == "stage:asset_package" || step.StepKey == "quality:full-film" {
			return "", fmt.Errorf("当前自检计划缺少 %s 的逐资源合同", step.StepKey)
		}
		return "", nil
	}
	resourceIDs := productionManifestStrings(contract["resourceIds"])
	for _, key := range productionManifestStrings(contract["sourceStepKeys"]) {
		source, err := repo.ProductionStepByKey(run.ID, key)
		if err != nil || source.Superseded || source.Status != "succeeded" {
			return "", fmt.Errorf("自检引用的实际输出步骤 %s 尚未成功", key)
		}
		outputs := decodeStringList(source.OutputArtifactJSON)
		if len(outputs) == 0 {
			return "", fmt.Errorf("自检引用步骤 %s 没有真实资源输出", key)
		}
		resourceIDs = append(resourceIDs, outputs...)
	}
	durations := map[string]int64{}
	for _, id := range resourceIDs {
		resource, err := repo.ResourceForUser(run.UserID, id)
		if err != nil || resource.UserID != run.UserID || resource.Status != model.ResourceStatusReady {
			return "", fmt.Errorf("自检资源 %s 不属于当前用户或未就绪", id)
		}
		durations[id] = resource.DurationMs
	}
	return evaluateProductionSelfCheckCoverage(contract, step.InputFingerprint, durations, evidence)
}

func evaluateProductionSelfCheckCoverage(contract map[string]any, fingerprint string, durations map[string]int64, evidence map[string]any) (string, error) {
	minSamples, err := selfCheckSampleTime(contract["minSamples"])
	if err != nil || minSamples < 1 || minSamples > 200 || len(productionManifestStrings(contract["requiredChecks"])) == 0 {
		return "", fmt.Errorf("自检合同缺少有效检查项或抽帧数量")
	}
	if stringValue(evidence["inputFingerprint"]) != fingerprint {
		return "", fmt.Errorf("自检证据 inputFingerprint 与当前步骤不一致")
	}
	reviews := map[string]map[string]any{}
	for _, item := range productionManifestRecords(evidence["reviewedMedia"]) {
		id := strings.TrimSpace(stringValue(item["resourceId"]))
		if _, exists := durations[id]; !exists || reviews[id] != nil {
			return "", fmt.Errorf("自检包含未绑定或重复的资源 %s", id)
		}
		reviews[id] = item
	}
	outcome := "passed"
	for id, duration := range durations {
		review := reviews[id]
		if review == nil {
			outcome = stricterProductionStepOutcome(outcome, "uncertain")
			continue
		}
		checks := map[string]map[string]any{}
		for _, check := range productionManifestRecords(review["checks"]) {
			name := stringValue(check["name"])
			if checks[name] != nil {
				return "", fmt.Errorf("资源 %s 的检查项 %s 重复", id, name)
			}
			checks[name] = check
			status := stringValue(check["status"])
			if status != "passed" && status != "failed" && status != "uncertain" {
				return "", fmt.Errorf("逐资源检查状态无效")
			}
			outcome = stricterProductionStepOutcome(outcome, status)
		}
		for _, name := range productionManifestStrings(contract["requiredChecks"]) {
			check := checks[name]
			if check == nil || strings.TrimSpace(stringValue(check["observation"])) == "" {
				outcome = stricterProductionStepOutcome(outcome, "uncertain")
			}
		}
		samples := productionManifestRecords(review["samples"])
		times := map[int64]bool{}
		var first, last int64 = -1, -1
		for _, sample := range samples {
			if strings.TrimSpace(stringValue(sample["observation"])) == "" {
				continue
			}
			if _, exists := sample["timeMs"]; !exists {
				continue
			}
			t, err := selfCheckSampleTime(sample["timeMs"])
			if err != nil {
				return "", fmt.Errorf("资源 %s 的抽帧时间必须是整数毫秒", id)
			}
			if t < 0 || (duration > 0 && t > duration) {
				return "", fmt.Errorf("资源 %s 的抽帧时间不在实际范围内", id)
			}
			times[t] = true
			if first < 0 || t < first {
				first = t
			}
			if t > last {
				last = t
			}
		}
		if int64(len(times)) < minSamples || (minSamples > 1 && duration <= 0) || (duration > 0 && (first > 250 || last < duration-300)) {
			outcome = stricterProductionStepOutcome(outcome, "uncertain")
		}
		if boolValue(contract["requiresListening"]) {
			audio := productionRecord(review["audioReview"])
			if stringValue(audio["voiceQuality"]) == "failed" {
				outcome = "failed"
			}
			if stringValue(audio["listeningStatus"]) != "performed" || stringValue(audio["voiceQuality"]) != "passed" || strings.TrimSpace(stringValue(audio["evaluator"])) == "" || strings.TrimSpace(stringValue(audio["summary"])) == "" {
				outcome = stricterProductionStepOutcome(outcome, "uncertain")
			}
		}
	}
	return outcome, nil
}

func selfCheckSampleTime(value any) (int64, error) {
	var number float64
	switch v := value.(type) {
	case json.Number:
		parsed, err := v.Int64()
		if err != nil {
			return 0, err
		}
		return parsed, nil
	case int:
		return int64(v), nil
	case int64:
		return v, nil
	case float64:
		number = v
	default:
		return 0, fmt.Errorf("不是数值")
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number || number < -9e15 || number > 9e15 {
		return 0, fmt.Errorf("不是有限整数")
	}
	return int64(number), nil
}

func productionSemanticReviewOutcome(evidence map[string]any) (string, error) {
	semantic := productionRecord(evidence["semanticQuality"])
	switch stringValue(semantic["status"]) {
	case "failed":
		return "failed", nil
	case "", "unavailable", "uncertain":
		return "uncertain", nil
	case "passed":
		if strings.TrimSpace(stringValue(semantic["model"])) == "" || strings.TrimSpace(stringValue(semantic["summary"])) == "" {
			return "uncertain", nil
		}
		return "passed", nil
	default:
		return "", fmt.Errorf("semanticQuality.status 必须是 passed、failed、uncertain 或 unavailable")
	}
}

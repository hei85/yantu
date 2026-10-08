package app

import (
	"testing"

	"infinite-canvas/backend/internal/model"
)

func stageGateRefsAsAny(refs []map[string]any) []any {
	result := make([]any, 0, len(refs))
	for _, ref := range refs {
		result = append(result, ref)
	}
	return result
}

func fullFilmStageGateFixture() (map[string]any, []ProductionStepInput) {
	ref := func(name string) map[string]any {
		return map[string]any{
			"artifactId": "artifact-" + name, "versionId": "version-" + name,
			"inputFingerprint": "input-" + name, "outputFingerprint": "output-" + name,
		}
	}
	rowIDs := []any{"pilot", "batch"}
	preproduction := map[string]any{
		"sourceScript": ref("script"), "brief": ref("brief"), "scriptBreakdown": ref("breakdown"),
		"visualDesign":     ref("visual"),
		"roughStoryboard":  map[string]any{"artifactId": "artifact-rough", "versionId": "version-rough", "inputFingerprint": "input-rough", "outputFingerprint": "output-rough", "rowIds": rowIDs},
		"assetPackage":     map[string]any{"artifactId": "artifact-assets", "versionId": "version-assets", "inputFingerprint": "input-assets", "outputFingerprint": "output-assets", "assetIds": []any{"hero"}},
		"soundPlan":        map[string]any{"artifactId": "artifact-sound", "versionId": "version-sound", "inputFingerprint": "input-sound", "outputFingerprint": "output-sound", "voiceVersionIds": []any{}},
		"lockedStoryboard": map[string]any{"artifactId": "artifact-locked", "versionId": "version-locked", "inputFingerprint": "input-locked", "outputFingerprint": "output-locked", "rowIds": rowIDs, "durationFrames": 300},
		"pilot":            map[string]any{"artifactId": "artifact-pilot", "versionId": "version-pilot", "inputFingerprint": "input-pilot", "outputFingerprint": "output-pilot", "sampleRowIds": []any{"pilot"}},
	}
	productionSpec := map[string]any{
		"workflowVersion": int64(2), "preproduction": preproduction,
		"storyboardRows": []any{
			map[string]any{"rowId": "pilot", "characters": []any{}, "audioTracks": []any{}},
			map[string]any{"rowId": "batch", "characters": []any{}, "audioTracks": []any{}},
		},
		"sharedAssets": []any{map[string]any{"assetId": "hero", "generate": true}},
	}
	manifest := map[string]any{
		"workflowVersion": int64(2), "targetDurationMs": int64(10000),
		"timelineTimebase":       map[string]any{"totalFrames": int64(300), "fpsNumerator": int64(30), "fpsDenominator": int64(1)},
		"lockedStoryboardRowIds": rowIDs, "pilotRowIds": []any{"pilot"},
	}
	contracts := make([]any, 0, len(fullFilmStageKeys))
	for _, key := range fullFilmStageKeys {
		outputs, inputs := fullFilmStageArtifactRefs(key, preproduction)
		contract := map[string]any{
			"stepKey": key, "inputFingerprint": "fingerprint-" + key,
			"artifactRefs": stageGateRefsAsAny(outputs), "inputArtifactRefs": stageGateRefsAsAny(inputs),
		}
		switch key {
		case "stage:rough_storyboard":
			contract["rowIds"] = rowIDs
		case "stage:asset_package":
			contract["assetIds"] = []any{"hero"}
		case "stage:sound_plan":
			contract["voiceVersionIds"] = []any{}
		case "stage:locked_storyboard":
			contract["rowIds"], contract["durationFrames"] = rowIDs, int64(300)
		case "stage:pilot":
			contract["rowIds"], contract["sampleRowIds"] = []any{"pilot"}, []any{"pilot"}
		case "stage:postproduction":
			contract["outputKind"] = "timeline_master"
		}
		contracts = append(contracts, contract)
	}
	manifest["stageContracts"] = contracts
	plan := map[string]any{"productionSpec": productionSpec, "executionManifest": manifest}

	steps := make([]ProductionStepInput, 0, 30)
	add := func(key, kind, row string, deps ...string) {
		steps = append(steps, ProductionStepInput{StepKey: key, Kind: kind, StoryboardRowID: row, DependsOn: deps, InputFingerprint: "fingerprint-" + key})
	}
	stageDeps := map[string][]string{
		"stage:script_breakdown":  {"stage:brief"},
		"stage:visual_design":     {"stage:script_breakdown"},
		"stage:rough_storyboard":  {"stage:script_breakdown"},
		"stage:asset_package":     {"stage:visual_design", "stage:rough_storyboard", "asset:hero"},
		"stage:sound_plan":        {"stage:script_breakdown", "stage:visual_design", "stage:rough_storyboard"},
		"stage:locked_storyboard": {"stage:rough_storyboard", "stage:asset_package", "stage:sound_plan"},
		"stage:pilot":             {"stage:locked_storyboard", "stage:asset_package", "stage:sound_plan", "quality:shot:pilot", "continuity:pilot"},
		"stage:postproduction":    {"timeline:master", "quality:full-film"},
	}
	for _, key := range fullFilmStageKeys {
		add(key, "check", "", stageDeps[key]...)
	}
	add("asset:hero", "image", "", "stage:visual_design", "stage:rough_storyboard")
	add("storyboard:pilot", "check", "pilot", "stage:locked_storyboard")
	add("storyboard:batch", "check", "batch", "stage:locked_storyboard")
	add("video:pilot:segment", "video", "pilot", "stage:asset_package", "stage:sound_plan", "stage:locked_storyboard")
	add("video:batch:segment", "video", "batch", "stage:asset_package", "stage:sound_plan", "stage:locked_storyboard", "stage:pilot")
	add("quality:shot:pilot", "check", "pilot", "video:pilot:segment")
	add("continuity:pilot", "check", "pilot", "video:pilot:segment")
	add("quality:shot:batch", "check", "batch", "video:batch:segment")
	add("continuity:batch", "check", "batch", "video:batch:segment")
	add("timeline:master", "timeline", "", "stage:pilot", "video:pilot:segment", "video:batch:segment")
	add("quality:full-film", "verify", "", "timeline:master")
	add("delivery:contract", "delivery_check", "", "stage:postproduction")
	return plan, steps
}

func TestValidateProductionWorkflowPlanRequiresCompleteGatesAndExactLock(t *testing.T) {
	plan, steps := fullFilmStageGateFixture()
	if err := validateProductionWorkflowPlan(plan, steps, 10000, 30, 1); err != nil {
		t.Fatalf("valid v2 plan rejected: %v", err)
	}

	t.Run("missing stage", func(t *testing.T) {
		broken := append([]ProductionStepInput(nil), steps...)
		for i, step := range broken {
			if step.StepKey == "stage:sound_plan" {
				broken = append(broken[:i], broken[i+1:]...)
				break
			}
		}
		if err := validateProductionWorkflowPlan(plan, broken, 10000, 30, 1); err == nil {
			t.Fatal("plan without sound-plan stage was accepted")
		}
	})
	t.Run("video dependency", func(t *testing.T) {
		broken := append([]ProductionStepInput(nil), steps...)
		for i := range broken {
			if broken[i].StepKey == "video:batch:segment" {
				broken[i].DependsOn = []string{"stage:asset_package", "stage:locked_storyboard", "stage:pilot"}
			}
		}
		if err := validateProductionWorkflowPlan(plan, broken, 10000, 30, 1); err == nil {
			t.Fatal("video step without sound-plan dependency was accepted")
		}
	})
	t.Run("frame lock", func(t *testing.T) {
		broken, _ := fullFilmStageGateFixture()
		productionRecord(productionRecord(broken["productionSpec"])["preproduction"])["lockedStoryboard"].(map[string]any)["durationFrames"] = int64(299)
		if err := validateProductionWorkflowPlan(broken, steps, 10000, 30, 1); err == nil {
			t.Fatal("locked storyboard with the wrong total frame count was accepted")
		}
	})
	t.Run("legacy v1 remains continuable", func(t *testing.T) {
		legacy := map[string]any{"productionSpec": map[string]any{"workflowVersion": int64(1)}, "executionManifest": map[string]any{"workflowVersion": int64(1)}}
		if err := validateProductionWorkflowPlan(legacy, nil, 0, 0, 0); err != nil {
			t.Fatalf("legacy v1 plan rejected: %v", err)
		}
	})
}

func TestValidateFullFilmLockedStageEvidenceAndOutcomeMonotonicity(t *testing.T) {
	plan, _ := fullFilmStageGateFixture()
	run := &model.ProductionRun{PlanJSON: mapJSON(plan)}
	step := &model.ProductionStep{StepKey: "stage:locked_storyboard", InputFingerprint: "fingerprint-stage:locked_storyboard"}
	artifacts, inputs := fullFilmStageArtifactRefs(step.StepKey, productionRecord(productionRecord(plan["productionSpec"])["preproduction"]))
	evidence := map[string]any{
		"checks":          []any{map[string]any{"name": "frame_total", "status": "passed"}},
		"semanticQuality": map[string]any{"status": "passed", "model": "review-model-v1", "summary": "锁定镜头表与目标总帧数一致。"},
		"stageEvidence": map[string]any{
			"workflowVersion": int64(2), "stageKey": step.StepKey, "inputFingerprint": step.InputFingerprint,
			"artifacts": stageGateRefsAsAny(artifacts), "inputArtifacts": stageGateRefsAsAny(inputs), "rowIds": []any{"pilot", "batch"}, "durationFrames": int64(300),
		},
	}
	stageOutcome, err := validateFullFilmStageEvidence(nil, run, step, evidence)
	if err != nil || stageOutcome != "passed" {
		t.Fatalf("valid locked-stage evidence = %q, %v", stageOutcome, err)
	}
	missingSummary := map[string]any{
		"semanticQuality": map[string]any{"status": "passed", "model": "review-model-v1"},
		"stageEvidence":   evidence["stageEvidence"],
	}
	if got, err := validateFullFilmStageEvidence(nil, run, step, missingSummary); err != nil || got != "uncertain" {
		t.Fatalf("stage evidence without a semantic summary = %q, %v; want uncertain", got, err)
	}
	if _, _, err := normalizeProductionStepEvidence(map[string]any{
		"checks": []any{}, "semanticQuality": map[string]any{"status": "passed", "model": "review-model-v1", "summary": "声称通过"},
	}); err == nil {
		t.Fatal("empty checks with a semantic pass claim were accepted")
	}
	for _, testCase := range []struct {
		checkStatus string
		want        string
	}{{"failed", "failed"}, {"uncertain", "uncertain"}} {
		evidence["checks"] = []any{map[string]any{"name": "frame_total", "status": testCase.checkStatus}}
		_, checksOutcome, err := normalizeProductionStepEvidence(evidence)
		if err != nil {
			t.Fatalf("normalize %s check: %v", testCase.checkStatus, err)
		}
		if got := stricterProductionStepOutcome(checksOutcome, stageOutcome); got != testCase.want {
			t.Errorf("semantic pass promoted %s checks to %s; want %s", testCase.checkStatus, got, testCase.want)
		}
	}
	evidence["stageEvidence"].(map[string]any)["durationFrames"] = int64(299)
	if _, err := validateFullFilmStageEvidence(nil, run, step, evidence); err == nil {
		t.Fatal("locked-stage evidence with an incorrect total frame count was accepted")
	}
}

func TestRecordFullFilmStageSemanticPassCannotPromoteCheckOutcome(t *testing.T) {
	for _, testCase := range []struct {
		checkStatus string
		wantStatus  string
	}{{"failed", "failed"}, {"uncertain", "uncertain"}} {
		t.Run(testCase.checkStatus, func(t *testing.T) {
			svc, db := newTimelineTaskTestService(t)
			plan, steps := fullFilmStageGateFixture()
			var briefStage ProductionStepInput
			for _, candidate := range steps {
				if candidate.StepKey == "stage:brief" {
					briefStage = candidate
					break
				}
			}
			run := &model.ProductionRun{
				ID: "run-stage-result-" + testCase.checkStatus, UserID: "usr-production", Status: "running", Revision: 1,
				PlanJSON: mapJSON(plan), PolicyJSON: mapJSON(map[string]any{"authorizationStatus": "authorized"}),
				TargetDurationMs: 10000, TargetFPSNumerator: 30, TargetFPSDenom: 1,
			}
			if err := db.Create(run).Error; err != nil {
				t.Fatalf("seed run: %v", err)
			}
			step := &model.ProductionStep{
				ID: "step-brief-" + testCase.checkStatus, RunID: run.ID, StepKey: briefStage.StepKey,
				Kind: "check", InputFingerprint: briefStage.InputFingerprint, DependsOnJSON: mapJSON([]string{}), Status: "ready",
			}
			if err := db.Create(step).Error; err != nil {
				t.Fatalf("seed brief stage: %v", err)
			}
			artifacts, inputs := fullFilmStageArtifactRefs(briefStage.StepKey, productionRecord(productionRecord(plan["productionSpec"])["preproduction"]))
			updated, err := svc.RecordProductionStepResult("usr-production", run.ID, ProductionStepResultRequest{
				ExpectedRevision: 1, StepID: step.ID,
				Evidence: map[string]any{
					"checks":          []any{map[string]any{"name": "brief_fields", "status": testCase.checkStatus}},
					"semanticQuality": map[string]any{"status": "passed", "model": "review-model-v1", "summary": "Brief 字段已审阅。"},
					"stageEvidence": map[string]any{
						"workflowVersion": int64(2), "stageKey": briefStage.StepKey, "inputFingerprint": briefStage.InputFingerprint,
						"artifacts": stageGateRefsAsAny(artifacts), "inputArtifacts": stageGateRefsAsAny(inputs),
					},
				},
			})
			if err != nil {
				t.Fatalf("record stage result: %v", err)
			}
			if got := updated.Steps[0].Status; got != testCase.wantStatus {
				t.Fatalf("stage semantic pass promoted %s checks to step status %s", testCase.checkStatus, got)
			}
		})
	}
}

func TestValidateFullFilmAssetPackageRequiresRealReadyOutputs(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	plan, _ := fullFilmStageGateFixture()
	run := &model.ProductionRun{ID: "run-full-film-assets", UserID: "usr-production", PlanJSON: mapJSON(plan)}
	step := &model.ProductionStep{StepKey: "stage:asset_package", InputFingerprint: "fingerprint-stage:asset_package"}
	artifacts, inputs := fullFilmStageArtifactRefs(step.StepKey, productionRecord(productionRecord(plan["productionSpec"])["preproduction"]))
	evidence := map[string]any{
		"semanticQuality": map[string]any{"status": "passed", "model": "review-model-v1", "summary": "角色资产版本已检查。"},
		"stageEvidence": map[string]any{
			"workflowVersion": int64(2), "stageKey": step.StepKey, "inputFingerprint": step.InputFingerprint,
			"artifacts": stageGateRefsAsAny(artifacts), "inputArtifacts": stageGateRefsAsAny(inputs),
			"assetIds": []any{"hero"}, "assetOutputs": []any{map[string]any{"assetId": "hero", "resourceId": "resource-hero"}},
		},
	}
	if err := db.Create(&model.Resource{ID: "resource-hero", UserID: run.UserID, Kind: "image", Status: model.ResourceStatusReady}).Error; err != nil {
		t.Fatalf("seed ready image resource: %v", err)
	}
	assetStep := &model.ProductionStep{
		ID: "step-asset-hero", RunID: run.ID, StepKey: "asset:hero", Status: "succeeded",
		OutputArtifactJSON: mapJSON([]string{"resource-hero"}),
	}
	if err := db.Create(assetStep).Error; err != nil {
		t.Fatalf("seed completed asset step: %v", err)
	}
	stageOutcome, err := validateFullFilmStageEvidence(svc.repo, run, step, evidence)
	if err != nil || stageOutcome != "passed" {
		t.Fatalf("valid real asset output was rejected: outcome=%q err=%v", stageOutcome, err)
	}

	evidence["stageEvidence"].(map[string]any)["assetOutputs"] = []any{map[string]any{"assetId": "hero", "resourceId": "made-up-resource"}}
	if _, err := validateFullFilmStageEvidence(svc.repo, run, step, evidence); err == nil {
		t.Fatal("asset evidence without a successful step output was accepted")
	}
}

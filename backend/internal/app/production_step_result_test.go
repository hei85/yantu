package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func createAuthorizedQualityRun(t *testing.T) (*Service, *ProductionRunOutput) {
	t.Helper()
	svc, _ := newTimelineTaskTestService(t)
	created, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey: "quality-evidence-roundtrip",
		Brief:     map[string]any{"targetDurationMs": int64(1000), "aspectRatio": "16:9"},
		Steps: []ProductionStepInput{
			{StepKey: "quality:shot:row-1", Kind: "check", StoryboardRowID: "row-1"},
			{StepKey: "quality:full-film", Kind: "verify", DependsOn: []string{"quality:shot:row-1"}},
		},
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	authorized, err := svc.AuthorizeProductionRun("usr-production", created.ID, ProductionAuthorizeRequest{
		ExpectedRevision: created.Revision,
		Policy:           map[string]any{"allowedCapabilities": []any{"video"}},
	})
	if err != nil {
		t.Fatalf("authorize run: %v", err)
	}
	return svc, authorized
}

func TestRecordProductionStepResultPersistsEvidenceAndUnlocksNextStep(t *testing.T) {
	svc, run := createAuthorizedQualityRun(t)
	step := run.Steps[0]
	updated, err := svc.RecordProductionStepResult("usr-production", run.ID, ProductionStepResultRequest{
		ExpectedRevision: run.Revision,
		StepID:           step.ID,
		Evidence: map[string]any{
			"checks":          []any{map[string]any{"name": "full_decode", "status": "passed", "detail": "decoded"}},
			"semanticQuality": map[string]any{"status": "passed", "model": "vision-review-v1", "summary": "实际样片的人物、动作与空间已检查"},
			"resourceId":      "row-video-resource",
		},
	})
	if err != nil {
		t.Fatalf("record result: %v", err)
	}
	if updated.Steps[0].Status != "succeeded" || updated.Steps[1].Status != "ready" {
		t.Fatalf("step results did not update/unlock the dependency: %#v", updated.Steps)
	}
	if updated.Revision != run.Revision+1 {
		t.Fatalf("run revision = %d, want %d", updated.Revision, run.Revision+1)
	}
	stepResults := productionRecord(updated.Quality["stepResults"])
	result := productionRecord(stepResults[step.StepKey])
	if stringValue(result["status"]) != "passed" || productionRecord(result["evidence"])["resourceId"] != "row-video-resource" {
		t.Fatalf("quality evidence did not round-trip: %#v", result)
	}
	foundEvent := false
	for _, event := range updated.Events {
		if event.Type == "step_result_recorded" && event.ObjectID == step.ID {
			foundEvent = true
		}
	}
	if !foundEvent {
		t.Fatalf("missing step result event: %#v", updated.Events)
	}
	if _, err := svc.RecordProductionStepResult("usr-production", run.ID, ProductionStepResultRequest{
		ExpectedRevision: run.Revision,
		StepID:           step.ID,
		Evidence:         map[string]any{"checks": []any{map[string]any{"name": "full_decode", "status": "passed"}}, "semanticQuality": map[string]any{"status": "passed"}},
	}); err == nil {
		t.Fatal("stale revision was accepted")
	}
}

func TestRecordProductionStepResultDoesNotPromoteUnavailableSemanticChecks(t *testing.T) {
	svc, run := createAuthorizedQualityRun(t)
	first, err := svc.RecordProductionStepResult("usr-production", run.ID, ProductionStepResultRequest{
		ExpectedRevision: run.Revision,
		StepID:           run.Steps[0].ID,
		Evidence:         map[string]any{"checks": []any{map[string]any{"name": "video_stream", "status": "passed"}}, "semanticQuality": map[string]any{"status": "passed", "model": "vision-review-v1", "summary": "实际样片的画面内容已查"}},
	})
	if err != nil {
		t.Fatalf("record first result: %v", err)
	}
	second, err := svc.RecordProductionStepResult("usr-production", run.ID, ProductionStepResultRequest{
		ExpectedRevision: first.Revision,
		StepID:           first.Steps[1].ID,
		Evidence:         map[string]any{"checks": []any{map[string]any{"name": "full_decode", "status": "passed"}}, "semanticQuality": map[string]any{"status": "unavailable"}},
	})
	if err != nil {
		t.Fatalf("record uncertain result: %v", err)
	}
	if second.Steps[1].Status != "uncertain" || second.Status != "waiting_agent" {
		t.Fatalf("unavailable semantic evidence was treated as success: run=%s step=%s", second.Status, second.Steps[1].Status)
	}
}

func createAuthorizedContinuitySkillRun(t *testing.T) (*Service, *ProductionRunOutput) {
	t.Helper()
	svc, _ := newTimelineTaskTestService(t)
	created, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey: "continuity-skill-evidence",
		Brief:     map[string]any{"targetDurationMs": int64(1000), "aspectRatio": "16:9"},
		Plan: map[string]any{"executionManifest": map[string]any{
			"skillEvidence": []any{map[string]any{"skillId": "character-scene-consistency", "versionId": "v7", "contentHash": "sha256:skill-v7", "phase": "continuity"}},
		}},
		Steps: []ProductionStepInput{{
			StepKey: "continuity:row-8", Kind: "check", StoryboardRowID: "row-8",
			InputFingerprint: "sha256:row-8-input", SelectedStrategyID: "continuity:character-scene-consistency",
		}},
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	authorized, err := svc.AuthorizeProductionRun("usr-production", created.ID, ProductionAuthorizeRequest{
		ExpectedRevision: created.Revision,
		Policy:           map[string]any{"allowedCapabilities": []any{"video"}},
	})
	if err != nil {
		t.Fatalf("authorize run: %v", err)
	}
	return svc, authorized
}

func TestRecordContinuitySkillApplicationIsBoundToReadVersionRowAndInput(t *testing.T) {
	baseApplication := map[string]any{
		"skillId": "character-scene-consistency", "versionId": "v7", "contentHash": "sha256:skill-v7",
		"storyboardRowId": "row-8", "inputFingerprint": "sha256:row-8-input",
		"outputSummary": "角色外套、发型和场景光线与上一镜一致。",
	}

	t.Run("records a row-scoped output fingerprint", func(t *testing.T) {
		svc, run := createAuthorizedContinuitySkillRun(t)
		updated, err := svc.RecordProductionStepResult("usr-production", run.ID, ProductionStepResultRequest{
			ExpectedRevision: run.Revision,
			StepID:           run.Steps[0].ID,
			Evidence: map[string]any{
				"checks":          []any{map[string]any{"name": "continuity", "status": "passed"}},
				"semanticQuality": map[string]any{"status": "passed"},
				"skillApplications": []any{map[string]any{
					"skillId": baseApplication["skillId"], "versionId": baseApplication["versionId"], "contentHash": baseApplication["contentHash"],
					"storyboardRowId": baseApplication["storyboardRowId"], "inputFingerprint": baseApplication["inputFingerprint"], "outputSummary": baseApplication["outputSummary"],
				}},
			},
		})
		if err != nil {
			t.Fatalf("record continuity evidence: %v", err)
		}
		stepResults := productionRecord(updated.Quality["stepResults"])
		result := productionRecord(stepResults[run.Steps[0].StepKey])
		applications := productionManifestRecords(productionRecord(result["evidence"])["skillApplications"])
		if len(applications) != 1 || stringValue(applications[0]["storyboardRowId"]) != "row-8" || !strings.HasPrefix(stringValue(applications[0]["outputFingerprint"]), "sha256:") {
			t.Fatalf("row-scoped skill output was not fingerprinted: %#v", applications)
		}
	})

	for _, testCase := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{name: "missing application", mutate: nil},
		{name: "wrong row", mutate: func(item map[string]any) { item["storyboardRowId"] = "row-7" }},
		{name: "wrong input", mutate: func(item map[string]any) { item["inputFingerprint"] = "sha256:stale-input" }},
		{name: "unread skill version", mutate: func(item map[string]any) { item["versionId"] = "v6" }},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			svc, run := createAuthorizedContinuitySkillRun(t)
			var applications []any
			if testCase.mutate != nil {
				application := map[string]any{}
				for key, value := range baseApplication {
					application[key] = value
				}
				testCase.mutate(application)
				applications = []any{application}
			}
			_, err := svc.RecordProductionStepResult("usr-production", run.ID, ProductionStepResultRequest{
				ExpectedRevision: run.Revision,
				StepID:           run.Steps[0].ID,
				Evidence: map[string]any{
					"checks":          []any{map[string]any{"name": "continuity", "status": "passed"}},
					"semanticQuality": map[string]any{"status": "passed"}, "skillApplications": applications,
				},
			})
			if err == nil {
				t.Fatal("invalid skill application evidence was accepted")
			}
		})
	}
}

func TestRecordProductionStepResultRejectsWrongKindAndSensitiveEvidence(t *testing.T) {
	svc, run := createAuthorizedQualityRun(t)
	videoStep := model.ProductionStep{ID: "video-step", RunID: run.ID, StepKey: "video:row-1", Kind: "video", Status: "ready", OutputArtifactJSON: "[]", Revision: 1}
	if err := svc.repo.CreateProductionStep(&videoStep); err != nil {
		t.Fatalf("create video step: %v", err)
	}
	validEvidence := map[string]any{"checks": []any{map[string]any{"name": "probe", "status": "passed"}}, "semanticQuality": map[string]any{"status": "passed", "model": "vision-review-v1", "summary": "实际样片的人物、动作与空间已检查"}}
	if _, err := svc.RecordProductionStepResult("usr-production", run.ID, ProductionStepResultRequest{ExpectedRevision: run.Revision, StepID: videoStep.ID, Evidence: validEvidence}); err == nil {
		t.Fatal("video generation step accepted a quality result")
	}
	if _, _, err := normalizeProductionStepEvidence(map[string]any{"checks": []any{map[string]any{"name": "probe", "status": "passed", "api_key": "hidden"}}}); err == nil {
		t.Fatal("sensitive evidence was accepted")
	}
	if _, _, err := normalizeProductionStepEvidence(map[string]any{"checks": []any{map[string]any{"name": "probe", "status": "passed", "mediaUrl": "https://example.invalid/video.mp4"}}}); err == nil {
		t.Fatal("media URL was accepted")
	}
}

func TestVerifyProductionDeliveryCompletesServerOwnedStepFromRealMediaProbe(t *testing.T) {
	ffmpeg := requireCommand(t, "ffmpeg")
	_ = requireCommand(t, "ffprobe")
	svc, db := newTimelineTaskTestService(t)
	svc.dataDir = t.TempDir()
	objectKey := "video/final.mp4"
	mediaPath := filepath.Join(svc.dataDir, "resources", filepath.FromSlash(objectKey))
	if err := os.MkdirAll(filepath.Dir(mediaPath), 0o750); err != nil {
		t.Fatalf("create media directory: %v", err)
	}
	runCommand(t, ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=256x144:r=30:d=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", mediaPath)
	info, err := os.Stat(mediaPath)
	if err != nil {
		t.Fatalf("stat media: %v", err)
	}
	resource := model.Resource{ID: "final-resource", UserID: "usr-production", Kind: "video", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: objectKey, MimeType: "video/mp4", Size: info.Size()}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatalf("create resource: %v", err)
	}

	videoKey, qaKey, continuityKey := "video:row-1:seg-1", "quality:shot:row-1", "continuity:row-1"
	manifest := map[string]any{
		"targetDurationMs": int64(1000), "targetAspectRatio": "16:9", "audioMode": model.ProductionAudioModeNative, "audioPolicy": "native",
		"videoStepKeys": []any{videoKey}, "audioStepKeys": []any{}, "sharedAssetStepKeys": []any{},
		"rowAssetBindings":        []any{map[string]any{"storyboardRowId": "row-1", "sharedAssetIds": []any{}, "segmentIds": []any{"seg-1"}}},
		"selectedModelsBySegment": []any{map[string]any{"storyboardRowId": "row-1", "segmentId": "seg-1", "model": "model-x", "capabilityRevision": "model-x:1", "operation": "text_to_video"}},
		"timelineSpans":           []any{map[string]any{"storyboardRowId": "row-1", "segmentId": "seg-1", "startFrame": int64(0), "durationFrames": int64(30)}},
		"timelineTimebase":        map[string]any{"fpsNumerator": int64(30), "fpsDenominator": int64(1), "totalFrames": int64(30), "durationMs": int64(1000)},
		"skillEvidence":           []any{map[string]any{"skillId": "continuity", "versionId": "v1", "contentHash": "sha256:fixture", "phase": "preflight"}},
	}
	run, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey: "delivery-step-writeback", Brief: map[string]any{"targetDurationMs": int64(1000), "aspectRatio": "16:9"},
		DeliveryContract: ProductionDeliveryContract{TargetDurationMs: 1000, TargetAspectRatio: "16:9"},
		Plan:             map[string]any{"executionManifest": manifest},
		Steps: []ProductionStepInput{
			{StepKey: videoKey, Kind: "video", StoryboardRowID: "row-1", SegmentID: "seg-1", SegmentOrder: 0, SelectedStrategyID: "model-x@model-x:1:text_to_video"},
			{StepKey: qaKey, Kind: "check", StoryboardRowID: "row-1", DependsOn: []string{videoKey}},
			{StepKey: continuityKey, Kind: "check", StoryboardRowID: "row-1", DependsOn: []string{videoKey}},
			{StepKey: "timeline:master", Kind: "render", DependsOn: []string{videoKey, qaKey, continuityKey}},
			{StepKey: "quality:full-film", Kind: "verify", DependsOn: []string{"timeline:master"}},
			{StepKey: "delivery:contract", Kind: "delivery_check", DependsOn: []string{"quality:full-film"}},
		},
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	stepByKey := map[string]model.ProductionStep{}
	for _, item := range run.Steps {
		step := item.ProductionStep
		if step.StepKey != "delivery:contract" {
			step.Status = "succeeded"
		}
		if step.StepKey == videoKey {
			step.AttemptCount = 1
		}
		if step.StepKey == "timeline:master" {
			step.OutputArtifactJSON = mapJSON([]string{resource.ID})
		}
		if err := svc.repo.SaveProductionStep(&step); err != nil {
			t.Fatalf("save step %s: %v", step.StepKey, err)
		}
		stepByKey[step.StepKey] = step
	}
	attempt := model.ProductionAttempt{ID: "attempt-delivery-video", RunID: run.ID, StepID: stepByKey[videoKey].ID, AttemptNumber: 1, IdempotencyKey: "delivery-video-key", RequestHash: "delivery-video-hash", CapabilityRevision: "model-x:1", GenerationTaskID: "task-delivery-video", State: "succeeded"}
	if err := svc.repo.CreateProductionAttempt(&attempt); err != nil {
		t.Fatalf("create attempt: %v", err)
	}
	task := model.Task{ID: attempt.GenerationTaskID, UserID: "usr-production", Type: "canvas_video", Status: model.TaskStatusSucceeded, Model: "model-x", Operation: "text_to_video", CapabilityRevision: "model-x:1", ProductionRunID: run.ID, ProductionStepID: attempt.StepID, ProductionAttemptID: attempt.ID, StoryboardRowID: "row-1", SegmentID: "seg-1"}
	if err := db.Create(&task).Error; err != nil {
		t.Fatalf("create task: %v", err)
	}

	verified, err := svc.VerifyProductionDelivery("usr-production", run.ID, ProductionDeliveryVerificationRequest{ExpectedRevision: run.Revision, ResourceID: resource.ID})
	if err != nil {
		t.Fatalf("verify delivery: %v", err)
	}
	if !verified.Completed || verified.DeliveryStatus != "passed" || verified.Run.Status != "completed" {
		t.Fatalf("real probed delivery was not accepted: %#v", verified)
	}
	var deliveryStep *model.ProductionStep
	var deliveryArtifacts []string
	for index := range verified.Run.Steps {
		if verified.Run.Steps[index].StepKey == "delivery:contract" {
			deliveryStep = &verified.Run.Steps[index].ProductionStep
			deliveryArtifacts = verified.Run.Steps[index].OutputArtifactIDs
			break
		}
	}
	if deliveryStep == nil || deliveryStep.Status != "succeeded" || len(deliveryArtifacts) != 1 || deliveryArtifacts[0] != resource.ID {
		t.Fatalf("server-owned delivery evidence was not written back: %#v", verified.Run.Steps)
	}
}

func newAuthorizedReuseMediaRun(t *testing.T, aspect string) (*Service, *ProductionRunOutput, model.Resource) {
	t.Helper()
	ffmpeg := requireCommand(t, "ffmpeg")
	_ = requireCommand(t, "ffprobe")
	svc, _ := newTimelineTaskTestService(t)
	svc.dataDir = t.TempDir()
	objectKey := "video/reused.mp4"
	mediaPath := filepath.Join(svc.dataDir, "resources", filepath.FromSlash(objectKey))
	if err := os.MkdirAll(filepath.Dir(mediaPath), 0o750); err != nil {
		t.Fatalf("create media directory: %v", err)
	}
	size := "256x144"
	if aspect == "9:16" {
		size = "144x256"
	}
	runCommand(t, ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s="+size+":r=30:d=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", mediaPath)
	info, err := os.Stat(mediaPath)
	if err != nil {
		t.Fatalf("stat reused media: %v", err)
	}
	resource := model.Resource{ID: "reused-video-resource", UserID: "usr-production", Kind: "video", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: objectKey, MimeType: "video/mp4", Size: info.Size()}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatalf("create reused resource: %v", err)
	}
	videoKey, rowID, segmentID := "reuse-video:reuse-shot:reuse-seg", "reuse-shot", "reuse-seg"
	manifest := map[string]any{
		"targetDurationMs": int64(1000), "targetAspectRatio": "16:9", "audioMode": model.ProductionAudioModeNative, "audioPolicy": "native",
		"requireAudio": false, "requireSubtitle": false,
		"videoStepKeys": []any{videoKey}, "audioStepKeys": []any{}, "audioTrackBindings": []any{}, "audioCapabilityGaps": []any{}, "sharedAssetStepKeys": []any{},
		"rowAssetBindings":        []any{map[string]any{"storyboardRowId": rowID, "sharedAssetIds": []any{}, "segmentIds": []any{segmentID}}},
		"reusedMediaBindings":     []any{map[string]any{"storyboardRowId": rowID, "segmentId": segmentID, "stepKey": videoKey, "resourceId": resource.ID, "sourceTaskId": "", "sourceNodeId": "canvas-video-node"}},
		"selectedModelsBySegment": []any{},
		"timelineSpans":           []any{map[string]any{"storyboardRowId": rowID, "segmentId": segmentID, "startFrame": int64(0), "durationFrames": int64(30)}},
		"timelineTimebase":        map[string]any{"unit": "frame", "fpsNumerator": int64(30), "fpsDenominator": int64(1), "totalFrames": int64(30), "durationMs": int64(1000)},
		"skillEvidence":           []any{map[string]any{"skillId": "continuity", "versionId": "v1", "contentHash": "sha256:fixture", "phase": "preflight"}},
	}
	created, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey: "reuse-media-roundtrip-" + aspect, Brief: map[string]any{"targetDurationMs": int64(1000), "aspectRatio": "16:9"},
		DeliveryContract: ProductionDeliveryContract{TargetDurationMs: 1000, TargetAspectRatio: "16:9"}, Plan: map[string]any{"executionManifest": manifest},
		Steps: []ProductionStepInput{
			{StepKey: "storyboard:" + rowID, Kind: "check", StoryboardRowID: rowID},
			{StepKey: videoKey, Kind: "reuse_media", StoryboardRowID: rowID, SegmentID: segmentID, SelectedStrategyID: "existing-media:" + resource.ID, DependsOn: []string{"storyboard:" + rowID}},
			{StepKey: "quality:shot:" + rowID, Kind: "check", StoryboardRowID: rowID, DependsOn: []string{videoKey}},
			{StepKey: "continuity:" + rowID, Kind: "check", StoryboardRowID: rowID, DependsOn: []string{videoKey}},
			{StepKey: "timeline:master", Kind: "render", DependsOn: []string{videoKey, "quality:shot:" + rowID, "continuity:" + rowID}},
			{StepKey: "quality:full-film", Kind: "verify", DependsOn: []string{"timeline:master"}},
			{StepKey: "delivery:contract", Kind: "delivery_check", DependsOn: []string{"quality:full-film"}},
		},
	})
	if err != nil {
		t.Fatalf("create reuse run: %v", err)
	}
	authorized, err := svc.AuthorizeProductionRun("usr-production", created.ID, ProductionAuthorizeRequest{ExpectedRevision: created.Revision, Policy: map[string]any{"allowedCapabilities": []any{"video"}}})
	if err != nil {
		t.Fatalf("authorize reuse run: %v", err)
	}
	return svc, authorized, resource
}

func TestRecordProductionMediaReuseProbesAndPersistsTheBoundResource(t *testing.T) {
	svc, run, resource := newAuthorizedReuseMediaRun(t, "16:9")
	var storyboard, reuse model.ProductionStep
	for _, step := range run.Steps {
		switch step.StepKey {
		case "storyboard:reuse-shot":
			storyboard = step.ProductionStep
		case "reuse-video:reuse-shot:reuse-seg":
			reuse = step.ProductionStep
		}
	}
	ready, err := svc.RecordProductionStepResult("usr-production", run.ID, ProductionStepResultRequest{
		ExpectedRevision: run.Revision, StepID: storyboard.ID,
		Evidence: map[string]any{"checks": []any{map[string]any{"name": "storyboard_row_binding", "status": "passed"}}},
	})
	if err != nil {
		t.Fatalf("complete storyboard dependency: %v", err)
	}
	updated, err := svc.RecordProductionStepResult("usr-production", run.ID, ProductionStepResultRequest{
		ExpectedRevision: ready.Revision, StepID: reuse.ID, Evidence: map[string]any{"resourceId": resource.ID},
	})
	if err != nil {
		t.Fatalf("record reused video: %v", err)
	}
	var stored *ProductionStepOutput
	for index := range updated.Steps {
		if updated.Steps[index].ID == reuse.ID {
			stored = &updated.Steps[index]
			break
		}
	}
	if stored == nil || stored.Status != "succeeded" || stored.AttemptCount != 0 || len(stored.OutputArtifactIDs) != 1 || stored.OutputArtifactIDs[0] != resource.ID {
		t.Fatalf("reuse step did not round-trip as a no-generation resource binding: %#v", stored)
	}
	results := productionRecord(updated.Quality["stepResults"])
	result := productionRecord(results[stored.StepKey])
	evidence := productionRecord(result["evidence"])
	probe := productionRecord(evidence["probe"])
	if stringValue(evidence["sourceNodeId"]) != "canvas-video-node" || !boolValue(probe["decoded"]) || intValue(probe["videoStreams"]) != 1 {
		t.Fatalf("server media probe and source node evidence did not round-trip: %#v", evidence)
	}
	steps := make([]model.ProductionStep, 0, len(updated.Steps))
	for _, item := range updated.Steps {
		steps = append(steps, item.ProductionStep)
	}
	audit := inspectProductionManifest(mapJSON(updated.Plan), productionDeliveryContractForRun(updated.ProductionRun), steps, updated.Attempts, mapJSON(updated.Quality))
	if len(audit.Segments) != 1 || audit.Segments[0].StepKind != "reuse_media" || audit.Segments[0].ResourceID != resource.ID || containsString(audit.Issues, "manifest_segment_attempt_incomplete:reuse-seg") || containsString(audit.Issues, "manifest_reused_media_probe_missing_or_invalid:reuse-seg") {
		t.Fatalf("manifest failed to audit a no-attempt reused segment with its persisted real probe: %#v", audit)
	}
	if _, err := svc.RecordProductionStepResult("usr-production", run.ID, ProductionStepResultRequest{
		ExpectedRevision: updated.Revision, StepID: stored.ID,
		Evidence: map[string]any{"resourceId": resource.ID, "checks": []any{map[string]any{"name": "forged", "status": "passed"}}},
	}); err == nil {
		t.Fatal("client-supplied reuse QA evidence was accepted")
	}
}

func TestRecordProductionMediaReuseRejectsBriefAspectMismatch(t *testing.T) {
	svc, run, resource := newAuthorizedReuseMediaRun(t, "9:16")
	var storyboard, reuse model.ProductionStep
	for _, step := range run.Steps {
		if step.StepKey == "storyboard:reuse-shot" {
			storyboard = step.ProductionStep
		}
		if step.StepKey == "reuse-video:reuse-shot:reuse-seg" {
			reuse = step.ProductionStep
		}
	}
	ready, err := svc.RecordProductionStepResult("usr-production", run.ID, ProductionStepResultRequest{
		ExpectedRevision: run.Revision, StepID: storyboard.ID,
		Evidence: map[string]any{"checks": []any{map[string]any{"name": "storyboard_row_binding", "status": "passed"}}},
	})
	if err != nil {
		t.Fatalf("complete storyboard dependency: %v", err)
	}
	if _, err := svc.RecordProductionStepResult("usr-production", run.ID, ProductionStepResultRequest{
		ExpectedRevision: ready.Revision, StepID: reuse.ID, Evidence: map[string]any{"resourceId": resource.ID},
	}); err == nil || !strings.Contains(err.Error(), "Brief 合同") {
		t.Fatalf("portrait reused media was not rejected for the 16:9 Brief: %v", err)
	}
}

package app

import (
	"encoding/json"
	"strings"
	"testing"

	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

type productionRenderFixture struct {
	svc       *Service
	db        *gorm.DB
	run       *ProductionRunOutput
	videoStep model.ProductionStep
	render    model.ProductionStep
	request   ProductionRenderSubmitRequest
}

func newProductionRenderFixture(t *testing.T) productionRenderFixture {
	t.Helper()
	svc, db := newTimelineTaskTestService(t)
	manifest := map[string]any{
		"targetDurationMs": int64(1000), "targetAspectRatio": "16:9", "audioMode": model.ProductionAudioModeNative, "audioPolicy": "native",
		"requireAudio": false, "requireSubtitle": false,
		"videoStepKeys": []string{"video:row-1:seg-1"}, "audioStepKeys": []string{}, "audioTrackBindings": []any{}, "subtitleCues": []any{},
		"rowAssetBindings":        []any{map[string]any{"storyboardRowId": "row-1", "segmentIds": []any{"seg-1"}}},
		"selectedModelsBySegment": []any{map[string]any{"storyboardRowId": "row-1", "segmentId": "seg-1", "model": "model-x", "capabilityRevision": "model-x:1", "operation": "text_to_video"}},
		"timelineSpans":           []any{map[string]any{"storyboardRowId": "row-1", "segmentId": "seg-1", "startFrame": int64(0), "durationFrames": int64(30)}},
		"timelineTimebase":        map[string]any{"fpsNumerator": int64(30), "fpsDenominator": int64(1), "totalFrames": int64(30), "durationMs": int64(1000)},
		"skillEvidence":           []any{map[string]any{"skillId": "film-production", "versionId": "v1", "contentHash": "sha256:fixture", "phase": "preflight"}},
	}
	run, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey:        "render-binding-" + strings.ReplaceAll(t.Name(), "/", "-"),
		Plan:             map[string]any{"executionManifest": manifest},
		Policy:           map[string]any{"authorizationStatus": "authorized"},
		DeliveryContract: ProductionDeliveryContract{TargetDurationMs: 1000, TargetAspectRatio: "16:9", DurationToleranceMs: 0, RequireVideo: true, RequireFullDecode: true},
		TargetDurationMs: 1000,
		Steps: []ProductionStepInput{
			{StepKey: "video:row-1:seg-1", Kind: "video", StoryboardRowID: "row-1", SegmentID: "seg-1", SelectedStrategyID: "model-x@model-x:1:text_to_video"},
			{StepKey: "quality:shot:row-1", Kind: "check", StoryboardRowID: "row-1", DependsOn: []string{"video:row-1:seg-1"}},
			{StepKey: "continuity:row-1", Kind: "check", StoryboardRowID: "row-1", DependsOn: []string{"video:row-1:seg-1"}},
			{StepKey: "timeline:master", Kind: "render", DependsOn: []string{"video:row-1:seg-1", "quality:shot:row-1", "continuity:row-1"}},
			{StepKey: "quality:full-film", Kind: "verify", DependsOn: []string{"timeline:master"}},
			{StepKey: "delivery:contract", Kind: "delivery_check", DependsOn: []string{"quality:full-film"}},
		},
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	authorized, err := svc.AuthorizeProductionRun("usr-production", run.ID, ProductionAuthorizeRequest{ExpectedRevision: run.Revision, Policy: map[string]any{"authorizationStatus": "authorized"}})
	if err != nil {
		t.Fatalf("authorize run: %v", err)
	}
	steps, err := svc.repo.ProductionSteps(run.ID)
	if err != nil {
		t.Fatalf("read steps: %v", err)
	}
	var videoStep, renderStep model.ProductionStep
	for _, step := range steps {
		switch step.StepKey {
		case "video:row-1:seg-1":
			videoStep = step
		case "timeline:master":
			renderStep = step
		case "quality:shot:row-1", "continuity:row-1":
			step.Status = "succeeded"
			if err := svc.repo.SaveProductionStep(&step); err != nil {
				t.Fatalf("save ready dependency: %v", err)
			}
		}
	}
	videoStep.Status = "succeeded"
	videoStep.AttemptCount = 1
	videoStep.OutputArtifactJSON = mapJSON([]string{"video-resource"})
	if err := svc.repo.SaveProductionStep(&videoStep); err != nil {
		t.Fatalf("save video step: %v", err)
	}
	attempt := model.ProductionAttempt{ID: "video-attempt", RunID: run.ID, StepID: videoStep.ID, AttemptNumber: 1, IdempotencyKey: "video-key", CapabilityRevision: "model-x:1", State: "succeeded", GenerationTaskID: "video-task"}
	if err := svc.repo.CreateProductionAttempt(&attempt); err != nil {
		t.Fatalf("create video attempt: %v", err)
	}
	if err := db.Create(&model.Task{
		ID: "video-task", UserID: "usr-production", Type: "canvas_video", Status: model.TaskStatusSucceeded,
		ProductionRunID: run.ID, ProductionStepID: videoStep.ID, ProductionAttemptID: attempt.ID,
		StoryboardRowID: "row-1", SegmentID: "seg-1", Model: "model-x", Operation: "text_to_video", CapabilityRevision: "model-x:1",
		ResultJSON: `{"video":{"resourceId":"video-resource"}}`,
	}).Error; err != nil {
		t.Fatalf("create video task: %v", err)
	}
	if err := db.Create(&model.Resource{ID: "video-resource", UserID: "usr-production", Kind: "video", MimeType: "video/mp4", Status: model.ResourceStatusReady}).Error; err != nil {
		t.Fatalf("create video resource: %v", err)
	}
	request := ProductionRenderSubmitRequest{
		ExpectedRevision: authorized.Revision, StepID: renderStep.ID, IdempotencyKey: "render-key",
		Timeline: TimelineRenderCreateRequest{
			ProjectID: "project-1",
			Timeline: renderProject{
				Version: 2, DurationMs: 1000,
				Tracks: []renderTrack{{ID: "video-track", Kind: "video"}},
				Clips: []renderClip{{
					ID: "row-1-seg-1", Kind: "video", TrackID: "video-track", StoryboardRowID: "row-1", SegmentID: "seg-1", StartMs: 0, DurationMs: 1000,
					DirectMedia: &struct {
						ID         string `json:"id"`
						Kind       string `json:"kind"`
						StorageKey string `json:"storageKey"`
					}{ID: "video-resource", Kind: "video", StorageKey: "resource:video-resource"},
				}},
			},
			Output: renderOutputSpec{Width: 1920, Height: 1080, FPSNumerator: 30, FPSDenominator: 1},
		},
	}
	return productionRenderFixture{svc: svc, db: db, run: authorized, videoStep: videoStep, render: renderStep, request: request}
}

func TestProductionRenderAudioPolicyMutesUnplannedEmbeddedVideoAudio(t *testing.T) {
	run := model.ProductionRun{AudioMode: model.ProductionAudioModeRebuild, PlanJSON: `{"executionManifest":{"audioMode":"REBUILD_AUDIO","audioPolicy":"independent"}}`}
	project := renderProject{Clips: []renderClip{
		{ID: "video-1", Kind: "video", Volume: nil},
		{ID: "voice-1", Kind: "audio", Volume: float64Fixture(0.8)},
	}}
	project, evidence := applyProductionRenderAudioPolicy(run, project)
	if project.AudioPolicy != "independent" || project.RequireNativeAudio {
		t.Fatalf("project audio policy = %q, requireNativeAudio=%v", project.AudioPolicy, project.RequireNativeAudio)
	}
	if project.Clips[0].Volume == nil || *project.Clips[0].Volume != 0 {
		t.Fatalf("embedded video audio was not muted: %#v", project.Clips[0])
	}
	if project.Clips[1].Volume == nil || *project.Clips[1].Volume != 0.8 {
		t.Fatalf("planned independent audio was changed: %#v", project.Clips[1])
	}
	mutedIDs, ok := evidence["mutedEmbeddedVideoClipIds"].([]string)
	if !ok || len(mutedIDs) != 1 || mutedIDs[0] != "video-1" {
		t.Fatalf("audio policy evidence = %#v", evidence)
	}

	run.AudioMode = model.ProductionAudioModeNative
	run.PlanJSON = `{"executionManifest":{"audioMode":"NATIVE_AUDIO","audioPolicy":"native"}}`
	project.Clips[0].Volume = nil
	project, nativeEvidence := applyProductionRenderAudioPolicy(run, project)
	if project.AudioPolicy != "native" || project.RequireNativeAudio || project.Clips[0].Volume != nil {
		t.Fatalf("native policy must preserve embedded audio without requiring it: project=%#v", project)
	}
	if mode := nativeEvidence["mode"]; mode != "preserve_embedded_video_audio" {
		t.Fatalf("native audio handling = %#v", nativeEvidence)
	}
}

func TestProductionRenderSubmissionBindsExactSegmentResourceAndIsIdempotent(t *testing.T) {
	fixture := newProductionRenderFixture(t)
	first, err := fixture.svc.SubmitProductionRenderStep("usr-production", fixture.run.ID, fixture.request)
	if err != nil {
		t.Fatalf("submit render: %v", err)
	}
	if first["idempotent"] != false {
		t.Fatalf("first render result = %#v", first)
	}
	firstTask := first["task"].(*model.Task).ID
	if firstTask == "" {
		t.Fatalf("render task ID is missing: %#v", first)
	}
	audioHandling, ok := first["audioHandling"].(map[string]any)
	if !ok || audioHandling["mode"] != "preserve_embedded_video_audio" {
		t.Fatalf("render audio handling = %#v", first["audioHandling"])
	}
	persistedTask, err := fixture.svc.repo.TaskForUser("usr-production", firstTask)
	if err != nil {
		t.Fatalf("read persisted render task: %v", err)
	}
	var input timelineRenderInput
	if err := json.Unmarshal([]byte(persistedTask.InputJSON), &input); err != nil {
		t.Fatalf("decode persisted render input: %v", err)
	}
	if input.Timeline.AudioPolicy != "native" || input.Timeline.Clips[0].Volume != nil {
		t.Fatalf("persisted render audio policy = %#v", input.Timeline)
	}
	replay := fixture.request
	replay.ExpectedRevision-- // a transport retry must still replay the stored task.
	second, err := fixture.svc.SubmitProductionRenderStep("usr-production", fixture.run.ID, replay)
	if err != nil {
		t.Fatalf("idempotent render replay: %v", err)
	}
	if second["idempotent"] != true || second["task"].(*model.Task).ID != firstTask {
		t.Fatalf("idempotent render replay = %#v, first task=%v", second, firstTask)
	}
	var count int64
	if err := fixture.db.Model(&model.Task{}).Where("user_id = ?", "usr-production").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("task count = %d, want one video task plus one render task", count)
	}
	changed := fixture.request
	changed.Timeline.Timeline.Clips[0].DirectMedia.StorageKey = "resource:other-video"
	if _, err := fixture.svc.SubmitProductionRenderStep("usr-production", fixture.run.ID, changed); err == nil || !strings.Contains(err.Error(), "幂等键") {
		t.Fatalf("changed payload with same key err = %v, want idempotency conflict", err)
	}
}

func TestProductionRenderRejectsWrongRowSegmentResourceAndRevisionBeforeQueue(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*ProductionRenderSubmitRequest, *productionRenderFixture)
		want   string
	}{
		{name: "wrong storyboard row", mutate: func(req *ProductionRenderSubmitRequest, _ *productionRenderFixture) {
			req.Timeline.Timeline.Clips[0].StoryboardRowID = "row-other"
		}, want: "未规划"},
		{name: "wrong segment", mutate: func(req *ProductionRenderSubmitRequest, _ *productionRenderFixture) {
			req.Timeline.Timeline.Clips[0].SegmentID = "seg-other"
		}, want: "未规划"},
		{name: "wrong task resource", mutate: func(req *ProductionRenderSubmitRequest, _ *productionRenderFixture) {
			req.Timeline.Timeline.Clips[0].DirectMedia.StorageKey = "resource:other-video"
		}, want: "实际视频资源"},
		{name: "brief duration", mutate: func(req *ProductionRenderSubmitRequest, _ *productionRenderFixture) {
			req.Timeline.Timeline.DurationMs = 5170
		}, want: "总时长"},
		{name: "segment duration", mutate: func(req *ProductionRenderSubmitRequest, _ *productionRenderFixture) {
			req.Timeline.Timeline.Clips[0].DurationMs = 5170
		}, want: "帧范围"},
		{name: "stale revision", mutate: func(req *ProductionRenderSubmitRequest, _ *productionRenderFixture) { req.ExpectedRevision-- }, want: "revision"},
		{name: "wrong step kind", mutate: func(req *ProductionRenderSubmitRequest, fixture *productionRenderFixture) {
			req.StepID = fixture.videoStep.ID
		}, want: "render ProductionStep"},
		{name: "dependency not complete", mutate: func(_ *ProductionRenderSubmitRequest, fixture *productionRenderFixture) {
			steps, err := fixture.svc.repo.ProductionSteps(fixture.run.ID)
			if err != nil {
				t.Fatalf("read dependencies: %v", err)
			}
			for _, step := range steps {
				if step.StepKey == "continuity:row-1" {
					step.Status = "pending"
					if err := fixture.svc.repo.SaveProductionStep(&step); err != nil {
						t.Fatalf("save pending dependency: %v", err)
					}
				}
			}
		}, want: "依赖尚未完成"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fixture := newProductionRenderFixture(t)
			req := fixture.request
			tt.mutate(&req, &fixture)
			if _, err := fixture.svc.SubmitProductionRenderStep("usr-production", fixture.run.ID, req); err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("submit err = %v, want substring %q", err, tt.want)
			}
			var count int64
			if err := fixture.db.Model(&model.Task{}).Where("user_id = ?", "usr-production").Count(&count).Error; err != nil {
				t.Fatal(err)
			}
			if count != 1 {
				t.Fatalf("task count = %d, want only the already-created video task", count)
			}
		})
	}
}

func TestProductionRenderReprobesExistingMediaBeforeTimelineAcceptance(t *testing.T) {
	svc, run, resource := newAuthorizedReuseMediaRun(t, "16:9")
	var storyboard, reuse model.ProductionStep
	for _, item := range run.Steps {
		if item.StepKey == "storyboard:reuse-shot" {
			storyboard = item.ProductionStep
		}
		if item.StepKey == "reuse-video:reuse-shot:reuse-seg" {
			reuse = item.ProductionStep
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
		t.Fatalf("probe and bind existing media: %v", err)
	}
	steps, err := svc.repo.ProductionSteps(run.ID)
	if err != nil {
		t.Fatalf("read production steps: %v", err)
	}
	attempts, err := svc.repo.ProductionAttempts(run.ID, "")
	if err != nil {
		t.Fatalf("read production attempts: %v", err)
	}
	direct := &struct {
		ID         string `json:"id"`
		Kind       string `json:"kind"`
		StorageKey string `json:"storageKey"`
	}{ID: resource.ID, Kind: "video", StorageKey: "resource:" + resource.ID}
	timeline := renderProject{
		Version: 2, DurationMs: 1000, AudioPolicy: "native",
		Tracks: []renderTrack{{ID: "video-track", Kind: "video"}},
		Clips:  []renderClip{{ID: "reuse-clip", Kind: "video", TrackID: "video-track", StoryboardRowID: "reuse-shot", SegmentID: "reuse-seg", StartMs: 0, DurationMs: 1000, DirectMedia: direct}},
	}
	taskLookup := func(taskID string) (*model.Task, error) { return svc.repo.TaskForUser("usr-production", taskID) }
	resourceLookup := func(resourceID string) (*model.Resource, error) {
		return svc.repo.ResourceForUser("usr-production", resourceID)
	}
	probe := func(resourceID string) (*ResourceProbeResult, error) {
		return svc.ProbeResource("usr-production", resourceID, true)
	}
	if err := validateProductionRenderTimeline(updated.ProductionRun, steps, attempts, timeline, taskLookup, resourceLookup, probe); err != nil {
		t.Fatalf("full-decode reused media was rejected by the master timeline: %v", err)
	}
}

func TestProductionRenderUncertainAttemptDoesNotQueueAgain(t *testing.T) {
	fixture := newProductionRenderFixture(t)
	run, err := fixture.svc.repo.ProductionRunForUser("usr-production", fixture.run.ID)
	if err != nil {
		t.Fatalf("load run for audio policy: %v", err)
	}
	timeline, _ := applyProductionRenderAudioPolicy(*run, fixture.request.Timeline.Timeline)
	requestHash := productionJSONHash([]any{fixture.request.StepID, fixture.request.RetryOf, fixture.request.Timeline.ProjectID, timeline, fixture.request.Timeline.Output})
	attempt := model.ProductionAttempt{
		ID: "render-uncertain", RunID: fixture.run.ID, StepID: fixture.render.ID, AttemptNumber: 1,
		IdempotencyKey: fixture.request.IdempotencyKey, RequestHash: requestHash, State: "submitting",
	}
	if err := fixture.svc.repo.CreateProductionAttempt(&attempt); err != nil {
		t.Fatalf("create uncertain attempt: %v", err)
	}
	result, err := fixture.svc.SubmitProductionRenderStep("usr-production", fixture.run.ID, fixture.request)
	if err != nil {
		t.Fatalf("replay uncertain attempt: %v", err)
	}
	if result["idempotent"] != true || result["status"] != "submitting" || result["task"] != nil {
		t.Fatalf("uncertain replay = %#v", result)
	}
	var count int64
	if err := fixture.db.Model(&model.Task{}).Where("user_id = ?", "usr-production").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("task count = %d, want no duplicate render task", count)
	}
}

func TestProductionRenderOutputMustMatchBriefContract(t *testing.T) {
	run := model.ProductionRun{DeliveryContractJSON: `{"targetDurationMs":1000,"targetAspectRatio":"16:9"}`, PlanJSON: `{"executionManifest":{"timelineTimebase":{"fpsNumerator":30,"fpsDenominator":1}}}`}
	if err := validateProductionRenderOutput(run, renderOutputSpec{Width: 1080, Height: 1920, FPSNumerator: 30, FPSDenominator: 1}); err == nil || !strings.Contains(err.Error(), "画幅") {
		t.Fatalf("portrait output err = %v, want aspect rejection", err)
	}
	if err := validateProductionRenderOutput(run, renderOutputSpec{Width: 1920, Height: 1080, FPSNumerator: 30, FPSDenominator: 1}); err != nil {
		t.Fatalf("valid contract output rejected: %v", err)
	}
}

func TestProductionRenderBindsAudioTrackAndSubtitleToStoryboardRows(t *testing.T) {
	fixture := newProductionRenderFixture(t)
	audioStep := model.ProductionStep{
		ID: "audio-step", RunID: fixture.run.ID, StepKey: "audio:row-1:dialogue", Kind: "audio",
		StoryboardRowID: "row-1", TrackID: "dialogue", Status: "succeeded", AttemptCount: 1,
		OutputArtifactJSON: mapJSON([]string{"audio-resource"}),
	}
	manifest := decodeMap(fixture.run.PlanJSON)["executionManifest"].(map[string]any)
	manifest["audioMode"] = model.ProductionAudioModeRebuild
	manifest["audioPolicy"] = "independent"
	manifest["requireAudio"] = true
	manifest["requireSubtitle"] = true
	manifest["audioStepKeys"] = []string{"audio:row-1:dialogue"}
	manifest["audioTrackBindings"] = []any{map[string]any{
		"storyboardRowId": "row-1", "trackId": "dialogue", "stepKey": audioStep.StepKey,
		"rowStartMs": int64(0), "rowDurationMs": int64(1000), "kind": "dialogue",
	}}
	manifest["subtitleCues"] = []any{map[string]any{"storyboardRowId": "row-1", "startMs": int64(0), "durationMs": int64(1000), "text": "你好"}}
	run := model.ProductionRun{ID: fixture.run.ID, AudioMode: model.ProductionAudioModeRebuild, PlanJSON: mapJSON(map[string]any{"executionManifest": manifest})}
	if err := fixture.svc.repo.CreateProductionStep(&audioStep); err != nil {
		t.Fatalf("create audio step: %v", err)
	}
	audioAttempt := model.ProductionAttempt{ID: "audio-attempt", RunID: fixture.run.ID, StepID: audioStep.ID, AttemptNumber: 1, IdempotencyKey: "audio-key", State: "succeeded", GenerationTaskID: "audio-task"}
	if err := fixture.svc.repo.CreateProductionAttempt(&audioAttempt); err != nil {
		t.Fatalf("create audio attempt: %v", err)
	}
	if err := fixture.db.Create(&model.Task{
		ID: "audio-task", UserID: "usr-production", Type: "canvas_audio", Status: model.TaskStatusSucceeded,
		ProductionRunID: run.ID, ProductionStepID: audioStep.ID, ProductionAttemptID: audioAttempt.ID,
		StoryboardRowID: "row-1", TrackID: "dialogue", Model: "voice-x", Operation: "text_to_audio",
		ResultJSON: `{"audio":{"resourceId":"audio-resource"}}`,
	}).Error; err != nil {
		t.Fatalf("create audio task: %v", err)
	}
	if err := fixture.db.Create(&model.Resource{ID: "audio-resource", UserID: "usr-production", Kind: "audio", MimeType: "audio/mpeg", Status: model.ResourceStatusReady}).Error; err != nil {
		t.Fatalf("create audio resource: %v", err)
	}
	timeline := fixture.request.Timeline.Timeline
	timeline, _ = applyProductionRenderAudioPolicy(run, timeline)
	timeline.Tracks = append(timeline.Tracks, renderTrack{ID: "dialogue", Kind: "audio"}, renderTrack{ID: "subtitle", Kind: "subtitle"})
	timeline.Clips = append(timeline.Clips,
		renderClip{ID: "dialogue-clip", Kind: "audio", TrackID: "dialogue", StoryboardRowID: "row-1", StartMs: 0, DurationMs: 900, DirectMedia: &struct {
			ID         string `json:"id"`
			Kind       string `json:"kind"`
			StorageKey string `json:"storageKey"`
		}{ID: "audio-resource", Kind: "audio", StorageKey: "resource:audio-resource"}},
		renderClip{ID: "subtitle-clip", Kind: "subtitle", TrackID: "subtitle", StoryboardRowID: "row-1", StartMs: 0, DurationMs: 1000, Text: "你好"},
	)
	steps := []model.ProductionStep{fixture.videoStep, audioStep}
	attempts, err := fixture.svc.repo.ProductionAttempts(run.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	taskLookup := func(id string) (*model.Task, error) { return fixture.svc.repo.TaskForUser("usr-production", id) }
	resourceLookup := func(id string) (*model.Resource, error) {
		return fixture.svc.repo.ResourceForUser("usr-production", id)
	}
	if err := validateProductionRenderTimeline(run, steps, attempts, timeline, taskLookup, resourceLookup); err != nil {
		t.Fatalf("valid video/audio/subtitle trace rejected: %v", err)
	}
	wrongAudio := timeline
	wrongAudio.Clips = append([]renderClip(nil), timeline.Clips...)
	wrongAudioMedia := *wrongAudio.Clips[1].DirectMedia
	wrongAudioMedia.StorageKey = "resource:video-resource"
	wrongAudio.Clips[1].DirectMedia = &wrongAudioMedia
	if err := validateProductionRenderTimeline(run, steps, attempts, wrongAudio, taskLookup, resourceLookup); err == nil || !strings.Contains(err.Error(), "实际资源") {
		t.Fatalf("wrong audio resource err = %v, want audio task binding rejection", err)
	}
	wrongSubtitle := timeline
	wrongSubtitle.Clips = append([]renderClip(nil), timeline.Clips...)
	wrongSubtitle.Clips[2].Text = "错行字幕"
	if err := validateProductionRenderTimeline(run, steps, attempts, wrongSubtitle, taskLookup, resourceLookup); err == nil || !strings.Contains(err.Error(), "计划字幕") {
		t.Fatalf("wrong subtitle err = %v, want manifest cue rejection", err)
	}
}

func TestProductionRenderManifestFixtureRoundTripsAsJSON(t *testing.T) {
	fixture := newProductionRenderFixture(t)
	encoded, err := json.Marshal(fixture.request.Timeline.Timeline)
	if err != nil {
		t.Fatal(err)
	}
	var decoded renderProject
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	clip := decoded.Clips[0]
	if clip.StoryboardRowID != "row-1" || clip.SegmentID != "seg-1" || mediaResourceIDForProductionClip(clip) != "video-resource" {
		t.Fatalf("render binding fields failed JSON round trip: %#v", clip)
	}
}

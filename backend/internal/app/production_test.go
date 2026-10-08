package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestProductionRunCreateAuthorizeAndVersion(t *testing.T) {
	svc, _ := newTimelineTaskTestService(t)
	created, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey: "film-1",
		Brief:     map[string]any{"scriptResourceId": "script-1", "targetDurationMs": 30000},
		Plan:      map[string]any{"scenes": []any{map[string]any{"id": "scene-1"}}},
		Policy:    map[string]any{"authorizationStatus": "planning"},
		Quality:   map[string]any{"profile": "standard"},
		Steps: []ProductionStepInput{
			{StepKey: "shot-1-image", Kind: "image", InputFingerprint: "shot-1-v1"},
			{StepKey: "shot-1-video", Kind: "video", DependsOn: []string{"shot-1-image"}, InputFingerprint: "shot-1-v1"},
		},
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	if created.ID == "" || created.Status != "planning" || created.AudioMode != model.ProductionAudioModeNative || len(created.Steps) != 2 {
		t.Fatalf("created run = %#v", created)
	}
	rebuilt, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey: "film-rebuild-mode",
		AudioMode: model.ProductionAudioModeRebuild,
		Plan: map[string]any{"executionManifest": map[string]any{
			"audioMode": model.ProductionAudioModeRebuild, "audioPolicy": "independent",
			"audioStepKeys":      []any{"audio:row-1:music"},
			"audioTrackBindings": []any{map[string]any{"stepKey": "audio:row-1:music", "trackId": "music", "kind": "music"}},
		}},
		Steps: []ProductionStepInput{{StepKey: "audio:row-1:music", Kind: "audio", StoryboardRowID: "row-1", TrackID: "music"}},
	})
	if err != nil {
		t.Fatalf("create rebuild run: %v", err)
	}
	if rebuilt.AudioMode != model.ProductionAudioModeRebuild {
		t.Fatalf("explicit rebuild mode = %q, want %q", rebuilt.AudioMode, model.ProductionAudioModeRebuild)
	}
	again, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey: "film-1",
		Brief:     map[string]any{"scriptResourceId": "script-1", "targetDurationMs": 30000},
		Plan:      map[string]any{"scenes": []any{map[string]any{"id": "scene-1"}}},
		Policy:    map[string]any{"authorizationStatus": "planning"},
		Quality:   map[string]any{"profile": "standard"},
		Steps: []ProductionStepInput{
			{StepKey: "shot-1-image", Kind: "image", InputFingerprint: "shot-1-v1"},
			{StepKey: "shot-1-video", Kind: "video", DependsOn: []string{"shot-1-image"}, InputFingerprint: "shot-1-v1"},
		},
	})
	if err != nil || again.ID != created.ID {
		t.Fatalf("idempotent create = %#v, err=%v", again, err)
	}
	authorized, err := svc.AuthorizeProductionRun("usr-production", created.ID, ProductionAuthorizeRequest{
		ExpectedRevision: created.Revision,
		Policy: map[string]any{
			"allowedCapabilities": []any{"image", "video", "audio"},
			"maxRepairAttempts":   2,
		},
	})
	if err != nil {
		t.Fatalf("authorize run: %v", err)
	}
	if authorized.Status != "running" || !policyAuthorized(authorized.PolicyJSON) {
		t.Fatalf("authorized run = %#v", authorized)
	}
	if authorized.Revision <= created.Revision {
		t.Fatalf("revision did not advance: before=%d after=%d", created.Revision, authorized.Revision)
	}
}

func TestProductionRunRoundTripsUnavailableAudioCapabilityGap(t *testing.T) {
	svc, _ := newTimelineTaskTestService(t)
	plan := map[string]any{"executionManifest": map[string]any{
		"targetDurationMs": 1000, "targetAspectRatio": "16:9",
		"audioMode": model.ProductionAudioModeRebuild, "audioPolicy": "independent",
		"audioStepKeys": []any{}, "audioTrackBindings": []any{},
		"audioCapabilityGaps": []any{map[string]any{
			"storyboardRowId": "row-1", "trackId": "ambient-1", "kind": "ambient",
			"capability": "ambientSound", "missingCapabilities": []any{"ambientSound"},
			"status": "unavailable", "required": true, "reason": "当前能力目录未声明 ambientSound",
		}},
	}}
	created, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey: "audio-capability-gap-roundtrip", AudioMode: model.ProductionAudioModeRebuild,
		Brief: map[string]any{"targetDurationMs": 1000, "aspectRatio": "16:9"}, Plan: plan,
	})
	if err != nil {
		t.Fatalf("create run with explicit capability gap: %v", err)
	}
	readback, err := svc.GetProductionRun("usr-production", created.ID, 0)
	if err != nil {
		t.Fatalf("read back ProductionRun: %v", err)
	}
	manifest := productionRecord(readback.Plan["executionManifest"])
	gaps := productionManifestRecords(manifest["audioCapabilityGaps"])
	if readback.AudioMode != model.ProductionAudioModeRebuild || len(gaps) != 1 || stringValue(gaps[0]["status"]) != "unavailable" || stringValue(gaps[0]["capability"]) != "ambientSound" {
		t.Fatalf("audio mode or unavailable capability gap did not round-trip: mode=%q manifest=%#v", readback.AudioMode, manifest)
	}
	if len(readback.Steps) != 0 || len(readback.Attempts) != 0 {
		t.Fatalf("unavailable audio capability was persisted as a successful generation: steps=%#v attempts=%#v", readback.Steps, readback.Attempts)
	}
}

func TestProductionDeliveryContractRejectsShortPortraitClipForLongLandscapeBrief(t *testing.T) {
	brief := map[string]any{"targetDurationMs": float64(180000), "aspectRatio": "16:9", "requireAudio": true, "briefVersion": "brief-v1"}
	contract, err := normalizeProductionDeliveryContract(ProductionDeliveryContract{}, brief, 0)
	if err != nil {
		t.Fatalf("normalize contract: %v", err)
	}
	if contract.TargetDurationMs != 180000 || contract.TargetAspectRatio != "16:9" || !contract.RequireAudio || contract.BriefVersion != "brief-v1" {
		t.Fatalf("contract = %#v", contract)
	}
	run := model.ProductionRun{BriefJSON: mapJSON(brief), TargetDurationMs: contract.TargetDurationMs}
	probe := mediaProbeReport{FileSizeBytes: 1024, DurationMs: 5170, VideoStreams: 1, AudioStreams: 1, Width: 736, Height: 1280, Decoded: true}
	callerDuration := int64(5170)
	checks := evaluateProductionDelivery(contract, run, probe, ProductionDeliveryVerificationRequest{ExpectedDurationMs: &callerDuration})
	if status := deliveryStatus(checks); status != "failed" {
		t.Fatalf("delivery status = %s, want failed; checks=%#v", status, checks)
	}
	failed := map[string]bool{}
	for _, check := range checks {
		if check.Status == "failed" {
			failed[check.Name] = true
		}
	}
	if !failed["duration_contract"] || !failed["aspect_ratio_contract"] {
		t.Fatalf("short portrait clip did not fail duration and aspect ratio: %#v", checks)
	}
}

func TestProductionDeliveryAudioPolicyRequiresAudioTrack(t *testing.T) {
	noAudio := false
	tests := []struct {
		name  string
		brief map[string]any
		want  bool
	}{
		{
			name:  "music and ambience without dialogue",
			brief: map[string]any{"audioPolicy": "music and ambience only (no dialogue)"},
			want:  true,
		},
		{
			name: "nested audio policy",
			brief: map[string]any{"deliveryContract": map[string]any{
				"audioPolicy": "ambient sound only",
			}},
			want: true,
		},
		{
			name:  "explicit silence",
			brief: map[string]any{"audioPolicy": "none"},
			want:  false,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			contract, err := normalizeProductionDeliveryContract(ProductionDeliveryContract{}, test.brief, 1000)
			if err != nil {
				t.Fatalf("normalize contract: %v", err)
			}
			if contract.RequireAudio != test.want {
				t.Fatalf("RequireAudio = %v, want %v", contract.RequireAudio, test.want)
			}
			probe := mediaProbeReport{DurationMs: 1000, VideoStreams: 1, Width: 1600, Height: 900, Decoded: true}
			checks := evaluateProductionDelivery(contract, model.ProductionRun{
				BriefJSON:        mapJSON(test.brief),
				TargetDurationMs: 1000,
			}, probe, ProductionDeliveryVerificationRequest{RequireAudio: &noAudio})
			for _, check := range checks {
				if check.Name != "audio_stream" {
					continue
				}
				if test.want && (check.Status != "failed" || check.EffectiveRequirement != true) {
					t.Fatalf("audio check = %#v, want required and failed without a stream", check)
				}
				if !test.want && check.Status != "passed" {
					t.Fatalf("audio check = %#v, want optional pass for explicit silence", check)
				}
				return
			}
			t.Fatal("audio_stream check is missing")
		})
	}
}

func TestProductionDeliveryAcceptsNative736LandscapeWithinAspectRatioTolerance(t *testing.T) {
	const targetDurationMs = int64(5167)
	contract := ProductionDeliveryContract{
		TargetDurationMs:    targetDurationMs,
		TargetAspectRatio:   "16:9",
		DurationToleranceMs: 0,
		RequireVideo:        true,
		RequireFullDecode:   true,
	}
	run := model.ProductionRun{
		BriefJSON:        mapJSON(map[string]any{"targetDurationMs": targetDurationMs, "aspectRatio": "16:9"}),
		TargetDurationMs: targetDurationMs,
	}
	probe := mediaProbeReport{
		FileSizeBytes: 1024,
		DurationMs:    targetDurationMs,
		VideoStreams:  1,
		Width:         1280,
		Height:        736,
		Decoded:       true,
	}
	checks := evaluateProductionDelivery(contract, run, probe, ProductionDeliveryVerificationRequest{})
	for _, check := range checks {
		if check.Name == "aspect_ratio_contract" {
			if check.Status != "passed" {
				t.Fatalf("native 1280x736 frame status = %s, want passed within 3%% tolerance: %#v", check.Status, check)
			}
			return
		}
	}
	t.Fatal("aspect_ratio_contract check is missing")
}

func TestProductionDeliveryRejectsPortraitForLandscapeAspectRatio(t *testing.T) {
	contract := ProductionDeliveryContract{TargetDurationMs: 5000, TargetAspectRatio: "16:9", RequireVideo: true, RequireFullDecode: true}
	run := model.ProductionRun{BriefJSON: `{"targetDurationMs":5000,"aspectRatio":"16:9"}`, TargetDurationMs: 5000}
	probe := mediaProbeReport{FileSizeBytes: 1024, DurationMs: 5000, VideoStreams: 1, Width: 736, Height: 1280, Decoded: true}
	checks := evaluateProductionDelivery(contract, run, probe, ProductionDeliveryVerificationRequest{})
	for _, check := range checks {
		if check.Name == "aspect_ratio_contract" {
			if check.Status != "failed" {
				t.Fatalf("portrait frame status = %s, want failed: %#v", check.Status, check)
			}
			return
		}
	}
	t.Fatal("aspect_ratio_contract check is missing")
}

func TestProductionVideoProbeUsesNearbyRatioTolerance(t *testing.T) {
	nearby := ResourceProbeResult{
		MediaType: "video",
		Probe:     mediaProbeReport{Width: 1280, Height: 736, VideoStreams: 1},
	}
	if reason := productionVideoProbeFailure(nearby, "16:9"); reason != "" {
		t.Fatalf("nearby 1280x736 landscape was rejected: %s", reason)
	}
	nearby.Probe.Width, nearby.Probe.Height = 736, 1280
	if reason := productionVideoProbeFailure(nearby, "16:9"); reason == "" {
		t.Fatal("portrait 736x1280 video was accepted for a 16:9 target")
	}
}

func TestProductionVideoAudioObservationRecordsUnexpectedAAC(t *testing.T) {
	task := model.Task{InputJSON: `{"mode":"video","config":{"videoGenerateAudio":"false"}}`}
	media := ResourceProbeResult{ResourceID: "video-with-aac", Probe: mediaProbeReport{AudioStreams: 1}}
	observed := observeProductionVideoAudio(model.ProductionAudioModeRebuild, task, media)
	if observed.Status != "native_audio_discarded" || observed.AudioMode != model.ProductionAudioModeRebuild || observed.RequestedGenerateAudio != "false" || observed.ObservedAudioStreams != 1 {
		t.Fatalf("audio observation = %#v", observed)
	}
	if !strings.Contains(observed.Reason, "静音") {
		t.Fatalf("audio mismatch did not explain follow-up handling: %#v", observed)
	}

	media.Probe.AudioStreams = 0
	observed = observeProductionVideoAudio(model.ProductionAudioModeRebuild, task, media)
	if observed.Status != "native_audio_absent" {
		t.Fatalf("audio-disabled observation = %#v", observed)
	}
	media.Probe.AudioStreams = 1
	observed = observeProductionVideoAudio(model.ProductionAudioModeNative, task, media)
	if observed.Status != "native_audio_preserved" || !strings.Contains(observed.Reason, "不会调用 MiMo") {
		t.Fatalf("native audio was not explicitly preserved: %#v", observed)
	}
}

func TestProductionTaskArtifactsFindsNestedVideoResources(t *testing.T) {
	task := model.Task{ResultJSON: `{"video":{"resourceId":"video-1","artifactIds":["video-2"]},"resourceId":"video-1","metadata":{"outputArtifactIds":["poster-1"]}}`}
	artifacts := productionTaskArtifacts(task)
	videoArtifacts := productionTaskVideoArtifacts(task)
	if len(artifacts) != 3 || len(videoArtifacts) != 2 {
		t.Fatalf("artifacts = %#v, video artifacts = %#v", artifacts, videoArtifacts)
	}
	all := map[string]bool{}
	for _, id := range artifacts {
		all[id] = true
	}
	videos := map[string]bool{}
	for _, id := range videoArtifacts {
		videos[id] = true
	}
	if !all["video-1"] || !all["video-2"] || !all["poster-1"] || !videos["video-1"] || !videos["video-2"] || videos["poster-1"] {
		t.Fatalf("artifact classification is incorrect: all=%#v videos=%#v", all, videos)
	}
}

func TestProductionReconcilerBlocksPortraitVideoAndRecordsMediaProbe(t *testing.T) {
	t.Setenv("CANVAS_PRODUCTION_AUTO_REPAIR", "true")
	svc, _ := newTimelineTaskTestService(t)
	run, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey: "film-video-quality-gate",
		Brief:     map[string]any{"targetDurationMs": int64(180000), "aspectRatio": "16:9"},
		Steps: []ProductionStepInput{{
			StepKey: "shot-01-segment-0", Kind: "video", StoryboardRowID: "shot-01", SegmentID: "seg-0", SegmentOrder: 0,
		}},
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	step := run.Steps[0].ProductionStep
	step.Status = "running"
	step.AttemptCount = 1
	if err := svc.repo.SaveProductionStep(&step); err != nil {
		t.Fatalf("save step: %v", err)
	}
	attempt := model.ProductionAttempt{
		ID: "attempt-video-quality", RunID: run.ID, StepID: step.ID, AttemptNumber: 1,
		IdempotencyKey: "video-quality-key", RequestHash: "video-quality-hash", State: "running",
		GenerationTaskID: "task-video-quality",
	}
	if err := svc.repo.CreateProductionAttempt(&attempt); err != nil {
		t.Fatalf("create attempt: %v", err)
	}
	task := model.Task{
		ID: "task-video-quality", Status: model.TaskStatusSucceeded,
		ResultJSON: `{"video":{"resourceId":"portrait-resource"}}`,
	}
	quality := &productionVideoQualityObservation{
		ArtifactIDs: []string{"portrait-resource"}, TargetAspectRatio: "16:9", Passed: false,
		Reason: "实测画幅 9:16 不符合制作计划要求 16:9",
		Audio: []productionVideoAudioObservation{{
			ResourceID: "portrait-resource", RequestedGenerateAudio: "false", ObservedAudioStreams: 1,
			Status: "unexpected_audio_present", Reason: "请求关闭原生音频，但实测包含音轨",
		}},
		Media: []ResourceProbeResult{{
			ResourceID: "portrait-resource", MediaType: "video",
			Probe: mediaProbeReport{Width: 736, Height: 1280, VideoStreams: 1, AudioStreams: 1, DurationMs: 5170},
		}},
	}
	if err := svc.applyProductionAttemptObservation(attempt, task, quality); err != nil {
		t.Fatalf("apply observation: %v", err)
	}
	actual, err := svc.GetProductionRun("usr-production", run.ID, 0)
	if err != nil {
		t.Fatalf("get run: %v", err)
	}
	if actual.Steps[0].Status != "failed" || actual.Steps[0].BlockingReason != quality.Reason || actual.Status != "repairing" {
		t.Fatalf("mismatched portrait output was accepted: run=%s step=%#v", actual.Status, actual.Steps[0])
	}
	if actual.Attempts[0].State != "quality_failed" || actual.Attempts[0].ErrorCode != "video_quality_failed" {
		t.Fatalf("attempt did not retain the quality failure: %#v", actual.Attempts[0])
	}
	retryStep, err := svc.repo.ProductionStepByKey(run.ID, step.StepKey)
	if err != nil {
		t.Fatalf("load failed step for repair: %v", err)
	}
	if err := validateProductionStepAttempt(svc.repo, retryStep, actual.Attempts[0].ID); err != nil {
		t.Fatalf("confirmed quality failure must allow a same-step repair attempt: %v", err)
	}
	if len(actual.Steps[0].OutputArtifactIDs) != 1 || actual.Steps[0].OutputArtifactIDs[0] != "portrait-resource" {
		t.Fatalf("failed artifact was not preserved for traceability: %#v", actual.Steps[0].OutputArtifactIDs)
	}
	var qualityEvent *model.ProductionRunEvent
	for index := range actual.Events {
		if actual.Events[index].Type == "step_quality_failed" {
			qualityEvent = &actual.Events[index]
		}
	}
	if qualityEvent == nil {
		t.Fatalf("missing quality event: %#v", actual.Events)
	}
	payload := decodeMap(qualityEvent.PayloadJSON)
	videoQuality, ok := payload["videoQuality"].(map[string]any)
	if !ok || stringValue(videoQuality["targetAspectRatio"]) != "16:9" {
		t.Fatalf("event did not retain the delivery contract: %#v", payload)
	}
	mediaItems, ok := videoQuality["media"].([]any)
	if !ok || len(mediaItems) != 1 {
		t.Fatalf("event did not retain media probe results: %#v", videoQuality)
	}
	media, ok := mediaItems[0].(map[string]any)
	if !ok {
		t.Fatalf("media probe result malformed: %#v", mediaItems[0])
	}
	probe, ok := media["probe"].(map[string]any)
	if !ok || int64Value(probe["audioStreams"]) != 1 {
		t.Fatalf("audio stream observation was lost: %#v", media)
	}
	audioItems, ok := videoQuality["audio"].([]any)
	if !ok || len(audioItems) != 1 || stringValue(productionRecord(audioItems[0])["status"]) != "unexpected_audio_present" {
		t.Fatalf("request/output audio conflict was not persisted in quality evidence: %#v", videoQuality["audio"])
	}
}

func TestProductionReconcilerProbesRealNestedVideoResource(t *testing.T) {
	ffmpeg := requireCommand(t, "ffmpeg")
	_ = requireCommand(t, "ffprobe")
	t.Setenv("CANVAS_PRODUCTION_AUTO_REPAIR", "true")
	svc, db := newTimelineTaskTestService(t)
	svc.dataDir = t.TempDir()
	objectKey := "video/portrait.mp4"
	resourcePath := filepath.Join(svc.dataDir, "resources", filepath.FromSlash(objectKey))
	if err := os.MkdirAll(filepath.Dir(resourcePath), 0o750); err != nil {
		t.Fatalf("create resource directory: %v", err)
	}
	runCommand(t, ffmpeg,
		"-v", "error", "-y",
		"-f", "lavfi", "-i", "color=c=blue:s=736x1280:r=24:d=1",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
		"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-shortest", resourcePath)
	resourceInfo, err := os.Stat(resourcePath)
	if err != nil {
		t.Fatalf("stat generated resource: %v", err)
	}
	resource := model.Resource{
		ID: "portrait-resource", UserID: "usr-production", Kind: "video", Status: model.ResourceStatusReady,
		Provider: "local", ObjectKey: objectKey, MimeType: "video/mp4", Size: resourceInfo.Size(),
	}
	if err := svc.repo.CreateResource(&resource); err != nil {
		t.Fatalf("create resource: %v", err)
	}
	run, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey: "film-real-video-probe",
		Brief:     map[string]any{"targetDurationMs": int64(180000), "aspectRatio": "16:9"},
		Steps: []ProductionStepInput{{
			StepKey: "shot-01-segment-0", Kind: "video", StoryboardRowID: "shot-01", SegmentID: "seg-0", SegmentOrder: 0,
		}},
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	step := run.Steps[0].ProductionStep
	step.Status = "running"
	step.AttemptCount = 1
	if err := svc.repo.SaveProductionStep(&step); err != nil {
		t.Fatalf("save step: %v", err)
	}
	attempt := model.ProductionAttempt{
		ID: "attempt-real-video-probe", RunID: run.ID, StepID: step.ID, AttemptNumber: 1,
		IdempotencyKey: "real-video-probe-key", RequestHash: "real-video-probe-hash", State: "running",
		GenerationTaskID: "task-real-video-probe",
	}
	if err := svc.repo.CreateProductionAttempt(&attempt); err != nil {
		t.Fatalf("create attempt: %v", err)
	}
	task := model.Task{
		ID: "task-real-video-probe", UserID: "usr-production", Type: "canvas_video", Status: model.TaskStatusSucceeded,
		ProductionRunID: run.ID, ProductionStepID: step.ID, ProductionAttemptID: attempt.ID,
		StoryboardRowID: "shot-01", SegmentID: "seg-0",
		ResultJSON: `{"video":{"resourceId":"portrait-resource"}}`,
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := svc.ReconcileProductionRunsOnce(); err != nil {
		t.Fatalf("reconcile real video task: %v", err)
	}
	actual, err := svc.GetProductionRun("usr-production", run.ID, 0)
	if err != nil {
		t.Fatalf("get run: %v", err)
	}
	if actual.Steps[0].Status != "failed" || actual.Status != "repairing" || actual.Attempts[0].State != "quality_failed" {
		t.Fatalf("real portrait resource passed production reconciliation: run=%s step=%#v attempt=%#v", actual.Status, actual.Steps[0], actual.Attempts[0])
	}
	if len(actual.Steps[0].OutputArtifactIDs) != 1 || actual.Steps[0].OutputArtifactIDs[0] != resource.ID {
		t.Fatalf("nested video resource was not bound to its step: %#v", actual.Steps[0].OutputArtifactIDs)
	}
	qualityEventFound := false
	for _, event := range actual.Events {
		if event.Type != "step_quality_failed" {
			continue
		}
		payload := decodeMap(event.PayloadJSON)
		videoQuality, ok := payload["videoQuality"].(map[string]any)
		if !ok {
			t.Fatalf("quality event omitted its evidence: %#v", payload)
		}
		mediaItems, ok := videoQuality["media"].([]any)
		if !ok || len(mediaItems) != 1 {
			t.Fatalf("quality event omitted its media probe: %#v", videoQuality)
		}
		media, ok := mediaItems[0].(map[string]any)
		if !ok {
			t.Fatalf("malformed media probe result: %#v", mediaItems[0])
		}
		probe, ok := media["probe"].(map[string]any)
		if !ok || int64Value(probe["width"]) != 736 || int64Value(probe["height"]) != 1280 || int64Value(probe["audioStreams"]) != 1 {
			t.Fatalf("real ffprobe dimensions/audio were not preserved: %#v", media)
		}
		qualityEventFound = true
	}
	if !qualityEventFound {
		t.Fatalf("missing real resource quality event: %#v", actual.Events)
	}
}

func TestProductionDeliveryContractAcceptsMeasuredTargetAndRequiresRealDecode(t *testing.T) {
	contract := ProductionDeliveryContract{TargetDurationMs: 180000, TargetAspectRatio: "16:9", DurationToleranceMs: 1000, RequireVideo: true, RequireFullDecode: true}
	run := model.ProductionRun{BriefJSON: `{"targetDurationMs":180000,"aspectRatio":"16:9"}`, TargetDurationMs: 180000}
	probe := mediaProbeReport{FileSizeBytes: 1024, DurationMs: 180000, VideoStreams: 1, Width: 1920, Height: 1080, Decoded: true, VideoFrameSamples: []mediaVideoFrameSample{
		{Position: "start", TimestampMs: 0, Decoded: true, ImageBytes: 128},
		{Position: "middle", TimestampMs: 90000, Decoded: true, ImageBytes: 128},
		{Position: "end", TimestampMs: 179750, Decoded: true, ImageBytes: 128},
	}}
	if status := deliveryStatus(evaluateProductionDelivery(contract, run, probe, ProductionDeliveryVerificationRequest{})); status != "passed" {
		t.Fatalf("delivery status = %s, want passed", status)
	}
	probe.VideoFrameSamples = nil
	missingSamples := evaluateProductionDelivery(contract, run, probe, ProductionDeliveryVerificationRequest{})
	if status := deliveryStatus(missingSamples); status != "uncertain" {
		t.Fatalf("delivery status without first/middle/last samples = %s, want uncertain", status)
	}
	probe.VideoFrameSamples = []mediaVideoFrameSample{
		{Position: "start", TimestampMs: 0, Decoded: true, ImageBytes: 128},
		{Position: "middle", TimestampMs: 90000, Decoded: true, ImageBytes: 128},
		{Position: "end", TimestampMs: 179750, Decoded: true, ImageBytes: 128},
	}
	probe.Decoded = false
	checks := evaluateProductionDelivery(contract, run, probe, ProductionDeliveryVerificationRequest{})
	if status := deliveryStatus(checks); status != "uncertain" {
		t.Fatalf("undecoded delivery status = %s, want uncertain", status)
	}
}

func TestProductionDeliveryContractRejectsConflictingBriefAndRunValues(t *testing.T) {
	_, err := normalizeProductionDeliveryContract(ProductionDeliveryContract{TargetDurationMs: 5170, TargetAspectRatio: "9:16"}, map[string]any{"targetDurationMs": float64(180000), "aspectRatio": "16:9"}, 180000)
	if err == nil || !strings.Contains(err.Error(), "不一致") {
		t.Fatalf("err = %v, want conflicting contract error", err)
	}
}

func TestProductionDeliveryRequiresEveryStepAndRunOwnedRenderArtifact(t *testing.T) {
	steps := []model.ProductionStep{
		{Kind: "storyboard_video", Status: "succeeded", OutputArtifactJSON: mapJSON([]string{"shot-resource"})},
		{Kind: "final_render", Status: "succeeded", OutputArtifactJSON: mapJSON([]string{"final-resource"})},
	}
	if !productionStepsReady(steps) {
		t.Fatal("all succeeded steps should be ready")
	}
	if !productionResourceLinkedToRun(steps, "final-resource") {
		t.Fatal("final resource should be linked to its run render step")
	}
	if productionResourceLinkedToRun(steps, "shot-resource") {
		t.Fatal("a shot resource must not substitute for the final render")
	}
	steps[1].Status = "running"
	if productionStepsReady(steps) || productionResourceLinkedToRun(steps, "final-resource") {
		t.Fatal("an unfinished render must not satisfy final delivery")
	}
}

func TestProductionManifestRequiresEveryStoryboardSegmentAndTrace(t *testing.T) {
	contract := ProductionDeliveryContract{TargetDurationMs: 1000, TargetAspectRatio: "16:9", DurationToleranceMs: 0}
	manifest := map[string]any{
		"productionSpecVersion": "v1",
		"targetDurationMs":      int64(1000),
		"targetAspectRatio":     "16:9",
		"audioMode":             model.ProductionAudioModeNative,
		"audioPolicy":           "native",
		"videoStepKeys":         []string{"video:row-1:seg-1"},
		"audioStepKeys":         []string{},
		"sharedAssetStepKeys":   []string{},
		"rowAssetBindings":      []any{map[string]any{"storyboardRowId": "row-1", "sharedAssetIds": []any{}, "segmentIds": []any{"seg-1"}}},
		"selectedModelsBySegment": []any{map[string]any{
			"storyboardRowId": "row-1", "segmentId": "seg-1", "model": "model-x", "capabilityRevision": "model-x:1", "operation": "text_to_video",
		}},
		"timelineSpans":    []any{map[string]any{"storyboardRowId": "row-1", "segmentId": "seg-1", "startFrame": int64(0), "durationFrames": int64(30)}},
		"timelineTimebase": map[string]any{"fpsNumerator": int64(30), "fpsDenominator": int64(1), "totalFrames": int64(30), "durationMs": int64(1000)},
		"skillEvidence":    []any{map[string]any{"skillId": "continuity", "versionId": "v1", "contentHash": "sha256:fixture", "phase": "preflight"}},
	}
	steps := []model.ProductionStep{
		{ID: "step-video", StepKey: "video:row-1:seg-1", Kind: "video", StoryboardRowID: "row-1", SegmentID: "seg-1", SelectedStrategyID: "model-x@model-x:1:text_to_video", Status: "succeeded", AttemptCount: 1},
		{ID: "step-qc", StepKey: "quality:shot:row-1", Kind: "check", StoryboardRowID: "row-1", Status: "succeeded"},
		{ID: "step-continuity", StepKey: "continuity:row-1", Kind: "check", StoryboardRowID: "row-1", Status: "succeeded"},
		{ID: "step-timeline", StepKey: "timeline:master", Kind: "render", Status: "succeeded"},
		{ID: "step-full-qa", StepKey: "quality:full-film", Kind: "verify", Status: "succeeded"},
		{ID: "step-delivery", StepKey: "delivery:contract", Kind: "delivery_check", Status: "pending"},
	}
	attempts := []model.ProductionAttempt{{ID: "attempt-1", RunID: "run-1", StepID: "step-video", AttemptNumber: 1, CapabilityRevision: "model-x:1", GenerationTaskID: "task-1", State: "succeeded"}}
	plan := mapJSON(map[string]any{"executionManifest": manifest})
	audit := inspectProductionManifest(plan, contract, steps, attempts)
	if len(audit.Issues) != 0 || len(audit.Segments) != 1 {
		t.Fatalf("valid manifest with server-owned pending delivery step audit issues=%v segments=%v", audit.Issues, audit.Segments)
	}
	taskIssues := productionManifestTaskIssues("run-1", "user-1", audit, func(taskID string) (*model.Task, error) {
		if taskID != "task-1" {
			return nil, os.ErrNotExist
		}
		return &model.Task{
			ID: taskID, UserID: "user-1", Status: model.TaskStatusSucceeded, Model: "model-x", Operation: "text_to_video", CapabilityRevision: "model-x:1",
			ProductionRunID: "run-1", ProductionStepID: "step-video", ProductionAttemptID: "attempt-1", StoryboardRowID: "row-1", SegmentID: "seg-1",
		}, nil
	})
	if len(taskIssues) != 0 {
		t.Fatalf("valid task trace issues=%v", taskIssues)
	}

	manifest["rowAssetBindings"] = []any{map[string]any{"storyboardRowId": "row-1", "sharedAssetIds": []any{}, "segmentIds": []any{"seg-1", "seg-2"}}}
	manifest["videoStepKeys"] = []string{"video:row-1:seg-1"}
	manifest["selectedModelsBySegment"] = append(manifest["selectedModelsBySegment"].([]any), map[string]any{
		"storyboardRowId": "row-1", "segmentId": "seg-2", "model": "model-x", "capabilityRevision": "model-x:1", "operation": "text_to_video",
	})
	broken := inspectProductionManifest(mapJSON(map[string]any{"executionManifest": manifest}), contract, steps, attempts)
	if !strings.Contains(strings.Join(broken.Issues, ","), "manifest_segment_step_missing:seg-2") {
		t.Fatalf("missing second planned segment was accepted: %v", broken.Issues)
	}
}

func TestProductionManifestRequiresEveryAudioTrackAndPersistedTaskTrace(t *testing.T) {
	contract := ProductionDeliveryContract{TargetDurationMs: 1000, TargetAspectRatio: "16:9", DurationToleranceMs: 0, RequireAudio: true}
	manifest := map[string]any{
		"targetDurationMs": int64(1000), "targetAspectRatio": "16:9", "audioMode": model.ProductionAudioModeRebuild, "audioPolicy": "independent", "requireAudio": true,
		"videoStepKeys": []string{"video:row-1:seg-1"}, "audioStepKeys": []string{"audio:row-1:dialogue"},
		"audioTrackBindings": []any{map[string]any{
			"storyboardRowId": "row-1", "trackId": "dialogue", "stepKey": "audio:row-1:dialogue",
			"kind": "dialogue", "model": "voice-model", "capabilityRevision": "voice-model:4",
		}},
		"sharedAssetStepKeys": []string{},
		"rowAssetBindings":    []any{map[string]any{"storyboardRowId": "row-1", "sharedAssetIds": []any{}, "segmentIds": []any{"seg-1"}}},
		"selectedModelsBySegment": []any{map[string]any{
			"storyboardRowId": "row-1", "segmentId": "seg-1", "model": "video-model", "capabilityRevision": "video-model:1", "operation": "text_to_video",
		}},
		"timelineSpans":    []any{map[string]any{"storyboardRowId": "row-1", "segmentId": "seg-1", "startFrame": int64(0), "durationFrames": int64(30)}},
		"timelineTimebase": map[string]any{"fpsNumerator": int64(30), "fpsDenominator": int64(1), "totalFrames": int64(30), "durationMs": int64(1000)},
		"skillEvidence":    []any{map[string]any{"skillId": "continuity", "versionId": "v1", "contentHash": "sha256:fixture", "phase": "preflight"}},
	}
	steps := []model.ProductionStep{
		{ID: "step-video", StepKey: "video:row-1:seg-1", Kind: "video", StoryboardRowID: "row-1", SegmentID: "seg-1", SelectedStrategyID: "video-model@video-model:1:text_to_video", Status: "succeeded", AttemptCount: 1},
		{ID: "step-audio", StepKey: "audio:row-1:dialogue", Kind: "audio", StoryboardRowID: "row-1", TrackID: "dialogue", SelectedStrategyID: "dialogue:voice-model@voice-model:4", Status: "succeeded", AttemptCount: 1},
		{ID: "step-qc", StepKey: "quality:shot:row-1", Kind: "check", StoryboardRowID: "row-1", Status: "succeeded"},
		{ID: "step-continuity", StepKey: "continuity:row-1", Kind: "check", StoryboardRowID: "row-1", Status: "succeeded"},
		{ID: "step-timeline", StepKey: "timeline:master", Kind: "render", Status: "succeeded"},
		{ID: "step-full-qa", StepKey: "quality:full-film", Kind: "verify", Status: "succeeded"},
		{ID: "step-delivery", StepKey: "delivery:contract", Kind: "delivery_check", Status: "succeeded"},
	}
	attempts := []model.ProductionAttempt{
		{ID: "attempt-video", RunID: "run-1", StepID: "step-video", AttemptNumber: 1, CapabilityRevision: "video-model:1", GenerationTaskID: "task-video", State: "succeeded"},
		{ID: "attempt-audio", RunID: "run-1", StepID: "step-audio", AttemptNumber: 1, CapabilityRevision: "voice-model:4", GenerationTaskID: "task-audio", State: "succeeded"},
	}
	audit := inspectProductionManifest(mapJSON(map[string]any{"executionManifest": manifest}), contract, steps, attempts)
	if len(audit.Issues) != 0 || len(audit.AudioTracks) != 1 {
		t.Fatalf("audio manifest audit issues=%v tracks=%v", audit.Issues, audit.AudioTracks)
	}
	tasks := map[string]*model.Task{
		"task-video": {ID: "task-video", UserID: "user-1", Status: model.TaskStatusSucceeded, Model: "video-model", Operation: "text_to_video", CapabilityRevision: "video-model:1", ProductionRunID: "run-1", ProductionStepID: "step-video", ProductionAttemptID: "attempt-video", StoryboardRowID: "row-1", SegmentID: "seg-1"},
		"task-audio": {ID: "task-audio", UserID: "user-1", Status: model.TaskStatusSucceeded, Model: "voice-model", Operation: "text_to_audio", CapabilityRevision: "voice-model:4", ProductionRunID: "run-1", ProductionStepID: "step-audio", ProductionAttemptID: "attempt-audio", StoryboardRowID: "row-1", TrackID: "dialogue"},
	}
	taskIssues := productionManifestTaskIssues("run-1", "user-1", audit, func(taskID string) (*model.Task, error) {
		if task := tasks[taskID]; task != nil {
			return task, nil
		}
		return nil, os.ErrNotExist
	})
	if len(taskIssues) != 0 {
		t.Fatalf("valid audio task trace issues=%v", taskIssues)
	}

	tasks["task-audio"].TrackID = "wrong-track"
	if issues := productionManifestTaskIssues("run-1", "user-1", audit, func(taskID string) (*model.Task, error) {
		if task := tasks[taskID]; task != nil {
			return task, nil
		}
		return nil, os.ErrNotExist
	}); !strings.Contains(strings.Join(issues, ","), "manifest_audio_task_binding_mismatch:dialogue") {
		t.Fatalf("wrong persisted audio track was accepted: %v", issues)
	}
}

func TestProductionManifestBlocksDeliveryForRequiredUnavailableAudioCapability(t *testing.T) {
	manifest := map[string]any{
		"targetDurationMs":   1000,
		"targetAspectRatio":  "16:9",
		"audioMode":          model.ProductionAudioModeRebuild,
		"audioPolicy":        "independent",
		"audioStepKeys":      []any{},
		"audioTrackBindings": []any{},
		"audioCapabilityGaps": []any{map[string]any{
			"storyboardRowId": "row-1", "trackId": "music", "kind": "music",
			"capability": "music", "status": "unavailable", "required": true,
			"reason": "当前能力目录未声明 music",
		}},
	}
	audit := inspectProductionManifest(mapJSON(map[string]any{"executionManifest": manifest}), ProductionDeliveryContract{TargetDurationMs: 1000, TargetAspectRatio: "16:9"}, nil, nil)
	if !strings.Contains(strings.Join(audit.Issues, ","), "manifest_audio_capability_missing:row-1:music:music") {
		t.Fatalf("required missing audio capability did not block final acceptance: %v", audit.Issues)
	}
}

func TestProductionManifestPrefersMeasuredNativeAudioOverCapabilityDeclaration(t *testing.T) {
	contract := ProductionDeliveryContract{TargetDurationMs: 1000, TargetAspectRatio: "16:9", DurationToleranceMs: 0, RequireAudio: true}
	manifest := map[string]any{
		"targetDurationMs":    int64(1000),
		"targetAspectRatio":   "16:9",
		"audioMode":           model.ProductionAudioModeNative,
		"audioPolicy":         "native",
		"requireAudio":        true,
		"videoStepKeys":       []string{"video:row-1:seg-1"},
		"audioStepKeys":       []any{},
		"audioTrackBindings":  []any{},
		"audioCapabilityGaps": []any{},
		"sharedAssetStepKeys": []string{},
		"rowAssetBindings":    []any{map[string]any{"storyboardRowId": "row-1", "sharedAssetIds": []any{}, "segmentIds": []any{"seg-1"}}},
		"selectedModelsBySegment": []any{map[string]any{
			"storyboardRowId": "row-1", "segmentId": "seg-1", "model": "MiniMax-H3", "capabilityRevision": "MiniMax-H3:1", "operation": "text_to_video",
			"generateAudio": false, "supportsNativeAudio": false,
		}},
		"timelineSpans":    []any{map[string]any{"storyboardRowId": "row-1", "segmentId": "seg-1", "startFrame": int64(0), "durationFrames": int64(30)}},
		"timelineTimebase": map[string]any{"fpsNumerator": int64(30), "fpsDenominator": int64(1), "totalFrames": int64(30), "durationMs": int64(1000)},
		"skillEvidence":    []any{map[string]any{"skillId": "continuity", "versionId": "v1", "contentHash": "sha256:fixture", "phase": "preflight"}},
	}
	steps := []model.ProductionStep{
		{ID: "step-video", StepKey: "video:row-1:seg-1", Kind: "video", StoryboardRowID: "row-1", SegmentID: "seg-1", SelectedStrategyID: "MiniMax-H3@MiniMax-H3:1:text_to_video", Status: "succeeded", AttemptCount: 1, OutputArtifactJSON: mapJSON([]string{"res-1"})},
		{ID: "step-qc", StepKey: "quality:shot:row-1", Kind: "check", StoryboardRowID: "row-1", Status: "succeeded"},
		{ID: "step-continuity", StepKey: "continuity:row-1", Kind: "check", StoryboardRowID: "row-1", Status: "succeeded"},
		{ID: "step-timeline", StepKey: "timeline:master", Kind: "render", Status: "succeeded"},
		{ID: "step-full-qa", StepKey: "quality:full-film", Kind: "verify", Status: "succeeded"},
		{ID: "step-delivery", StepKey: "delivery:contract", Kind: "delivery_check", Status: "pending"},
	}
	plan := mapJSON(map[string]any{"executionManifest": manifest})
	noEvidence := inspectProductionManifest(plan, contract, steps, nil)
	if issues := strings.Join(noEvidence.Issues, ","); strings.Contains(issues, "manifest_native_audio_capability_missing") || strings.Contains(issues, "manifest_native_audio_stream_missing") {
		t.Fatalf("拿不到实测证据时不能只凭能力声明阻断：%v", noEvidence.Issues)
	}
	if !strings.Contains(strings.Join(noEvidence.Warnings, ","), "manifest_native_audio_declaration_unsupported:row-1:seg-1") {
		t.Fatalf("声明与要求不一致时应留下可追踪警告：%v", noEvidence.Warnings)
	}
	qualityWith := func(audioStreams int) string {
		return mapJSON(map[string]any{"stepResults": map[string]any{"quality:shot:row-1": map[string]any{
			"status":   "passed",
			"evidence": map[string]any{"media": map[string]any{"resourceId": "res-1", "probe": map[string]any{"audioStreams": audioStreams, "videoStreams": 1}}},
		}}})
	}
	measured := inspectProductionManifest(plan, contract, steps, nil, qualityWith(1))
	if issues := strings.Join(measured.Issues, ","); strings.Contains(issues, "manifest_native_audio") {
		t.Fatalf("实测已检到音轨时不应再按声明拦截：%v", measured.Issues)
	}
	silent := inspectProductionManifest(plan, contract, steps, nil, qualityWith(0))
	if !strings.Contains(strings.Join(silent.Issues, ","), "manifest_native_audio_stream_missing:row-1:seg-1") {
		t.Fatalf("实测没有音轨时必须拦截交付：%v", silent.Issues)
	}
}

func TestProductionStepGraphRejectsMissingDependency(t *testing.T) {
	svc, _ := newTimelineTaskTestService(t)
	_, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey: "film-invalid-graph",
		Steps: []ProductionStepInput{
			{StepKey: "video", Kind: "video", DependsOn: []string{"missing-image"}},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "依赖不存在") {
		t.Fatalf("err = %v, want dependency error", err)
	}
}

func TestProductionPlanMutationInvalidatesDownstreamAndReportsReworkCost(t *testing.T) {
	svc, _ := newTimelineTaskTestService(t)
	steps := []ProductionStepInput{
		{StepKey: "character-asset", Kind: "image", InputFingerprint: "character-v1", EstimatedCostMicros: 100},
		{StepKey: "shot-01-video", Kind: "video", StoryboardRowID: "shot-01", SegmentID: "shot-01-segment-0", SegmentOrder: 0, DependsOn: []string{"character-asset"}, InputFingerprint: "video-v1", EstimatedCostMicros: 250},
		{StepKey: "shot-01-qc", Kind: "check", StoryboardRowID: "shot-01", DependsOn: []string{"shot-01-video"}, InputFingerprint: "qc-v1"},
	}
	run, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{ClientKey: "film-invalidation", BudgetLimit: 1000, Steps: steps})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	authorized, err := svc.AuthorizeProductionRun("usr-production", run.ID, ProductionAuthorizeRequest{ExpectedRevision: run.Revision, Policy: map[string]any{"authorizationStatus": "authorized", "budgetPolicy": "bounded"}})
	if err != nil {
		t.Fatalf("authorize run: %v", err)
	}
	for _, stepOutput := range authorized.Steps {
		step := stepOutput.ProductionStep
		step.Status = "succeeded"
		step.AttemptCount = 1
		step.OutputArtifactJSON = `[` + `"resource-` + step.StepKey + `"` + `]`
		if err := svc.repo.SaveProductionStep(&step); err != nil {
			t.Fatalf("mark %s succeeded: %v", step.StepKey, err)
		}
	}
	steps[0].InputFingerprint = "character-v2"
	updated, err := svc.UpdateProductionPlan("usr-production", run.ID, ProductionPlanRequest{ExpectedRevision: authorized.Revision, Steps: steps})
	if err != nil {
		t.Fatalf("update plan: %v", err)
	}
	byKey := map[string]model.ProductionStep{}
	for _, item := range updated.Steps {
		byKey[item.StepKey] = item.ProductionStep
	}
	for _, key := range []string{"character-asset", "shot-01-video", "shot-01-qc"} {
		if byKey[key].Status != "pending" || byKey[key].OutputArtifactJSON != "[]" {
			t.Fatalf("changed step %s was not invalidated: %+v", key, byKey[key])
		}
	}
	if updated.Status != "planning" || stringValue(decodeMap(updated.PolicyJSON)["authorizationStatus"]) != "planning" {
		t.Fatalf("plan edit must require renewed authorization: status=%s policy=%s", updated.Status, updated.PolicyJSON)
	}
	if len(updated.Events) == 0 {
		t.Fatal("updated run did not return plan update evidence")
	}
	payload := decodeMap(updated.Events[len(updated.Events)-1].PayloadJSON)
	if intValue(payload["estimatedReworkCostMicros"]) != 350 {
		t.Fatalf("estimated rework cost = %#v, want 350", payload["estimatedReworkCostMicros"])
	}
	invalidated, _ := payload["invalidatedStepKeys"].([]any)
	if len(invalidated) != 3 {
		t.Fatalf("invalidated keys = %#v, want asset, video, and downstream QC", invalidated)
	}
}

func TestProductionPlanMutationKeepsUnaffectedShotsIntact(t *testing.T) {
	svc, _ := newTimelineTaskTestService(t)
	steps := []ProductionStepInput{
		{StepKey: "character-asset", Kind: "image", InputFingerprint: "character-v1", EstimatedCostMicros: 100},
		{StepKey: "shot-01-video", Kind: "video", StoryboardRowID: "shot-01", SegmentID: "shot-01-segment-0", SegmentOrder: 0, DependsOn: []string{"character-asset"}, InputFingerprint: "video-v1", EstimatedCostMicros: 250},
		{StepKey: "shot-02-video", Kind: "video", StoryboardRowID: "shot-02", SegmentID: "shot-02-segment-0", SegmentOrder: 0, InputFingerprint: "video-v1", EstimatedCostMicros: 250},
		{StepKey: "shot-02-qc", Kind: "check", StoryboardRowID: "shot-02", DependsOn: []string{"shot-02-video"}, InputFingerprint: "qc-v1"},
	}
	run, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{ClientKey: "film-unaffected-shot", BudgetLimit: 1000, Steps: steps})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	authorized, err := svc.AuthorizeProductionRun("usr-production", run.ID, ProductionAuthorizeRequest{ExpectedRevision: run.Revision, Policy: map[string]any{"authorizationStatus": "authorized", "budgetPolicy": "bounded"}})
	if err != nil {
		t.Fatalf("authorize run: %v", err)
	}
	for _, stepOutput := range authorized.Steps {
		step := stepOutput.ProductionStep
		step.Status = "succeeded"
		step.AttemptCount = 1
		step.OutputArtifactJSON = "[\"resource-" + step.StepKey + "\"]"
		if err := svc.repo.SaveProductionStep(&step); err != nil {
			t.Fatalf("mark %s succeeded: %v", step.StepKey, err)
		}
	}

	// 只改角色资产版本：受影响的镜头 1 与其下游重做，未依赖它的镜头 2 必须原样保留。
	steps[0].InputFingerprint = "character-v2"
	updated, err := svc.UpdateProductionPlan("usr-production", run.ID, ProductionPlanRequest{ExpectedRevision: authorized.Revision, Steps: steps})
	if err != nil {
		t.Fatalf("update plan: %v", err)
	}
	byKey := map[string]model.ProductionStep{}
	for _, item := range updated.Steps {
		byKey[item.StepKey] = item.ProductionStep
	}
	for _, key := range []string{"character-asset", "shot-01-video"} {
		if byKey[key].Status != "pending" || byKey[key].OutputArtifactJSON != "[]" {
			t.Fatalf("changed step %s was not invalidated: %+v", key, byKey[key])
		}
	}
	for _, key := range []string{"shot-02-video", "shot-02-qc"} {
		step := byKey[key]
		if step.Status != "succeeded" || step.OutputArtifactJSON != "[\"resource-"+key+"\"]" {
			t.Fatalf("unaffected step %s lost its artifact: %+v", key, step)
		}
	}
	payload := decodeMap(updated.Events[len(updated.Events)-1].PayloadJSON)
	if intValue(payload["estimatedReworkCostMicros"]) != 350 {
		t.Fatalf("estimated rework cost = %#v, want 350 for the changed asset and its dependent video only", payload["estimatedReworkCostMicros"])
	}
	invalidated, _ := payload["invalidatedStepKeys"].([]any)
	if len(invalidated) != 2 {
		t.Fatalf("invalidated keys = %#v, want only the changed asset and its dependent video", invalidated)
	}
}

func TestProductionPlanMutationRejectsUnsettledChangedTask(t *testing.T) {
	svc, _ := newTimelineTaskTestService(t)
	run, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{ClientKey: "film-active-invalidation", Steps: []ProductionStepInput{{StepKey: "shot-video", Kind: "video", InputFingerprint: "v1"}}})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	step := run.Steps[0].ProductionStep
	step.Status = "running"
	if err := svc.repo.SaveProductionStep(&step); err != nil {
		t.Fatalf("mark step running: %v", err)
	}
	_, err = svc.UpdateProductionPlan("usr-production", run.ID, ProductionPlanRequest{ExpectedRevision: run.Revision, Steps: []ProductionStepInput{{StepKey: "shot-video", Kind: "video", InputFingerprint: "v2"}}})
	if err == nil || !strings.Contains(err.Error(), "未结清任务") {
		t.Fatalf("running changed step err = %v, want unsettled task conflict", err)
	}
}

func TestProductionStepsRoundTripStoryboardRowsAndOrderedSegments(t *testing.T) {
	svc, _ := newTimelineTaskTestService(t)
	created, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey: "film-segments",
		Steps: []ProductionStepInput{
			{StepKey: "shot-01-segment-0", Kind: "video", StoryboardRowID: "shot-01", SegmentID: "seg-a", SegmentOrder: 0},
			{StepKey: "shot-01-segment-1", Kind: "video", StoryboardRowID: "shot-01", SegmentID: "seg-b", SegmentOrder: 1},
			{StepKey: "shot-01-segment-0-audio", Kind: "audio", StoryboardRowID: "shot-01", SegmentID: "seg-a", SegmentOrder: 0, TrackID: "dialogue-main"},
		},
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	if len(created.Steps) != 3 {
		t.Fatalf("steps = %d, want three segment/model steps", len(created.Steps))
	}
	got := map[string]model.ProductionStep{}
	for _, step := range created.Steps {
		got[step.StepKey] = step.ProductionStep
	}
	if got["shot-01-segment-0"].StoryboardRowID != "shot-01" || got["shot-01-segment-0"].SegmentID != "seg-a" || got["shot-01-segment-0"].SegmentOrder != 0 {
		t.Fatalf("first segment binding = %+v", got["shot-01-segment-0"])
	}
	if got["shot-01-segment-1"].StoryboardRowID != "shot-01" || got["shot-01-segment-1"].SegmentID != "seg-b" || got["shot-01-segment-1"].SegmentOrder != 1 {
		t.Fatalf("second segment binding = %+v", got["shot-01-segment-1"])
	}
	if got["shot-01-segment-0-audio"].StoryboardRowID != "shot-01" || got["shot-01-segment-0-audio"].TrackID != "dialogue-main" {
		t.Fatalf("audio track binding = %+v", got["shot-01-segment-0-audio"])
	}
	if err := validateProductionSteps([]ProductionStepInput{
		{StepKey: "a", Kind: "video", StoryboardRowID: "shot-01", SegmentID: "seg-a", SegmentOrder: 0},
		{StepKey: "b", Kind: "video", StoryboardRowID: "shot-01", SegmentID: "seg-b", SegmentOrder: 0},
	}); err == nil || !strings.Contains(err.Error(), "顺序重复") {
		t.Fatalf("duplicate segment order err = %v", err)
	}
	if err := validateProductionSteps([]ProductionStepInput{{StepKey: "orphan", Kind: "video", SegmentID: "seg-orphan"}}); err == nil || !strings.Contains(err.Error(), "分镜行 ID") {
		t.Fatalf("orphan segment err = %v", err)
	}
}

func TestProductionAudioStepsRequireStableTrackIdentity(t *testing.T) {
	if err := validateProductionSteps([]ProductionStepInput{{StepKey: "audio", Kind: "audio", StoryboardRowID: "row-1"}}); err == nil || !strings.Contains(err.Error(), "trackId") {
		t.Fatalf("audio step without track id err = %v, want stable track id validation", err)
	}
	if err := validateProductionSteps([]ProductionStepInput{
		{StepKey: "audio-a", Kind: "audio", StoryboardRowID: "row-1", TrackID: "dialogue"},
		{StepKey: "audio-b", Kind: "audio", StoryboardRowID: "row-1", TrackID: "dialogue"},
	}); err == nil || !strings.Contains(err.Error(), "不能重复") {
		t.Fatalf("duplicate row track id err = %v, want duplicate binding validation", err)
	}
	if err := validateProductionSteps([]ProductionStepInput{{StepKey: "video", Kind: "video", StoryboardRowID: "row-1", TrackID: "dialogue"}}); err == nil || !strings.Contains(err.Error(), "只有音频") {
		t.Fatalf("video track id err = %v, want non-audio binding validation", err)
	}
}

func TestProductionAudioTrackIdentityChangeInvalidatesStep(t *testing.T) {
	svc, _ := newTimelineTaskTestService(t)
	steps := []ProductionStepInput{{StepKey: "audio:row-1:dialogue", Kind: "audio", StoryboardRowID: "row-1", TrackID: "dialogue-v1", InputFingerprint: "audio-v1"}}
	run, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{ClientKey: "audio-track-invalidation", Steps: steps})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	step := run.Steps[0].ProductionStep
	step.Status = "succeeded"
	step.AttemptCount = 1
	step.OutputArtifactJSON = `["audio-resource-v1"]`
	if err := svc.repo.SaveProductionStep(&step); err != nil {
		t.Fatalf("mark audio step succeeded: %v", err)
	}
	steps[0].TrackID = "dialogue-v2"
	updated, err := svc.UpdateProductionPlan("usr-production", run.ID, ProductionPlanRequest{ExpectedRevision: run.Revision, Steps: steps})
	if err != nil {
		t.Fatalf("update audio track identity: %v", err)
	}
	got := updated.Steps[0].ProductionStep
	if got.TrackID != "dialogue-v2" || got.Status != "pending" || got.OutputArtifactJSON != "[]" {
		t.Fatalf("audio step did not invalidate on track identity change: %+v", got)
	}
}

func TestProductionTaskTraceRoundTripsAndIdempotentRetryReusesTask(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	run, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey: "film-task-trace",
		Steps:     []ProductionStepInput{{StepKey: "shot-07-segment-1", Kind: "video", StoryboardRowID: "shot-07", SegmentID: "seg-2", SegmentOrder: 1}},
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	step := run.Steps[0].ProductionStep
	req := ProductionSubmitRequest{
		ExpectedRevision: run.Revision, StepID: step.ID, IdempotencyKey: "retry-after-timeout",
		CapabilityRevision: "cap-v1", EstimatedCostMicros: 300,
		Task: CreateTaskRequest{Type: "canvas_video", Prompt: "fixture", Input: map[string]any{"mode": "video"}},
	}
	attempt := model.ProductionAttempt{
		ID: "attempt-trace", RunID: run.ID, StepID: step.ID, AttemptNumber: 1, IdempotencyKey: req.IdempotencyKey,
		RequestHash: productionJSONHash([]any{req.StepID, req.Task, req.CapabilityRevision, req.EstimatedCostMicros, strings.TrimSpace(req.RetryOf)}),
		State:       "running", GenerationTaskID: "task-trace",
	}
	task := model.Task{ID: "task-trace", UserID: "usr-production", Type: "canvas_video"}
	bindProductionTaskTrace(&task, run.ID, &step, &attempt)
	if err := db.Create(&task).Error; err != nil {
		t.Fatalf("create fixture task: %v", err)
	}
	storedTask, err := svc.repo.TaskForUser("usr-production", task.ID)
	if err != nil {
		t.Fatalf("read fixture task: %v", err)
	}
	if storedTask.ProductionRunID != run.ID || storedTask.ProductionStepID != step.ID || storedTask.ProductionAttemptID != attempt.ID || storedTask.StoryboardRowID != "shot-07" || storedTask.SegmentID != "seg-2" || storedTask.SegmentOrder != 1 {
		t.Fatalf("task trace = %+v", storedTask)
	}
	if err := svc.repo.CreateProductionAttempt(&model.ProductionAttempt{
		ID: attempt.ID, RunID: run.ID, StepID: step.ID, AttemptNumber: attempt.AttemptNumber, IdempotencyKey: attempt.IdempotencyKey,
		RequestHash: attempt.RequestHash, CapabilityRevision: attempt.CapabilityRevision, State: attempt.State, GenerationTaskID: task.ID,
	}); err != nil {
		t.Fatalf("create attempt: %v", err)
	}
	// Existing attempt lookup precedes revision validation and task preparation, so a
	// client retry after a bridge timeout can only read the task already paid for.
	if _, err := svc.AuthorizeProductionRun("usr-production", run.ID, ProductionAuthorizeRequest{ExpectedRevision: run.Revision, Policy: map[string]any{"authorizationStatus": "authorized"}}); err != nil {
		t.Fatalf("authorize run: %v", err)
	}
	result, err := svc.SubmitProductionStep("usr-production", run.ID, req)
	if err != nil {
		t.Fatalf("idempotent retry: %v", err)
	}
	if result["idempotent"] != true {
		t.Fatalf("retry result = %#v, want idempotent true", result)
	}
	var taskCount int64
	if err := db.Model(&model.Task{}).Where("user_id = ?", "usr-production").Count(&taskCount).Error; err != nil {
		t.Fatal(err)
	}
	if taskCount != 1 {
		t.Fatalf("task count = %d, want the single existing paid task", taskCount)
	}
	req.Task.Prompt = "different payload"
	if _, err := svc.SubmitProductionStep("usr-production", run.ID, req); err == nil || !strings.Contains(err.Error(), "幂等键") {
		t.Fatalf("changed payload with same key err = %v, want conflict", err)
	}
}

func TestProductionAudioTrackTaskTracePersistsThroughRepository(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	run, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey: "audio-task-track-trace",
		Steps:     []ProductionStepInput{{StepKey: "audio:row-1:music", Kind: "audio", StoryboardRowID: "row-1", TrackID: "music-main"}},
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	step := run.Steps[0].ProductionStep
	attempt := model.ProductionAttempt{ID: "audio-attempt", RunID: run.ID, StepID: step.ID}
	task := model.Task{ID: "audio-task", UserID: "usr-production", Type: "canvas_audio"}
	bindProductionTaskTrace(&task, run.ID, &step, &attempt)
	if err := db.Create(&task).Error; err != nil {
		t.Fatalf("create audio task: %v", err)
	}
	stored, err := svc.repo.TaskForUser("usr-production", task.ID)
	if err != nil {
		t.Fatalf("read audio task: %v", err)
	}
	if stored.ProductionRunID != run.ID || stored.ProductionStepID != step.ID || stored.ProductionAttemptID != attempt.ID || stored.StoryboardRowID != "row-1" || stored.TrackID != "music-main" {
		t.Fatalf("persisted audio trace = %+v", stored)
	}
}

func TestProductionNewAttemptsRequireLatestSettledSameStepRetryLineage(t *testing.T) {
	svc, _ := newTimelineTaskTestService(t)
	run, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey: "film-retry-lineage",
		Steps: []ProductionStepInput{
			{StepKey: "shot-07-video", Kind: "video", StoryboardRowID: "shot-07", SegmentID: "seg-1"},
			{StepKey: "shot-08-video", Kind: "video", StoryboardRowID: "shot-08", SegmentID: "seg-2"},
		},
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	step, err := svc.repo.ProductionStepByKey(run.ID, "shot-07-video")
	if err != nil {
		t.Fatalf("get step: %v", err)
	}
	if err := validateProductionStepAttempt(svc.repo, step, ""); err != nil {
		t.Fatalf("first attempt should be allowed: %v", err)
	}
	prior := model.ProductionAttempt{ID: "attempt-latest", RunID: run.ID, StepID: step.ID, AttemptNumber: 1, IdempotencyKey: "key-latest", State: "running"}
	if err := svc.repo.CreateProductionAttempt(&prior); err != nil {
		t.Fatalf("create prior attempt: %v", err)
	}
	step.AttemptCount = 1
	step.Status = "failed"
	if err := svc.repo.SaveProductionStep(step); err != nil {
		t.Fatalf("save failed step: %v", err)
	}
	if err := validateProductionStepAttempt(svc.repo, step, prior.ID); err == nil || !strings.Contains(err.Error(), "尚未确认") {
		t.Fatalf("running attempt retry err = %v", err)
	}
	prior.State = "quality_failed"
	if err := svc.repo.SaveProductionAttempt(&prior); err != nil {
		t.Fatalf("settle quality-failed attempt: %v", err)
	}
	if err := validateProductionStepAttempt(svc.repo, step, prior.ID); err != nil {
		t.Fatalf("settled quality-failed attempt should be retryable: %v", err)
	}
	prior.State = "failed"
	if err := svc.repo.SaveProductionAttempt(&prior); err != nil {
		t.Fatalf("settle prior attempt: %v", err)
	}
	if err := validateProductionStepAttempt(svc.repo, step, prior.ID); err != nil {
		t.Fatalf("confirmed same-step failure should be retryable: %v", err)
	}
	otherStep, err := svc.repo.ProductionStepByKey(run.ID, "shot-08-video")
	if err != nil {
		t.Fatalf("get other step: %v", err)
	}
	otherStep.AttemptCount = 1
	if err := validateProductionStepAttempt(svc.repo, otherStep, prior.ID); err == nil || !strings.Contains(err.Error(), "最近一次 attempt") {
		t.Fatalf("cross-step retry lineage err = %v", err)
	}
}

func TestProductionSubmitRequiresCurrentCapabilityRevision(t *testing.T) {
	if err := validateProductionCapabilityRevision("", "channel-model:7"); err == nil || !strings.Contains(err.Error(), "缺少模型能力版本") {
		t.Fatalf("missing capability revision err = %v", err)
	}
	if err := validateProductionCapabilityRevision("channel-model:6", "channel-model:7"); err == nil || !strings.Contains(err.Error(), "已更新") {
		t.Fatalf("stale capability revision err = %v", err)
	}
	if err := validateProductionCapabilityRevision("channel-model:7", "channel-model:7"); err != nil {
		t.Fatalf("matching capability revision err = %v", err)
	}
}

func TestProductionReconcilerProjectsTerminalTaskWithoutResubmitting(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	run, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{ClientKey: "film-reconcile", Steps: []ProductionStepInput{{StepKey: "shot-1-image", Kind: "image"}}})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	attempt := model.ProductionAttempt{ID: "attempt-1", RunID: run.ID, StepID: run.Steps[0].ID, AttemptNumber: 1, IdempotencyKey: "attempt-key", RequestHash: "hash", State: "running", GenerationTaskID: "task-1"}
	if err := svc.repo.CreateProductionAttempt(&attempt); err != nil {
		t.Fatalf("create attempt: %v", err)
	}
	if err := db.Create(&model.Task{ID: "task-1", UserID: "usr-production", Type: "canvas_image", Status: model.TaskStatusSucceeded, ResultJSON: `{"resourceId":"res-final"}`}).Error; err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := svc.ReconcileProductionRunsOnce(); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	reconciled, err := svc.GetProductionRun("usr-production", run.ID, 0)
	if err != nil {
		t.Fatalf("get run: %v", err)
	}
	if reconciled.Status != "verifying" || reconciled.Steps[0].Status != "succeeded" || len(reconciled.Attempts) != 1 || reconciled.Attempts[0].State != "succeeded" {
		t.Fatalf("reconciled = %#v", reconciled)
	}
	if len(reconciled.Steps[0].OutputArtifactIDs) != 1 || reconciled.Steps[0].OutputArtifactIDs[0] != "res-final" {
		t.Fatalf("artifact ids = %#v", reconciled.Steps[0].OutputArtifactIDs)
	}
}

func TestProductionReconcilerUnlocksDependencyByStepKey(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	run, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey: "film-reconcile-dependency",
		Steps: []ProductionStepInput{
			{StepKey: "shared-character-asset", Kind: "image"},
			{StepKey: "shot-01-video", Kind: "video", StoryboardRowID: "shot-01", DependsOn: []string{"shared-character-asset"}},
		},
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	if run.Steps[0].ID == run.Steps[0].StepKey || run.Steps[1].ID == run.Steps[1].StepKey {
		t.Fatal("fixture must keep database step IDs distinct from dependency step keys")
	}
	attempt := model.ProductionAttempt{ID: "attempt-dependency", RunID: run.ID, StepID: run.Steps[0].ID, AttemptNumber: 1, IdempotencyKey: "dependency-key", RequestHash: "hash", State: "running", GenerationTaskID: "task-dependency"}
	if err := svc.repo.CreateProductionAttempt(&attempt); err != nil {
		t.Fatalf("create attempt: %v", err)
	}
	if err := db.Create(&model.Task{ID: "task-dependency", UserID: "usr-production", Type: "canvas_image", Status: model.TaskStatusSucceeded, ResultJSON: `{"resourceId":"res-character"}`}).Error; err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := svc.ReconcileProductionRunsOnce(); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	reconciled, err := svc.GetProductionRun("usr-production", run.ID, 0)
	if err != nil {
		t.Fatalf("get run: %v", err)
	}
	if reconciled.Steps[0].Status != "succeeded" || reconciled.Steps[1].Status != "ready" {
		t.Fatalf("dependency statuses = %s, %s; dependent step should be ready", reconciled.Steps[0].Status, reconciled.Steps[1].Status)
	}
}

func TestProductionSubmissionChecksDependencyStepKeys(t *testing.T) {
	svc, _ := newTimelineTaskTestService(t)
	run, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey: "film-submit-dependency",
		Steps: []ProductionStepInput{
			{StepKey: "shared-scene-asset", Kind: "image"},
			{StepKey: "shot-02-video", Kind: "video", StoryboardRowID: "shot-02", DependsOn: []string{"shared-scene-asset"}},
		},
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	dependency, err := svc.repo.ProductionStepByKey(run.ID, "shared-scene-asset")
	if err != nil {
		t.Fatalf("read dependency by key: %v", err)
	}
	dependent, err := svc.repo.ProductionStepByKey(run.ID, "shot-02-video")
	if err != nil {
		t.Fatalf("read dependent by key: %v", err)
	}
	if dependency.ID == dependency.StepKey || dependent.ID == dependent.StepKey {
		t.Fatal("fixture must keep database step IDs distinct from dependency step keys")
	}
	if err := ensureProductionDependenciesReady(svc.repo, run.ID, dependent); err == nil || !strings.Contains(err.Error(), "shared-scene-asset") {
		t.Fatalf("pending dependency err = %v, want dependency key", err)
	}
	dependency.Status = "succeeded"
	if err := svc.repo.SaveProductionStep(dependency); err != nil {
		t.Fatalf("mark dependency succeeded: %v", err)
	}
	if err := ensureProductionDependenciesReady(svc.repo, run.ID, dependent); err != nil {
		t.Fatalf("succeeded dependency was not accepted: %v", err)
	}
}
func TestProductionSubmitRequiresUserAuthorization(t *testing.T) {
	svc, _ := newTimelineTaskTestService(t)
	run, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey: "film-unauthorized",
		Steps:     []ProductionStepInput{{StepKey: "shot-1-image", Kind: "image"}},
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	_, err = svc.SubmitProductionStep("usr-production", run.ID, ProductionSubmitRequest{
		ExpectedRevision: run.Revision,
		StepID:           run.Steps[0].ID,
		IdempotencyKey:   "first-attempt",
		Task: CreateTaskRequest{
			Type:   "canvas_image",
			Prompt: "fixture",
			Input:  map[string]any{"mode": "image", "prompt": "fixture"},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "尚未授权") {
		t.Fatalf("err = %v, want authorization gate", err)
	}
}

func TestProductionStepGraphRejectsDependencyCycle(t *testing.T) {
	err := validateProductionSteps([]ProductionStepInput{
		{StepKey: "a", Kind: "image", DependsOn: []string{"b"}},
		{StepKey: "b", Kind: "video", DependsOn: []string{"c"}},
		{StepKey: "c", Kind: "audio", StoryboardRowID: "row-1", TrackID: "music-main", DependsOn: []string{"a"}},
	})
	if err == nil || !strings.Contains(err.Error(), "环") {
		t.Fatalf("err = %v, want dependency cycle error", err)
	}
}

func TestProductionBudgetReservationGuardsPaidSteps(t *testing.T) {
	video := &model.ProductionStep{Kind: "video"}
	run := &model.ProductionRun{BudgetLimit: 1000, PolicyJSON: `{"authorizationStatus":"authorized"}`}
	if err := reserveProductionBudget(run, video, 600); err != nil {
		t.Fatalf("first reservation: %v", err)
	}
	if run.Reserved != 600 {
		t.Fatalf("reserved = %d, want 600", run.Reserved)
	}
	if err := reserveProductionBudget(run, video, 500); err == nil || !strings.Contains(err.Error(), "预算不足") {
		t.Fatalf("over-budget err = %v", err)
	}
	if run.Reserved != 600 {
		t.Fatalf("failed reservation must not mutate run: %d", run.Reserved)
	}
	noBudget := &model.ProductionRun{PolicyJSON: `{"authorizationStatus":"authorized"}`}
	if err := reserveProductionBudget(noBudget, video, 10); err == nil || !strings.Contains(err.Error(), "缺少有效预算上限") {
		t.Fatalf("missing budget err = %v", err)
	}
	unbounded := &model.ProductionRun{PolicyJSON: `{"authorizationStatus":"authorized","budgetPolicy":"unbounded"}`}
	if err := reserveProductionBudget(unbounded, video, 10); err != nil {
		t.Fatalf("explicit unbounded err = %v", err)
	}
	unknownPrice := &model.ProductionRun{PolicyJSON: `{"authorizationStatus":"authorized","budgetPolicy":"unbounded"}`}
	if err := reserveProductionBudget(unknownPrice, video, 0); err != nil {
		t.Fatalf("explicit unbounded unknown price err = %v", err)
	}
	if unknownPrice.Reserved != 0 || unknownPrice.Spent != 0 {
		t.Fatalf("unknown price must not be represented as free or reserved: %#v", unknownPrice)
	}
	boundedUnknown := &model.ProductionRun{BudgetLimit: 1000, PolicyJSON: `{"authorizationStatus":"authorized","budgetPolicy":"bounded"}`}
	if err := reserveProductionBudget(boundedUnknown, video, 0); err == nil || !strings.Contains(err.Error(), "未验证价格") {
		t.Fatalf("bounded zero estimate err = %v, want unknown price rejection", err)
	}
	render := &model.ProductionRun{}
	if err := reserveProductionBudget(render, &model.ProductionStep{Kind: "render"}, 0); err != nil {
		t.Fatalf("local render step err = %v", err)
	}
}

func TestProductionCostSettlementKeepsCancelledReservation(t *testing.T) {
	settledRun := &model.ProductionRun{Reserved: 500, Spent: 100}
	settledAttempt := &model.ProductionAttempt{ReservedCostMicros: 500}
	if settlement, amount := settleProductionAttemptCost(settledRun, settledAttempt, model.TaskStatusSucceeded); settlement != "settled" || amount != 500 {
		t.Fatalf("settlement = %s/%d", settlement, amount)
	}
	if settledRun.Reserved != 0 || settledRun.Spent != 600 || settledAttempt.ReservedCostMicros != 0 {
		t.Fatalf("settled run = %#v attempt=%#v", settledRun, settledAttempt)
	}

	failedRun := &model.ProductionRun{Reserved: 300}
	failedAttempt := &model.ProductionAttempt{ReservedCostMicros: 300}
	if settlement, _ := settleProductionAttemptCost(failedRun, failedAttempt, model.TaskStatusFailed); settlement != "released" {
		t.Fatalf("failed settlement = %s", settlement)
	}
	if failedRun.Reserved != 0 || failedRun.Spent != 0 {
		t.Fatalf("failed run = %#v", failedRun)
	}

	cancelledRun := &model.ProductionRun{Reserved: 200}
	cancelledAttempt := &model.ProductionAttempt{ReservedCostMicros: 200}
	if settlement, _ := settleProductionAttemptCost(cancelledRun, cancelledAttempt, model.TaskStatusCancelled); settlement != "unsettled" {
		t.Fatalf("cancelled settlement = %s", settlement)
	}
	if cancelledRun.Reserved != 200 || cancelledAttempt.ErrorCode != "cancellation_unsettled" {
		t.Fatalf("cancelled run = %#v attempt=%#v", cancelledRun, cancelledAttempt)
	}
}

func TestProductionReconcilerIgnoresLateAttemptResult(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	run, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey:   "film-late-attempt",
		BudgetLimit: 1000,
		Policy:      map[string]any{"authorizationStatus": "authorized"},
		Steps:       []ProductionStepInput{{StepKey: "shot-1-video", Kind: "video"}},
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	step := run.Steps[0].ProductionStep
	step.AttemptCount = 2
	step.Status = "running"
	if err := svc.repo.SaveProductionStep(&step); err != nil {
		t.Fatalf("save step: %v", err)
	}
	attempt := model.ProductionAttempt{ID: "attempt-old", RunID: run.ID, StepID: step.ID, AttemptNumber: 1, IdempotencyKey: "old-key", RequestHash: "hash", State: "running", GenerationTaskID: "late-task"}
	if err := svc.repo.CreateProductionAttempt(&attempt); err != nil {
		t.Fatalf("create attempt: %v", err)
	}
	if err := db.Create(&model.Task{ID: "late-task", UserID: "usr-production", Type: "canvas_video", Status: model.TaskStatusSucceeded, ResultJSON: `{"resourceId":"late-resource"}`}).Error; err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := svc.ReconcileProductionRunsOnce(); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	reconciled, err := svc.GetProductionRun("usr-production", run.ID, 0)
	if err != nil {
		t.Fatalf("get run: %v", err)
	}
	if reconciled.Steps[0].Status != "running" || len(reconciled.Steps[0].OutputArtifactIDs) != 0 {
		t.Fatalf("late attempt overwrote newer step: %#v", reconciled.Steps[0])
	}
	if reconciled.Attempts[0].State != "succeeded" {
		t.Fatalf("late attempt state = %s, want succeeded", reconciled.Attempts[0].State)
	}
	lateEvent := false
	for _, event := range reconciled.Events {
		if event.Type == "attempt_late_observed" {
			lateEvent = true
		}
	}
	if !lateEvent {
		t.Fatalf("missing attempt_late_observed event: %#v", reconciled.Events)
	}
}

func TestProductionReconcilerSettlesReservationAndRespectsCancel(t *testing.T) {
	svc, db := newTimelineTaskTestService(t)
	run, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{
		ClientKey:   "film-settle",
		BudgetLimit: 900,
		Policy:      map[string]any{"authorizationStatus": "authorized"},
		Steps:       []ProductionStepInput{{StepKey: "shot-1-video", Kind: "video"}},
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	stored := run.ProductionRun
	stored.Reserved = 400
	if err := svc.repo.SaveProductionRun(&stored); err != nil {
		t.Fatalf("save run: %v", err)
	}
	step := run.Steps[0].ProductionStep
	step.Status = "running"
	if err := svc.repo.SaveProductionStep(&step); err != nil {
		t.Fatalf("save step: %v", err)
	}
	attempt := model.ProductionAttempt{ID: "attempt-settle", RunID: run.ID, StepID: step.ID, AttemptNumber: 1, IdempotencyKey: "settle-key", RequestHash: "hash", State: "running", GenerationTaskID: "settle-task", ReservedCostMicros: 400, CostReservationID: "resv-attempt-settle"}
	if err := svc.repo.CreateProductionAttempt(&attempt); err != nil {
		t.Fatalf("create attempt: %v", err)
	}
	if err := db.Create(&model.Task{ID: "settle-task", UserID: "usr-production", Type: "canvas_video", Status: model.TaskStatusSucceeded, ResultJSON: `{"resourceId":"res-settle"}`}).Error; err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := svc.ReconcileProductionRunsOnce(); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	settled, err := svc.GetProductionRun("usr-production", run.ID, 0)
	if err != nil {
		t.Fatalf("get run: %v", err)
	}
	if settled.Reserved != 0 || settled.Spent != 400 {
		t.Fatalf("budget ledger = reserved %d spent %d", settled.Reserved, settled.Spent)
	}
	if _, err := svc.ChangeProductionRunStatus("usr-production", run.ID, ProductionActionRequest{ExpectedRevision: settled.Revision, Action: "cancel"}); err != nil {
		t.Fatalf("cancel run: %v", err)
	}
	cancelled, err := svc.GetProductionRun("usr-production", run.ID, 0)
	if err != nil {
		t.Fatalf("get cancelled run: %v", err)
	}
	lateStep := cancelled.Steps[0].ProductionStep
	lateStep.Status = "running"
	if err := svc.repo.SaveProductionStep(&lateStep); err != nil {
		t.Fatalf("save late step: %v", err)
	}
	lateStep.AttemptCount = 2
	if err := svc.repo.SaveProductionStep(&lateStep); err != nil {
		t.Fatalf("bump late step attempts: %v", err)
	}
	lateAttempt := model.ProductionAttempt{ID: "attempt-after-cancel", RunID: run.ID, StepID: lateStep.ID, AttemptNumber: 2, IdempotencyKey: "after-cancel-key", RequestHash: "hash", State: "running", GenerationTaskID: "after-cancel-task"}
	if err := svc.repo.CreateProductionAttempt(&lateAttempt); err != nil {
		t.Fatalf("create late attempt: %v", err)
	}
	if err := db.Create(&model.Task{ID: "after-cancel-task", UserID: "usr-production", Type: "canvas_video", Status: model.TaskStatusSucceeded, ResultJSON: `{"resourceId":"res-after-cancel"}`}).Error; err != nil {
		t.Fatalf("create late task: %v", err)
	}
	if err := svc.ReconcileProductionRunsOnce(); err != nil {
		t.Fatalf("reconcile after cancel: %v", err)
	}
	after, err := svc.GetProductionRun("usr-production", run.ID, 0)
	if err != nil {
		t.Fatalf("get run after cancel: %v", err)
	}
	if after.Status != "cancelled" {
		t.Fatalf("cancelled run was revived: %s", after.Status)
	}
}

func TestProductionAutoSwitchBlocksPaidSubmission(t *testing.T) {
	svc, _ := newTimelineTaskTestService(t)
	run, err := svc.CreateProductionRun("usr-production", ProductionRunRequest{ClientKey: "film-flag", Steps: []ProductionStepInput{{StepKey: "shot-1-image", Kind: "image"}}})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	authorized, err := svc.AuthorizeProductionRun("usr-production", run.ID, ProductionAuthorizeRequest{ExpectedRevision: run.Revision, Policy: map[string]any{"allowedCapabilities": []any{"image"}}})
	if err != nil {
		t.Fatalf("authorize run: %v", err)
	}
	t.Setenv("CANVAS_PRODUCTION_AUTO", "0")
	defer os.Unsetenv("CANVAS_PRODUCTION_AUTO")
	_, err = svc.SubmitProductionStep("usr-production", run.ID, ProductionSubmitRequest{
		ExpectedRevision: authorized.Revision,
		StepID:           run.Steps[0].ID,
		IdempotencyKey:   "flag-attempt",
		Task:             CreateTaskRequest{Type: "canvas_image", Prompt: "fixture", Input: map[string]any{"mode": "image", "prompt": "fixture"}},
	})
	if err == nil || !strings.Contains(err.Error(), "自动制作已关闭") {
		t.Fatalf("err = %v, want feature switch gate", err)
	}
}

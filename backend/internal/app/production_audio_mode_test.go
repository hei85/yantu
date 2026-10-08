package app

import (
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestProductionAudioModeIsPersistedAndMutuallyExclusive(t *testing.T) {
	mode, err := normalizeProductionAudioMode("")
	if err != nil || mode != model.ProductionAudioModeNative {
		t.Fatalf("empty audioMode = %q, err=%v; want native default", mode, err)
	}
	if _, err := normalizeProductionAudioMode("mixed"); err == nil {
		t.Fatal("legacy mixed mode must be rejected")
	}
	for _, test := range []struct {
		name     string
		mode     string
		manifest map[string]any
		want     string
	}{
		{name: "native cannot add generated dialogue", mode: model.ProductionAudioModeNative, manifest: map[string]any{"audioStepKeys": []any{"audio:row:dialogue"}}, want: "禁止创建独立"},
		{name: "rebuild requires bound tracks", mode: model.ProductionAudioModeRebuild, manifest: map[string]any{}, want: "必须绑定至少一条独立音轨"},
		{name: "rebuild speech needs stable line ID", mode: model.ProductionAudioModeRebuild, manifest: map[string]any{"audioStepKeys": []any{"audio:row:dialogue"}, "audioTrackBindings": []any{map[string]any{"kind": "dialogue"}}}, want: "稳定 lineId"},
		{name: "rebuild speech needs locked text", mode: model.ProductionAudioModeRebuild, manifest: map[string]any{"audioStepKeys": []any{"audio:row:dialogue"}, "audioTrackBindings": []any{map[string]any{"kind": "dialogue", "lineId": "line-1"}}}, want: "台词文本"},
		{name: "rebuild rejects duplicate dialogue", mode: model.ProductionAudioModeRebuild, manifest: map[string]any{"audioStepKeys": []any{"audio:row:dialogue-a", "audio:row:dialogue-b"}, "audioTrackBindings": []any{map[string]any{"kind": "dialogue", "lineId": "line-1", "text": "你好"}, map[string]any{"kind": "voiceover", "lineId": "line-1", "text": "你好"}}}, want: "不能重复生成"},
		{name: "rebuild cannot request native audio", mode: model.ProductionAudioModeRebuild, manifest: map[string]any{"audioStepKeys": []any{"audio:row:music"}, "audioTrackBindings": []any{map[string]any{"kind": "music"}}, "selectedModelsBySegment": []any{map[string]any{"generateAudio": true}}}, want: "禁止请求视频模型生成原生音轨"},
	} {
		t.Run(test.name, func(t *testing.T) {
			plan := map[string]any{"executionManifest": test.manifest}
			if err := normalizeProductionPlanAudioMode(plan, test.mode); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("normalize plan error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestRebuildAudioPersistsRequiredCapabilityGapsWithoutInventingTasks(t *testing.T) {
	plan := map[string]any{"executionManifest": map[string]any{
		"audioStepKeys":      []any{},
		"audioTrackBindings": []any{},
		"audioCapabilityGaps": []any{map[string]any{
			"storyboardRowId": "row-1", "trackId": "ambient", "kind": "ambient",
			"capability": "ambientSound", "missingCapabilities": []any{"ambientSound"},
			"status": "unavailable", "required": true, "reason": "当前能力目录未声明 ambientSound",
		}},
	}}
	if err := normalizeProductionPlanAudioMode(plan, model.ProductionAudioModeRebuild); err != nil {
		t.Fatalf("explicit unavailable track should remain a valid, traceable planning state: %v", err)
	}
	manifest := plan["executionManifest"].(map[string]any)
	if manifest["audioPolicy"] != "independent" || manifest["audioMode"] != model.ProductionAudioModeRebuild {
		t.Fatalf("audio mode/policy were not normalized: %#v", manifest)
	}
	if len(productionManifestStrings(manifest["audioStepKeys"])) != 0 || len(productionManifestRecords(manifest["audioTrackBindings"])) != 0 {
		t.Fatalf("unavailable capability was fabricated as a generation step: %#v", manifest)
	}
}

func TestNativeAudioRejectsIndependentCapabilityGap(t *testing.T) {
	plan := map[string]any{"executionManifest": map[string]any{
		"audioCapabilityGaps": []any{map[string]any{
			"storyboardRowId": "row-1", "trackId": "music", "kind": "music",
			"capability": "music", "status": "unavailable", "required": true, "reason": "未声明 music",
		}},
	}}
	if err := normalizeProductionPlanAudioMode(plan, model.ProductionAudioModeNative); err == nil || !strings.Contains(err.Error(), "NATIVE_AUDIO 禁止") {
		t.Fatalf("native mode accepted a requested independent audio track gap: %v", err)
	}
}

func TestProductionVoiceProfileModelCompatibility(t *testing.T) {
	allowed := &model.VoiceProfile{CompatibleModelsJSON: `["CHANNEL_AUDIO::mimo"]`}
	if !productionVoiceProfileAllowsModel(allowed, "CHANNEL_AUDIO::mimo") {
		t.Fatal("declared compatible model was rejected")
	}
	if productionVoiceProfileAllowsModel(allowed, "CHANNEL_AUDIO::other") {
		t.Fatal("model outside VoiceProfile compatibility list was accepted")
	}
	if !productionVoiceProfileAllowsModel(&model.VoiceProfile{CompatibleModelsJSON: `[]`}, "CHANNEL_AUDIO::any") {
		t.Fatal("empty compatibility list should leave selection to the capability registry")
	}
	if productionVoiceProfileAllowsModel(&model.VoiceProfile{CompatibleModelsJSON: `not-json`}, "CHANNEL_AUDIO::any") {
		t.Fatal("malformed compatibility list must fail closed")
	}
}

func TestProductionVideoTaskNativeAudioFlagFollowsSegmentPlan(t *testing.T) {
	service := &Service{}
	step := &model.ProductionStep{Kind: "video", StoryboardRowID: "row-1", SegmentID: "seg-1"}
	for _, test := range []struct {
		name          string
		mode          string
		generateAudio bool
		supportsAudio bool
		want          string
		wantErr       string
	}{
		{name: "native stays disabled unless planned", mode: model.ProductionAudioModeNative, want: "false"},
		{name: "native follows planned supported output", mode: model.ProductionAudioModeNative, generateAudio: true, supportsAudio: true, want: "true"},
		{name: "native cannot exceed capability", mode: model.ProductionAudioModeNative, generateAudio: true, wantErr: "不支持"},
		{name: "rebuild disables embedded output", mode: model.ProductionAudioModeRebuild, generateAudio: false, want: "false"},
	} {
		t.Run(test.name, func(t *testing.T) {
			policy := "native"
			if test.mode == model.ProductionAudioModeRebuild {
				policy = "independent"
			}
			run := &model.ProductionRun{AudioMode: test.mode, PlanJSON: mapJSON(map[string]any{"executionManifest": map[string]any{
				"audioMode": test.mode, "audioPolicy": policy,
				"selectedModelsBySegment": []any{map[string]any{"storyboardRowId": "row-1", "segmentId": "seg-1", "generateAudio": test.generateAudio, "supportsNativeAudio": test.supportsAudio}},
			}})}
			req := &ProductionSubmitRequest{Task: CreateTaskRequest{Type: "canvas_video", Input: map[string]any{"mode": "video", "config": map[string]any{"videoGenerateAudio": "true"}}}}
			err := service.prepareProductionAudioTask("user-1", run, step, req)
			if test.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantErr) {
					t.Fatalf("prepare error = %v, want %q", err, test.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("prepare task: %v", err)
			}
			config := req.Task.Input["config"].(map[string]any)
			if config["videoGenerateAudio"] != test.want {
				t.Fatalf("videoGenerateAudio = %#v, want %q", config["videoGenerateAudio"], test.want)
			}
		})
	}
}

func TestNativeAudioModeRejectsIndependentDialogueSubmission(t *testing.T) {
	run := &model.ProductionRun{AudioMode: model.ProductionAudioModeNative}
	step := &model.ProductionStep{Kind: "audio"}
	req := &ProductionSubmitRequest{Task: CreateTaskRequest{Type: "canvas_audio", Input: map[string]any{"mode": "audio"}}}
	if err := (&Service{}).prepareProductionAudioTask("user-1", run, step, req); err == nil || !strings.Contains(err.Error(), "禁止提交") {
		t.Fatalf("native audio submission error = %v", err)
	}
}

func TestRebuildAudioBindingReplacesUntrustedVoiceMetadataAndReferences(t *testing.T) {
	run := &model.ProductionRun{
		AudioMode: model.ProductionAudioModeRebuild,
		PlanJSON: mapJSON(map[string]any{"executionManifest": map[string]any{
			"audioTrackBindings": []any{map[string]any{
				"stepKey": "audio:row-1:line-1", "storyboardRowId": "row-1", "trackId": "line-1",
				"kind": "dialogue", "lineId": "line-1", "characterId": "temporary-speaker", "voiceStrategy": "standard_tts", "speakingRate": float64(1),
				"model": "CHANNEL_AUDIO::tts", "voiceModel": "CHANNEL_AUDIO::tts", "voiceId": "registry-voice", "text": "计划对白",
			}},
		}}),
	}
	step := &model.ProductionStep{Kind: "audio", StepKey: "audio:row-1:line-1"}
	req := &ProductionSubmitRequest{Task: CreateTaskRequest{Type: "canvas_audio", Prompt: "调用方对白", Input: map[string]any{
		"mode":            "audio",
		"config":          map[string]any{"model": "caller-model", "audioVoice": "caller-voice", "audioSpeed": "1.8", "audioInstructions": "caller instruction"},
		"metadata":        map[string]any{"productionAudioMode": "NATIVE_AUDIO", "voiceStrategy": "voice_reference", "voiceId": "caller-voice", "referenceAudioResourceId": "caller-sample"},
		"referenceAudios": []any{map[string]any{"id": "caller-sample", "storageKey": "resource:caller-sample"}},
	}}}
	service, _ := newTimelineTaskTestService(t)
	if err := service.prepareProductionAudioTask("user-1", run, step, req); err != nil {
		t.Fatalf("prepareProductionAudioTask: %v", err)
	}
	input := req.Task.Input
	metadata := input["metadata"].(map[string]any)
	if metadata["productionAudioMode"] != model.ProductionAudioModeRebuild || metadata["voiceStrategy"] != "standard_tts" || metadata["voiceId"] != "registry-voice" || metadata["characterId"] != "temporary-speaker" {
		t.Fatalf("task metadata did not follow the stored plan binding: %#v", metadata)
	}
	for _, key := range []string{"referenceAudioResourceId", "voiceVersionId"} {
		if _, exists := metadata[key]; exists {
			t.Fatalf("unbound caller metadata %q survived: %#v", key, metadata)
		}
	}
	if _, exists := input["referenceAudios"]; exists {
		t.Fatalf("unbound caller reference audio survived: %#v", input["referenceAudios"])
	}
	config := input["config"].(map[string]any)
	if config["model"] != "CHANNEL_AUDIO::tts" || config["audioVoice"] != "registry-voice" || config["audioSpeed"] != "1" {
		t.Fatalf("audio provider config did not follow the stored plan binding: %#v", config)
	}
	if _, exists := config["audioInstructions"]; exists {
		t.Fatalf("caller voice instructions survived the VoiceVersion binding: %#v", config)
	}
	if req.Task.Prompt != "计划对白" {
		t.Fatalf("audio task prompt = %q, want persisted track text", req.Task.Prompt)
	}
}

func TestRebuildNonSpeechTrackClearsCallerVoiceAndSpeed(t *testing.T) {
	run := &model.ProductionRun{AudioMode: model.ProductionAudioModeRebuild, PlanJSON: mapJSON(map[string]any{"executionManifest": map[string]any{
		"audioTrackBindings": []any{map[string]any{
			"stepKey": "audio:row-1:music", "storyboardRowId": "row-1", "trackId": "music", "kind": "music",
			"model": "CHANNEL_AUDIO::music", "text": "温暖舒缓的片尾音乐",
		}},
	}})}
	step := &model.ProductionStep{Kind: "audio", StepKey: "audio:row-1:music"}
	req := &ProductionSubmitRequest{Task: CreateTaskRequest{Type: "canvas_audio", Prompt: "调用方文本", Input: map[string]any{
		"mode":   "audio",
		"config": map[string]any{"model": "caller-model", "audioVoice": "caller-voice", "audioSpeed": "1.8", "audioInstructions": "caller instruction"},
	}}}
	if err := (&Service{}).prepareProductionAudioTask("user-1", run, step, req); err != nil {
		t.Fatalf("prepareProductionAudioTask: %v", err)
	}
	config := req.Task.Input["config"].(map[string]any)
	if config["audioVoice"] != "" || config["audioSpeed"] != "" {
		t.Fatalf("non-speech track inherited voice-only parameters: %#v", config)
	}
	if _, exists := config["audioInstructions"]; exists {
		t.Fatalf("non-speech track inherited caller instructions: %#v", config)
	}
	if req.Task.Prompt != "温暖舒缓的片尾音乐" {
		t.Fatalf("music task prompt = %q, want persisted track text", req.Task.Prompt)
	}
}

func TestRebuildSpeechRequiresVoiceVersionForFixedProjectCharacter(t *testing.T) {
	service, db := newTimelineTaskTestService(t)
	project := &model.Project{ID: "project-audio", UserID: "user-audio", Name: "Audio identity"}
	asset := &model.Asset{ID: "character-audio", UserID: project.UserID, Kind: "entity", Category: model.AssetCategoryCharacter, Status: model.AssetVersionStatusConfirmed, Title: "固定角色"}
	link := &model.ProjectAssetLink{ID: "project-character-audio", ProjectID: project.ID, AssetID: asset.ID}
	for _, value := range []any{project, asset, link} {
		if err := db.Create(value).Error; err != nil {
			t.Fatalf("seed project character: %v", err)
		}
	}

	binding := map[string]any{
		"stepKey": "audio:row-1:dialogue", "kind": "dialogue", "characterId": asset.ID,
		"lineId": "line-1", "text": "固定角色台词", "model": "CHANNEL_AUDIO::tts",
		"capabilityRevision": "channel-audio:3", "voiceStrategy": "standard_tts", "voiceId": "voice-a",
	}
	run := &model.ProductionRun{
		DomainProjectID: project.ID, AudioMode: model.ProductionAudioModeRebuild,
		PlanJSON: mapJSON(map[string]any{"executionManifest": map[string]any{"audioTrackBindings": []any{binding}}}),
	}
	step := &model.ProductionStep{Kind: "audio", StepKey: "audio:row-1:dialogue"}
	req := &ProductionSubmitRequest{Task: CreateTaskRequest{Type: "canvas_audio", Model: "CHANNEL_AUDIO::tts", Input: map[string]any{
		"mode": "audio", "config": map[string]any{"model": "CHANNEL_AUDIO::tts"},
	}}}
	if err := service.prepareProductionAudioTask(project.UserID, run, step, req); err == nil || !strings.Contains(err.Error(), "必须引用已保存的 VoiceProfile/VoiceVersion") {
		t.Fatalf("fixed project character without VoiceVersion error = %v", err)
	}
}

func TestRebuildSpeechAllowsTemporarySpeakerWithoutVoiceVersion(t *testing.T) {
	service, _ := newTimelineTaskTestService(t)
	binding := map[string]any{
		"stepKey": "audio:row-1:dialogue", "kind": "dialogue", "characterId": "temporary-speaker-1",
		"lineId": "line-1", "text": "临时人物台词", "model": "CHANNEL_AUDIO::tts",
		"capabilityRevision": "channel-audio:3", "voiceStrategy": "standard_tts", "voiceId": "registry-voice",
	}
	run := &model.ProductionRun{
		AudioMode: model.ProductionAudioModeRebuild,
		PlanJSON:  mapJSON(map[string]any{"executionManifest": map[string]any{"audioTrackBindings": []any{binding}}}),
	}
	step := &model.ProductionStep{Kind: "audio", StepKey: "audio:row-1:dialogue"}
	req := &ProductionSubmitRequest{Task: CreateTaskRequest{Type: "canvas_audio", Model: "CHANNEL_AUDIO::tts", Input: map[string]any{
		"mode": "audio", "config": map[string]any{"model": "CHANNEL_AUDIO::tts"},
	}}}
	if err := service.prepareProductionAudioTask("user-audio", run, step, req); err != nil {
		t.Fatalf("temporary speaker standard TTS should not require persistent VoiceVersion: %v", err)
	}
}

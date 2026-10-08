package app

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestInferChannelModelCapability(t *testing.T) {
	cases := []struct {
		modelKey string
		want     string
	}{
		{"minimax_h3_z0902", "video"},
		{"minimax_h3_image_audio_to_video_v2", "video"},
		{"h3 六图生视频", "video"},
		{"wan2.2-i2v", "video"},
		{"veo-3", "video"},
		{"qwen-image", "image"},
		{"gpt-image-2", "image"},
		{"flux-1.1-pro", "image"},
		{"mimo-v2.5-tts", "audio"},
		{"voice-clone", "audio"},
		{"deepseek-v4.1-flash", "text"},
		{"", ""},
	}
	for _, item := range cases {
		if got := inferChannelModelCapability(item.modelKey); got != item.want {
			t.Fatalf("inferChannelModelCapability(%q) = %q, want %q", item.modelKey, got, item.want)
		}
	}
}

func TestDefaultChannelModelCapabilityJSONForVideoIsUsableButNarrowable(t *testing.T) {
	raw, ok := defaultChannelModelCapabilityJSON("video", "", "minimax_h3_z0902")
	if !ok {
		t.Fatal("video capability should produce a default declaration")
	}
	config := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		t.Fatal(err)
	}
	video, _ := config["video"].(map[string]any)
	operations := stringListFromAny(video["operations"])
	if len(operations) != 2 || operations[0] != "text_to_video" || operations[1] != "image_to_video" {
		t.Fatalf("operations = %v, want both text_to_video and image_to_video", operations)
	}
	references, _ := video["references"].(map[string]any)
	if numberValue(references["maxImages"]) != float64(autoVideoMaxReferenceImages) {
		t.Fatalf("maxImages = %v, want %d", references["maxImages"], autoVideoMaxReferenceImages)
	}
	if video["defaultOperation"] != "text_to_video" {
		t.Fatalf("defaultOperation = %v", video["defaultOperation"])
	}
}

func TestDefaultChannelModelCapabilityJSONForAudioTTS(t *testing.T) {
	raw, ok := defaultChannelModelCapabilityJSON("audio", "", "mimo-v2.5-tts")
	if !ok {
		t.Fatal("audio capability should produce a default declaration")
	}
	config := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		t.Fatal(err)
	}
	audio, _ := config["audio"].(map[string]any)
	if audio["tts"] != "configured" {
		t.Fatalf("tts = %v, want configured for a TTS-looking model", audio["tts"])
	}
	if audio["ambientSound"] == "configured" || audio["music"] == "configured" {
		t.Fatalf("没有实测证据时不得声明 ambient/music：%v", audio)
	}

	// 不是 TTS 特征的音频模型保持 unknown，避免凭名字硬猜。
	rawOther, ok := defaultChannelModelCapabilityJSON("audio", "", "some-audio-model")
	if !ok {
		t.Fatal("audio capability should produce a default declaration")
	}
	other := map[string]any{}
	if err := json.Unmarshal([]byte(rawOther), &other); err != nil {
		t.Fatal(err)
	}
	if otherAudio, _ := other["audio"].(map[string]any); otherAudio["tts"] != "unknown" {
		t.Fatalf("tts = %v, want unknown", otherAudio["tts"])
	}
}

func TestIndexTTSAsyncAudioDefaultDeclaresOnlyVerifiedReferenceField(t *testing.T) {
	for _, tc := range []struct {
		protocol model.ChannelInterfaceType
		modelKey string
		want     bool
	}{
		{model.ChannelInterfaceAsyncAudio, "indextts2-v1", true},
		{model.ChannelInterfaceAsyncAudio, "other-tts", false},
		{"openai-audio", "indextts2-v1", false},
	} {
		raw, ok := defaultChannelModelCapabilityJSON("audio", tc.protocol, tc.modelKey)
		if !ok {
			t.Fatal("expected audio capability declaration")
		}
		var config ModelCapabilityConfig
		if err := json.Unmarshal([]byte(raw), &config); err != nil {
			t.Fatal(err)
		}
		got := config.Audio.VoiceReference == "configured" && config.Audio.ReferenceAudioParameter == "reference_audio"
		if got != tc.want {
			t.Fatalf("reference support for protocol=%q model=%q = %#v, want supported=%v", tc.protocol, tc.modelKey, config.Audio, tc.want)
		}
	}
}

func TestDiscoveredChannelModelIsEnabledAndDeclared(t *testing.T) {
	item := discoveredChannelModel("MODEL_NEW", "channel-1", "minimax_h3_z0902", "newapi")
	if !item.Enabled {
		t.Fatal("已确认请求协议的模型应默认可用")
	}
	if item.Protocol != "newapi" {
		t.Fatalf("request protocol was not saved: %#v", item)
	}
	if item.Capability != "video" || item.CapabilityVersion != 1 || item.CapabilityConfigJSON == "" {
		t.Fatalf("新模型缺少初始能力声明: %#v", item)
	}
	if item.ProviderModelKey != "minimax_h3_z0902" || item.DisplayName != "minimax_h3_z0902" {
		t.Fatalf("上游模型标识没有带上: %#v", item)
	}

	textModel := discoveredChannelModel("MODEL_TEXT", "channel-1", "deepseek-v4.1-flash", "chat-completion")
	if !textModel.Enabled || textModel.Capability != "text" {
		t.Fatalf("文本模型分类错误: %#v", textModel)
	}
	if textModel.CapabilityConfigJSON != "" {
		t.Fatalf("文本模型不需要能力声明: %#v", textModel)
	}
	unknown := discoveredChannelModel("MODEL_UNKNOWN", "channel-1", "unknown-model", "")
	if unknown.Enabled || unknown.Protocol != "" {
		t.Fatalf("无法确认请求接口的模型不可假装可用: %#v", unknown)
	}
}

func TestDiscoveredChannelModelFromCatalogUsesAdvertisedEndpoint(t *testing.T) {
	cases := []struct {
		name       string
		endpoints  []string
		capability string
		protocol   string
	}{
		{"go-deepseek-v4.1-flash", []string{"openai-response", "openai"}, "text", "chat-completion"},
		{"gpt-image-2", []string{"openai", "image-generation", "image-edit"}, "image", "openai-image"},
		{"gpt-image-2", nil, "image", "openai-image"},
		{"gpt-image-2", []string{"generate", "edit"}, "image", "openai-image"},
		{"gpt-image-2.5", nil, "image", "openai-image"},
		{"gpt-image-2.5", []string{"generate", "edit"}, "image", "openai-image"},
		{"gpt-image-2.5-flare", nil, "image", "openai-image"},
		{"gpt-image-2.5-flare", []string{"generate", "edit"}, "image", "openai-image"},
		{"gpt-image-2.5-sunburst", nil, "image", "openai-image"},
		{"gpt-image-2.5-sunburst", []string{"generate", "edit"}, "image", "openai-image"},
		{"tenant/gpt-image-2.5-sunburst", []string{"openai"}, "image", "openai-image"},
		{"dall-e-3", nil, "image", "openai-image"},
		{"qwen-image", []string{"generate", "edit"}, "image", ""},
		{"gpt-image-2.5-flare", []string{"gemini-image"}, "image", ""},
		{"minimax_h3_image_audio_to_video_v2", []string{"openai", "openai-video"}, "video", "newapi"},
		{"indextts2-v1", []string{"openai", "openai-video"}, "audio", ""},
		{"indextts2-v1", []string{"openai", "audio-speech"}, "audio", "openai-audio"},
		{"gpt-image-2.5-flare", []string{"openai-video"}, "video", "newapi"},
		{"unknown-model", nil, "text", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			item := discoveredChannelModelFromCatalog("MODEL_TEST", "channel-1", ChannelModelCatalogItem{ID: tc.name, SupportedEndpointTypes: tc.endpoints}, "")
			if item.Capability != tc.capability || string(item.Protocol) != tc.protocol || item.Enabled != (tc.protocol != "") {
				t.Fatalf("catalog model = %#v, want capability=%s protocol=%s", item, tc.capability, tc.protocol)
			}
		})
	}
}

func TestMergeChannelModelCatalogMetadataRepairsOnlyMissingProtocol(t *testing.T) {
	entry := ChannelModelCatalogItem{ID: "gpt-image-2.5-flare"}
	legacy := model.ChannelModel{
		ID: "MODEL_LEGACY", ChannelID: "channel-1", ModelKey: entry.ID,
		Capability: "image", Enabled: false,
		CapabilityConfigJSON: `{"version":1,"image":{"size":{"parameter":"size","values":["auto","1:1"],"default":"1:1","allowCustom":true}}}`,
	}
	changed, err := mergeChannelModelCatalogMetadata(&legacy, entry, "openai")
	if err != nil {
		t.Fatalf("mergeChannelModelCatalogMetadata() error = %v", err)
	}
	if !changed || legacy.Protocol != model.ChannelInterfaceOpenAIImage || legacy.Enabled {
		t.Fatalf("legacy model repair = %#v, changed=%v; want openai-image protocol and disabled state preserved", legacy, changed)
	}
	if legacy.CapabilityVersion < 1 {
		t.Fatalf("repaired capability version = %d, want nonzero", legacy.CapabilityVersion)
	}

	manual := model.ChannelModel{
		ID: "MODEL_MANUAL", ChannelID: "channel-1", ModelKey: entry.ID,
		Capability: "image", Protocol: model.ChannelInterfaceVolcengineJiMengImage,
		Enabled: true,
	}
	changed, err = mergeChannelModelCatalogMetadata(&manual, entry, "openai")
	if err != nil {
		t.Fatalf("mergeChannelModelCatalogMetadata() with explicit protocol error = %v", err)
	}
	if manual.Protocol != model.ChannelInterfaceVolcengineJiMengImage || !manual.Enabled {
		t.Fatalf("catalog metadata replaced explicit local protocol or enabled state: %#v", manual)
	}
}

func TestUnconfiguredChannelModelCanOnlyBeSavedDisabled(t *testing.T) {
	disabled, enabled := false, true
	channel := &model.ModelChannel{}
	req := ChannelModelRequest{ModelKey: "voice-model", Capability: "audio", Enabled: &disabled}
	_, _, _, protocol, err := normalizeChannelModelContract(channel, req)
	if err != nil || protocol != "" {
		t.Fatalf("disabled unconfigured model: protocol=%q error=%v", protocol, err)
	}
	req.Enabled = &enabled
	if _, _, _, _, err := normalizeChannelModelContract(channel, req); err == nil {
		t.Fatal("enabling a model without a request protocol must fail")
	}
}

func TestUnconfiguredSystemModelIsNotAdvertised(t *testing.T) {
	channel := model.ModelChannel{Scope: model.ChannelScopeSystem, ModelsJSON: `["ghost"]`}
	items := []model.ChannelModel{{ModelKey: "ghost", Enabled: true}}
	result := publicChannel(channel, false, items)
	if len(result.Models) != 0 || len(result.ModelCosts) != 0 {
		t.Fatalf("unconfigured system model leaked into public picker: %#v", result)
	}
}

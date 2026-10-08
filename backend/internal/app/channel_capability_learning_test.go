package app

import (
	"encoding/json"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestClassifyUpstreamCapabilityRejection(t *testing.T) {
	cases := []struct {
		name    string
		message string
		feature string
		ok      bool
	}{
		{name: "英文参考图拒绝", message: `{"error":{"message":"this model does not accept reference images"}}`, feature: "image_input", ok: true},
		{name: "中文参考图拒绝", message: "上游：该模型不支持参考图", feature: "image_input", ok: true},
		{name: "文本拒绝", message: "this model does not support text input", feature: "text_input", ok: true},
		{name: "鉴权问题不是能力结论", message: "401 invalid api key", ok: false},
		{name: "余额问题不是能力结论", message: "402 Insufficient account balance", ok: false},
		{name: "超时不是能力结论", message: "context deadline exceeded", ok: false},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			feature, _, ok := classifyUpstreamCapabilityRejection(item.message)
			if ok != item.ok || feature != item.feature {
				t.Fatalf("classify(%q) = (%q, %v), want (%q, %v)", item.message, feature, ok, item.feature, item.ok)
			}
		})
	}
}

func TestLearnChannelCapabilityNarrowsDeclarationFromUpstreamRejection(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	channel := &model.ModelChannel{ID: "CHANNEL_LEARN", UserID: "user-1", Scope: model.ChannelScopeSystem, Enabled: true, Name: "测试中转站", BaseURL: "https://relay.example.com", APIFormat: "openai"}
	if err := db.Create(channel).Error; err != nil {
		t.Fatal(err)
	}
	declared := `{"version":1,"video":{"operations":["text_to_video","image_to_video"],"defaultOperation":"image_to_video","references":{"minImages":0,"maxImages":9,"maxImageBytes":31457280}}}`
	item := &model.ChannelModel{ID: "MODEL_LEARN", ChannelID: channel.ID, ModelKey: "minimax_h3_b99_001", ProviderModelKey: "minimax_h3_b99_001", DisplayName: "H3 文生视频 通用版", Capability: "video", Enabled: true, CapabilityConfigJSON: declared, CapabilityVersion: 3}
	if err := db.Create(item).Error; err != nil {
		t.Fatal(err)
	}

	changed := svc.LearnChannelCapabilityFromUpstreamFailure(channel.ID, item.ModelKey, `{"error":{"message":"this model does not accept reference images"}}`, "api_call_log")
	if !changed {
		t.Fatal("上游明确拒绝参考图时应当收窄声明")
	}

	stored, err := svc.repo.ChannelModelByID(channel.ID, item.ID)
	if err != nil || stored == nil {
		t.Fatalf("reload channel model: %v", err)
	}
	if stored.CapabilityVersion != 4 {
		t.Fatalf("capabilityVersion = %d, want 4", stored.CapabilityVersion)
	}
	config := map[string]any{}
	if err := json.Unmarshal([]byte(stored.CapabilityConfigJSON), &config); err != nil {
		t.Fatal(err)
	}
	video, _ := config["video"].(map[string]any)
	operations := stringListFromAny(video["operations"])
	if len(operations) != 1 || operations[0] != "text_to_video" {
		t.Fatalf("operations = %v, want [text_to_video]", operations)
	}
	references, _ := video["references"].(map[string]any)
	if numberValue(references["maxImages"]) != 0 {
		t.Fatalf("maxImages = %v, want 0", references["maxImages"])
	}
	if video["defaultOperation"] != "text_to_video" {
		t.Fatalf("defaultOperation = %v, want text_to_video", video["defaultOperation"])
	}
	observations, _ := config["observed"].([]any)
	if len(observations) != 1 {
		t.Fatalf("observed = %#v, want one entry", config["observed"])
	}
	first, _ := observations[0].(map[string]any)
	if first["verdict"] != "unsupported" || first["feature"] != "image_input" {
		t.Fatalf("observation = %#v", first)
	}

	// 已经收窄过就不该重复写库或继续刷版本号。
	if again := svc.LearnChannelCapabilityFromUpstreamFailure(channel.ID, item.ModelKey, "this model does not accept reference images", "api_call_log"); again {
		t.Fatal("重复的同一拒绝不应当再次改声明")
	}
	reloaded, err := svc.repo.ChannelModelByID(channel.ID, item.ID)
	if err != nil || reloaded == nil {
		t.Fatalf("reload after repeat: %v", err)
	}
	if reloaded.CapabilityVersion != 4 {
		t.Fatalf("capabilityVersion after repeat = %d, want 4", reloaded.CapabilityVersion)
	}
}

func TestLearnChannelCapabilityDoesNotInventTextVideoWhenLastOperationRejected(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	channel := &model.ModelChannel{ID: "CHANNEL_LEARN_LAST", UserID: "user-1", Scope: model.ChannelScopeSystem, Enabled: true, Name: "测试中转站", BaseURL: "https://relay.example.com", APIFormat: "openai"}
	if err := db.Create(channel).Error; err != nil {
		t.Fatal(err)
	}
	declared := DefaultModelCapabilityConfigForModel("", "example-image-video-model")
	declared.Video.Operations = []string{"image_to_video"}
	declared.Video.DefaultOperation = "image_to_video"
	encoded, err := json.Marshal(declared)
	if err != nil {
		t.Fatal(err)
	}
	item := &model.ChannelModel{ID: "MODEL_LEARN_LAST", ChannelID: channel.ID, ModelKey: "example-image-video-model", ProviderModelKey: "example-image-video-model", DisplayName: "仅图生视频模型", Capability: "video", Enabled: true, CapabilityConfigJSON: string(encoded), CapabilityVersion: 1}
	if err := db.Create(item).Error; err != nil {
		t.Fatal(err)
	}

	if !svc.LearnChannelCapabilityFromUpstreamFailure(channel.ID, item.ModelKey, "this model does not accept reference images", "api_call_log") {
		t.Fatal("上游明确拒绝参考图时应当记录收窄结论")
	}
	stored, err := svc.repo.ChannelModelByID(channel.ID, item.ID)
	if err != nil || stored == nil {
		t.Fatalf("reload channel model: %v", err)
	}
	learned, err := DecodeModelCapabilityConfig(stored.CapabilityConfigJSON)
	if err != nil || learned == nil || learned.Video == nil {
		t.Fatalf("decode learned capability: %v", err)
	}
	if len(learned.Video.Operations) != 0 {
		t.Fatalf("operations = %v, want empty; refusal cannot imply another operation", learned.Video.Operations)
	}
	if learned.Video.DefaultOperation != "" {
		t.Fatalf("defaultOperation = %q, want empty when no declared operation remains", learned.Video.DefaultOperation)
	}
	if _, err := NormalizeModelCapabilityConfigForModel("video", "", item.ModelKey, learned); err == nil {
		t.Fatal("an operation-less model must not normalize as a usable video capability")
	}
}

func TestLearnChannelCapabilityIgnoresNonCapabilityFailures(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	channel := &model.ModelChannel{ID: "CHANNEL_LEARN2", UserID: "user-1", Scope: model.ChannelScopeSystem, Enabled: true, Name: "测试中转站", BaseURL: "https://relay.example.com", APIFormat: "openai"}
	if err := db.Create(channel).Error; err != nil {
		t.Fatal(err)
	}
	item := &model.ChannelModel{ID: "MODEL_LEARN2", ChannelID: channel.ID, ModelKey: "mimo-v2.5-tts", Capability: "audio", Enabled: true, CapabilityConfigJSON: `{"version":1,"audio":{"tts":"configured"}}`, CapabilityVersion: 1}
	if err := db.Create(item).Error; err != nil {
		t.Fatal(err)
	}
	if svc.LearnChannelCapabilityFromUpstreamFailure(channel.ID, item.ModelKey, `{"error":{"code":"402","message":"Insufficient account balance"}}`, "api_call_log") {
		t.Fatal("余额不足不应当被当成能力结论")
	}
	stored, err := svc.repo.ChannelModelByID(channel.ID, item.ID)
	if err != nil || stored == nil {
		t.Fatalf("reload channel model: %v", err)
	}
	if stored.CapabilityVersion != 1 || stored.CapabilityConfigJSON != item.CapabilityConfigJSON {
		t.Fatalf("非能力失败不应改声明：version=%d config=%s", stored.CapabilityVersion, stored.CapabilityConfigJSON)
	}
}

func TestCapabilityEvidenceSurvivesCatalogNormalization(t *testing.T) {
	raw := `{"version":1,"video":{"operations":["text_to_video"],"defaultOperation":"text_to_video","references":{"promptMaxChars":8000,"minImages":0,"maxImages":0,"maxImageBytes":0},"duration":{"selection":"range","min":1,"max":15,"step":1,"default":5},"ratios":["16:9"],"defaultRatio":"16:9","generateAudio":{"supported":false,"default":false},"watermark":{"supported":false,"default":false}},"observed":[{"verdict":"unsupported","feature":"image_input","reason":"上游拒绝参考图","source":"api_call_log","at":"2026-09-25T07:00:00Z","details":{"inputCounts":{"images":1},"durationSeconds":8,"size":"1280x720"}}]}`
	config, err := DecodeModelCapabilityConfig(raw)
	if err != nil || config == nil {
		t.Fatalf("decode capability config: %v", err)
	}
	normalized, err := NormalizeModelCapabilityConfigForModel("video", "", "minimax_h3_b99_001", config)
	if err != nil || normalized == nil {
		t.Fatalf("normalize capability config: %v", err)
	}
	if len(normalized.Observed) != 1 || normalized.Observed[0].Feature != "image_input" || normalized.Observed[0].Verdict != "unsupported" {
		t.Fatalf("observed = %#v，归一化不应丢掉实测证据", normalized.Observed)
	}
	if normalized.Observed[0].Details["size"] != "1280x720" || normalized.Observed[0].Details["durationSeconds"] != float64(8) {
		t.Fatalf("observation details lost during normalization: %#v", normalized.Observed[0].Details)
	}
	encoded, err := json.Marshal(normalized)
	if err != nil || !strings.Contains(string(encoded), "image_input") || !strings.Contains(string(encoded), "inputCounts") {
		t.Fatalf("目录返回体里必须带证据：err=%v body=%s", err, encoded)
	}
}

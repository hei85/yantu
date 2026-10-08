package app

import (
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func mustEncodeModelCapabilityConfig(t *testing.T, config *ModelCapabilityConfig) string {
	t.Helper()
	encoded, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestNormalizeChannelModelContract(t *testing.T) {
	channel := &model.ModelChannel{APIKey: "test-key"}
	modelKey, providerModelKey, capability, protocol, err := normalizeChannelModelContract(channel, ChannelModelRequest{
		ModelKey: "models/gpt-test", Capability: "text", Protocol: string(model.ChannelInterfaceChatCompletion),
	})
	if err != nil {
		t.Fatalf("normalizeChannelModelContract() error = %v", err)
	}
	if modelKey != "gpt-test" || providerModelKey != "gpt-test" || capability != "text" || protocol != model.ChannelInterfaceChatCompletion {
		t.Fatalf("contract = %q, %q, %q, %q", modelKey, providerModelKey, capability, protocol)
	}
}

func TestNormalizeChannelModelContractPreservesProviderModelKey(t *testing.T) {
	channel := &model.ModelChannel{APIKey: "test-key"}
	modelKey, providerModelKey, _, _, err := normalizeChannelModelContract(channel, ChannelModelRequest{
		ModelKey: "seedance-2-5-480p", ProviderModelKey: "models/doubao-seedance-2-5", Capability: "video", Protocol: string(model.ChannelInterfaceVolcengineArkVideo),
	})
	if err != nil {
		t.Fatalf("normalizeChannelModelContract() error = %v", err)
	}
	if modelKey != "seedance-2-5-480p" || providerModelKey != "doubao-seedance-2-5" {
		t.Fatalf("contract = %q, %q", modelKey, providerModelKey)
	}
}

func TestNormalizeChannelModelContractRejectsCapabilityMismatch(t *testing.T) {
	channel := &model.ModelChannel{APIKey: "test-key"}
	_, _, _, _, err := normalizeChannelModelContract(channel, ChannelModelRequest{
		ModelKey: "image-test", Capability: "text", Protocol: string(model.ChannelInterfaceOpenAIImage),
	})
	if err == nil {
		t.Fatal("normalizeChannelModelContract() should reject a mismatched capability")
	}
}

func TestNormalizeChannelModelContractRequiresJiMengSecret(t *testing.T) {
	channel := &model.ModelChannel{APIKey: "access-key"}
	_, _, _, _, err := normalizeChannelModelContract(channel, ChannelModelRequest{
		ModelKey: "jimeng-test", Capability: "image", Protocol: string(model.ChannelInterfaceVolcengineJiMengImage),
	})
	if err == nil {
		t.Fatal("normalizeChannelModelContract() should require JiMeng credentials")
	}
}

func TestSaveAdminChannelModelPersistsAndPublishesIcon(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	admin := &model.User{ID: "admin", Role: model.UserRoleAdmin}
	channel := model.ModelChannel{ID: "channel-1", UserID: admin.ID, Scope: model.ChannelScopeSystem, Enabled: true, Name: "Test", BaseURL: "https://example.com/v1", APIKey: "key", APIFormat: "openai", ModelsJSON: `[]`}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	enabled := true
	saved, err := svc.SaveAdminChannelModel(admin, channel.ID, "", ChannelModelRequest{
		ModelKey: "gpt-test", DisplayName: "GPT Test", Icon: "OpenAI", Capability: "text", Protocol: string(model.ChannelInterfaceChatCompletion),
		CapabilityConfig: DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceChatCompletion), "gpt-test"),
		Variants:         []ChannelModelVariantRequest{{Enabled: &enabled}}, Enabled: &enabled,
	})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Icon != "OpenAI" {
		t.Fatalf("saved icon = %q, want OpenAI", saved.Icon)
	}
	var stored model.ChannelModel
	if err := db.First(&stored, "id = ?", saved.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Icon != "OpenAI" {
		t.Fatalf("stored icon = %q, want OpenAI", stored.Icon)
	}
	public, err := svc.sanitizeChannelModel(saved)
	if err != nil {
		t.Fatal(err)
	}
	if public.Icon != "OpenAI" {
		t.Fatalf("public icon = %q, want OpenAI", public.Icon)
	}
	legacyPublic := publicChannel(channel, false, []model.ChannelModel{*saved})
	if len(legacyPublic.ModelCosts) != 1 || legacyPublic.ModelCosts[0].Icon != "OpenAI" {
		t.Fatalf("legacy public model costs = %#v", legacyPublic.ModelCosts)
	}
}

func TestSaveAdminChannelModelBumpsCapabilityVersionWhenExecutionIdentityChanges(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	admin := &model.User{ID: "admin", Role: model.UserRoleAdmin}
	channel := model.ModelChannel{ID: "channel-revision", UserID: admin.ID, Scope: model.ChannelScopeSystem, Enabled: true, Name: "Revision", BaseURL: "https://example.com/v1", APIKey: "key", APIFormat: "openai", ModelsJSON: `[]`}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	enabled := true
	request := ChannelModelRequest{
		ModelKey: "revision-text", ProviderModelKey: "provider-v1", Capability: "text", Protocol: string(model.ChannelInterfaceChatCompletion),
		CapabilityConfig: DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceChatCompletion), "revision-text"),
		Variants:         []ChannelModelVariantRequest{{Enabled: &enabled}}, Enabled: &enabled,
	}
	created, err := svc.SaveAdminChannelModel(admin, channel.ID, "", request)
	if err != nil {
		t.Fatalf("create model: %v", err)
	}
	if created.CapabilityVersion == 0 {
		t.Fatalf("new model capability version = %d, want nonzero", created.CapabilityVersion)
	}
	firstRevision := created.CapabilityVersion
	request.ProviderModelKey = "provider-v2"
	updated, err := svc.SaveAdminChannelModel(admin, channel.ID, created.ID, request)
	if err != nil {
		t.Fatalf("update provider identity: %v", err)
	}
	if updated.CapabilityVersion <= firstRevision {
		t.Fatalf("capability version = %d after provider change, want greater than %d", updated.CapabilityVersion, firstRevision)
	}
	stableVersion := updated.CapabilityVersion
	unchanged, err := svc.SaveAdminChannelModel(admin, channel.ID, created.ID, request)
	if err != nil {
		t.Fatalf("save unchanged model: %v", err)
	}
	if unchanged.CapabilityVersion != stableVersion {
		t.Fatalf("unchanged model version = %d, want stable %d", unchanged.CapabilityVersion, stableVersion)
	}
}

func TestSaveAdminChannelModelObservedEvidenceDoesNotBumpCapabilityVersion(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	admin := &model.User{ID: "admin", Role: model.UserRoleAdmin}
	channel := model.ModelChannel{ID: "channel-observed", UserID: admin.ID, Scope: model.ChannelScopeSystem, Enabled: true, Name: "Observed", BaseURL: "https://example.com/v1", APIKey: "key", APIFormat: "openai", ModelsJSON: `[]`}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	enabled := true
	request := ChannelModelRequest{
		ModelKey: "observed-text", ProviderModelKey: "provider-v1", Capability: "text", Protocol: string(model.ChannelInterfaceChatCompletion),
		CapabilityConfig: DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceChatCompletion), "observed-text"),
		Variants:         []ChannelModelVariantRequest{{Enabled: &enabled}}, Enabled: &enabled,
	}
	created, err := svc.SaveAdminChannelModel(admin, channel.ID, "", request)
	if err != nil {
		t.Fatalf("create model: %v", err)
	}
	version := created.CapabilityVersion
	request.CapabilityConfig.Observed = []CapabilityObservation{{
		Verdict: "supported", Feature: "generated_audio", Source: "api_call_log",
		Details: map[string]any{"hasAudio": true, "durationSeconds": float64(8)},
	}}
	withAudio, err := svc.SaveAdminChannelModel(admin, channel.ID, created.ID, request)
	if err != nil {
		t.Fatalf("save successful audio observation: %v", err)
	}
	if withAudio.CapabilityVersion != version {
		t.Fatalf("version after audio observation = %d, want unchanged %d", withAudio.CapabilityVersion, version)
	}
	request.CapabilityConfig.Observed = append(request.CapabilityConfig.Observed, CapabilityObservation{
		Verdict: "unsupported", Feature: "generated_audio", Reason: "成功响应没有音轨", Source: "api_call_log",
		Details: map[string]any{"hasAudio": false, "durationSeconds": float64(8)},
	})
	withSilent, err := svc.SaveAdminChannelModel(admin, channel.ID, created.ID, request)
	if err != nil {
		t.Fatalf("save successful silent observation: %v", err)
	}
	if withSilent.CapabilityVersion != version {
		t.Fatalf("version after silent observation = %d, want unchanged %d", withSilent.CapabilityVersion, version)
	}
	stored, err := svc.repo.ChannelModelByID(channel.ID, created.ID)
	if err != nil {
		t.Fatalf("reload model: %v", err)
	}
	config, err := DecodeModelCapabilityConfig(stored.CapabilityConfigJSON)
	if err != nil || len(config.Observed) != 2 {
		t.Fatalf("decode observations: err=%v observed=%#v", err, config)
	}
	if config.Observed[0].Details["hasAudio"] != true || config.Observed[0].Details["durationSeconds"] != float64(8) || config.Observed[1].Details["hasAudio"] != false {
		t.Fatalf("observation details did not round-trip: %#v", config.Observed)
	}
}

func TestSaveAdminChannelModelBumpsVersionWhenCapabilityContractChanges(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	admin := &model.User{ID: "admin", Role: model.UserRoleAdmin}
	channel := model.ModelChannel{ID: "channel-contract", UserID: admin.ID, Scope: model.ChannelScopeSystem, Enabled: true, Name: "Contract", BaseURL: "https://example.com/v1", APIKey: "key", APIFormat: "openai", ModelsJSON: `[]`}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	enabled := true
	request := ChannelModelRequest{
		ModelKey: "contract-text", ProviderModelKey: "provider-v1", Capability: "text", Protocol: string(model.ChannelInterfaceChatCompletion),
		CapabilityConfig: DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceChatCompletion), "contract-text"),
		Variants:         []ChannelModelVariantRequest{{Enabled: &enabled}}, Enabled: &enabled,
	}
	created, err := svc.SaveAdminChannelModel(admin, channel.ID, "", request)
	if err != nil {
		t.Fatalf("create model: %v", err)
	}
	request.CapabilityConfig.Text.References.MaxImages++
	updated, err := svc.SaveAdminChannelModel(admin, channel.ID, created.ID, request)
	if err != nil {
		t.Fatalf("save changed contract: %v", err)
	}
	if updated.CapabilityVersion <= created.CapabilityVersion {
		t.Fatalf("version after contract change = %d, want greater than %d", updated.CapabilityVersion, created.CapabilityVersion)
	}
}

func TestSanitizeChannelModelRejectsCorruptCapabilityConfig(t *testing.T) {
	svc := &Service{}
	_, err := svc.sanitizeChannelModel(&model.ChannelModel{
		ID:                   "broken-image-model",
		Capability:           "image",
		CapabilityConfigJSON: `{`,
	})
	if err == nil {
		t.Fatal("sanitizeChannelModel() should reject corrupt capability JSON")
	}
}

func TestSanitizeChannelModelPublishesEnabledModelVariants(t *testing.T) {
	svc := &Service{}
	channelModel := &model.ChannelModel{
		ID:                   "image-model",
		ModelKey:             "image-model",
		Capability:           "image",
		Protocol:             model.ChannelInterfaceOpenAIImage,
		Enabled:              true,
		CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceOpenAIImage), "image-model")),
	}

	public, err := svc.sanitizeChannelModel(channelModel)
	if err != nil {
		t.Fatal(err)
	}
	if !public.Available || len(public.Variants) != 0 {
		t.Fatalf("enabled model without variants was not published: %#v", public)
	}

	channelModel.Variants = []model.ChannelModelVariant{{
		ID: "tier-1", Enabled: true,
	}}
	public, err = svc.sanitizeChannelModel(channelModel)
	if err != nil {
		t.Fatal(err)
	}
	if !public.Available || len(public.Variants) != 1 {
		t.Fatalf("variant was not published: %#v", public)
	}
}

func TestChannelModelMatchesIntentUsesPersistedCapabilityContract(t *testing.T) {
	svc := &Service{}
	profile := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceOpenAIImage), "image-model")
	profile.Image.References.MaxImages = 1
	channelModel := &model.ChannelModel{
		ID:                   "image-model",
		ModelKey:             "image-model",
		Capability:           "image",
		Protocol:             model.ChannelInterfaceOpenAIImage,
		CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, profile),
	}

	matched, err := svc.channelModelMatchesIntent(channelModel, &ModelRequestIntent{
		Capability: "image",
		Inputs:     map[string]int{"image": 2},
	})
	if err != nil {
		t.Fatal(err)
	}
	if matched {
		t.Fatal("request exceeding the persisted reference-image limit should not match")
	}

	channelModel.CapabilityConfigJSON = `{`
	if _, err := svc.channelModelMatchesIntent(channelModel, &ModelRequestIntent{Capability: "image"}); err == nil {
		t.Fatal("corrupt persisted capability config should fail closed")
	}
}

func TestPublicSystemChannelCatalogIsolatesCorruptModel(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	channel := model.ModelChannel{ID: "system-channel", Scope: model.ChannelScopeSystem, Enabled: true, Name: "系统渠道"}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	validConfig := mustEncodeModelCapabilityConfig(t, DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceOpenAIImage), "valid-model"))
	models := []model.ChannelModel{
		{ID: "valid-model", ChannelID: channel.ID, ModelKey: "valid-model", Capability: "image", Protocol: model.ChannelInterfaceOpenAIImage, CapabilityConfigJSON: validConfig, Enabled: true},
		{ID: "broken-model", ChannelID: channel.ID, ModelKey: "broken-model", Capability: "image", Protocol: model.ChannelInterfaceOpenAIImage, CapabilityConfigJSON: `{`, Enabled: true},
	}
	for index := range models {
		if err := db.Create(&models[index]).Error; err != nil {
			t.Fatal(err)
		}
	}

	catalog, err := svc.publicSystemChannelCatalog(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog) != 1 || len(catalog[0].Models) != 1 || catalog[0].Models[0].ID != "valid-model" {
		t.Fatalf("catalog should retain only the valid model: %#v", catalog)
	}
}

func TestImageTestDefaultsUseModelCapability(t *testing.T) {
	tests := []struct {
		name        string
		profile     *ImageCapabilityConfig
		wantSize    string
		wantQuality string
	}{
		{name: "legacy fallback", wantSize: "1024x1024", wantQuality: "auto"},
		{
			name: "fixed 2k model",
			profile: &ImageCapabilityConfig{
				Size:    ImageSizeConfig{Parameter: "size", Default: "2048x2048"},
				Quality: ImageQualityConfig{Supported: false, Default: "auto"},
			},
			wantSize: "2048x2048",
		},
		{
			name: "provider selected size",
			profile: &ImageCapabilityConfig{
				Size:    ImageSizeConfig{Parameter: "none", Default: "auto"},
				Quality: ImageQualityConfig{Supported: false},
			},
		},
		{
			name: "gpt image capability",
			profile: &ImageCapabilityConfig{
				Size:    ImageSizeConfig{Parameter: "size", Default: "1024x1536"},
				Quality: ImageQualityConfig{Supported: true, Default: "high"},
			},
			wantSize: "1024x1536", wantQuality: "high",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			size, quality := imageTestDefaults(test.profile)
			if size != test.wantSize || quality != test.wantQuality {
				t.Fatalf("imageTestDefaults() = %q, %q; want %q, %q", size, quality, test.wantSize, test.wantQuality)
			}
		})
	}
}

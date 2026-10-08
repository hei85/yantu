package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestFetchChannelModelCatalogCarriesRelayDescriptionAndObserved(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"model-a","description":"说你好朋友的短对话","yingce":{"observed":[{"verdict":"observed","feature":"human_dialogue","source":"h3-test","reason":"ASR matched; human clarity unverified","details":{"humanClarityVerified":false}}]}}]}`))
	}))
	defer upstream.Close()

	svc, _ := newChannelModelTestService(t)
	catalog, err := svc.FetchChannelModelCatalog(context.Background(), &model.User{ID: "user-1"}, ChannelModelsRequest{BaseURL: upstream.URL, APIKey: "test-key", APIFormat: "openai"})
	if err != nil {
		t.Fatalf("FetchChannelModelCatalog() error = %v", err)
	}
	if len(catalog) != 1 || catalog[0].Description != "说你好朋友的短对话" {
		t.Fatalf("catalog = %#v, want description carried through", catalog)
	}
	if len(catalog[0].Observed) != 1 || catalog[0].Observed[0].Feature != "human_dialogue" || catalog[0].Observed[0].Source != "h3-test" || catalog[0].Observed[0].Details["humanClarityVerified"] != false {
		t.Fatalf("catalog observed = %#v", catalog[0].Observed)
	}

	encoded, err := json.Marshal(catalog[0])
	if err != nil {
		t.Fatal(err)
	}
	var roundTrip ChannelModelCatalogItem
	if err := json.Unmarshal(encoded, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if roundTrip.Description != catalog[0].Description || !reflect.DeepEqual(roundTrip.Observed, catalog[0].Observed) {
		t.Fatalf("catalog app contract lost metadata: %#v", roundTrip)
	}
}

func TestDiscoveredChannelModelFromCatalogCarriesDescriptionAndObserved(t *testing.T) {
	item := discoveredChannelModelFromCatalog("MODEL_NEW", "channel-1", ChannelModelCatalogItem{
		ID:                     "minimax_h3_z0902",
		Description:            "ASR matches the short phrase; clarity unverified",
		SupportedEndpointTypes: []string{"openai-video"},
		Observed: []CapabilityObservation{{
			Verdict: "observed", Feature: "human_dialogue", Source: "h3-test",
			Details: map[string]any{"humanClarityVerified": false},
		}},
	}, "openai")
	config, err := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
	if err != nil {
		t.Fatal(err)
	}
	if item.Description != "ASR matches the short phrase; clarity unverified" || config == nil || len(config.Observed) != 1 {
		t.Fatalf("discovered model did not carry metadata: model=%#v config=%#v", item, config)
	}
	if config.Video == nil || item.Protocol != model.ChannelInterfaceNewAPIVideo || !item.Enabled {
		t.Fatalf("discovered model lost its local auto configuration: %#v", item)
	}
}

func TestFetchAdminChannelModelsMergesMetadataWithoutReplacingLocalConfiguration(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"model-a","description":"Relay short dialogue","yingce":{"observed":[{"verdict":"observed","feature":"human_dialogue","source":"relay","reason":"ASR exact match","details":{"humanClarityVerified":false}}]}}]}`))
	}))
	defer upstream.Close()

	svc, db := newChannelModelTestService(t)
	admin := &model.User{ID: "admin", Role: model.UserRoleAdmin}
	channel := model.ModelChannel{ID: "channel-1", UserID: admin.ID, Scope: model.ChannelScopeSystem, Enabled: true, Name: "Test", BaseURL: upstream.URL, APIKey: "key", APIFormat: "openai", ModelsJSON: `[]`}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	localConfig := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceNewAPIVideo), "model-a")
	localConfig.Video.Duration.Max = 9
	localConfig.Observed = []CapabilityObservation{
		{Verdict: "observed", Feature: "human_dialogue", Source: "relay", Reason: "old upstream fact"},
		{Verdict: "observed", Feature: "local_check", Source: "local", Reason: "keep local fact"},
		{Verdict: "rejected", Feature: "local_check", Source: "local", Reason: "duplicate local fact"},
	}
	capabilityJSON, err := json.Marshal(localConfig)
	if err != nil {
		t.Fatal(err)
	}
	existing := model.ChannelModel{
		ID: "MODEL_EXISTING", ChannelID: channel.ID, ModelKey: "model-a", ProviderModelKey: "upstream-model-a",
		DisplayName: "Local display name", Description: "Stale relay description", Icon: "local-icon",
		Capability: "video", CapabilityVersion: 17, CapabilityConfigJSON: string(capabilityJSON),
		Protocol: model.ChannelInterfaceNewAPIVideo, Enabled: false,
	}
	if err := db.Create(&existing).Error; err != nil {
		t.Fatal(err)
	}
	tier := model.ChannelModelVariant{ID: "TIER_EXISTING", ChannelModelID: existing.ID, SelectorKey: "{}", SelectorJSON: "{}", Resolution: "480P", VideoSeconds: 2, ProviderModelKey: "local-tier-model", Enabled: false}
	if err := db.Create(&tier).Error; err != nil {
		t.Fatal(err)
	}

	for attempt := 0; attempt < 2; attempt++ {
		result, err := svc.FetchAdminChannelModels(context.Background(), admin, channel.ID)
		if err != nil {
			t.Fatalf("FetchAdminChannelModels() attempt %d error = %v", attempt+1, err)
		}
		if result.Added != 0 {
			t.Fatalf("attempt %d added %d duplicate models", attempt+1, result.Added)
		}
	}
	var saved model.ChannelModel
	if err := db.First(&saved, "id = ?", existing.ID).Error; err != nil {
		t.Fatal(err)
	}
	if saved.Description != "Relay short dialogue" || saved.DisplayName != existing.DisplayName || saved.Icon != existing.Icon || saved.Enabled != existing.Enabled || saved.Protocol != existing.Protocol || saved.CapabilityVersion != existing.CapabilityVersion {
		t.Fatalf("metadata sync changed more than description/observations: %#v", saved)
	}
	savedConfig, err := DecodeModelCapabilityConfig(saved.CapabilityConfigJSON)
	if err != nil {
		t.Fatal(err)
	}
	if savedConfig.Video == nil || !reflect.DeepEqual(savedConfig.Video, localConfig.Video) {
		t.Fatalf("local video dimensions/config changed: got %#v, want %#v", savedConfig.Video, localConfig.Video)
	}
	if len(savedConfig.Observed) != 2 {
		t.Fatalf("observations = %#v, want one preserved local item plus one upstream item", savedConfig.Observed)
	}
	if savedConfig.Observed[0].Feature != "local_check" || savedConfig.Observed[0].Reason != "keep local fact" || savedConfig.Observed[1].Feature != "human_dialogue" || savedConfig.Observed[1].Reason != "ASR exact match" {
		t.Fatalf("observed merge lost local evidence or failed to refresh relay evidence: %#v", savedConfig.Observed)
	}
	var tiers []model.ChannelModelVariant
	if err := db.Where("channel_model_id = ?", existing.ID).Find(&tiers).Error; err != nil {
		t.Fatal(err)
	}
	if len(tiers) != 1 || tiers[0].ProviderModelKey != tier.ProviderModelKey || tiers[0].Resolution != tier.Resolution || tiers[0].VideoSeconds != tier.VideoSeconds || tiers[0].Enabled != tier.Enabled {
		t.Fatalf("metadata sync changed local variants: %#v", tiers)
	}
}

func TestImportAdminChannelModelsUpdatesMetadataOnlyForSelectedExistingRows(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"model-a","description":"Selected relay description","yingce":{"observed":[{"verdict":"observed","feature":"short_dialogue","source":"relay","reason":"ASR exact match"}]}},{"id":"model-b","description":"Unselected relay description","yingce":{"observed":[{"verdict":"observed","feature":"other","source":"relay"}]}}]}`))
	}))
	defer upstream.Close()

	svc, db := newChannelModelTestService(t)
	admin := &model.User{ID: "admin", Role: model.UserRoleAdmin}
	channel := model.ModelChannel{ID: "channel-1", UserID: admin.ID, Scope: model.ChannelScopeSystem, Enabled: true, Name: "Test", BaseURL: upstream.URL, APIKey: "key", APIFormat: "openai", ModelsJSON: `[]`}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	models := []model.ChannelModel{
		{ID: "MODEL_A", ChannelID: channel.ID, ModelKey: "model-a", ProviderModelKey: "model-a", DisplayName: "A local", Description: "A old", Capability: "text", Protocol: model.ChannelInterfaceChatCompletion, Enabled: false},
		{ID: "MODEL_B", ChannelID: channel.ID, ModelKey: "model-b", ProviderModelKey: "model-b", DisplayName: "B local", Description: "B old", Capability: "text", Protocol: model.ChannelInterfaceChatCompletion, Enabled: true},
	}
	if err := db.Create(&models).Error; err != nil {
		t.Fatal(err)
	}
	result, err := svc.ImportAdminChannelModels(context.Background(), admin, channel.ID, []string{"model-a"})
	if err != nil {
		t.Fatalf("ImportAdminChannelModels() error = %v", err)
	}
	if result.Added != 0 || !reflect.DeepEqual(result.Models, []string{"model-a"}) {
		t.Fatalf("import result = %#v", result)
	}
	var savedA, savedB model.ChannelModel
	if err := db.First(&savedA, "id = ?", "MODEL_A").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.First(&savedB, "id = ?", "MODEL_B").Error; err != nil {
		t.Fatal(err)
	}
	if savedA.Description != "Selected relay description" {
		t.Fatalf("selected description = %q", savedA.Description)
	}
	configA, err := DecodeModelCapabilityConfig(savedA.CapabilityConfigJSON)
	if err != nil || configA == nil || len(configA.Observed) != 1 || configA.Observed[0].Feature != "short_dialogue" {
		t.Fatalf("selected observations = %#v, error = %v", configA, err)
	}
	if savedB.Description != "B old" || savedB.CapabilityConfigJSON != "" || !savedB.Enabled {
		t.Fatalf("unselected model was modified: %#v", savedB)
	}
}

package app

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestCatalogVideoResolutionDiscovery(t *testing.T) {
	for _, tc := range []struct {
		name   string
		want   []string
		source string
	}{
		{"MiniMax H3-1", []string{"768P", "2K"}, "model-profile"},
		{"vendor/MiniMax-H3", []string{"768P", "2K"}, "model-profile"},
		{"MiniMax-H3-Max", []string{"480P", "768P"}, "model-profile"},
		{"some-video-1080p", []string{"1080P"}, "model-id"},
		{"private-video-2k", []string{"2K"}, "model-id"},
		{"doubao-seedance-2-0-mini-260615", nil, ""},
		{"minimax_h3_z0902", nil, ""},
		{"future-unknown-video", nil, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			entry := enrichCatalogVideoResolutions(ChannelModelCatalogItem{ID: tc.name, ModelType: "video"})
			var got []string
			for _, tier := range entry.Options.Resolution {
				got = append(got, tier.Value)
			}
			if !reflect.DeepEqual(got, tc.want) || entry.ResolutionSource != tc.source {
				t.Fatalf("resolution discovery = %#v, source=%q; want %v %q", got, entry.ResolutionSource, tc.want, tc.source)
			}
		})
	}
	entry := enrichCatalogVideoResolutions(ChannelModelCatalogItem{ID: "MiniMax H3-1", ModelType: "video", Options: ChannelModelCatalogOptions{Resolution: []ChannelModelCatalogOption{{Value: "480P"}}}})
	if len(entry.Options.Resolution) != 1 || entry.Options.Resolution[0].Value != "480P" || entry.ResolutionSource != "catalog" {
		t.Fatal("an explicit relay tier must precede the official-family template")
	}
}

func TestCatalogVideoResolutionNamingStyles(t *testing.T) {
	for _, raw := range []string{
		`{"id":"test-video","options":{"resolution_name":["480P",{"value":"768P","label":"HD"},null]}}`,
		`{"id":"test-video","supportedResolutions":["480P","768P"]}`,
		`{"id":"test-video","options":{"resolution":{"enum":["480P","768P"]}}}`,
		`{"id":"test-video","defaultParameters":{"aspectRatio":"16:9","durationSeconds":5,"resolutionName":"768P"},"options":{"resolutions":["480P","768P"]}}`,
	} {
		var item channelModelItem
		if err := json.Unmarshal([]byte(raw), &item); err != nil {
			t.Fatal(err)
		}
		if len(item.Options.Resolution) != 2 || item.Options.Resolution[0].Value != "480P" || item.Options.Resolution[1].Value != "768P" {
			t.Fatalf("lost options from %s: %#v", raw, item.Options)
		}
		if item.DefaultParameters.Resolution != "" && (item.DefaultParameters.AspectRatio != "16:9" || item.DefaultParameters.DurationSeconds != "5") {
			t.Fatalf("lost camel-case defaults: %#v", item.DefaultParameters)
		}
	}
	var nullable channelModelItem
	if err := json.Unmarshal([]byte(`{"id":"video","options":{"resolution":null},"defaultParameters":null}`), &nullable); err != nil {
		t.Fatal(err)
	}
	if len(nullable.Options.Resolution) != 0 {
		t.Fatal("null must stay empty")
	}
}

func TestCatalogVideoResolutionImportAndRefresh(t *testing.T) {
	entry := enrichCatalogVideoResolutions(ChannelModelCatalogItem{ID: "MiniMax H3-1", ModelType: "video", SupportedEndpointTypes: []string{"openai-video"}})
	item := discoveredChannelModelFromCatalog("MODEL_NEW", "CHANNEL_NEW", entry, "openai")
	config, err := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(config.Video.Resolutions, []string{"768P", "2K"}) || config.Video.DefaultResolution != "768P" || config.Video.ResolutionSource != "model-profile" || item.CapabilityVersion != 1 {
		t.Fatalf("new import lost resolution configuration: %#v %#v", item, config.Video)
	}
	config.Video.Resolutions = nil
	config.Video.DefaultResolution = ""
	encoded, _ := json.Marshal(config)
	item.CapabilityConfigJSON = string(encoded)
	item.CapabilityVersion = 4
	changed, err := mergeChannelModelCatalogMetadata(&item, entry, "openai")
	if err != nil || !changed || item.CapabilityVersion != 5 {
		t.Fatalf("existing empty configuration not repaired: %v %v %#v", changed, err, item)
	}
	if changed, err := mergeChannelModelCatalogMetadata(&item, entry, "openai"); err != nil || changed || item.CapabilityVersion != 5 {
		t.Fatalf("repeat refresh must be idempotent: %v %v", changed, err)
	}
	config.Video.Resolutions = []string{"736P"}
	config.Video.DefaultResolution = "736P"
	encoded, _ = json.Marshal(config)
	item.CapabilityConfigJSON = string(encoded)
	if changed, err := mergeChannelModelCatalogMetadata(&item, entry, "openai"); err != nil || changed {
		t.Fatalf("manual tier overwritten: %v %v", changed, err)
	}
	config.Video.Resolutions = nil
	config.Video.DefaultResolution = ""
	config.Observed = []CapabilityObservation{{Feature: "resolution", Verdict: "unsupported", Source: "upstream"}}
	if fillMissingCatalogVideoResolutions(config, entry) {
		t.Fatal("explicit rejection must survive template matching")
	}
}

func TestCatalogVideoResolutionImportPrefersRelayDeclaration(t *testing.T) {
	entry := ChannelModelCatalogItem{ID: "MiniMax H3-1", ModelType: "video", SupportedEndpointTypes: []string{"openai-video"}, Options: ChannelModelCatalogOptions{Resolution: []ChannelModelCatalogOption{{Value: "480P"}, {Value: "1080P"}}}, DefaultParameters: ChannelModelCatalogDefaultParameters{Resolution: "1080P"}}
	item := discoveredChannelModelFromCatalog("MODEL_NEW", "CHANNEL_NEW", entry, "openai")
	config, err := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(config.Video.Resolutions, []string{"480P", "1080P"}) || config.Video.DefaultResolution != "1080P" || config.Video.ResolutionSource != "catalog" {
		t.Fatalf("relay declaration lost: %#v", config.Video)
	}
}

func TestCatalogVideoResolutionDeclarationReplacesOnlyUnchangedInference(t *testing.T) {
	entry := ChannelModelCatalogItem{ID: "MiniMax H3-1", ModelType: "video"}
	profile := &ModelCapabilityConfig{Video: &VideoCapabilityConfig{}}
	if !fillMissingCatalogVideoResolutions(profile, entry) {
		t.Fatal("expected a family template")
	}
	declared := entry
	declared.Options.Resolution = []ChannelModelCatalogOption{{Value: "480P"}, {Value: "768P"}}
	declared.DefaultParameters.Resolution = "480P"
	if !fillMissingCatalogVideoResolutions(profile, declared) || profile.Video.ResolutionSource != "catalog" || profile.Video.DefaultResolution != "480P" {
		t.Fatalf("new provider declaration must win: %#v", profile.Video)
	}
	profile.Video = &VideoCapabilityConfig{}
	fillMissingCatalogVideoResolutions(profile, entry)
	profile.Video.Resolutions = []string{"736P"}
	profile.Video.DefaultResolution = "736P"
	if fillMissingCatalogVideoResolutions(profile, declared) {
		t.Fatal("modified/manual tiers must survive refresh")
	}
}

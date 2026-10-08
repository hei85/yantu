package app

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestFutureVideoCatalogImportsDeclaredSpecs(t *testing.T) {
	for _, raw := range []string{
		`{"id":"future-video-model","model_type":"video","supported_endpoint_types":["openai-video"],"default_parameters":{"aspect_ratio":"9:16","duration_seconds":10,"resolution":"1080P"},"options":{"aspect_ratio":["16:9","9:16"],"duration_seconds":[5,10],"resolution":["720P","1080P"]}}`,
		`{"id":"future-video-model","modelType":"video","supportedEndpointTypes":["openai-video"],"defaultParameters":{"aspectRatio":"9:16","durationSeconds":"10","resolutionName":"1080P"},"supportedAspectRatios":["16:9","9:16"],"supportedDurations":[5,10],"supportedResolutions":["720P","1080P"]}`,
		`{"id":"future-video-model","model_type":"video","supported_endpoint_types":["openai-video"],"defaultParameters":{"aspectRatio":"9:16","seconds":10,"resolution":"1080P"},"options":{"ratios":{"enum":["16:9","9:16",null]},"seconds":{"values":[5,10,null,-1,"invalid"]},"resolution_name":{"options":["720P","1080P"]}}}`,
	} {
		var upstream channelModelItem
		if err := json.Unmarshal([]byte(raw), &upstream); err != nil {
			t.Fatal(err)
		}
		entry := ChannelModelCatalogItem{ID: upstream.ID, ModelType: upstream.ModelType, SupportedEndpointTypes: upstream.SupportedEndpointTypes,
			Options:           ChannelModelCatalogOptions{AspectRatio: upstream.Options.AspectRatio, DurationSeconds: upstream.Options.DurationSeconds, Resolution: upstream.Options.Resolution},
			DefaultParameters: ChannelModelCatalogDefaultParameters{AspectRatio: upstream.DefaultParameters.AspectRatio, DurationSeconds: upstream.DefaultParameters.DurationSeconds, Resolution: upstream.DefaultParameters.Resolution}}
		item := discoveredChannelModelFromCatalog("NEW", "RELAY", entry, "openai")
		profile, err := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
		if err != nil {
			t.Fatal(err)
		}
		video := profile.Video
		if !item.Enabled || item.Protocol != "newapi" || item.CapabilityVersion != 1 || video.DefaultRatio != "9:16" || video.DefaultResolution != "1080P" || video.ResolutionSource != "catalog" || !reflect.DeepEqual(video.Ratios, []string{"16:9", "9:16"}) || !reflect.DeepEqual(video.Duration.Values, []int{5, 10}) || video.Duration.Default != 10 {
			t.Fatalf("new model lost upstream declarations: %#v %#v", item, video)
		}
	}
}

func TestFutureVideoMissingMalformedMetadataStaysUnknown(t *testing.T) {
	for _, raw := range []string{
		`{"id":"future-video-model","options":null,"defaultParameters":null}`,
		`{"id":"future-video-model","options":42,"defaultParameters":false}`,
		`{"id":"future-video-model","options":{"resolution":{},"aspectRatio":false,"duration":null}}`,
	} {
		var upstream channelModelItem
		if err := json.Unmarshal([]byte(raw), &upstream); err != nil {
			t.Fatal(err)
		}
		item := discoveredChannelModelFromCatalog("NEW", "RELAY", ChannelModelCatalogItem{ID: upstream.ID, ModelType: "video", SupportedEndpointTypes: []string{"openai-video"}}, "openai")
		config, _ := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
		if len(config.Video.Resolutions) != 0 || config.Video.DefaultResolution != "" {
			t.Fatal("missing metadata cannot invent resolution choices")
		}
	}
}

func TestFutureVideoRefreshPreservesManualSettings(t *testing.T) {
	config := &ModelCapabilityConfig{Video: &VideoCapabilityConfig{Ratios: []string{"4:3"}, DefaultRatio: "4:3", Duration: VideoDurationConfig{Selection: "enum", Values: []int{7}, Default: 7}}}
	entry := ChannelModelCatalogItem{Options: ChannelModelCatalogOptions{AspectRatio: []ChannelModelCatalogOption{{Value: "16:9"}}, DurationSeconds: []ChannelModelCatalogOption{{Value: "5"}}}}
	if fillCatalogVideoSpecs(config, entry, false) || config.Video.DefaultRatio != "4:3" || config.Video.Duration.Default != 7 {
		t.Fatal("refresh replaced an administrator's settings")
	}
	missing := &ModelCapabilityConfig{Video: &VideoCapabilityConfig{}}
	if !fillCatalogVideoSpecs(missing, entry, false) || missing.Video.DefaultRatio != "16:9" || missing.Video.Duration.Default != 5 {
		t.Fatal("absent declarations were not filled")
	}
	if fillCatalogVideoSpecs(missing, entry, false) {
		t.Fatal("refresh must be idempotent")
	}
}

func TestOpenAIVideoPixelSizeKeepsSelectedTierAndRatio(t *testing.T) {
	for _, tc := range []struct{ ratio, tier, want string }{
		{"16:9", "768P", "1366x768"}, {"9:16", "768P", "768x1366"}, {"1:1", "1080P", "1080x1080"},
		{"4:3", "720P", "960x720"}, {"16:9", "2K", "2560x1440"}, {"1024x1792", "720P", "1024x1792"},
	} {
		input := canvasGenerationInput{Mode: "video", Config: providerConfig{InterfaceType: "newapi", Model: "future-video", Size: tc.ratio, VQuality: tc.tier}}
		request := protocolRequestFromInput(input)
		if request.AspectRatio != tc.want || request.Resolution != tc.tier || input.Config.Size != tc.ratio {
			t.Fatalf("ratio=%s tier=%s: %#v", tc.ratio, tc.tier, request)
		}
		input.Config.InterfaceType = "volcengine-ark-video"
		if protocolRequestFromInput(input).AspectRatio != tc.ratio {
			t.Fatal("OpenAI size conversion leaked into another adapter")
		}
	}
}

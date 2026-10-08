package app

import (
	"encoding/json"
	"reflect"
	"strings"

	"infinite-canvas/backend/internal/model"
)

// 拉取/导入模型时按目录声明或渠道的标准接口写入初始能力与协议。
// 声明与真实能力不符时，由上游的能力类拒绝自动收窄
// （见 channel_capability_learning.go）。

const (
	autoVideoMaxReferenceImages = 9
	autoVideoMaxImageBytes      = 30 << 20
	autoVideoMaxSeconds         = 15
)

var autoCapabilityKeywords = []struct {
	capability string
	keywords   []string
}{
	{"video", []string{"video", "h3", "veo", "kling", "seedance", "wan2", "wan-", "wan_", "sora", "runway", "pika", "i2v", "t2v", "mochi", "ltx", "cogvideo", "hunyuan"}},
	{"audio", []string{"tts", "voice", "speech", "audio", "music", "sfx", "sound"}},
	{"image", []string{"image", "img", "flux", "sdxl", "sd3", "dall", "kolors", "midjourney", "nano-banana", "banana", "gpt-image", "qwen-image", "seedream", "recraft"}},
}

// inferChannelModelCapability 只做粗分类，用于给新模型一份可用起点；
// 真实能力仍以能力声明+实测收窄为准，不在这里下结论。
func inferChannelModelCapability(modelKey string) string {
	key := strings.ToLower(strings.TrimSpace(modelKey))
	if key == "" {
		return ""
	}
	for _, group := range autoCapabilityKeywords {
		for _, keyword := range group.keywords {
			if strings.Contains(key, keyword) {
				return group.capability
			}
		}
	}
	return "text"
}

// defaultChannelModelCapabilityJSON 生成初始能力声明；返回 false 表示该类型不需要声明。
func defaultChannelModelCapabilityJSON(capability string, protocol model.ChannelInterfaceType, modelKey string) (string, bool) {
	switch capability {
	case "text":
		config := ModelCapabilityConfig{Version: 1, Text: DefaultTextCapabilityConfig()}
		return marshalModelCapabilityConfig(config)
	case "image":
		config := ModelCapabilityConfig{Version: 1, Image: DefaultImageCapabilityConfig(string(protocol), modelKey)}
		return marshalModelCapabilityConfig(config)
	case "video":
		durationSupported := true
		config := ModelCapabilityConfig{Version: 1, Video: &VideoCapabilityConfig{
			References: VideoReferenceConfig{
				PromptMaxChars: DefaultVideoPromptMaxChars,
				MinImages:      0,
				MaxImages:      autoVideoMaxReferenceImages,
				MaxImageBytes:  autoVideoMaxImageBytes,
			},
			Duration:          VideoDurationConfig{Selection: "range", Min: 1, Max: autoVideoMaxSeconds, Step: 1, Default: 5},
			DurationSupported: &durationSupported,
			Ratios:            []string{"16:9", "9:16", "1:1", "4:3", "3:4", "21:9"},
			DefaultRatio:      "16:9",
			Resolutions:       []string{},
			GenerateAudio:     VideoBooleanConfig{Supported: false, Default: false},
			Watermark:         VideoBooleanConfig{Supported: false, Default: false},
			Operations:        []string{"text_to_video", "image_to_video"},
			DefaultOperation:  "text_to_video",
		}}
		return marshalModelCapabilityConfig(config)
	case "audio":
		audio := DefaultAudioCapabilityConfig()
		key := strings.ToLower(modelKey)
		for _, keyword := range []string{"tts", "voice", "speech"} {
			if strings.Contains(key, keyword) {
				audio.TTS = "configured"
				break
			}
		}
		// The configured Axon async-audio relay exposes a dedicated IndexTTS2
		// mapping from reference_audio to AutoDL prompt_simple. Keep this
		// declaration tightly scoped to that exact model and protocol.
		if protocol == model.ChannelInterfaceAsyncAudio && key == "indextts2-v1" {
			audio.TTS = "configured"
			audio.VoiceReference = "configured"
			audio.ReferenceAudioParameter = "reference_audio"
		}
		config := ModelCapabilityConfig{Version: 1, Audio: audio}
		return marshalModelCapabilityConfig(config)
	default:
		return "", false
	}
}

func marshalModelCapabilityConfig(config ModelCapabilityConfig) (string, bool) {
	encoded, err := json.Marshal(config)
	if err != nil || string(encoded) == "null" {
		return "", false
	}
	return string(encoded), true
}

// discoveredChannelModel creates a model with a concrete request protocol.
// A catalog entry without a known endpoint stays disabled until configured.
func discoveredChannelModel(id, channelID, modelKey string, protocol model.ChannelInterfaceType) model.ChannelModel {
	item := model.ChannelModel{
		ID:               id,
		ChannelID:        channelID,
		ModelKey:         modelKey,
		ProviderModelKey: modelKey,
		DisplayName:      modelKey,
		Protocol:         protocol,
		Enabled:          protocol != "",
	}
	capability := inferChannelModelCapability(modelKey)
	if capability == "" {
		return item
	}
	item.Capability = capability
	if config, ok := defaultChannelModelCapabilityJSON(capability, protocol, modelKey); ok {
		item.CapabilityConfigJSON = config
		item.CapabilityVersion = 1
	}
	return item
}

// The upstream model catalog describes endpoints, while the channel API format
// only describes how to read that catalog. Keep these two concepts separate.
func discoveredChannelModelFromCatalog(id, channelID string, entry ChannelModelCatalogItem, apiFormat string) model.ChannelModel {
	capability := catalogModelCapability(entry)
	protocol := catalogModelProtocol(entry, capability, apiFormat)
	item := discoveredChannelModel(id, channelID, entry.ID, protocol)
	if capability != item.Capability {
		item.Capability = capability
		item.CapabilityConfigJSON = ""
		item.CapabilityVersion = 0
		if config, ok := defaultChannelModelCapabilityJSON(capability, protocol, entry.ID); ok {
			item.CapabilityConfigJSON = config
			item.CapabilityVersion = 1
		}
	}
	if strings.TrimSpace(entry.DisplayName) != "" {
		item.DisplayName = strings.TrimSpace(entry.DisplayName)
	}
	// The default capability JSON created above is valid; use the same metadata
	// merge path as repeated admin pulls/imports so relay observations are carried
	// without replacing the model's local capability declaration.
	_, _ = mergeChannelModelCatalogMetadata(&item, entry, apiFormat)
	if item.Capability == "video" {
		config, err := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
		if err == nil && fillCatalogVideoSpecs(config, entry, true) {
			item.CapabilityConfigJSON, _ = marshalModelCapabilityConfig(*config)
		}
	}
	// A newly imported record saves its initial contract once, at version 1.
	if item.CapabilityConfigJSON != "" {
		item.CapabilityVersion = 1
	}
	return item
}

// Refresh upstream descriptions/evidence and fill only missing resolution
// declarations. Saved local protocols, enablement, variants and tiers survive.
func mergeChannelModelCatalogMetadata(item *model.ChannelModel, entry ChannelModelCatalogItem, apiFormat string) (bool, error) {
	if item == nil {
		return false, nil
	}
	changed := false
	// Repair legacy catalog imports that could not be assigned a protocol.
	// A saved non-empty protocol is an administrator choice and always wins;
	// Enabled is also deliberately left untouched so an explicit disable stays
	// in effect while its request protocol is repaired.
	if strings.TrimSpace(string(item.Protocol)) == "" {
		capability := catalogModelCapability(entry)
		protocol := catalogModelProtocol(entry, capability, apiFormat)
		if protocol != "" && (strings.TrimSpace(item.Capability) == "" || item.Capability == capability) {
			contractChanged := false
			if item.Capability != capability {
				item.Capability = capability
				contractChanged = true
			}
			item.Protocol = protocol
			contractChanged = true
			if strings.TrimSpace(item.CapabilityConfigJSON) == "" {
				if config, ok := defaultChannelModelCapabilityJSON(capability, protocol, entry.ID); ok {
					item.CapabilityConfigJSON = config
					contractChanged = true
				}
			}
			if contractChanged {
				if item.CapabilityVersion < 1 {
					item.CapabilityVersion = 1
				} else {
					item.CapabilityVersion++
				}
				changed = true
			}
		}
	}
	if description := strings.TrimSpace(entry.Description); description != "" && item.Description != description {
		item.Description = description
		changed = true
	}
	if len(entry.Observed) == 0 && item.Capability != "video" {
		return changed, nil
	}
	config, err := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
	if err != nil {
		return changed, err
	}
	if config == nil {
		config = &ModelCapabilityConfig{Version: 1}
	}
	resolutionChanged := item.Capability == "video" && fillMissingCatalogVideoResolutions(config, entry)
	specsChanged := item.Capability == "video" && fillCatalogVideoSpecs(config, entry, false)
	merged := mergeCapabilityObservations(config.Observed, entry.Observed)
	if !resolutionChanged && !specsChanged && reflect.DeepEqual(config.Observed, merged) {
		return changed, nil
	}
	config.Observed = merged
	encoded, err := json.Marshal(config)
	if err != nil {
		return changed, err
	}
	item.CapabilityConfigJSON = string(encoded)
	if resolutionChanged || specsChanged {
		item.CapabilityVersion++
	}
	return true, nil
}

func mergeCapabilityObservations(existing, incoming []CapabilityObservation) []CapabilityObservation {
	keyFor := func(observation CapabilityObservation) string {
		return strings.TrimSpace(observation.Feature) + "\x00" + strings.TrimSpace(observation.Source)
	}
	incomingByKey := make(map[string]CapabilityObservation, len(incoming))
	incomingOrder := make([]string, 0, len(incoming))
	for _, observation := range incoming {
		observation.Feature = strings.TrimSpace(observation.Feature)
		observation.Source = strings.TrimSpace(observation.Source)
		key := keyFor(observation)
		if _, exists := incomingByKey[key]; !exists {
			incomingOrder = append(incomingOrder, key)
		}
		incomingByKey[key] = observation
	}
	merged := make([]CapabilityObservation, 0, len(existing)+len(incomingOrder))
	seen := make(map[string]bool, len(existing)+len(incomingOrder))
	for _, observation := range existing {
		key := keyFor(observation)
		if _, replaced := incomingByKey[key]; replaced || seen[key] {
			continue
		}
		seen[key] = true
		merged = append(merged, observation)
	}
	for _, key := range incomingOrder {
		if seen[key] {
			continue
		}
		seen[key] = true
		merged = append(merged, incomingByKey[key])
	}
	if len(merged) == 0 {
		return nil
	}
	return merged
}

func catalogModelCapability(entry ChannelModelCatalogItem) string {
	if entry.ModelType != "" {
		return entry.ModelType
	}
	key := strings.ToLower(entry.ID)
	for _, endpoint := range entry.SupportedEndpointTypes {
		switch normalizeCatalogEndpoint(endpoint) {
		case "openai-video":
			// Some relays advertise TTS models as video. Do not turn TTS into video.
			if strings.Contains(key, "tts") && !strings.Contains(key, "video") {
				return "audio"
			}
			return "video"
		case "image-generation", "image-edit":
			return "image"
		case "audio-speech", "openai-audio":
			return "audio"
		}
	}
	// GPT Image is an unambiguous image family even when a relay advertises
	// only the broad OpenAI API marker (or no endpoint metadata at all).
	if isOpenAIImageModelFamily(entry.ID) {
		return "image"
	}
	return inferChannelModelCapability(entry.ID)
}

func catalogModelProtocol(entry ChannelModelCatalogItem, capability, apiFormat string) model.ChannelInterfaceType {
	endpoints := make(map[string]bool, len(entry.SupportedEndpointTypes))
	for _, endpoint := range entry.SupportedEndpointTypes {
		endpoints[normalizeCatalogEndpoint(endpoint)] = true
	}
	if capability == "text" && isNonGenerationCatalogModel(entry.ID) {
		return ""
	}
	switch capability {
	case "video":
		if endpoints["openai-video"] {
			return "newapi"
		}
	case "image":
		if endpoints["image-generation"] || endpoints["image-edit"] {
			return model.ChannelInterfaceOpenAIImage
		}
		// /v1/models from OpenAI-compatible relays commonly contains only IDs,
		// or a generic "openai" marker. Only infer the image protocol for
		// well-known OpenAI image model IDs; specialized or unknown endpoints
		// remain governed by their explicit catalog metadata.
		if isOpenAIImageModelFamily(entry.ID) && onlyGenericOpenAIEndpoint(endpoints) {
			return model.ChannelInterfaceOpenAIImage
		}
	case "text":
		if endpoints["openai"] {
			return "chat-completion"
		}
		if endpoints["openai-response"] {
			return "openai-response"
		}
	case "audio":
		if endpoints["audio-speech"] || endpoints["openai-audio"] {
			return "openai-audio"
		}
		key := catalogModelFamilyKey(entry.ID)
		if onlyGenericOpenAIEndpoint(endpoints) && (key == "tts-1" || key == "tts-1-hd" || key == "gpt-4o-mini-tts" || strings.HasPrefix(key, "gpt-4o-mini-tts-")) {
			return "openai-audio"
		}
	}
	// A list-only OpenAI relay uses the channel's standard interface. Dedicated
	// endpoints take precedence; private video/TTS protocols are not invented.
	if strings.EqualFold(strings.TrimSpace(apiFormat), "openai") && onlyGenericOpenAIEndpoint(endpoints) && !isNonGenerationCatalogModel(entry.ID) {
		if capability == "text" {
			return "chat-completion"
		}
		if capability == "image" {
			return model.ChannelInterfaceOpenAIImage
		}
	}
	return ""
}

func normalizeCatalogEndpoint(value string) string {
	endpoint := strings.TrimSpace(strings.ToLower(value))
	endpoint = strings.TrimSpace(strings.TrimPrefix(endpoint, "post "))
	endpoint = strings.TrimPrefix(strings.TrimPrefix(endpoint, "/"), "v1/")
	endpoint = strings.TrimSuffix(endpoint, "/")
	switch endpoint {
	case "chat/completions", "chat-completion", "openai-chat":
		return "openai"
	case "responses", "openai-responses":
		return "openai-response"
	case "images/generations":
		return "image-generation"
	case "images/edits":
		return "image-edit"
	case "audio/speech":
		return "audio-speech"
	case "videos":
		return "openai-video"
	default:
		return endpoint
	}
}

func isNonGenerationCatalogModel(value string) bool {
	key := strings.ToLower(value)
	for _, marker := range []string{"embedding", "embed-", "rerank", "whisper", "transcrib", "realtime"} {
		if strings.Contains(key, marker) {
			return true
		}
	}
	return false
}

func onlyGenericOpenAIEndpoint(endpoints map[string]bool) bool {
	for endpoint := range endpoints {
		// Some relay catalogs use these operation labels instead of endpoint
		// protocol names. They are compatible with the known OpenAI image
		// family fallback and do not select a dedicated provider protocol.
		switch endpoint {
		case "openai", "generate", "edit":
		default:
			return false
		}
	}
	return true
}

func isOpenAIImageModelFamily(value string) bool {
	key := catalogModelFamilyKey(value)
	return key == "gpt-image" || strings.HasPrefix(key, "gpt-image-") || key == "dall-e" || strings.HasPrefix(key, "dall-e-")
}

func catalogModelFamilyKey(value string) string {
	key := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(value), "models/")))
	// A relay may namespace an alias (for example, "tenant/gpt-image-2.5").
	if separator := strings.LastIndexAny(key, "/:"); separator >= 0 {
		key = key[separator+1:]
	}
	return key
}

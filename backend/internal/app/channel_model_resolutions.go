package app

import (
	"encoding/json"
	"reflect"
	"regexp"
	"strings"
)

// A relay's advertised tiers take precedence over family-level templates.
// A family match is an initial configuration, not evidence of a paid test.
const miniMaxH3ResolutionDoc = "https://platform.minimax.io/docs/api-reference/video-generation-v2-create"

var namedVideoResolution = regexp.MustCompile(`(?i)(?:^|[-_/\s])((?:[1-4][0-9]{2,3})p|2k|4k)(?:$|[-_/\s])`)

func enrichCatalogVideoResolutions(entry ChannelModelCatalogItem) ChannelModelCatalogItem {
	if catalogModelCapability(entry) != "video" {
		return entry
	}
	entry.Options.Resolution = normalizeCatalogOptions(entry.Options.Resolution)
	if len(entry.Options.Resolution) > 0 || strings.TrimSpace(entry.DefaultParameters.Resolution) != "" {
		if len(entry.Options.Resolution) == 0 {
			entry.Options.Resolution = []ChannelModelCatalogOption{{Value: strings.TrimSpace(entry.DefaultParameters.Resolution)}}
		}
		if entry.ResolutionSource == "" {
			entry.ResolutionSource = "catalog"
		}
		return entry
	}
	if matched := namedVideoResolution.FindStringSubmatch(entry.ID); len(matched) > 1 {
		value := strings.ToUpper(matched[1])
		entry.Options.Resolution = []ChannelModelCatalogOption{{Value: value}}
		entry.DefaultParameters.Resolution = value
		entry.ResolutionSource = "model-id"
		return entry
	}
	key := strings.NewReplacer("_", "-", " ", "-").Replace(strings.ToLower(strings.TrimSpace(entry.ID)))
	if slash := strings.LastIndex(key, "/"); slash >= 0 {
		key = key[slash+1:]
	}
	var tiers []string
	switch key {
	case "minimax-h3", "minimax-h3-1", "h3", "h3-1":
		tiers = []string{"768P", "2K"}
	case "minimax-h3-max", "minimax-h3-max-1", "h3-max", "h3-max-1":
		tiers = []string{"480P", "768P"}
	default:
		// Private workflows such as minimax_h3_z0902 are not equated with
		// the official API. Unknown IDs retain a visible channel default.
		return entry
	}
	for _, tier := range tiers {
		entry.Options.Resolution = append(entry.Options.Resolution, ChannelModelCatalogOption{Value: tier})
	}
	entry.DefaultParameters.Resolution = "768P"
	entry.ResolutionSource = "model-profile"
	entry.ResolutionSourceURL = miniMaxH3ResolutionDoc
	return entry
}

// Fill absent declarations, or replace an unchanged inferred template with
// a provider declaration. Manual tiers and explicit rejections take priority.
func fillMissingCatalogVideoResolutions(config *ModelCapabilityConfig, entry ChannelModelCatalogItem) bool {
	if config == nil || config.Video == nil {
		return false
	}
	for _, observation := range config.Observed {
		if observation.Feature == "resolution" && observation.Verdict == "unsupported" {
			return false
		}
	}
	profile := config.Video
	entry = enrichCatalogVideoResolutions(entry)
	if len(entry.Options.Resolution) == 0 {
		return false
	}
	if len(profile.Resolutions) > 0 {
		if entry.ResolutionSource != "catalog" || (profile.ResolutionSource != "model-id" && profile.ResolutionSource != "model-profile") {
			return false
		}
		inferred := enrichCatalogVideoResolutions(ChannelModelCatalogItem{ID: entry.ID, ModelType: "video"})
		var inferredValues []string
		for _, option := range inferred.Options.Resolution {
			inferredValues = append(inferredValues, option.Value)
		}
		if !reflect.DeepEqual(profile.Resolutions, inferredValues) || profile.DefaultResolution != inferred.DefaultParameters.Resolution {
			return false
		}
	}
	profile.Resolutions = make([]string, 0, len(entry.Options.Resolution))
	for _, option := range entry.Options.Resolution {
		profile.Resolutions = append(profile.Resolutions, option.Value)
	}
	profile.DefaultResolution = strings.TrimSpace(entry.DefaultParameters.Resolution)
	if !containsCapabilityString(profile.Resolutions, profile.DefaultResolution) {
		profile.DefaultResolution = profile.Resolutions[0]
	}
	profile.ResolutionSource = entry.ResolutionSource
	profile.ResolutionSourceURL = entry.ResolutionSourceURL
	return true
}

func firstCatalogRaw(values map[string]json.RawMessage, keys ...string) json.RawMessage {
	for _, key := range keys {
		if raw := values[key]; len(raw) > 0 && string(raw) != "null" {
			return raw
		}
	}
	return nil
}

func catalogScalar(raw json.RawMessage) string {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case float64:
		encoded, _ := json.Marshal(typed)
		return string(encoded)
	}
	return ""
}

// Relays use strings, option objects and OpenAPI enum wrappers interchangeably.
func catalogOptionsFromJSON(raw json.RawMessage) []ChannelModelCatalogOption {
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) == nil {
		out := make([]ChannelModelCatalogOption, 0, len(items))
		for _, item := range items {
			var fields map[string]json.RawMessage
			if json.Unmarshal(item, &fields) == nil && fields != nil {
				value := catalogScalar(firstCatalogRaw(fields, "value", "id", "name"))
				out = append(out, ChannelModelCatalogOption{Value: value, Label: catalogScalar(fields["label"])})
			} else {
				out = append(out, ChannelModelCatalogOption{Value: catalogScalar(item)})
			}
		}
		return normalizeCatalogOptions(out)
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) == nil && fields != nil {
		return catalogOptionsFromJSON(firstCatalogRaw(fields, "enum", "values", "options"))
	}
	if value := catalogScalar(raw); value != "" {
		return []ChannelModelCatalogOption{{Value: value}}
	}
	return nil
}

func (parameters *channelModelCatalogParameters) UnmarshalJSON(raw []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		// Malformed optional metadata means no declaration; one bad model's
		// options must not crash the picker or prevent importing other models.
		return nil
	}
	parameters.AspectRatio = catalogScalar(firstCatalogRaw(fields, "aspect_ratio", "aspectRatio", "ratio"))
	parameters.DurationSeconds = catalogScalar(firstCatalogRaw(fields, "duration_seconds", "durationSeconds", "duration", "seconds"))
	parameters.Resolution = catalogScalar(firstCatalogRaw(fields, "resolution", "resolution_name", "resolutionName"))
	return nil
}

func (options *channelModelCatalogOptions) UnmarshalJSON(raw []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil
	}
	options.AspectRatio = catalogOptionsFromJSON(firstCatalogRaw(fields, "aspect_ratio", "aspectRatio", "aspect_ratios", "aspectRatios", "ratio", "ratios", "supported_aspect_ratios", "supportedAspectRatios"))
	options.DurationSeconds = catalogOptionsFromJSON(firstCatalogRaw(fields, "duration_seconds", "durationSeconds", "duration", "seconds", "durations", "supported_durations", "supportedDurations"))
	options.Resolution = catalogOptionsFromJSON(firstCatalogRaw(fields, "resolution", "resolutions", "resolution_name", "resolutionName", "supported_resolutions", "supportedResolutions"))
	return nil
}

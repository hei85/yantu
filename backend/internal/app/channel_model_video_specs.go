package app

import (
	"reflect"
	"strconv"
	"strings"
)

// Apply declarations to a newly imported model, or fill an absent declaration.
// A catalogue refresh cannot replace an existing administrator's choices.
func fillCatalogVideoSpecs(config *ModelCapabilityConfig, entry ChannelModelCatalogItem, newImport bool) bool {
	if config == nil || config.Video == nil {
		return false
	}
	profile := config.Video
	changed := false
	ratios := make([]string, 0, len(entry.Options.AspectRatio))
	for _, option := range entry.Options.AspectRatio {
		value := strings.TrimSpace(option.Value)
		if value != "" && !containsCapabilityString(ratios, value) {
			ratios = append(ratios, value)
		}
	}
	if len(ratios) == 0 && strings.TrimSpace(entry.DefaultParameters.AspectRatio) != "" {
		ratios = append(ratios, strings.TrimSpace(entry.DefaultParameters.AspectRatio))
	}
	if len(ratios) > 0 && (newImport || len(profile.Ratios) == 0) {
		value := strings.TrimSpace(entry.DefaultParameters.AspectRatio)
		if !containsCapabilityString(ratios, value) {
			value = ratios[0]
		}
		changed = changed || !reflect.DeepEqual(profile.Ratios, ratios) || profile.DefaultRatio != value
		profile.Ratios, profile.DefaultRatio = ratios, value
	}
	durations := make([]int, 0, len(entry.Options.DurationSeconds))
	for _, option := range entry.Options.DurationSeconds {
		value, err := strconv.Atoi(strings.TrimSpace(option.Value))
		if err == nil && value > 0 && value <= 86400 && !containsInt(durations, value) {
			durations = append(durations, value)
		}
	}
	defaultSeconds, _ := strconv.Atoi(strings.TrimSpace(entry.DefaultParameters.DurationSeconds))
	if len(durations) == 0 && defaultSeconds > 0 && defaultSeconds <= 86400 {
		durations = append(durations, defaultSeconds)
	}
	durationAbsent := profile.Duration.Default == 0 && len(profile.Duration.Values) == 0 && profile.Duration.Min == 0 && profile.Duration.Max == 0
	if len(durations) > 0 && (newImport || durationAbsent) {
		if !containsInt(durations, defaultSeconds) {
			defaultSeconds = durations[0]
		}
		declared := VideoDurationConfig{Selection: "enum", Values: durations, Default: defaultSeconds}
		changed = changed || !reflect.DeepEqual(profile.Duration, declared)
		profile.Duration = declared
		supported := true
		profile.DurationSupported = &supported
	}
	return changed
}

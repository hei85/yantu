package app

import "strings"

// containsInlineMediaDataURL keeps large media data out of durable task payloads.
func containsInlineMediaDataURL(value any) bool {
	switch item := value.(type) {
	case string:
		text := strings.ToLower(strings.TrimSpace(item))
		return strings.HasPrefix(text, "data:image/") || strings.HasPrefix(text, "data:video/") || strings.HasPrefix(text, "data:audio/")
	case []any:
		for _, child := range item {
			if containsInlineMediaDataURL(child) {
				return true
			}
		}
	case map[string]any:
		for _, child := range item {
			if containsInlineMediaDataURL(child) {
				return true
			}
		}
	}
	return false
}

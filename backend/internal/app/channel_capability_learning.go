package app

import (
	"encoding/json"
	"strings"
	"time"
)

// 能力学习：上游对某个 operation 的明确拒绝，比渠道声明更可信。
// 这里把拒绝写回模型的能力声明（收窄 operations 与参考图上限），
// 让下一次规划与 MCP 自动绕开不可用路线，而不是等用户踩第二次。

const channelCapabilityObservationLimit = 12

// classifyUpstreamCapabilityRejection 只识别"能力边界"类拒绝；
// 鉴权、额度、超时、参数格式问题都不是能力结论，不能据此收窄声明。
func classifyUpstreamCapabilityRejection(message string) (feature string, reason string, ok bool) {
	trimmed := strings.TrimSpace(message)
	if trimmed == "" {
		return "", "", false
	}
	lowered := strings.ToLower(trimmed)
	switch {
	case strings.Contains(lowered, "does not accept reference images"),
		strings.Contains(lowered, "does not accept reference image"),
		strings.Contains(lowered, "not support reference image"),
		strings.Contains(lowered, "unsupported reference image"),
		strings.Contains(trimmed, "不支持参考图"),
		strings.Contains(trimmed, "不支持图片输入"):
		return "image_input", "上游拒绝参考图：该模型不支持图片输入", true
	case strings.Contains(lowered, "does not support text"),
		strings.Contains(trimmed, "不支持文本输入"):
		return "text_input", "上游拒绝文本输入", true
	default:
		return "", "", false
	}
}

// LearnChannelCapabilityFromUpstreamFailure 在中继失败后把能力结论写回声明。
// 返回是否真的改了声明；任何错误都当作"没学到"处理，绝不打断中继链路。
func (s *Service) LearnChannelCapabilityFromUpstreamFailure(channelID, modelKey, message, source string) bool {
	feature, reason, ok := classifyUpstreamCapabilityRejection(message)
	if !ok || s == nil || s.repo == nil {
		return false
	}
	changed, err := s.applyChannelCapabilityLearning(channelID, modelKey, feature, reason, source)
	if err != nil {
		return false
	}
	return changed
}

func (s *Service) applyChannelCapabilityLearning(channelID, modelKey, feature, reason, source string) (bool, error) {
	channelID = strings.TrimSpace(channelID)
	modelKey = strings.TrimSpace(modelKey)
	if channelID == "" || modelKey == "" {
		return false, nil
	}
	item, err := s.repo.ChannelModelByKey(channelID, modelKey)
	if err != nil || item == nil {
		return false, nil
	}
	config := map[string]any{}
	if raw := strings.TrimSpace(item.CapabilityConfigJSON); raw != "" {
		_ = json.Unmarshal([]byte(raw), &config)
	}
	video, _ := config["video"].(map[string]any)
	if video == nil {
		// 只处理视频能力：音频/图片的能力收窄另走各自路径。
		return false, nil
	}
	changed := false
	operations := stringListFromAny(video["operations"])
	switch feature {
	case "image_input":
		if filtered := removeString(operations, "image_to_video"); len(filtered) != len(operations) {
			operations = filtered
			video["operations"] = operations
			changed = true
		}
		if references, ok := video["references"].(map[string]any); ok {
			for _, key := range []string{"minImages", "maxImages", "maxImageBytes"} {
				if value, exists := references[key]; exists && numberValue(value) != 0 {
					references[key] = 0
					changed = true
				}
			}
			video["references"] = references
		}
	case "text_input":
		if filtered := removeString(operations, "text_to_video"); len(filtered) != len(operations) {
			operations = filtered
			video["operations"] = operations
			changed = true
		}
	}
	if current, _ := video["defaultOperation"].(string); strings.TrimSpace(current) != "" && !containsCapabilityString(operations, current) {
		// 只有剩余的已声明 operation 才可成为默认值。若拒绝最后一个
		// operation，保留空值，让后续校验拒绝这条能力声明；不能推断
		// 上游支持其他 operation。
		video["defaultOperation"] = ""
		if len(operations) > 0 {
			video["defaultOperation"] = operations[0]
		}
		changed = true
	}
	if !changed {
		// 已经按实测收窄过：不重复写库、不刷版本号。
		return false, nil
	}
	config["video"] = video
	observations := observationsFromAny(config["observed"])
	observations = append(observations, map[string]any{
		"verdict": "unsupported",
		"feature": feature,
		"reason":  reason,
		"source":  firstNonEmpty(strings.TrimSpace(source), "upstream"),
		"at":      time.Now().UTC().Format(time.RFC3339),
	})
	if len(observations) > channelCapabilityObservationLimit {
		observations = observations[len(observations)-channelCapabilityObservationLimit:]
	}
	config["observed"] = observations
	encoded, err := json.Marshal(config)
	if err != nil {
		return false, err
	}
	item.CapabilityConfigJSON = string(encoded)
	item.CapabilityVersion++
	item.UpdatedAt = time.Now()
	if err := s.repo.SaveChannelModel(item); err != nil {
		return false, err
	}
	s.invalidateRouteCatalog()
	return true, nil
}

func stringListFromAny(value any) []string {
	items, ok := value.([]any)
	if !ok {
		if typed, ok := value.([]string); ok {
			return append([]string(nil), typed...)
		}
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
			out = append(out, strings.TrimSpace(text))
		}
	}
	return out
}

func observationsFromAny(value any) []any {
	items, ok := value.([]any)
	if !ok {
		return []any{}
	}
	return append([]any(nil), items...)
}

func removeString(values []string, target string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == target {
			continue
		}
		out = append(out, value)
	}
	return out
}

func numberValue(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return 0
		}
		return parsed
	default:
		return 0
	}
}

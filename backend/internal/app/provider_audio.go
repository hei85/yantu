package app

// 音频生成。

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"
)

func runAudioTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	productionAudioMode := strings.ToUpper(strings.TrimSpace(metadataString(input.Metadata, "productionAudioMode")))
	if productionAudioMode == model.ProductionAudioModeNative {
		return nil, errors.New("NATIVE_AUDIO 禁止调用独立 TTS 或音效模型；必须保留视频原生音轨")
	}
	indexTTS := input.Config.InterfaceType == string(model.ChannelInterfaceAsyncAudio) && strings.EqualFold(strings.TrimSpace(input.Config.Model), "indextts2-v1")
	if indexTTS {
		// The installed async-audio adapter reads Config directly and runs before
		// the legacy HTTP path below. Normalize it here so both paths request the
		// WAV output and fixed playback speed that this workflow supports.
		input.Config.AudioFormat = "wav"
		input.Config.AudioSpeed = "1"
		if strings.TrimSpace(input.Config.AudioVoice) == "" || strings.EqualFold(strings.TrimSpace(input.Config.AudioVoice), "alloy") {
			input.Config.AudioVoice = "sample"
		}
	}
	_, hasDeclarativeAdapter := declarativeProtocolAdapterForContext(ctx, input.Config.InterfaceType)
	if productionAudioMode == model.ProductionAudioModeRebuild {
		kind := strings.TrimSpace(metadataString(input.Metadata, "kind"))
		feature := productionAudioCapabilityForTrackKind(kind)
		if feature == "" {
			return nil, errors.New("ProductionRun 音轨用途无效，不能路由到音频模型")
		}
		capability := input.Config.CapabilityConfig
		if capability == nil || capability.Audio == nil || audioCapabilityStatus(capability.Audio, feature) != "configured" {
			return nil, fmt.Errorf("当前模型能力目录没有声明 %s，不能生成该音轨", feature)
		}
		if feature != "tts" && !hasDeclarativeAdapter {
			return nil, fmt.Errorf("当前音频接口只有通用 TTS 路径，未提供可验证的 %s 生成协议", feature)
		}
		if strings.TrimSpace(metadataString(input.Metadata, "referenceAudioResourceId")) != "" && len(input.ReferenceAudios) != 1 {
			return nil, errors.New("VoiceVersion 参考音频没有解析成唯一的上游音频输入")
		}
		if strings.TrimSpace(metadataString(input.Metadata, "referenceAudioResourceId")) != "" {
			reference := input.ReferenceAudios[0]
			if strings.TrimSpace(reference.URL) == "" && !strings.HasPrefix(strings.TrimSpace(reference.DataURL), "data:audio/") {
				return nil, errors.New("VoiceVersion 参考音频没有可用的上游 URL 或音频 data URL")
			}
		}
	}
	// IndexTTS2 uses the relay's native async-audio endpoint, but the generic
	// async-audio manifest intentionally has no reference-audio field. Keep this
	// model-specific mapping here so other audio channels cannot inherit it.
	if indexTTS {
		if len(input.ReferenceAudios) > 1 {
			return nil, errors.New("IndexTTS2 每次只接受一个参考声音")
		}
		if productionAudioMode == model.ProductionAudioModeRebuild {
			kind := strings.TrimSpace(metadataString(input.Metadata, "kind"))
			strategy := strings.TrimSpace(metadataString(input.Metadata, "voiceStrategy"))
			if (kind == "dialogue" || kind == "voiceover") && strategy != "voice_reference" {
				return nil, errors.New("IndexTTS2 对白/旁白只支持已绑定的参考声音，不支持模型 Voice ID")
			}
			if strategy != "voice_reference" && len(input.ReferenceAudios) > 0 {
				return nil, errors.New("IndexTTS2 ProductionRun 只能使用 VoiceVersion 绑定的参考声音")
			}
			if strategy == "voice_reference" {
				audio := input.Config.CapabilityConfig.Audio
				if audio == nil || audio.VoiceReference != "configured" || audio.ReferenceAudioParameter != "reference_audio" {
					return nil, errors.New("IndexTTS2 能力目录没有声明已验证的 reference_audio 参数")
				}
				if strings.TrimSpace(metadataString(input.Metadata, "referenceAudioResourceId")) == "" || len(input.ReferenceAudios) != 1 {
					return nil, errors.New("IndexTTS2 VoiceVersion 必须引用唯一的已授权参考声音资源")
				}
			}
		}
		body := map[string]interface{}{
			"model": input.Config.Model, "input": input.Prompt, "voice": defaultString(input.Config.AudioVoice, "sample"),
			"response_format": "wav", "speed": 1,
		}
		if len(input.ReferenceAudios) == 1 {
			var audio *AudioCapabilityConfig
			if input.Config.CapabilityConfig != nil {
				audio = input.Config.CapabilityConfig.Audio
			}
			if audio == nil || audio.VoiceReference != "configured" || audio.ReferenceAudioParameter != "reference_audio" {
				return nil, errors.New("IndexTTS2 能力目录没有声明已验证的 reference_audio 参数")
			}
			reference := input.ReferenceAudios[0]
			value := firstNonEmpty(strings.TrimSpace(reference.URL), strings.TrimSpace(reference.DataURL))
			if value == "" {
				return nil, errors.New("IndexTTS2 参考声音没有可用的上游 URL 或音频 data URL")
			}
			body[audio.ReferenceAudioParameter] = value
			delete(body, "voice")
		}
		if productionAudioMode == model.ProductionAudioModeRebuild {
			if err := applyProductionVoiceParameters(body, input); err != nil {
				return nil, err
			}
			if metadataString(input.Metadata, "voiceStrategy") == "voice_reference" {
				delete(body, "voice")
			}
		}
		return runAsyncAudioTask(ctx, input, body, "wav")
	}
	if hasDeclarativeAdapter {
		return runDeclarativeProtocolTask(ctx, input)
	}
	if resolved, ok := input.Metadata["resolvedCharacterVersions"].([]interface{}); ok && len(resolved) > 0 {
		voiceKey := metadataString(input.Metadata, "resolvedCharacterVoiceKey")
		if voiceKey == "" || strings.TrimSpace(input.Config.AudioVoice) != voiceKey {
			return nil, errors.New("角色配音缺少已解析的声音绑定")
		}
	}
	format := defaultString(input.Config.AudioFormat, "mp3")
	if indexTTS {
		// AutoDL IndexTTS2 only produces WAV. Keep the requested format honest for
		// both direct audio tasks and canvas/film production tasks.
		format = "wav"
	}
	body := map[string]interface{}{
		"model":           input.Config.Model,
		"input":           input.Prompt,
		"voice":           defaultString(input.Config.AudioVoice, "alloy"),
		"response_format": format,
		"speed":           1,
	}
	if input.Config.AudioSpeed != "" {
		body["speed"] = parseFloat(input.Config.AudioSpeed, 1)
	}
	if input.Config.AudioInstructions != "" {
		body["instructions"] = input.Config.AudioInstructions
	}
	if productionAudioMode == model.ProductionAudioModeRebuild {
		kind := strings.TrimSpace(metadataString(input.Metadata, "kind"))
		capability := input.Config.CapabilityConfig
		voiceStrategy := strings.TrimSpace(metadataString(input.Metadata, "voiceStrategy"))
		if (kind == "dialogue" || kind == "voiceover") && voiceStrategy != "voice_reference" && strings.TrimSpace(input.Config.AudioVoice) == "" {
			return nil, errors.New("REBUILD_AUDIO 对白/旁白缺少能力目录绑定的 Voice ID")
		}
		if (kind == "dialogue" || kind == "voiceover") && voiceStrategy != "voice_reference" && capability != nil && capability.Audio != nil && !audioCapabilityAllowsVoice(capability.Audio, input.Config.AudioVoice) {
			return nil, errors.New("REBUILD_AUDIO Voice ID 不在当前模型能力目录中")
		}
		if err := applyProductionVoiceParameters(body, input); err != nil {
			return nil, err
		}
		if metadataString(input.Metadata, "voiceStrategy") == "voice_reference" {
			delete(body, "voice")
		}
	}
	if indexTTS {
		body["response_format"] = "wav"
		body["speed"] = 1
	}
	if input.Config.InterfaceType == string(model.ChannelInterfaceAsyncAudio) {
		return runAsyncAudioTask(ctx, input, body, format)
	}
	data, mimeType, err := postBinary(ctx, input.Config, "/audio/speech", body)
	if err != nil {
		return nil, err
	}
	mimeType, err = validateGeneratedAudio(mimeType, data, format)
	if err != nil {
		return nil, err
	}
	return generatedAudioResult(data, mimeType, format), nil
}

func audioCapabilityAllowsVoice(capability *AudioCapabilityConfig, voiceID string) bool {
	voiceID = strings.TrimSpace(voiceID)
	if capability == nil || voiceID == "" {
		return false
	}
	if len(capability.VoiceIDs) == 0 {
		return capability.DefaultVoiceID != "" && voiceID == capability.DefaultVoiceID || capability.VoiceIDParameter != ""
	}
	for _, allowed := range capability.VoiceIDs {
		if voiceID == allowed {
			return true
		}
	}
	return false
}

func audioCapabilityStatus(config *AudioCapabilityConfig, feature string) string {
	if config == nil {
		return "unknown"
	}
	switch feature {
	case "tts":
		return config.TTS
	case "ambientSound":
		return config.AmbientSound
	case "soundEffects":
		return config.SoundEffects
	case "music":
		return config.Music
	default:
		return "unknown"
	}
}

func applyProductionVoiceParameters(body map[string]interface{}, input canvasGenerationInput) error {
	capability := input.Config.CapabilityConfig
	if capability == nil || capability.Audio == nil {
		return errors.New("制作音频任务缺少当前模型的音频能力合同")
	}
	audio := capability.Audio
	metadata := metadataStringValues(input.Metadata)
	setDeclared := func(parameterKey, metadataKey string) error {
		value := strings.TrimSpace(metadata[metadataKey])
		if value == "" {
			return nil
		}
		parameter := strings.TrimSpace(audioParameter(audio, parameterKey))
		if parameter == "" {
			return fmt.Errorf("模型能力目录未声明 %s 参数，不能应用角色 VoiceVersion", parameterKey)
		}
		body[parameter] = value
		return nil
	}
	if voiceID := strings.TrimSpace(metadata["voiceId"]); voiceID != "" {
		if audio.VoiceIDParameter != "" {
			delete(body, "voice")
			body[audio.VoiceIDParameter] = voiceID
		} else if metadata["voiceStrategy"] == "standard_tts" {
			body["voice"] = voiceID
		} else {
			return errors.New("模型能力目录未声明 voiceIdParameter")
		}
	}
	if referenceID := strings.TrimSpace(metadata["referenceAudioResourceId"]); referenceID != "" {
		if audio.VoiceReference != "configured" || audio.ReferenceAudioParameter == "" {
			return errors.New("模型能力目录未声明参考声音参数")
		}
		if len(input.ReferenceAudios) != 1 {
			return errors.New("VoiceVersion 参考音频未绑定到已授权资源")
		}
		reference := input.ReferenceAudios[0]
		if strings.TrimSpace(reference.URL) != "" {
			body[audio.ReferenceAudioParameter] = reference.URL
		} else if strings.HasPrefix(strings.TrimSpace(reference.DataURL), "data:audio/") {
			body[audio.ReferenceAudioParameter] = reference.DataURL
		} else {
			return errors.New("VoiceVersion 参考音频未完成资源读取")
		}
	}
	if audio.SpeakingRateParameter != "" {
		if value := strings.TrimSpace(metadata["speakingRate"]); value != "" {
			delete(body, "speed")
			body[audio.SpeakingRateParameter] = parseFloat(value, 1)
		}
	}
	for _, field := range []struct{ parameter, metadata string }{
		{"toneParameter", "tone"}, {"emotionStyleParameter", "emotionStyle"},
		{"languageParameter", "language"}, {"accentParameter", "accent"},
	} {
		if err := setDeclared(field.parameter, field.metadata); err != nil {
			return err
		}
	}
	return nil
}

func audioParameter(config *AudioCapabilityConfig, field string) string {
	if config == nil {
		return ""
	}
	switch field {
	case "voiceIdParameter":
		return config.VoiceIDParameter
	case "referenceAudioParameter":
		return config.ReferenceAudioParameter
	case "toneParameter":
		return config.ToneParameter
	case "emotionStyleParameter":
		return config.EmotionStyleParameter
	case "speakingRateParameter":
		return config.SpeakingRateParameter
	case "languageParameter":
		return config.LanguageParameter
	case "accentParameter":
		return config.AccentParameter
	default:
		return ""
	}
}

func runAsyncAudioTask(ctx context.Context, input canvasGenerationInput, body map[string]interface{}, format string) (map[string]interface{}, error) {
	id := resumedProviderRequestID(ctx)
	var state map[string]interface{}
	if id == "" {
		if err := postJSON(ctx, input.Config, "/audio/tasks", body, &state); err != nil {
			return nil, err
		}
		state = asyncAudioPayload(state)
		extracted, err := firstJSONString(state, "id", "task_id", "request_id")
		if err != nil {
			return nil, fmt.Errorf("异步音频接口任务 ID 无效：%w", err)
		}
		id = extracted
		if id == "" {
			return nil, errors.New("异步音频接口没有返回任务 ID")
		}
		if asyncAudioSucceeded(state) {
			return asyncAudioResult(ctx, input.Config, id, state, format)
		}
	}
	for deadline := providerPollingDeadline(ctx); time.Now().Before(deadline); {
		state = map[string]interface{}{}
		pollCtx := withProviderRequestKind(ctx, "poll")
		if err := getJSON(pollCtx, input.Config, "/audio/tasks/"+url.PathEscape(id), &state); err != nil {
			return nil, err
		}
		state = asyncAudioPayload(state)
		if asyncAudioSucceeded(state) {
			return asyncAudioResult(ctx, input.Config, id, state, format)
		}
		status := strings.ToLower(strings.TrimSpace(stringField(state, "status")))
		if status == "failed" || status == "cancelled" || status == "canceled" || status == "expired" || status == "error" {
			return nil, fmt.Errorf("异步音频生成失败（任务 %s）：%s", id, asyncAudioErrorMessage(state))
		}
		if err := sleepContext(ctx, 2500*time.Millisecond); err != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("异步音频生成超时（任务 %s）", id)
}

func asyncAudioPayload(payload map[string]interface{}) map[string]interface{} {
	for _, key := range []string{"data", "result", "output"} {
		if nested, ok := payload[key].(map[string]interface{}); ok {
			for parentKey, parentValue := range payload {
				if parentKey == "data" || parentKey == "result" || parentKey == "output" {
					continue
				}
				if _, exists := nested[parentKey]; !exists {
					nested[parentKey] = parentValue
				}
			}
			return nested
		}
	}
	return payload
}

func asyncAudioSucceeded(state map[string]interface{}) bool {
	status := strings.ToLower(strings.TrimSpace(stringField(state, "status")))
	done, _ := state["done"].(bool)
	return done || status == "completed" || status == "succeeded" || status == "success" || status == "done" || (status == "" && asyncAudioResultURL(state) != "")
}

func asyncAudioResult(ctx context.Context, config providerConfig, id string, state map[string]interface{}, format string) (map[string]interface{}, error) {
	resultURL := asyncAudioResultURL(state)
	var data []byte
	var mimeType string
	var err error
	if strings.HasPrefix(resultURL, "data:") {
		mimeType, data, err = decodeProviderDataURL(resultURL)
		if err == nil {
			limit, limitErr := providerGeneratedFileLimit(ctx)
			if limitErr != nil {
				err = limitErr
			} else if int64(len(data)) > limit {
				err = fmt.Errorf("异步音频结果超过 %s 限制", formatStorageLimit(limit))
			}
		}
	} else if isPublicMediaURL(resultURL) {
		data, mimeType, err = getExternalBinary(withProviderRequestKind(ctx, "download"), resultURL)
	} else {
		data, mimeType, err = getBinary(withProviderRequestKind(ctx, "download"), config, "/audio/tasks/"+url.PathEscape(id)+"/content")
	}
	if err != nil {
		return nil, fmt.Errorf("异步音频结果下载失败（任务 %s）：%w", id, err)
	}
	mimeType, err = validateGeneratedAudio(mimeType, data, format)
	if err != nil {
		return nil, fmt.Errorf("异步音频结果无效（任务 %s）：%w", id, err)
	}
	return generatedAudioResult(data, mimeType, format), nil
}

func generatedAudioResult(data []byte, mimeType, requestedFormat string) map[string]interface{} {
	actualFormat := audioFormatForMimeType(mimeType)
	return map[string]interface{}{"mode": "audio", "audio": map[string]interface{}{
		"dataUrl": dataURL(mimeType, data), "mimeType": mimeType, "format": actualFormat,
		"actualFormat": actualFormat, "requestedFormat": strings.ToLower(strings.TrimSpace(requestedFormat)),
	}}
}

// DownloadGeneratedAudioURL lets the local web app read a provider's signed
// result URL when that storage host does not allow browser CORS. The same
// outbound URL validation and size limit used for resource imports apply.
func (s *Service) DownloadGeneratedAudioURL(rawURL string) ([]byte, string, error) {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, "", err
	}
	payload, err := downloadRemoteResource(rawURL, megabytes(policy.Resource.GeneratedFileMB))
	if err != nil {
		return nil, "", err
	}
	mimeType, err := validateGeneratedAudio(payload.mimeType, payload.data, "")
	if err != nil {
		return nil, "", err
	}
	return payload.data, mimeType, nil
}

func asyncAudioResultURL(state map[string]interface{}) string {
	for _, key := range []string{"audio_url", "audioUrl", "result_url", "resultUrl", "output_url", "outputUrl", "url", "data"} {
		if value := strings.TrimSpace(stringField(state, key)); strings.HasPrefix(value, "data:") || isPublicMediaURL(value) {
			return value
		}
	}
	for _, key := range []string{"audio", "data", "result", "output"} {
		if nested, ok := state[key].(map[string]interface{}); ok {
			if value := asyncAudioResultURL(nested); value != "" {
				return value
			}
		}
	}
	return ""
}

func asyncAudioErrorMessage(state map[string]interface{}) string {
	_, message := providerFailureDetails(state)
	return defaultString(message, firstNonEmptyString(stringField(state, "message"), "上游返回失败状态"))
}

func decodeProviderDataURL(value string) (string, []byte, error) {
	header, encoded, ok := strings.Cut(value, ",")
	if !ok || !strings.HasPrefix(header, "data:") || !strings.HasSuffix(strings.ToLower(header), ";base64") {
		return "", nil, errors.New("data URL 格式无效")
	}
	mimeType := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
	data, err := base64.StdEncoding.DecodeString(encoded)
	return mimeType, data, err
}

func providerGeneratedFileLimit(ctx context.Context) (int64, error) {
	metadata, ok := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	if !ok || metadata.Service == nil {
		return maxProviderResponseBytes, nil
	}
	policy, err := metadata.Service.RuntimePolicy()
	if err != nil {
		return 0, fmt.Errorf("读取生成资源限制失败：%w", err)
	}
	return megabytes(policy.Resource.GeneratedFileMB), nil
}

func validateGeneratedAudio(declared string, data []byte, format string) (string, error) {
	if len(data) == 0 {
		return "", errors.New("音频内容为空")
	}
	detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0]))
	if strings.Contains(detected, "json") || strings.HasPrefix(detected, "text/") || strings.HasPrefix(detected, "image/") || strings.HasPrefix(detected, "video/") {
		return "", fmt.Errorf("上游返回了非音频内容：%s", detected)
	}
	mimeType := strings.ToLower(strings.TrimSpace(strings.Split(declared, ";")[0]))
	resolved := ""
	if strings.HasPrefix(mimeType, "audio/") {
		resolved = mimeType
	} else if strings.HasPrefix(detected, "audio/") {
		resolved = detected
	} else if fallback := audioFormatMimeType(format); fallback != "" && (mimeType == "" || mimeType == "application/octet-stream") {
		resolved = fallback
	}
	if resolved == "" {
		return "", fmt.Errorf("上游响应类型不是音频：%s", defaultString(mimeType, detected))
	}
	if !audioSignatureMatches(resolved, data) {
		return "", fmt.Errorf("音频内容与格式不匹配：%s", resolved)
	}
	return resolved, nil
}

func audioSignatureMatches(mimeType string, data []byte) bool {
	if strings.Contains(mimeType, "pcm") || mimeType == "audio/l16" {
		return len(data) > 0
	}
	if strings.Contains(mimeType, "mpeg") || strings.Contains(mimeType, "mp3") {
		return bytes.HasPrefix(data, []byte("ID3")) || (len(data) >= 2 && data[0] == 0xff && data[1]&0xe0 == 0xe0)
	}
	if strings.Contains(mimeType, "wav") || strings.Contains(mimeType, "wave") {
		return len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WAVE"))
	}
	if strings.Contains(mimeType, "opus") || strings.Contains(mimeType, "ogg") {
		return bytes.HasPrefix(data, []byte("OggS"))
	}
	if strings.Contains(mimeType, "flac") {
		return bytes.HasPrefix(data, []byte("fLaC"))
	}
	if strings.Contains(mimeType, "aac") {
		return bytes.HasPrefix(data, []byte("ADIF")) || (len(data) >= 2 && data[0] == 0xff && data[1]&0xf0 == 0xf0)
	}
	return false
}

func audioFormatMimeType(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "wav":
		return "audio/wav"
	case "opus":
		return "audio/opus"
	case "aac":
		return "audio/aac"
	case "flac":
		return "audio/flac"
	case "pcm":
		return "audio/pcm"
	case "mp3":
		return "audio/mpeg"
	default:
		return ""
	}
}

func audioFormatForMimeType(mimeType string) string {
	mimeType = strings.ToLower(strings.TrimSpace(strings.Split(mimeType, ";")[0]))
	switch mimeType {
	case "audio/mpeg", "audio/mp3", "audio/x-mpeg":
		return "mp3"
	case "audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave", "audio/x-pn-wav":
		return "wav"
	case "audio/opus":
		return "opus"
	case "audio/ogg", "application/ogg":
		return "ogg"
	case "audio/aac", "audio/aacp":
		return "aac"
	case "audio/flac", "audio/x-flac":
		return "flac"
	case "audio/mp4", "audio/x-m4a", "audio/m4a":
		return "m4a"
	case "audio/pcm", "audio/l16":
		return "pcm"
	default:
		if strings.HasPrefix(mimeType, "audio/") {
			return strings.TrimPrefix(mimeType, "audio/")
		}
		return ""
	}
}

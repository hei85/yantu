package app

// 视频生成遗留手写路径；已有官方插件的接口类型走声明式协议。

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"mime/multipart"
	"net/url"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

func (s *Service) validateResolvedVideoCapability(input *canvasGenerationInput) error {
	channelID := strings.TrimSpace(input.Config.ChannelID)
	if channelID == "" {
		profile := input.Config.CapabilityConfig
		if profile == nil || profile.Video == nil {
			if input.Config.InterfaceType != string(model.ChannelInterfaceAgnesVideo) {
				return nil
			}
			profile = DefaultModelCapabilityConfigForModel(input.Config.InterfaceType, input.Config.Model)
		}
		normalized, err := NormalizeModelCapabilityConfigForModel("video", input.Config.InterfaceType, input.Config.Model, profile)
		if err != nil || normalized == nil || normalized.Video == nil {
			return errors.New("当前视频模型能力参数无效")
		}
		input.Config.CapabilityConfig = normalized
		input.VideoCapability = normalized.Video
		applyFixedVideoResolution(input, normalized.Video)
		return validateVideoTask(normalized.Video, *input)
	}
	item, err := s.repo.ChannelModelByKey(channelID, providerChannelModelKey(input.Config))
	if err != nil {
		return errors.New("当前系统渠道模型未配置或已停用")
	}
	profile, err := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
	if err != nil || profile == nil || profile.Video == nil {
		return errors.New("当前视频模型尚未配置能力参数")
	}
	normalized, err := NormalizeModelCapabilityConfigForModel("video", string(item.Protocol), firstNonEmpty(item.ProviderModelKey, item.ModelKey), profile)
	if err != nil || normalized == nil || normalized.Video == nil {
		return errors.New("当前视频模型能力参数无效")
	}
	input.VideoCapability = normalized.Video
	applyFixedVideoResolution(input, normalized.Video)
	return validateVideoTask(normalized.Video, *input)
}

func runVideoTask(ctx context.Context, input canvasGenerationInput) (map[string]interface{}, error) {
	return runVideoTaskWithPolicy(ctx, input, defaultVideoPollPolicy())
}

func runVideoTaskWithPolicy(ctx context.Context, input canvasGenerationInput, pollPolicy videoPollPolicy) (map[string]interface{}, error) {
	// 路由顺序是协议边界，不是“哪个请求先试”：官方声明式接口必须由已注册适配器执行，
	// 缺少适配器时直接失败，不能偷偷退回遗留手写协议；只有未声明为官方插件的旧渠道才继续走兼容分支。
	if strings.TrimSpace(input.Mode) == "" {
		input.Mode = "video"
	}
	// 已有官方声明式插件的 InterfaceType 只走适配器。未注入 registry 时补官方包，
	// 显式空 registry 则报“插件未安装”，不再回退到手写协议。
	ctx = ensureOfficialProtocolAdapter(ctx, input.Config.InterfaceType)
	if adapter, ok := declarativeProtocolAdapterForContext(ctx, input.Config.InterfaceType); ok {
		return runProtocolAdapterTaskWithPolicy(ctx, input, adapter, pollPolicy)
	}
	if label, official := officialDeclarativeVideoInterface(input.Config.InterfaceType); official {
		return nil, fmt.Errorf("%s 视频插件未安装", label)
	}
	if isArkPlanVideoConfig(input.Config) {
		return runSeedanceAgentPlanVideoTask(ctx, input, pollPolicy)
	}
	if isSeedanceVideoConfig(input.Config) {
		return runSeedanceVideosTask(ctx, input, pollPolicy)
	}
	axonH3 := isHeihanAxonH3Video(input.Config.BaseURL, input.Config.Model)
	if len(input.ReferenceVideos) > 0 || (len(input.ReferenceAudios) > 0 && !axonH3) {
		return nil, errors.New("OpenAI 风格视频接口不支持参考视频或参考音频，请切换到 Seedance / Agent Plan 渠道")
	}
	id := resumedProviderRequestID(ctx)
	var created map[string]interface{}
	if id == "" && isGrokVideoConfig(input.Config) {
		requestBody, err := grokVideoBody(input)
		if err != nil {
			return nil, err
		}
		if err := postJSON(ctx, input.Config, "/videos", requestBody, &created); err != nil {
			return nil, err
		}
	} else if id == "" && axonH3 {
		requestBody, err := axonH3VideoBody(input)
		if err != nil {
			return nil, err
		}
		if err := postJSON(ctx, input.Config, "/videos", requestBody, &created); err != nil {
			return nil, err
		}
	} else if id == "" {
		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		writeField(writer, "model", input.Config.Model)
		writeField(writer, "prompt", newAPIVideoPromptText(input))
		writeField(writer, "seconds", defaultString(input.Config.VideoSeconds, "6"))
		if size := normalizeVideoSize(input.Config.Size); size != "" {
			writeField(writer, "size", size)
		}
		if axonH3 {
			// This relay's H3 adapter reads aspect_ratio to choose its distinct
			// horizontal/vertical workflow resolution. `size` alone is ignored for
			// orientation and the adapter otherwise defaults to vertical.
			ratio, ratioErr := axonH3AspectRatio(input.Config.Size)
			if ratioErr != nil {
				return nil, ratioErr
			}
			writeField(writer, "aspect_ratio", ratio)
		}
		if resolution := videoResolutionNameRequest(input.VideoCapability, input.Config.VQuality); resolution != "" {
			writeField(writer, "resolution_name", resolution)
		}
		writeField(writer, "preset", "normal")
		if shouldSendNewAPIVideoImages(input) {
			imageReferences := input.ReferenceImages
			if axonH3 && isAxonH3FirstLastModel(input.Config.Model) {
				orderedReferences, err := orderedVideoFrameReferences(input)
				if err != nil {
					return nil, err
				}
				imageReferences = orderedReferences
			}
			for _, image := range imageReferences {
				if err := writeMediaPart(writer, "input_reference", image); err != nil {
					return nil, err
				}
			}
		}
		if err := writer.Close(); err != nil {
			return nil, err
		}
		if err := postForm(ctx, input.Config, "/videos", writer.FormDataContentType(), body, &created); err != nil {
			return nil, err
		}
	}
	if id == "" {
		extracted, err := firstJSONString(created, "id", "request_id", "task_id")
		if err != nil {
			return nil, fmt.Errorf("视频接口任务 ID 无效：%w", err)
		}
		id = extracted
	}
	if id == "" {
		if data, ok := created["data"].(map[string]interface{}); ok {
			extracted, err := firstJSONString(data, "id", "request_id", "task_id")
			if err != nil {
				return nil, fmt.Errorf("视频接口任务 ID 无效：%w", err)
			}
			id = extracted
		}
	}
	if id == "" {
		return nil, errors.New("视频接口没有返回任务 ID")
	}
	return runVideoPollLoop(ctx, id, pollPolicy, func(ctx context.Context) (videoPollOutcome, error) {
		var state map[string]interface{}
		if err := getJSON(ctx, input.Config, "/videos/"+id, &state); err != nil {
			return videoPollOutcome{}, err
		}
		if data, ok := state["data"].(map[string]interface{}); ok {
			state = data
		}
		status := strings.ToLower(stringField(state, "status"))
		if status == "completed" || status == "succeeded" || status == "success" || status == "done" {
			if videoURL := newAPIVideoResultURL(state); videoURL != "" {
				data, mimeType, err := runVideoDownload(ctx, id, pollPolicy, func(ctx context.Context) ([]byte, string, error) {
					return getProviderExternalBinary(withProviderRequestKind(ctx, "download"), input.Config, videoURL)
				})
				if err != nil {
					return videoPollOutcome{}, fmt.Errorf("视频结果下载失败（任务 %s）：%w", id, err)
				}
				mimeType = normalizedMediaMimeType(mimeType, data)
				return videoPollOutcome{Done: true, Result: map[string]interface{}{"mode": "video", "video": map[string]interface{}{"dataUrl": dataURL(mimeType, data), "mimeType": mimeType}}}, nil
			}
			data, mimeType, err := runVideoDownload(ctx, id, pollPolicy, func(ctx context.Context) ([]byte, string, error) {
				return getBinary(withProviderRequestKind(ctx, "download"), input.Config, "/videos/"+id+"/content")
			})
			if err != nil {
				return videoPollOutcome{}, err
			}
			return videoPollOutcome{Done: true, Result: map[string]interface{}{"mode": "video", "video": map[string]interface{}{"dataUrl": dataURL(mimeType, data), "mimeType": mimeType}}}, nil
		}
		if status == "failed" || status == "cancelled" {
			return videoPollOutcome{}, errors.New("视频生成失败")
		}
		return videoPollOutcome{}, nil
	})
}

func newAPIVideoResultURL(state map[string]interface{}) string {
	return nestedNewAPIVideoResultURL(state, false, 0)
}

func nestedNewAPIVideoResultURL(payload map[string]interface{}, allowResultURL bool, depth int) string {
	if depth < 2 {
		for _, key := range []string{"data", "result", "video"} {
			if nested, ok := payload[key].(map[string]interface{}); ok {
				if videoURL := nestedNewAPIVideoResultURL(nested, true, depth+1); videoURL != "" {
					return videoURL
				}
			}
		}
	}
	keys := []string{"video_url", "videoUrl", "url"}
	if allowResultURL {
		keys = append(keys, "result_url", "resultUrl")
	}
	for _, key := range keys {
		if videoURL := strings.TrimSpace(stringField(payload, key)); isPublicMediaURL(videoURL) {
			return videoURL
		}
	}
	return ""
}

func grokVideoBody(input canvasGenerationInput) (map[string]interface{}, error) {
	seconds := defaultString(input.Config.VideoSeconds, "6")
	duration, err := strconv.Atoi(seconds)
	if err != nil || duration <= 0 {
		duration = 6
	}
	body := map[string]interface{}{
		"model":    input.Config.Model,
		"prompt":   strings.TrimSpace(input.Prompt),
		"duration": duration,
		"seconds":  strconv.Itoa(duration),
	}
	if size := normalizeVideoSize(input.Config.Size); size != "" {
		body["size"] = size
	}
	if shouldSendNewAPIVideoImages(input) && len(input.ReferenceImages) > 0 {
		images := make([]string, 0, len(input.ReferenceImages))
		for _, image := range input.ReferenceImages {
			url, err := openAIImageInputURL(image)
			if err != nil {
				return nil, err
			}
			images = append(images, url)
		}
		body["image"] = images[0]
		body["images"] = images
	}
	return body, nil
}

func runSeedanceVideosTask(ctx context.Context, input canvasGenerationInput, pollPolicy videoPollPolicy) (map[string]interface{}, error) {
	// 恢复任务已有 provider ID 时只能继续查询，绝不能重新 create，否则会产生第二个计费任务。
	// create 成功后的 poll/download 任一失败都保留失败或结果未知语义，不降级成“成功但无内容”。
	id := resumedProviderRequestID(ctx)
	var created map[string]interface{}
	if id == "" {
		body, err := seedanceVideosRequestBody(input)
		if err != nil {
			return nil, err
		}
		if err := postJSON(ctx, input.Config, "/videos", body, &created); err != nil {
			return nil, err
		}
		if data, ok := created["data"].(map[string]interface{}); ok {
			created = data
		}
		extracted, err := firstJSONString(created, "id", "task_id")
		if err != nil {
			return nil, fmt.Errorf("Seedance 接口任务 ID 无效：%w", err)
		}
		id = extracted
	}
	if id == "" {
		return nil, errors.New("Seedance 接口没有返回任务 ID")
	}
	return runVideoPollLoop(ctx, id, pollPolicy, func(ctx context.Context) (videoPollOutcome, error) {
		var state map[string]interface{}
		if err := getJSON(ctx, input.Config, "/videos/"+id, &state); err != nil {
			return videoPollOutcome{}, err
		}
		if data, ok := state["data"].(map[string]interface{}); ok {
			state = data
		}
		status := strings.ToLower(stringField(state, "status"))
		if status == "completed" || status == "succeeded" {
			videoURL := stringField(state, "video_url")
			if videoURL != "" {
				data, mimeType, err := runVideoDownload(ctx, id, pollPolicy, func(ctx context.Context) ([]byte, string, error) {
					return getExternalBinary(withProviderRequestKind(ctx, "download"), videoURL)
				})
				if err != nil {
					return videoPollOutcome{}, fmt.Errorf("视频结果下载失败：%w", err)
				}
				return videoPollOutcome{Done: true, Result: map[string]interface{}{"mode": "video", "video": map[string]interface{}{"dataUrl": dataURL(mimeType, data), "mimeType": mimeType}}}, nil
			}
			data, mimeType, err := runVideoDownload(ctx, id, pollPolicy, func(ctx context.Context) ([]byte, string, error) {
				return getBinary(withProviderRequestKind(ctx, "download"), input.Config, "/videos/"+id+"/content")
			})
			if err != nil {
				return videoPollOutcome{}, fmt.Errorf("Seedance 任务成功但未返回视频 URL，备用内容下载失败：%w", err)
			}
			return videoPollOutcome{Done: true, Result: map[string]interface{}{"mode": "video", "video": map[string]interface{}{"dataUrl": dataURL(mimeType, data), "mimeType": mimeType}}}, nil
		}
		if status == "failed" || status == "cancelled" || status == "expired" {
			return videoPollOutcome{}, errors.New(defaultString(seedanceErrorMessage(state), "Seedance 视频生成失败"))
		}
		return videoPollOutcome{}, nil
	})
}

func runSeedanceAgentPlanVideoTask(ctx context.Context, input canvasGenerationInput, pollPolicy videoPollPolicy) (map[string]interface{}, error) {
	providerName := "Seedance"
	if model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(input.Config.InterfaceType)) {
		providerName = "火山方舟"
	}
	// Agent Plan 与 Videos API 使用相同的恢复合同：已有任务只查询，不重复创建。
	// 外部签名地址仍统一经过 doBinary 的 SSRF、状态码和响应大小检查。
	id := resumedProviderRequestID(ctx)
	var created map[string]interface{}
	if id == "" {
		content, err := seedanceContent(input)
		if err != nil {
			return nil, err
		}
		if model.IsVolcengineArkVideoProtocol(model.ChannelInterfaceType(input.Config.InterfaceType)) {
			for _, item := range content {
				if item["type"] == "image_url" {
					item["role"] = "reference_image"
				}
			}
		}
		body := seedanceAgentPlanRequest{
			Model:      input.Config.Model,
			Content:    content,
			Ratio:      normalizeSeedanceRatio(input.Config.Size),
			Resolution: normalizeSeedanceResolution(input.Config.VQuality, input.Config.Model),
			Duration:   normalizeSeedanceDuration(input.Config.VideoSeconds),
		}
		if videoCapabilitySupportsAudio(input) {
			value := parseBool(input.Config.VideoGenerateAudio, true)
			body.GenerateAudio = &value
		}
		if videoCapabilitySupportsWatermark(input) {
			value := parseBool(input.Config.VideoWatermark, false)
			body.Watermark = &value
		}
		if err := postJSON(ctx, input.Config, "/contents/generations/tasks", body, &created); err != nil {
			return nil, err
		}
		if data, ok := created["data"].(map[string]interface{}); ok {
			created = data
		}
		extracted, err := firstJSONString(created, "id")
		if err != nil {
			return nil, fmt.Errorf("%s接口任务 ID 无效：%w", providerName, err)
		}
		id = extracted
	}
	if id == "" {
		return nil, fmt.Errorf("%s接口没有返回任务 ID", providerName)
	}
	return runVideoPollLoop(ctx, id, pollPolicy, func(ctx context.Context) (videoPollOutcome, error) {
		var state map[string]interface{}
		if err := getJSON(ctx, input.Config, "/contents/generations/tasks/"+id, &state); err != nil {
			return videoPollOutcome{}, err
		}
		if data, ok := state["data"].(map[string]interface{}); ok {
			state = data
		}
		status := strings.ToLower(strings.TrimSpace(stringField(state, "status")))
		if status == "succeeded" {
			content, _ := state["content"].(map[string]interface{})
			videoURL := stringField(content, "video_url")
			if videoURL == "" {
				return videoPollOutcome{}, fmt.Errorf("%s任务成功但没有返回视频 URL", providerName)
			}
			data, mimeType, err := runVideoDownload(ctx, id, pollPolicy, func(ctx context.Context) ([]byte, string, error) {
				return getExternalBinary(withProviderRequestKind(ctx, "download"), videoURL)
			})
			if err != nil {
				return videoPollOutcome{}, fmt.Errorf("视频结果下载失败：%w", err)
			}
			return videoPollOutcome{Done: true, Result: map[string]interface{}{"mode": "video", "video": map[string]interface{}{"dataUrl": dataURL(mimeType, data), "mimeType": mimeType}}}, nil
		}
		if status == "failed" || status == "cancelled" || status == "expired" {
			return videoPollOutcome{}, fmt.Errorf("%s视频生成失败", providerName)
		}
		return videoPollOutcome{}, nil
	})
}

func seedanceContent(input canvasGenerationInput) ([]map[string]interface{}, error) {
	content := make([]map[string]interface{}, 0, 1+len(input.ReferenceImages)+len(input.ReferenceVideos)+len(input.ReferenceAudios))
	text := seedancePromptText(input)
	if strings.TrimSpace(text) != "" {
		content = append(content, map[string]interface{}{"type": "text", "text": text})
	}
	for _, image := range input.ReferenceImages {
		url, err := mediaReferenceURL(image)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": url}, "role": videoImageRole(input, image)})
	}
	for _, video := range input.ReferenceVideos {
		url, err := mediaReferenceURL(video)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]interface{}{"type": "video_url", "video_url": map[string]interface{}{"url": url}, "role": "reference_video"})
	}
	for _, audio := range input.ReferenceAudios {
		url, err := mediaReferenceURL(audio)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]interface{}{"type": "audio_url", "audio_url": map[string]interface{}{"url": url}, "role": "reference_audio"})
	}
	if len(content) == 0 {
		return nil, errors.New("请输入视频提示词或连接参考素材")
	}
	return content, nil
}

func shouldSendNewAPIVideoImages(input canvasGenerationInput) bool {
	if input.Metadata == nil {
		return true
	}
	operation, _ := input.Metadata["videoEditOperation"].(string)
	return strings.TrimSpace(operation) != "text_to_video"
}

func isHeihanAxonH3Video(baseURL, modelName string) bool {
	name := strings.ToLower(strings.TrimSpace(modelName))
	canonical := strings.NewReplacer("_", "-", " ", "-").Replace(name)
	knownAlias := canonical == "minimax-h3" || canonical == "minimax-h3-1" || canonical == "minimax-h3-max" || canonical == "minimax-h3-max-1"
	if !strings.HasPrefix(name, "minimax_h3_") && !knownAlias {
		return false
	}
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	path := strings.ToLower(strings.TrimRight(parsed.Path, "/"))
	return (host == "zh.heihan.dpdns.org" || host == "198.44.84.56") && (path == "" || path == "/v1")
}

// Axon's H3 /v1/videos relay needs aspect_ratio for orientation and URL/DataURL
// fields for references. The standard OpenAI Videos plugin only sends size and a
// multipart input_reference, so adapt this one relay without changing other
// providers that may reject these extension fields.
func applyAxonH3VideoCreateFields(input canvasGenerationInput, spec *protocol.RequestSpec) error {
	if !isHeihanAxonH3Video(input.Config.BaseURL, input.Config.Model) || spec == nil {
		return nil
	}
	fields, ok := spec.Body.(map[string]interface{})
	if !ok {
		return errors.New("Axon H3 视频请求字段无效")
	}
	ratio, err := axonH3AspectRatio(input.Config.Size)
	if err != nil {
		return err
	}
	fields["aspect_ratio"] = ratio
	if shouldSendNewAPIVideoImages(input) {
		imageReferences := input.ReferenceImages
		if isAxonH3FirstLastModel(input.Config.Model) {
			imageReferences, err = orderedVideoFrameReferences(input)
			if err != nil {
				return err
			}
		}
		imageURLs, _, err := axonH3MediaValues(imageReferences, "image")
		if err != nil {
			return err
		}
		for index, imageURL := range imageURLs {
			field := fmt.Sprintf("ref_image_%d", index)
			if isAxonH3FirstLastModel(input.Config.Model) {
				if index > 1 {
					return errors.New("当前首尾帧模型最多支持 2 张参考图")
				}
				field = []string{"first_frame", "last_frame"}[index]
			}
			fields[field] = imageURL
		}
	}
	audioURLs, inlineAudioBytes, err := axonH3MediaValues(input.ReferenceAudios, "audio")
	if err != nil {
		return err
	}
	var inlineImageBytes int64
	if shouldSendNewAPIVideoImages(input) {
		_, inlineImageBytes, err = axonH3MediaValues(input.ReferenceImages, "image")
		if err != nil {
			return err
		}
	}
	if inlineImageBytes+inlineAudioBytes > axonH3MaxInlineTotalBytes {
		return fmt.Errorf("Axon H3 内嵌参考素材总大小不能超过 %dMB", axonH3MaxInlineTotalBytes>>20)
	}
	for index, audioURL := range audioURLs {
		fields[fmt.Sprintf("ref_audio_%d", index)] = audioURL
	}
	spec.Files = nil
	spec.ContentType = "application/json"
	return nil
}

func isAxonH3FirstLastModel(model string) bool {
	model = strings.ToLower(strings.TrimSpace(model))
	return strings.HasSuffix(model, "b99_002") || strings.HasSuffix(model, "lightx2v")
}

func axonH3VideoBody(input canvasGenerationInput) (map[string]interface{}, error) {
	body := map[string]interface{}{
		"model":   input.Config.Model,
		"prompt":  newAPIVideoPromptText(input),
		"seconds": defaultString(input.Config.VideoSeconds, "6"),
		"preset":  "normal",
	}
	if size := normalizeVideoSize(input.Config.Size); size != "" {
		body["size"] = size
	}
	if resolution := videoResolutionNameRequest(input.VideoCapability, input.Config.VQuality); resolution != "" {
		body["resolution_name"] = resolution
	}
	spec := protocol.RequestSpec{Body: body}
	if err := applyAxonH3VideoCreateFields(input, &spec); err != nil {
		return nil, err
	}
	return body, nil
}

const (
	axonH3MaxInlineMediaBytes int64 = 30 << 20
	axonH3MaxInlineTotalBytes int64 = 50 << 20
)

// axonH3MediaValues matches AutoDL's H3 workflow UI: local files become
// DataURLs in JSON workflow fields, while existing remote URLs pass through.
// Keep this exception scoped to Axon H3; other providers keep their declared
// public URL or multipart contracts.
func axonH3MediaValues(media []providerMedia, kind string) ([]string, int64, error) {
	values := make([]string, 0, len(media))
	var inlineBytes int64
	for _, item := range media {
		value := firstNonEmpty(strings.TrimSpace(item.URL), strings.TrimSpace(item.DataURL))
		if isPublicMediaURL(value) {
			values = append(values, value)
			continue
		}
		if !strings.HasPrefix(strings.ToLower(value), "data:") {
			return nil, 0, fmt.Errorf("Axon H3 参考%s需要公网 URL 或受支持的 DataURL", axonH3MediaLabel(kind))
		}
		mimeType, data, err := decodeProviderDataURL(value)
		if err != nil || len(data) == 0 {
			return nil, 0, fmt.Errorf("Axon H3 参考%s DataURL 无效", axonH3MediaLabel(kind))
		}
		if !axonH3AllowedMediaMIME(kind, mimeType) {
			return nil, 0, fmt.Errorf("Axon H3 参考%s DataURL MIME 类型不受支持", axonH3MediaLabel(kind))
		}
		if int64(len(data)) > axonH3MaxInlineMediaBytes {
			return nil, 0, fmt.Errorf("Axon H3 单个内嵌参考%s不能超过 %dMB", axonH3MediaLabel(kind), axonH3MaxInlineMediaBytes>>20)
		}
		inlineBytes += int64(len(data))
		if inlineBytes > axonH3MaxInlineTotalBytes {
			return nil, 0, fmt.Errorf("Axon H3 内嵌参考素材总大小不能超过 %dMB", axonH3MaxInlineTotalBytes>>20)
		}
		values = append(values, value)
	}
	return values, inlineBytes, nil
}

func axonH3AllowedMediaMIME(kind, mimeType string) bool {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "image":
		switch strings.ToLower(strings.TrimSpace(mimeType)) {
		case "image/jpeg", "image/png", "image/webp":
			return true
		}
	case "audio":
		switch strings.ToLower(strings.TrimSpace(mimeType)) {
		case "audio/aac", "audio/flac", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/x-wav":
			return true
		}
	}
	return false
}

func axonH3MediaLabel(kind string) string {
	if strings.EqualFold(strings.TrimSpace(kind), "audio") {
		return "音频"
	}
	return "图片"
}

func axonH3AspectRatio(size string) (string, error) {
	for _, ratio := range []string{"16:9", "9:16", "1:1"} {
		if videoRatioAllowed([]string{ratio}, size) {
			return ratio, nil
		}
	}
	return "", errors.New("Axon H3 视频需要明确的 16:9、9:16 或 1:1 画幅，请先选择支持的尺寸")
}

// 本地测试 helper 没有能力配置时保留历史协议字段；真实系统任务会携带已解析的模型能力。
func videoCapabilitySupportsAudio(input canvasGenerationInput) bool {
	return input.VideoCapability == nil || input.VideoCapability.GenerateAudio.Supported
}

func videoCapabilitySupportsWatermark(input canvasGenerationInput) bool {
	return input.VideoCapability == nil || input.VideoCapability.Watermark.Supported
}

func newAPIVideoPromptText(input canvasGenerationInput) string {
	return strings.TrimSpace(input.Prompt)
}

func seedanceVideosRequestBody(input canvasGenerationInput) (seedanceVideosRequest, error) {
	if (len(input.ReferenceVideos) > 0 || len(input.ReferenceAudios) > 0) && len(input.ReferenceImages) == 0 {
		return seedanceVideosRequest{}, errors.New("Seedance 参考视频或参考音频需要同时连接至少 1 张主参考图")
	}
	body := seedanceVideosRequest{
		Model:       input.Config.Model,
		Prompt:      seedanceVideosPromptText(input),
		AspectRatio: normalizeSeedanceVideosRatio(input.Config.Size),
		Duration:    normalizeSeedanceVideosDuration(input.Config.VideoSeconds),
	}
	if videoCapabilitySupportsAudio(input) {
		value := parseBool(input.Config.VideoGenerateAudio, true)
		body.GenerateAudio = &value
	}
	imageURLs := make([]string, 0, len(input.ReferenceImages))
	for _, image := range input.ReferenceImages {
		url, err := openAIImageInputURL(image)
		if err != nil {
			return seedanceVideosRequest{}, err
		}
		imageURLs = append(imageURLs, url)
	}
	frameImageURLs, err := videoFrameImageURLs(input, imageURLs)
	if err != nil {
		return seedanceVideosRequest{}, err
	}
	if metadataString(input.Metadata, "videoEditOperation") == "reference_to_video" {
		body.ReferenceImageURLs = imageURLs
	} else if len(frameImageURLs) > 0 {
		body.ImageURLs = frameImageURLs
	} else if len(imageURLs) > 0 {
		body.ImageURL = imageURLs[0]
		if len(imageURLs) > 1 {
			body.ReferenceImageURLs = imageURLs[1:]
		}
	}
	videoURLs := make([]string, 0, len(input.ReferenceVideos))
	for _, video := range input.ReferenceVideos {
		url, err := seedanceVideosMediaURL(video)
		if err != nil {
			return seedanceVideosRequest{}, err
		}
		videoURLs = append(videoURLs, url)
	}
	if len(videoURLs) > 0 {
		body.ReferenceVideos = videoURLs
	}
	audioURLs := make([]string, 0, len(input.ReferenceAudios))
	for _, audio := range input.ReferenceAudios {
		url, err := seedanceVideosMediaURL(audio)
		if err != nil {
			return seedanceVideosRequest{}, err
		}
		audioURLs = append(audioURLs, url)
	}
	if len(audioURLs) > 0 {
		body.ReferenceAudios = audioURLs
	}
	return body, nil
}

// 兼容旧的 map 断言调用；实际请求路径使用类型化 Seedance DTO。
func seedanceVideosBody(input canvasGenerationInput) (map[string]interface{}, error) {
	body, err := seedanceVideosRequestBody(input)
	if err != nil {
		return nil, err
	}
	return requestAsMap(body)
}

func seedancePromptText(input canvasGenerationInput) string {
	return strings.TrimSpace(input.Prompt)
}

func seedanceVideosPromptText(input canvasGenerationInput) string {
	return strings.TrimSpace(input.Prompt)
}

func videoImageRole(input canvasGenerationInput, image providerMedia) string {
	return videoImageRoleOrDefault(input, image, "reference_image")
}

func videoImageRoleOrDefault(input canvasGenerationInput, image providerMedia, fallback string) string {
	if metadataString(input.Metadata, "videoEditOperation") == "reference_to_video" {
		return "reference_image"
	}
	if id := metadataString(input.Metadata, "videoStartFrameNodeId"); id != "" && image.ID == id {
		return "first_frame"
	}
	if id := metadataString(input.Metadata, "videoEndFrameNodeId"); id != "" && image.ID == id {
		return "last_frame"
	}
	return fallback
}

func videoFrameImageURLs(input canvasGenerationInput, imageURLs []string) ([]string, error) {
	indexes, err := videoFrameImageIndexes(input)
	if err != nil || indexes == nil {
		return nil, err
	}
	ordered := make([]string, 0, len(indexes))
	for _, index := range indexes {
		if index < len(imageURLs) {
			ordered = append(ordered, imageURLs[index])
		}
	}
	return ordered, nil
}

func orderedVideoFrameReferences(input canvasGenerationInput) ([]providerMedia, error) {
	indexes, err := videoFrameImageIndexes(input)
	if err != nil || indexes == nil {
		return input.ReferenceImages, err
	}
	ordered := make([]providerMedia, 0, len(indexes))
	for _, index := range indexes {
		ordered = append(ordered, input.ReferenceImages[index])
	}
	return ordered, nil
}

func videoFrameImageIndexes(input canvasGenerationInput) ([]int, error) {
	if metadataString(input.Metadata, "videoEditOperation") == "reference_to_video" {
		return nil, nil
	}
	startFrameID := metadataString(input.Metadata, "videoStartFrameNodeId")
	endFrameID := metadataString(input.Metadata, "videoEndFrameNodeId")
	if startFrameID == "" && endFrameID == "" {
		return nil, nil
	}
	// 视频协议没有通用 role 字段时，至少按已标记的帧 ID 排列输入素材。
	ordered := make([]int, 0, len(input.ReferenceImages))
	used := make([]bool, len(input.ReferenceImages))
	appendFrame := func(frameID string, label string) error {
		if frameID == "" {
			return nil
		}
		for index, image := range input.ReferenceImages {
			if image.ID != frameID {
				continue
			}
			ordered = append(ordered, index)
			used[index] = true
			return nil
		}
		return fmt.Errorf("已配置的%s参考图未包含在视频请求中", label)
	}
	if err := appendFrame(startFrameID, "首帧"); err != nil {
		return nil, err
	}
	if err := appendFrame(endFrameID, "尾帧"); err != nil {
		return nil, err
	}
	for index := range input.ReferenceImages {
		if !used[index] {
			ordered = append(ordered, index)
		}
	}
	return ordered, nil
}

func mediaReferenceURL(media providerMedia) (string, error) {
	value := strings.TrimSpace(media.URL)
	if isPublicMediaURL(value) || strings.HasPrefix(value, "asset://") || strings.HasPrefix(value, "data:") {
		return value, nil
	}
	value = strings.TrimSpace(media.DataURL)
	if value != "" {
		return value, nil
	}
	return "", errors.New("参考素材需要公网 URL、asset:// 素材 ID 或 data URL")
}

func seedanceVideosMediaURL(media providerMedia) (string, error) {
	value := strings.TrimSpace(media.DataURL)
	if strings.HasPrefix(value, "data:") {
		return value, nil
	}
	value = strings.TrimSpace(media.URL)
	if strings.HasPrefix(value, "data:") || isPublicMediaURL(value) {
		return value, nil
	}
	return "", errors.New("Seedance /videos 参考素材需要公网 URL 或 data URL")
}

func seedanceErrorMessage(state map[string]interface{}) string {
	if errorValue, ok := state["error"].(map[string]interface{}); ok {
		message := stringField(errorValue, "message")
		code := stringField(errorValue, "code")
		if message != "" && code != "" {
			return code + "：" + message
		}
		if message != "" {
			return message
		}
	}
	code := stringField(state, "error_code")
	if code != "" {
		return code
	}
	return ""
}

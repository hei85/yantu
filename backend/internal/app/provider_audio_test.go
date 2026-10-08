package app

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestIndexTTSAsyncAudioRequestsNativeWAV(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var payload map[string]any
	wav := make([]byte, 44)
	copy(wav[0:4], "RIFF")
	copy(wav[8:12], "WAVE")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/audio/tasks":
			if r.Method != http.MethodPost {
				t.Errorf("submit method = %s", r.Method)
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Errorf("decode request: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"task_id":"test-tts","status":"completed"}`))
		case "/v1/audio/tasks/test-tts/content":
			w.Header().Set("Content-Type", "audio/wav")
			_, _ = w.Write(wav)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	ctx := ensureOfficialProtocolAdapter(t.Context(), string(model.ChannelInterfaceAsyncAudio))
	if _, ok := declarativeProtocolAdapterForContext(ctx, string(model.ChannelInterfaceAsyncAudio)); !ok {
		t.Fatal("installed async-audio adapter is unavailable")
	}
	result, err := runAudioTask(ctx, canvasGenerationInput{
		Mode: "audio", Prompt: "你好，这是测试。",
		Config: providerConfig{
			BaseURL: server.URL + "/v1", APIKey: "test-key", Model: "indextts2-v1",
			InterfaceType: string(model.ChannelInterfaceAsyncAudio), AudioVoice: "alloy", AudioFormat: "mp3", AudioSpeed: "1.5",
		},
	})
	if err != nil {
		t.Fatalf("runAudioTask: %v", err)
	}
	if payload["response_format"] != "wav" || payload["speed"] != float64(1) {
		t.Fatalf("IndexTTS request format/speed = %#v", payload)
	}
	audio, ok := result["audio"].(map[string]interface{})
	if !ok || audio["format"] != "wav" || audio["requestedFormat"] != "wav" {
		t.Fatalf("IndexTTS result = %#v", result)
	}
}

func TestIndexTTSReferenceAudioUsesRelayReferenceAudioField(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var payload map[string]any
	wav := make([]byte, 44)
	copy(wav[0:4], "RIFF")
	copy(wav[8:12], "WAVE")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/audio/tasks":
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Errorf("decode request: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"task_id":"index-tts-ref","status":"completed"}`))
		case "/v1/audio/tasks/index-tts-ref/content":
			w.Header().Set("Content-Type", "audio/wav")
			_, _ = w.Write(wav)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	capability := DefaultAudioCapabilityConfig()
	capability.TTS = "configured"
	capability.VoiceReference = "configured"
	capability.ReferenceAudioParameter = "reference_audio"
	ctx := ensureOfficialProtocolAdapter(t.Context(), string(model.ChannelInterfaceAsyncAudio))
	_, err := runAudioTask(ctx, canvasGenerationInput{
		Mode: "audio", Prompt: "我回来了。",
		Config: providerConfig{
			BaseURL: server.URL + "/v1", APIKey: "test-key", Model: "indextts2-v1",
			InterfaceType: string(model.ChannelInterfaceAsyncAudio), AudioVoice: "sample", AudioFormat: "mp3", AudioSpeed: "1",
			CapabilityConfig: &ModelCapabilityConfig{Version: 1, Audio: capability},
		},
		Metadata: map[string]any{
			"productionAudioMode": "REBUILD_AUDIO", "kind": "dialogue", "voiceStrategy": "voice_reference",
			"referenceAudioResourceId": "authorized-voice-sample",
		},
		ReferenceAudios: []providerMedia{{ID: "authorized-voice-sample", Type: "audio", DataURL: "data:audio/wav;base64,UklGRg==", MimeType: "audio/wav"}},
	})
	if err != nil {
		t.Fatalf("runAudioTask: %v", err)
	}
	if payload["model"] != "indextts2-v1" || payload["input"] != "我回来了。" || payload["reference_audio"] != "data:audio/wav;base64,UklGRg==" {
		t.Fatalf("relay request did not carry the authorized IndexTTS reference: %#v", payload)
	}
	if payload["response_format"] != "wav" || payload["speed"] != float64(1) {
		t.Fatalf("IndexTTS request format/speed = %#v", payload)
	}
	if _, exists := payload["voice"]; exists {
		t.Fatalf("reference voice request unexpectedly included a fixed sample voice: %#v", payload)
	}
}

func TestIndexTTSReferenceAudioRejectsUnknownCapabilityBeforeUpstream(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
	}))
	defer server.Close()
	audio := DefaultAudioCapabilityConfig()
	audio.TTS = "configured"
	ctx := ensureOfficialProtocolAdapter(t.Context(), string(model.ChannelInterfaceAsyncAudio))
	_, err := runAudioTask(ctx, canvasGenerationInput{
		Mode: "audio", Prompt: "台词",
		Config: providerConfig{
			BaseURL: server.URL + "/v1", APIKey: "test-key", Model: "indextts2-v1", InterfaceType: string(model.ChannelInterfaceAsyncAudio),
			CapabilityConfig: &ModelCapabilityConfig{Version: 1, Audio: audio},
		},
		Metadata: map[string]any{
			"productionAudioMode": "REBUILD_AUDIO", "kind": "dialogue", "voiceStrategy": "voice_reference",
			"referenceAudioResourceId": "authorized-voice-sample",
		},
		ReferenceAudios: []providerMedia{{ID: "authorized-voice-sample", Type: "audio", DataURL: "data:audio/wav;base64,UklGRg=="}},
	})
	if err == nil || !strings.Contains(err.Error(), "没有声明已验证的 reference_audio") || requests != 0 {
		t.Fatalf("unsupported reference voice was not rejected before upstream: err=%v requests=%d", err, requests)
	}
}

func TestIndexTTSReferenceAudioRejectsMissingCapabilityWithoutPanic(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
	}))
	defer server.Close()
	ctx := ensureOfficialProtocolAdapter(t.Context(), string(model.ChannelInterfaceAsyncAudio))
	_, err := runAudioTask(ctx, canvasGenerationInput{
		Mode: "audio", Prompt: "你好。",
		Config:          providerConfig{BaseURL: server.URL + "/v1", APIKey: "test-key", Model: "indextts2-v1", InterfaceType: string(model.ChannelInterfaceAsyncAudio)},
		ReferenceAudios: []providerMedia{{ID: "local-reference", Type: "audio", DataURL: "data:audio/wav;base64,UklGRg=="}},
	})
	if err == nil || !strings.Contains(err.Error(), "没有声明已验证的 reference_audio") || requests != 0 {
		t.Fatalf("missing reference capability was not rejected before upstream: err=%v requests=%d", err, requests)
	}
}

func TestIndexTTSDirectReferenceAudioUsesDeclaredParameter(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var payload map[string]any
	wav := make([]byte, 44)
	copy(wav[0:4], "RIFF")
	copy(wav[8:12], "WAVE")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/audio/tasks":
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Errorf("decode request: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"task_id":"index-tts-direct-ref","status":"completed"}`))
		case "/v1/audio/tasks/index-tts-direct-ref/content":
			w.Header().Set("Content-Type", "audio/wav")
			_, _ = w.Write(wav)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	audio := DefaultAudioCapabilityConfig()
	audio.TTS, audio.VoiceReference, audio.ReferenceAudioParameter = "configured", "configured", "reference_audio"
	ctx := ensureOfficialProtocolAdapter(t.Context(), string(model.ChannelInterfaceAsyncAudio))
	_, err := runAudioTask(ctx, canvasGenerationInput{
		Mode: "audio", Prompt: "你好，我回来了。",
		Config: providerConfig{
			BaseURL: server.URL + "/v1", APIKey: "test-key", Model: "indextts2-v1", InterfaceType: string(model.ChannelInterfaceAsyncAudio),
			AudioVoice: "sample", AudioFormat: "wav", AudioSpeed: "1", CapabilityConfig: &ModelCapabilityConfig{Version: 1, Audio: audio},
		},
		ReferenceAudios: []providerMedia{{ID: "local-reference", Type: "audio", DataURL: "data:audio/wav;base64,UklGRg==", MimeType: "audio/wav"}},
	})
	if err != nil {
		t.Fatalf("runAudioTask: %v", err)
	}
	if payload["reference_audio"] != "data:audio/wav;base64,UklGRg==" || payload["input"] != "你好，我回来了。" || payload["voice"] != nil {
		t.Fatalf("IndexTTS did not preserve direct reference audio: %#v", payload)
	}
}

func TestGeneratedAudioResultRecordsRequestedAndObservedFormat(t *testing.T) {
	wav := make([]byte, 44)
	copy(wav[0:4], "RIFF")
	copy(wav[8:12], "WAVE")

	mimeType, err := validateGeneratedAudio("audio/wav", wav, "mp3")
	if err != nil {
		t.Fatalf("validate WAV returned for an MP3 request: %v", err)
	}
	result := generatedAudioResult(wav, mimeType, "mp3")
	audio, ok := result["audio"].(map[string]interface{})
	if !ok {
		t.Fatalf("audio result has unexpected shape: %#v", result)
	}
	if audio["mimeType"] != "audio/wav" || audio["format"] != "wav" || audio["actualFormat"] != "wav" || audio["requestedFormat"] != "mp3" {
		t.Fatalf("audio format evidence = %#v", audio)
	}
	dataURL, ok := audio["dataUrl"].(string)
	if !ok || dataURL != "data:audio/wav;base64,"+base64.StdEncoding.EncodeToString(wav) {
		t.Fatalf("audio data URL did not preserve observed MIME type: %#v", audio["dataUrl"])
	}
}

func TestProductionVoiceVersionParametersReachProviderPayload(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var payload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/audio/speech" {
			t.Errorf("upstream request = %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode provider payload: %v", err)
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = w.Write([]byte("ID3fixture"))
	}))
	defer server.Close()

	audio := DefaultAudioCapabilityConfig()
	audio.TTS = "configured"
	audio.VoiceDesign = "configured"
	audio.VoiceIDParameter = "voice_id"
	audio.VoiceIDs = []string{"character-voice-v4"}
	audio.ToneParameter = "tone"
	audio.EmotionStyleParameter = "emotion_style"
	audio.SpeakingRateParameter = "speaking_rate"
	audio.LanguageParameter = "language"
	audio.AccentParameter = "accent"
	_, err := runAudioTask(t.Context(), canvasGenerationInput{
		Mode:   "audio",
		Prompt: "请保持克制地说：我回来了。",
		Config: providerConfig{
			BaseURL: server.URL + "/v1", APIKey: "test-key", Model: "voice-model", AudioVoice: "character-voice-v4", AudioFormat: "mp3", AudioSpeed: "1",
			CapabilityConfig: &ModelCapabilityConfig{Version: 1, Audio: audio},
		},
		Metadata: map[string]any{
			"productionAudioMode": "REBUILD_AUDIO", "kind": "dialogue", "voiceStrategy": "voice_design",
			"voiceId": "character-voice-v4", "tone": "低沉温暖", "emotionStyle": "克制但堅定",
			"speakingRate": 0.9, "language": "zh-CN", "accent": "standard",
		},
	})
	if err != nil {
		t.Fatalf("runAudioTask: %v", err)
	}
	for key, want := range map[string]any{
		"voice_id": "character-voice-v4", "tone": "低沉温暖", "emotion_style": "克制但堅定",
		"speaking_rate": 0.9, "language": "zh-CN", "accent": "standard",
	} {
		if payload[key] != want {
			t.Fatalf("provider field %s = %#v, want %#v; payload=%#v", key, payload[key], want, payload)
		}
	}
	if _, exists := payload["voice"]; exists {
		t.Fatalf("voice design must use the declared upstream voice ID field, payload=%#v", payload)
	}
}

func TestProductionVoiceRouterRejectsUnregisteredVoiceBeforeUpstreamCall(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = w.Write([]byte("ID3fixture"))
	}))
	defer server.Close()

	audio := DefaultAudioCapabilityConfig()
	audio.TTS = "configured"
	audio.VoiceIDs = []string{"voice-from-registry"}
	audio.DefaultVoiceID = "voice-from-registry"
	_, err := runAudioTask(t.Context(), canvasGenerationInput{
		Mode: "audio", Prompt: "台词",
		Config:   providerConfig{BaseURL: server.URL + "/v1", APIKey: "test-key", Model: "audio-model", AudioVoice: "unregistered-voice", AudioFormat: "mp3", CapabilityConfig: &ModelCapabilityConfig{Audio: audio}},
		Metadata: map[string]any{"productionAudioMode": "REBUILD_AUDIO", "kind": "dialogue", "voiceStrategy": "standard_tts", "voiceId": "unregistered-voice"},
	})
	if err == nil || requests != 0 {
		t.Fatalf("unregistered voice reached upstream: err=%v requests=%d", err, requests)
	}
}

func TestProductionVoiceReferenceDoesNotMixTheModelDefaultVoice(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var payload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode provider payload: %v", err)
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = w.Write([]byte("ID3fixture"))
	}))
	defer server.Close()

	audio := DefaultAudioCapabilityConfig()
	audio.TTS = "configured"
	audio.VoiceReference = "configured"
	audio.ReferenceAudioParameter = "reference_audio"
	_, err := runAudioTask(t.Context(), canvasGenerationInput{
		Mode: "audio", Prompt: "角色台词",
		Config:          providerConfig{BaseURL: server.URL + "/v1", APIKey: "test-key", Model: "reference-tts", AudioVoice: "alloy", AudioFormat: "mp3", CapabilityConfig: &ModelCapabilityConfig{Audio: audio}},
		Metadata:        map[string]any{"productionAudioMode": "REBUILD_AUDIO", "kind": "dialogue", "voiceStrategy": "voice_reference", "referenceAudioResourceId": "voice-sample"},
		ReferenceAudios: []providerMedia{{URL: server.URL + "/voice-sample.wav", Type: "audio"}},
	})
	if err != nil {
		t.Fatalf("runAudioTask: %v", err)
	}
	if _, exists := payload["voice"]; exists {
		t.Fatalf("reference voice was mixed with the model default voice: %#v", payload)
	}
	if payload["reference_audio"] != server.URL+"/voice-sample.wav" {
		t.Fatalf("reference audio payload = %#v", payload)
	}
}

func TestProductionMusicDoesNotFallBackToGenericTTS(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = w.Write([]byte("ID3fixture"))
	}))
	defer server.Close()

	audio := DefaultAudioCapabilityConfig()
	audio.Music = "configured"
	_, err := runAudioTask(t.Context(), canvasGenerationInput{
		Mode: "audio", Prompt: "轻柔氛围配乐",
		Config:   providerConfig{BaseURL: server.URL + "/v1", APIKey: "test-key", Model: "audio-model", AudioFormat: "mp3", CapabilityConfig: &ModelCapabilityConfig{Audio: audio}},
		Metadata: map[string]any{"productionAudioMode": "REBUILD_AUDIO", "kind": "music"},
	})
	if err == nil || requests != 0 {
		t.Fatalf("generic TTS was used for music: err=%v, upstreamRequests=%d", err, requests)
	}
}

func TestNativeProductionAudioNeverCallsIndependentAudioModel(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = w.Write([]byte("ID3fixture"))
	}))
	defer server.Close()

	_, err := runAudioTask(t.Context(), canvasGenerationInput{
		Mode: "audio", Prompt: "即使被误调用也不能覆盖原生对白",
		Config:   providerConfig{BaseURL: server.URL + "/v1", APIKey: "test-key", Model: "audio-model"},
		Metadata: map[string]any{"productionAudioMode": "NATIVE_AUDIO", "kind": "dialogue"},
	})
	if err == nil || requests != 0 {
		t.Fatalf("NATIVE_AUDIO invoked independent audio model: err=%v requests=%d", err, requests)
	}
}

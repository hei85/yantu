import { describe, expect, test } from "bun:test";

import { buildSubmitRequest, extractUsage, meta, native, parseTaskResult } from "./plugin.js";

const SAMPLE_AUDIO = "https://zh.heihan.dpdns.org/tts-assets/voice_01.wav";

describe("IndexTTS2 native audio route", () => {
  test("declares audio task routes without replacing video protocol", () => {
    expect(meta.protocols).toEqual(["openai_video"]);
    expect(meta.routes).toEqual([
      expect.objectContaining({ method: "POST", path: "/v1/audio/tasks", models: ["indextts2-v1"] }),
      expect.objectContaining({ method: "GET", path: "/v1/audio/tasks/:task_id", type: "query" }),
    ]);
  });

  test("maps portable speech input to the verified AutoDL workflow", () => {
    const intent = native.createAudioTask({
      body: { kind: "json", value: { model: "indextts2-v1", input: "你好，这是语音测试。", voice: "alloy", response_format: "wav", speed: 1 } },
    });
    expect(intent.kind).toBe("submit");
    expect(intent.model).toBe("indextts2-v1");
    const outbound = buildSubmitRequest({
      baseUrl: "https://autodl.art",
      apiKey: "test-token",
      model: intent.model,
      requestBody: intent.requestBody,
    });
    expect(outbound.url).toBe("https://autodl.art/api/v1/comfyui/comfyui_workflow/indextts2-v1");
    expect(outbound.body).toEqual({
      prompt_simple: SAMPLE_AUDIO,
      prompt_text: "你好，这是语音测试。",
      emo_control_method: "与音色参考音频相同",
    });
    expect(extractUsage({ requestBody: intent.requestBody })).toEqual({ duration: 10 });
  });

  test("allows a replacement reference and reports the completed WAV", () => {
    const replacement = "https://example.com/voice.wav";
    const intent = native.createAudioTask({
      body: { kind: "json", value: { model: "indextts2-v1", input: "你好", reference_audio: replacement } },
    });
    expect(intent.requestBody.voiceAudio).toBe(replacement);
    const audioURL = "https://example.com/output.wav";
    const task = { task_id: "task-1", status: "SUCCESS", data: { data: { results: [{ url: audioURL, type: "audio", file_type: "wav" }] } } };
    expect(native.renderAudioTaskStatus({}, task)).toEqual({ id: "task-1", task_id: "task-1", status: "completed", format: "wav", audio_url: audioURL });
    expect(parseTaskResult({}, { data: { status: "SUCCESS", results: [{ url: audioURL }] } })).toEqual({ status: "SUCCESS", reason: "", url: audioURL });
  });

  test("rejects wrong model and unsupported speed before submission", () => {
    expect(() => native.createAudioTask({ body: { kind: "json", value: { model: "minimax_h3_z0901", input: "你好" } } })).toThrow();
    expect(() => native.createAudioTask({ body: { kind: "json", value: { model: "indextts2-v1", input: "你好", speed: 2 } } })).toThrow();
    expect(() => native.createAudioTask({ body: { kind: "json", value: { model: "indextts2-v1", input: "你好", response_format: "mp3" } } })).toThrow();
    expect(() => native.createAudioTask({ body: { kind: "json", value: { model: "indextts2-v1", input: "你好", voice: "ash" } } })).toThrow();
  });
});

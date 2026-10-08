const WORKFLOWS = {
  minimax_h3_z0903: {
    mode: "reference_images_audio",
    resolutionGroup: "z0902",
    maxDuration: 15,
    defaultResolution: "768P",
  },
  // Motion transfer: one character photo plus one motion video, no prompt.
  "wan2.2animate-v4-motion_retargeting": {
    mode: "motion_retarget",
    maxDuration: 60,
    defaultResolution: "464*832px(竖版)",
  },
  // Voice cloning TTS: a voice reference audio plus the text to speak.
  "indextts2-v1": {
    mode: "tts",
    maxDuration: 600,
    defaultResolution: "audio",
  },
  minimax_h3_z0902: {
    mode: "reference_images",
    resolutionGroup: "z0902",
    maxDuration: 15,
    defaultResolution: "768P",
  },
  minimax_h3_z0901: {
    mode: "text",
    resolutionGroup: "z0901",
    maxDuration: 15,
    defaultResolution: "768P",
  },
  minimax_h3_zm_u24: {
    mode: "reference_images_optional_audio",
    resolutionGroup: "basic_square",
    maxDuration: 15,
    defaultResolution: "768P",
  },
  minimax_h3_zm_u08: {
    mode: "reference_images_optional_audio",
    resolutionGroup: "basic_square",
    maxDuration: 15,
    defaultResolution: "768P",
  },
  minimax_h3_b99_002: {
    mode: "first_last",
    resolutionGroup: "fixed736",
    maxDuration: 15,
    defaultResolution: "736P",
  },
  minimax_h3_b99_001: {
    mode: "text",
    resolutionGroup: "fixed736",
    maxDuration: 15,
    defaultResolution: "736P",
  },
  minimax_h3_b99_003_12s: {
    mode: "reference_images",
    resolutionGroup: "fixed736",
    maxDuration: 12,
    defaultResolution: "736P",
  },
  minimax_h3_image_audio_to_video_v2_15s: {
    mode: "optional_reference_media",
    resolutionGroup: "basic",
    maxDuration: 15,
    defaultResolution: "768P",
  },
  minimax_h3_lightx2v_v5_15s: {
    mode: "reference_images",
    resolutionGroup: "basic_square",
    maxDuration: 15,
    defaultResolution: "768P",
  },
  minimax_h3_image_audio_to_video_v2: {
    mode: "optional_reference_media",
    resolutionGroup: "full",
    maxDuration: 10,
    defaultResolution: "768P",
  },
  minimax_h3_image_audio_to_video: {
    mode: "image_audio_sync",
    resolutionGroup: "full",
    maxDuration: 15,
    defaultResolution: "768P",
  },
  minimax_h3_lightx2v_v5: {
    mode: "reference_images",
    resolutionGroup: "full_square",
    maxDuration: 10,
    defaultResolution: "768P",
  },
  minimax_h3_lightx2v_no_pic: {
    mode: "text",
    resolutionGroup: "basic_square",
    maxDuration: 15,
    defaultResolution: "768P",
  },
  minimax_h3_lightx2v: {
    mode: "first_last",
    resolutionGroup: "basic_square",
    maxDuration: 10,
    defaultResolution: "768P",
  },
};

const MODEL_IDS = Object.keys(WORKFLOWS);

const DURATION_FIELD = {
  type: "number",
  unit: "second",
  description: { en: "Video generation unit price", zh: "视频生成单价" },
};

const RESOLUTION_DESCRIPTION = { en: "Output video resolution", zh: "输出视频分辨率" };

// Facts the host accepts for this plugin. Anything else (for example the
// motion-transfer pixel preset) must be omitted or the host rejects the
// whole usage payload.
const RESOLUTION_ENUM = ["480P", "736P", "768P", "1080P", "1088P", "1440P"];

const TTS_EMOTION_KEYS = [
  "emo_happy",
  "emo_sad",
  "emo_angry",
  "emo_afraid",
  "emo_disgusted",
  "emo_melancholic",
  "emo_calm",
];

const SCHEMA_Z = {
  duration: DURATION_FIELD,
  resolution: {
    enum: ["480P", "768P", "1088P", "1440P"],
    description: RESOLUTION_DESCRIPTION,
  },
};

const SCHEMA_BASIC = {
  duration: DURATION_FIELD,
  resolution: {
    enum: ["480P", "768P"],
    description: RESOLUTION_DESCRIPTION,
  },
};

const SCHEMA_FULL = {
  duration: DURATION_FIELD,
  resolution: {
    enum: ["480P", "768P", "1080P"],
    description: RESOLUTION_DESCRIPTION,
  },
};

const SCHEMA_736 = {
  duration: DURATION_FIELD,
  resolution: {
    enum: ["736P"],
    description: RESOLUTION_DESCRIPTION,
  },
};

export const meta = {
  apiVersion: 1,
  key: "autodl-comfyui",
  name: "AutoDL ComfyUI Video",
  icon: "text:DL",
  description: {
    en: "AutoDL.Art ComfyUI video workflows with per-second billing by output resolution",
    zh: "AutoDL.Art ComfyUI 视频工作流，按输出分辨率与视频秒数计费",
  },
  version: "1.0.9",
  author: { name: "Axon" },
  baseUrl: "https://autodl.art",
  auth: "api_key",
  models: MODEL_IDS,
  fetchMode: "per_task",
  usageSchema: {
    duration: DURATION_FIELD,
    resolution: {
      enum: RESOLUTION_ENUM,
      description: RESOLUTION_DESCRIPTION,
    },
  },
  usageExamples: [
    { label: "480P 5s", facts: { duration: 5, resolution: "480P" } },
    { label: "736P 5s", facts: { duration: 5, resolution: "736P" } },
    { label: "768P 5s", facts: { duration: 5, resolution: "768P" } },
    { label: "1080P 5s", facts: { duration: 5, resolution: "1080P" } },
    { label: "1088P 5s", facts: { duration: 5, resolution: "1088P" } },
    { label: "1440P 5s", facts: { duration: 5, resolution: "1440P" } },
  ],
  routes: [
    {
      method: "POST",
      path: "/v1/audio/tasks",
      type: "submit",
      decode: "createAudioTask",
      render: "renderAudioTaskCreated",
      models: ["indextts2-v1"],
    },
    {
      method: "GET",
      path: "/v1/audio/tasks/:task_id",
      type: "query",
      render: "renderAudioTaskStatus",
    },
  ],
  protocols: ["openai_video"],
};

function trimmed(value) {
  return String(value == null ? "" : value).trim();
}

function numberOrNull(value) {
  const valueNumber = Number(value);
  return Number.isFinite(valueNumber) ? valueNumber : null;
}

function normalizeResolutionGroup(value, group, requestedAspectRatio) {
  const raw = trimmed(value).toLowerCase();
  if (!raw) return null;

  let resolution = null;
  if (raw.includes("2160") || raw === "4k") resolution = "2160P";
  else if (raw.includes("1440") || raw === "2k" || raw === "2.5k") resolution = "1440P";
  else if (raw.includes("1088")) resolution = "1088P";
  else if (raw.includes("1080")) resolution = "1080P";
  else if (raw.includes("768")) resolution = "768P";
  else if (raw.includes("736")) resolution = "736P";
  else if (raw.includes("480")) resolution = "480P";
  else if (raw.includes("720")) resolution = "720P";
  else throw new Error("unsupported resolution: " + value);

  if (resolution === "2160P") {
    throw new Error("AutoDL ComfyUI does not offer a 4K/2160p tier; choose a supported resolution")
  }
  if (resolution === "720P") {
    resolution = group === "fixed736" ? "736P" : "768P";
  }
  if (resolution === "1080P" && (group === "z0901" || group === "z0902")) {
    resolution = "1088P";
  }

  const dimensions = raw.match(/(\d{3,4})\s*[*x]\s*(\d{3,4})/);
  const ratio = trimmed(requestedAspectRatio).toLowerCase().replace(/\s/g, "");
  const ratioOrientations = {
    "16:9": "horizontal", "21:9": "horizontal", "4:3": "horizontal", "3:2": "horizontal",
    "9:16": "vertical", "3:4": "vertical", "2:3": "vertical", "1:1": "square",
  };
  const ratioOrientation = ratioOrientations[ratio] || null;
  const explicitOrientation = raw.includes("横") || (dimensions && Number(dimensions[1]) > Number(dimensions[2]))
    ? "horizontal"
    : raw.includes("竖") || (dimensions && Number(dimensions[1]) < Number(dimensions[2]))
      ? "vertical"
      : raw.includes("1:1") || raw.includes("square") ? "square" : null;
  if (explicitOrientation && ratioOrientation && explicitOrientation !== ratioOrientation) {
    throw new Error("aspect ratio conflicts with explicit resolution orientation");
  }
  let orientation = explicitOrientation || ratioOrientation || "vertical";

  if (group === "fixed736") resolution = "736P";
  if (group !== "fixed736" && resolution === "736P") resolution = "768P";
  if ((group === "basic" || group === "basic_square") && resolution !== "480P" && resolution !== "768P") resolution = "768P";
  if ((group === "full" || group === "full_square") && resolution !== "480P" && resolution !== "768P" && resolution !== "1080P") resolution = "1080P";
  if (orientation === "square" && group !== "fixed736" && group !== "basic_square" && group !== "full_square") {
    throw new Error("square resolution is not supported by this model");
  }
  return { resolution: resolution, orientation: orientation };
}

function upstreamResolution(model, group, resolution) {
  const config = WORKFLOWS[model];
  const orientation = resolution.orientation;
  const suffix = orientation === "horizontal" ? "横" : orientation === "square" ? "(1:1)" : "竖";
  const value = resolution.resolution;

  if (group === "fixed736") return "736p" + suffix;
  if (group === "z0901") {
    const dimensions = {
      "480P": { vertical: "480*864", horizontal: "864*480" },
      "768P": { vertical: "768*1344", horizontal: "1344*768" },
      "1088P": { vertical: "1088*1920", horizontal: "1920*1088" },
      "1440P": { vertical: "1440*2560", horizontal: "2560*1440" },
    };
    const size = dimensions[value] && dimensions[value][orientation];
    return size ? value.toLowerCase() + suffix + "(" + size + ")" : value.toLowerCase() + suffix;
  }
  if (group === "z0902") {
    const dimensions = {
      "480P": { vertical: "480*864", horizontal: "864*480" },
      "768P": { vertical: "768*1376", horizontal: "1376*768" },
      "1088P": { vertical: "1088*1920", horizontal: "1920*1088" },
      "1440P": { vertical: "1440*2560", horizontal: "2560*1440" },
    };
    const size = dimensions[value] && dimensions[value][orientation];
    return size ? value.toLowerCase() + suffix + "(" + size + ")" : value.toLowerCase() + suffix;
  }
  return value.toLowerCase() + suffix;
}

function mediaURL(item) {
  if (typeof item === "string") return trimmed(item);
  if (!item || typeof item !== "object" || Array.isArray(item)) return "";
  if (item.__fileRef) {
    throw new Error("AutoDL ComfyUI requires public media URLs; direct multipart files are not supported");
  }
  return trimmed(item.url || item.image_url || item.audio_url || item.value);
}

function appendMedia(items, value, role, order) {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      appendMedia(items, value[index], role, order + index);
    }
    return;
  }
  const url = mediaURL(value);
  if (!url) return;
  const source = value && typeof value === "object" ? value : {};
  items.push({
    value: url,
    role: trimmed(source.role) || role || "reference_image",
    order: numberOrNull(source.order) == null ? order : numberOrNull(source.order),
  });
}

function normalizedMedia(request, kind) {
  const items = [];
  const metadata = request.metadata && typeof request.metadata === "object" ? request.metadata : {};
  const plural = kind === "image" ? "images" : "audios";
  const single = kind === "image" ? "image" : "audio";

  appendMedia(items, request[plural], "reference_image", 0);
  appendMedia(items, request[single], "reference_image", 100);
  appendMedia(items, request["input_reference"], "reference_image", 110);

  const roles = kind === "image"
    ? [["first_frame", "first_frame"], ["last_frame", "last_frame"]]
    : [["input_audio", "reference_audio"], ["audio_reference", "reference_audio"]];
  for (const pair of roles) {
    appendMedia(items, request[pair[0]], pair[1], pair[0] === "last_frame" ? 2 : 1);
  }

  const metadataKeys = kind === "image"
    ? ["first_frame_image", "last_frame_image", "reference_image", "image_url"]
    : ["reference_audio", "audio_url"];
  for (const key of metadataKeys) appendMedia(items, metadata[key], "reference_image", 200);

  const prefix = kind === "image" ? "ref_image_" : "ref_audio_";
  for (let index = 0; index < 9; index += 1) {
    const direct = request[prefix + index];
    if (direct == null) continue;
    appendMedia(items, direct, "slot", index);
  }

  items.sort((left, right) => left.order - right.order);
  return items;
}

function normalizedPrompt(request) {
  const metadata = request.metadata && typeof request.metadata === "object" ? request.metadata : {};
  return trimmed(request.prompt || request.input_text || metadata.prompt);
}

function normalizedDuration(request, model, config) {
  const metadata = request.metadata && typeof request.metadata === "object" ? request.metadata : {};
  let raw = request.duration;
  if (raw == null) raw = request.seconds;
  if (raw == null && model === "minimax_h3_image_audio_to_video") raw = request.audio_duration;
  if (raw == null) raw = metadata.duration;
  if (raw == null || raw === "") raw = 5;

  const duration = Number(raw);
  if (!Number.isInteger(duration) || duration < 1 || duration > config.maxDuration) {
    throw new Error("duration must be an integer between 1 and " + config.maxDuration + " seconds");
  }
  return duration;
}

function normalizedSeed(request) {
  const metadata = request.metadata && typeof request.metadata === "object" ? request.metadata : {};
  const raw = request.seed == null ? metadata.seed : request.seed;
  if (raw == null || raw === "") return null;
  const seed = Number(raw);
  if (!Number.isInteger(seed) || seed < 0) throw new Error("seed must be a non-negative integer");
  return seed;
}

function normalizedRequest(ctx) {
  if (!ctx.body || (ctx.body.kind !== "json" && ctx.body.kind !== "multipart")) {
    throw new Error("JSON body required");
  }
  if (ctx.body.kind === "multipart" && ctx.body.files && ctx.body.files.length) {
    throw new Error("AutoDL ComfyUI requires public media URLs; direct multipart files are not supported");
  }

  let request;
  if (ctx.body.kind === "json") {
    if (!ctx.body.value || typeof ctx.body.value !== "object" || Array.isArray(ctx.body.value)) {
      throw new Error("request body must be an object");
    }
    request = Object.assign({}, ctx.body.value);
  } else {
    request = {};
    const fields = ctx.body.fields || {};
    for (const name of Object.keys(fields)) {
      const values = fields[name] || [];
      if (values.length > 1) throw new Error(name + " must be provided once");
      request[name] = values[0];
    }
    if (request.metadata !== undefined) {
      try {
        request.metadata = JSON.parse(request.metadata);
      } catch (error) {
        throw new Error("metadata must be a JSON object string");
      }
    }
    if (request.duration !== undefined) request.duration = Number(request.duration);
    if (request.seconds !== undefined) request.seconds = Number(request.seconds);
  }

  const model = ctx.upstreamModel || ctx.model || trimmed(request.model);
  const config = WORKFLOWS[model];
  if (!config) throw new Error("unsupported AutoDL ComfyUI model: " + model);

  // Motion transfer and TTS carry their own request shape and deliberately
  // skip the MiniMax resolution-group and duration handling below.
  if (config.mode === "motion_retarget" || config.mode === "tts") {
    return normalizedSpecialRequest(request, model, config);
  }

  const prompt = normalizedPrompt(request);
  if (config.mode !== "image_audio_sync" && !prompt) throw new Error("prompt is required");

  const duration = normalizedDuration(request, model, config);
  const metadata = request.metadata && typeof request.metadata === "object" ? request.metadata : {};
  const requestedAspectRatio =
    request.aspect_ratio ||
    request.aspectRatio ||
    request.ratio ||
    metadata.aspect_ratio ||
    metadata.aspectRatio ||
    metadata.ratio;
  const requestedResolution =
    request.resolution ||
    request.resolution_name ||
    request.vquality ||
    metadata.resolution ||
    metadata.resolution_name ||
    metadata.vquality ||
    request.size;
  const resolution = normalizeResolutionGroup(requestedResolution, config.resolutionGroup, requestedAspectRatio);
  const billingResolution = resolution ? resolution.resolution : config.defaultResolution;
  const finalResolution = resolution || normalizeResolutionGroup(config.defaultResolution, config.resolutionGroup, requestedAspectRatio);
  const images = normalizedMedia(request, "image");
  const audios = normalizedMedia(request, "audio");

  if (config.mode === "text" && images.length) throw new Error("this model does not accept reference images");
  if (config.mode === "first_last" && images.length < 2) throw new Error("first and last frame image URLs are required");
  if (config.mode === "reference_images" && images.length < 1) throw new Error("at least one reference image URL is required");
  if (config.mode === "reference_images_optional_audio" && images.length < 1) throw new Error("at least one reference image URL is required");
  if (config.mode === "reference_images_audio" && audios.length < 1) throw new Error("at least one reference audio URL is required");
  if (config.mode === "reference_images_audio" && images.length < 1) throw new Error("at least one reference image URL is required");
  if (config.mode === "image_audio_sync" && (images.length < 1 || audios.length < 1)) {
    throw new Error("one image URL and one audio URL are required");
  }

  return {
    model: model,
    prompt: prompt,
    duration: duration,
    resolution: billingResolution,
    resolutionUpstream: upstreamResolution(model, config.resolutionGroup, finalResolution),
    images: images.slice(0, 9),
    audios: audios.slice(0, 3),
    seed: normalizedSeed(request),
  };
}

// Motion transfer and TTS keep their own request shape. Duration is what the
// upstream bills on, so motion transfer asks the caller for the reference
// video length and TTS estimates speech seconds from the text.
function normalizedSpecialRequest(request, model, config) {
  const metadata = request.metadata && typeof request.metadata === "object" ? request.metadata : {};

  if (config.mode === "motion_retarget") {
    const images = normalizedMedia(request, "image");
    const refImage = images.length ? images[0].value : trimmed(request.ref_image);
    const refVideo = trimmed(request.ref_video || request.video_url || request.video);
    if (!refImage) throw new Error("ref_image (character photo URL) is required");
    if (!refVideo) throw new Error("ref_video (motion reference video URL) is required");

    const rawDuration = request.duration == null ? request.seconds : request.duration;
    const duration = Number(rawDuration == null ? 0 : rawDuration);
    if (!Number.isInteger(duration) || duration < 1 || duration > config.maxDuration) {
      throw new Error("duration must be an integer between 1 and " + config.maxDuration + " seconds (pass the reference video length)");
    }

    const requested = trimmed(request.resolution || metadata.resolution);
    const resolution = requested === "832*464px(横版)" ? requested : config.defaultResolution;

    return {
      model: model,
      prompt: "",
      duration: duration,
      // The pixel preset is not part of the declared resolution enum, so it
      // travels under its own key and never reaches usage validation.
      resolutionName: resolution,
      refVideo: refVideo,
      images: [{ value: refImage, role: "reference_image" }],
      audios: [],
      seed: normalizedSeed(request),
    };
  }

  const voice =
    trimmed(request.prompt_simple) ||
    (normalizedMedia(request, "audio")[0] || {}).value ||
    "";
  const text = trimmed(request.prompt_text || request.text || request.prompt);
  if (!voice) throw new Error("prompt_simple (voice reference audio URL) is required");
  if (!text) throw new Error("prompt_text is required");

  // ~5 spoken characters per second; the upstream bills the produced audio
  // seconds, which the response does not report.
  const characters = Array.from(text).length;
  // Upstream bills a minimum of 10 audio units per request, so the floor
  // starts there and the relay never charges below its own cost.
  const duration = Math.max(
    10,
    Math.min(config.maxDuration, Math.ceil(characters / 5))
  );

  return {
    model: model,
    prompt: text,
    duration: duration,
    voiceAudio: voice,
    ttsText: text,
    emoControlMethod: trimmed(request.emo_control_method) || "与音色参考音频相同",
    emoRefAudio: trimmed(request.emo_ref_audio),
    emotions: request.emotions && typeof request.emotions === "object" ? request.emotions : {},
    images: [],
    audios: [{ value: voice, role: "reference_audio" }],
    seed: null,
  };
}

function isReferenceSlots(items) {
  return items.some((item) => item.role === "slot");
}

function assignReferenceSlots(body, prefix, items, maximum) {
  for (let index = 0; index < Math.min(items.length, maximum); index += 1) {
    body[prefix + index] = items[index].value;
  }
}

export function buildSubmitRequest(ctx) {
  const request = ctx.requestBody || {};
  const model = ctx.upstreamModel || ctx.model || request.model;
  const config = WORKFLOWS[model];
  if (!config) throw new Error("unsupported AutoDL ComfyUI model: " + model);

  const body = {};

  const upstreamURL =
    ctx.baseUrl.replace(/\/+$/, "") +
    "/api/v1/comfyui/comfyui_workflow/" +
    encodeURIComponent(model);
  const upstreamHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: ctx.apiKey,
  };

  if (config.mode === "motion_retarget") {
    const special = {
      ref_image: request.images[0].value,
      ref_video: request.refVideo,
      resolution: request.resolutionName,
    };
    if (request.seed != null) special.seed = request.seed;
    return { url: upstreamURL, method: "POST", headers: upstreamHeaders, body: special, action: model };
  }

  if (config.mode === "tts") {
    const special = {
      prompt_simple: request.voiceAudio,
      prompt_text: request.ttsText,
      emo_control_method: request.emoControlMethod,
    };
    if (request.emoRefAudio) special.emo_ref_audio = request.emoRefAudio;
    const emotions = request.emotions || {};
    for (const key of TTS_EMOTION_KEYS) {
      const value = emotions[key];
      if (value != null && value !== "") special[key] = Number(value);
    }
    if (emotions.emo_random === true || emotions.emo_random === "true") {
      special.emo_random = true;
    }
    return { url: upstreamURL, method: "POST", headers: upstreamHeaders, body: special, action: model };
  }
  if (model === "minimax_h3_image_audio_to_video") {
    body.audio_duration = request.duration;
  } else {
    body.prompt = request.prompt;
    body.duration = request.duration;
  }
  if (request.resolutionUpstream) body.resolution = request.resolutionUpstream;
  if (request.seed != null) body.seed = request.seed;

  const images = Array.isArray(request.images) ? request.images : [];
  const audios = Array.isArray(request.audios) ? request.audios : [];

  if (config.mode === "first_last") {
    const first = images.find((item) => item.role === "first_frame") || images[0];
    const last = images.find((item) => item.role === "last_frame") || images[1];
    body.first_frame = first.value;
    body.last_frame = last.value;
  } else if (config.mode === "image_audio_sync") {
    body.ref_image_0 = images[0].value;
    body.ref_audio_0 = audios[0].value;
  } else if (config.mode === "reference_images" || config.mode === "reference_images_audio" || config.mode === "reference_images_optional_audio" || config.mode === "optional_reference_media") {
    assignReferenceSlots(body, "ref_image_", images, 9);
  }

  if (config.mode === "reference_images_audio" || config.mode === "reference_images_optional_audio" || config.mode === "optional_reference_media") {
    assignReferenceSlots(body, "ref_audio_", audios, 3);
  }

  return {
    url: ctx.baseUrl.replace(/\/+$/, "") + "/api/v1/comfyui/comfyui_workflow/" + encodeURIComponent(model),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: ctx.apiKey,
    },
    body: body,
    action: model,
  };
}

export function parseSubmitResponse(ctx, response) {
  const body = response.body || {};
  if (trimmed(body.code) && trimmed(body.code).toLowerCase() !== "success") {
    throw new Error(trimmed(body.msg) || trimmed(body.message) || "AutoDL task submission failed");
  }
  const data = body.data || {};
  const taskId = trimmed(data.task_id || body.task_id);
  if (!taskId) throw new Error("AutoDL response is missing task_id");
  return { taskId: taskId, taskData: body };
}

export function buildQueryRequest(ctx) {
  return {
    url: ctx.baseUrl.replace(/\/+$/, "") + "/api/v1/comfyui/comfyui_workflow/result/" + encodeURIComponent(ctx.taskId),
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: ctx.apiKey,
    },
  };
}

function taskStatus(data) {
  const status = trimmed(data && data.status).toUpperCase();
  if (status === "QUEUED" || status === "PENDING" || status === "SUBMITTED") return "QUEUED";
  if (status === "RUNNING" || status === "PROCESSING" || status === "IN_PROGRESS") return "IN_PROGRESS";
  if (status === "SUCCESS" || status === "SUCCEEDED" || status === "COMPLETED") return "SUCCESS";
  if (status === "FAILED" || status === "FAILURE" || status === "CANCELLED" || status === "CANCELED") return "FAILURE";
  return "UNKNOWN";
}

function resultURL(data) {
  const results = data && data.results;
  if (!Array.isArray(results) || !results.length) return "";
  return trimmed(results[0] && results[0].url);
}

export function parseTaskResult(ctx, body) {
  const envelope = body || {};
  const data = envelope.data || envelope;
  const status = taskStatus(data);
  const result = {
    status: status,
    reason: status === "FAILURE" ? trimmed(data.message || data.msg || envelope.msg || "AutoDL task failed") : "",
  };
  const url = resultURL(data);
  if (url) result.url = url;
  return result;
}

function artifactData(task) {
  const data = (task && task.data) || {};
  if (data.data && typeof data.data === "object") return data.data;
  return data;
}

function artifactURL(task) {
  return resultURL(artifactData(task));
}

export function listArtifacts(task) {
  return task.status === "SUCCESS" && artifactURL(task) ? [{ key: "video", type: "video" }] : [];
}

export function buildContentRequest(ctx) {
  if (ctx.artifactKey !== "video") throw new Error("artifact_not_found");
  const url = artifactURL(ctx);
  if (!url) throw new Error("artifact_not_found");
  return { url: url, method: ctx.clientRequest.method, credentialless: true };
}

export function extractUsage(ctx) {
  if (ctx.usagePurpose === "billing_ratios") return null;
  const request = ctx.requestBody || {};
  const duration = Number(request.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("usage duration is unavailable");
  const usage = { duration: duration };
  // Motion transfer reports a pixel preset and TTS reports "audio"; neither is
  // part of the declared enum, and an undeclared fact is rejected by the host.
  const resolution = trimmed(request.resolution);
  if (RESOLUTION_ENUM.includes(resolution)) usage.resolution = resolution;
  return usage;
}

export const protocols = {
  openai_video: {
    decodeRequest: function (ctx) {
      const request = normalizedRequest(ctx);
      return {
        kind: "submit",
        model: ctx.model,
        action: request.model,
        requestBody: request,
      };
    },
    render: function (_ctx, task) {
      const statusMap = {
        NOT_START: "queued",
        SUBMITTED: "queued",
        QUEUED: "queued",
        IN_PROGRESS: "in_progress",
        SUCCESS: "completed",
        FAILURE: "failed",
      };
      const output = {
        id: task.task_id,
        object: "video",
        model: "",
        status: statusMap[task.status] || "unknown",
        progress: Number(String(task.progress || "0").replace("%", "")),
        created_at: task.created_at,
      };
      if (task.updated_at) output.completed_at = task.updated_at;
      if (task.status === "FAILURE" && task.fail_reason) {
        output.error = { code: "task_failed", message: task.fail_reason };
      }
      return output;
    },
  },
};


const DEFAULT_TTS_REFERENCE_AUDIO =
  "https://zh.heihan.dpdns.org/tts-assets/voice_01.wav";

function nativeAudioTaskStatus(task) {
  const statusMap = {
    NOT_START: "queued",
    SUBMITTED: "queued",
    QUEUED: "queued",
    IN_PROGRESS: "in_progress",
    SUCCESS: "completed",
    FAILURE: "failed",
  };
  const output = {
    id: task.task_id,
    task_id: task.task_id,
    status: statusMap[task.status] || "unknown",
    format: "wav",
  };
  const url = artifactURL(task);
  if (url) output.audio_url = url;
  if (task.status === "FAILURE" && task.fail_reason) {
    output.error = { code: "task_failed", message: task.fail_reason };
  }
  return output;
}

export const native = {
  createAudioTask(ctx) {
    if (!ctx.body || ctx.body.kind !== "json" || !ctx.body.value || typeof ctx.body.value !== "object" || Array.isArray(ctx.body.value)) {
      throw new Error("JSON request body is required");
    }
    const input = ctx.body.value;
    if (input.model !== "indextts2-v1") throw new Error("model must be indextts2-v1");
    if (typeof input.input !== "string" || !input.input.trim() || Array.from(input.input).length > 2048) {
      throw new Error("input must contain 1 to 2048 characters");
    }
    if (input.voice != null && typeof input.voice !== "string") throw new Error("voice must be a string");
    const requestedFormat = trimmed(input.response_format).toLowerCase();
    if (requestedFormat && requestedFormat !== "wav") {
      throw new Error("this IndexTTS2 workflow returns WAV audio only; response_format must be wav");
    }
    const speed = input.speed == null ? 1 : Number(input.speed);
    if (!Number.isFinite(speed) || speed !== 1) throw new Error("this IndexTTS2 workflow supports speed 1 only");
    const explicitReferenceAudio = trimmed(input.reference_audio) || trimmed(input.prompt_simple);
    const voice = trimmed(input.voice).toLowerCase();
    if (voice && voice !== "alloy" && voice !== "sample" && !explicitReferenceAudio) {
      throw new Error("this IndexTTS2 workflow has one sample voice; provide reference_audio to use another voice");
    }
    const voiceAudio =
      explicitReferenceAudio ||
      DEFAULT_TTS_REFERENCE_AUDIO;
    const normalized = normalizedRequest({
      model: "indextts2-v1",
      upstreamModel: "indextts2-v1",
      body: {
        kind: "json",
        value: {
          model: "indextts2-v1",
          prompt_simple: voiceAudio,
          prompt_text: input.input,
          emo_control_method: input.emo_control_method,
          emo_ref_audio: input.emo_ref_audio,
          emotions: input.emotions,
        },
      },
    });
    return {
      kind: "submit",
      model: "indextts2-v1",
      action: "tts",
      requestBody: normalized,
    };
  },
  renderAudioTaskCreated(_ctx, task) {
    return nativeAudioTaskStatus(task);
  },
  renderAudioTaskStatus(_ctx, task) {
    return nativeAudioTaskStatus(task);
  },
};

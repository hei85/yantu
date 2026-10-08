export type ModelProtocol = string;
export type ProtocolCapability = "text" | "image" | "video" | "audio";
export type ModelProtocolWorkflow = { id: string; label: string; providerId: string; capability: ProtocolCapability; parameters: Array<{ name: string; type: string; required?: boolean; description?: string; values?: string[]; mapping?: string }>; defaults?: Record<string, string | number | boolean> };
export type ModelProtocolDefinition = { value: ModelProtocol; label: string; vendor?: string; capability: ProtocolCapability; create: string; contentType: string; poll?: string; media: string; enabled?: boolean; baseUrl?: string; workflows?: ModelProtocolWorkflow[] };

export function protocolGroups(protocols: ModelProtocolDefinition[]) {
    return (["text", "image", "video", "audio"] as ProtocolCapability[]).map((capability) => ({ label: { text: "文本", image: "图片", video: "视频", audio: "音频" }[capability], options: protocols.filter((item) => item.capability === capability && item.enabled !== false).map((item) => ({ label: `${item.label} · ${item.create.replace(/^POST /, "")}`, value: item.value })) }));
}
export function modelProtocolDefinition(value: string | undefined, definitions: ModelProtocolDefinition[] = []) { return definitions.find((item) => item.value === value); }
export function modelProtocolLabel(value: string | undefined, definitions: ModelProtocolDefinition[] = []) { return modelProtocolDefinition(value, definitions)?.label || (value ? value : "未安装协议"); }
export function modelProtocolCapability(value: string | undefined, definitions: ModelProtocolDefinition[] = []) { return modelProtocolDefinition(value, definitions)?.capability; }
export function isVolcengineArkImageProtocol(protocol?: string) {
    return protocol === "volcengine-ark-image" || protocol === "volcengine-ark-agent-plan-image";
}

export function isVolcengineArkVideoProtocol(protocol?: string) {
    return protocol === "volcengine-ark-video" || protocol === "volcengine-ark-agent-plan-video";
}


export function protocolForModelCatalog(endpointTypes: string[] = []): ModelProtocol | undefined {
    // Axon advertises its video endpoint explicitly in /v1/models. This is
    // different from the similarly named /v1/video/generations endpoint.
    const capability = catalogEndpointCapability(endpointTypes);
    return capability ? protocolForCatalogCapability(capability, endpointTypes) : undefined;
}

export function normalizeCatalogEndpoint(value: string) {
    const endpoint = value.trim().toLowerCase().replace(/^post\s+/, "").replace(/^\/?v1\//, "").replace(/^\//, "").replace(/\/$/, "");
    return ({ "chat/completions": "openai", "chat-completion": "openai", "openai-chat": "openai", responses: "openai-response", "openai-responses": "openai-response", "images/generations": "image-generation", "images/edits": "image-edit", "audio/speech": "audio-speech", videos: "openai-video" } as Record<string, string>)[endpoint] || endpoint;
}

export function catalogEndpointCapability(endpointTypes: string[] = [], modelKey = ""): ProtocolCapability | undefined {
    const endpoints = new Set(endpointTypes.map(normalizeCatalogEndpoint));
    if (endpoints.has("openai-video")) return /tts/i.test(modelKey) && !/video/i.test(modelKey) ? "audio" : "video";
    if (endpoints.has("image-generation") || endpoints.has("image-edit")) return "image";
    if (endpoints.has("audio-speech") || endpoints.has("openai-audio")) return "audio";
    if (endpoints.has("openai") || endpoints.has("openai-response")) return "text";
    return undefined;
}

export function inferCatalogModelCapability(modelKey: string): ProtocolCapability {
    const key = modelKey.trim().toLowerCase();
    if (/(video|h3|veo|kling|seedance|wan2|wan-|wan_|sora|runway|pika|i2v|t2v|mochi|ltx|cogvideo|hunyuan)/.test(key)) return "video";
    if (/(tts|voice|speech|audio|music|sfx|sound)/.test(key)) return "audio";
    if (/(image|img|flux|sdxl|sd3|dall|kolors|midjourney|nano-banana|banana|seedream|recraft)/.test(key)) return "image";
    return "text";
}

/** Match a model to the request route advertised by its upstream catalog. */
export function protocolForCatalogCapability(capability: ProtocolCapability, endpointTypes: string[] = [], modelKey = "", apiFormat = ""): ModelProtocol | undefined {
    const endpoints = new Set(endpointTypes.map(normalizeCatalogEndpoint));
    if (capability === "text" && /(embedding|embed-|rerank|whisper|transcrib|realtime)/i.test(modelKey)) return undefined;
    if (capability === "video" && endpoints.has("openai-video")) return "newapi";
    if (capability === "image" && (endpoints.has("image-generation") || endpoints.has("image-edit"))) return "openai-image";
    if (capability === "text" && endpoints.has("openai")) return "chat-completion";
    if (capability === "text" && endpoints.has("openai-response")) return "openai-response";
    if (capability === "audio" && (endpoints.has("audio-speech") || endpoints.has("openai-audio"))) return "openai-audio";
    const known = knownModelCatalogDefaults(modelKey);
    const generic = [...endpoints].every((type) => ["openai", "generate", "edit"].includes(type));
    if (known?.capability === capability && generic) return known.protocol;
    // An OpenAI-compatible channel already defines the standard request format.
    // Private video/TTS interfaces and non-generation models need their own route.
    if (apiFormat.trim().toLowerCase() === "openai" && generic && !/(embedding|embed-|rerank|whisper|transcrib|realtime)/i.test(modelKey)) {
        if (capability === "text") return "chat-completion";
        if (capability === "image") return "openai-image";
    }
    return undefined;
}

/** Standard model lists may contain only IDs, without request endpoint metadata. */
export function knownModelCatalogDefaults(modelKey: string): { capability: ProtocolCapability; protocol: ModelProtocol } | undefined {
    const name = modelKey.trim().toLowerCase().split(/[/:]/).at(-1) || "";
    if (name === "gpt-image" || name.startsWith("gpt-image-") || name === "dall-e" || name.startsWith("dall-e-")) {
        return { capability: "image", protocol: "openai-image" };
    }
    if (name === "tts-1" || name === "tts-1-hd" || /^gpt-4o-mini-tts(?:-|$)/.test(name)) return { capability: "audio", protocol: "openai-audio" };
    return undefined;
}

export function isHeihanAxonH3Video(baseUrl: string, model: string): boolean {
    const name = model.trim().toLowerCase();
    const canonical = name.replace(/[ _]/g, "-");
    const knownAlias = ["minimax-h3", "minimax-h3-1", "minimax-h3-max", "minimax-h3-max-1"].includes(canonical);
    if (!/^minimax_h3_/i.test(name) && !knownAlias) return false;
    try {
        const url = new URL(baseUrl);
        const hostname = url.hostname.toLowerCase();
        const pathname = url.pathname.replace(/\/+$/, "").toLowerCase();
        return (hostname === "zh.heihan.dpdns.org" || hostname === "198.44.84.56")
            && (pathname === "" || pathname === "/v1");
    } catch {
        return false;
    }
}

export function isHeihanAxonGptImage(baseUrl: string, model: string): boolean {
    if (model.trim().toLowerCase() !== "gpt-image-2") return false;
    try {
        const url = new URL(baseUrl);
        const hostname = url.hostname.toLowerCase();
        const pathname = url.pathname.replace(/\/+$/, "").toLowerCase();
        return (hostname === "zh.heihan.dpdns.org" || hostname === "198.44.84.56")
            && (pathname === "" || pathname === "/v1");
    } catch {
        return false;
    }
}
export function modelProtocolSummary(value: string | undefined, definitions: ModelProtocolDefinition[] = []) { const protocol = modelProtocolDefinition(value, definitions); return protocol ? [protocol.create, protocol.contentType, protocol.poll, protocol.media].filter(Boolean).join(" · ") : "当前协议未安装或尚未选择。"; }
export function normalizeModelProtocol(value: unknown): ModelProtocol | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }

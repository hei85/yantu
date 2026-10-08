import { describe, expect, it } from "bun:test";
import { buildPortableLocalChannelSyncPlan } from "../src/services/api/portable-channel-sync";
import { defaultConfig, encodeChannelModel, type AiConfig } from "../src/stores/use-config-store";

describe("portable local channel sync plan", () => {
    it("maps a local channel and its model details with a stable ownership marker", () => {
        const config: AiConfig = {
            ...defaultConfig,
            channels: [{
                id: "local relay/1",
                name: "Local Relay",
                baseUrl: "https://relay.example/v1",
                apiKey: "do-not-print-this",
                secretKey: "secret-value",
                headers: [{ name: "X-Relay", value: "configured" }],
                apiFormat: "openai",
                interfaceType: "chat-completion",
                models: ["vision-model"],
                scope: "user",
                enabled: true,
                modelCosts: [{
                    model: "vision-model",
                    displayName: "Vision",
                    capability: "image",
                    protocol: "openai-image",
                    capabilityConfig: { version: 1, capability: "image" },
                }],
            }],
        };

        const first = buildPortableLocalChannelSyncPlan(config);
        const again = buildPortableLocalChannelSyncPlan(config);
        expect(first).toEqual(again);
        expect(first.skipped).toEqual([]);
        expect(first.channels[0].markerName).toBe("Local Relay [portable-local:local%20relay%2F1]");
        expect(first.channels[0].models[0]).toMatchObject({
            modelKey: "vision-model",
            providerModelKey: "vision-model",
            capability: "image",
            protocol: "openai-image",
        });
        expect(first.channels[0].models[0].description).toBe("");
    });

    it("skips system channels, missing keys, and local channels without configured models", () => {
        const config: AiConfig = {
            ...defaultConfig,
            channels: [
                { id: "system", name: "Managed", baseUrl: "/api", apiKey: "system", apiFormat: "openai", models: ["m"], scope: "system" },
                { id: "no-key", name: "No Key", baseUrl: "https://example.test", apiKey: " ", apiFormat: "openai", models: ["m"], scope: "user" },
                { id: "no-model", name: "No Model", baseUrl: "https://example.test", apiKey: "key", apiFormat: "openai", models: [], scope: "user" },
            ],
        };

        const plan = buildPortableLocalChannelSyncPlan(config);
        expect(plan.channels).toEqual([]);
        expect(plan.skipped).toEqual([
            { channelId: "no-key", reason: "缺少 API Key" },
            { channelId: "no-model", reason: "没有具备能力配置的模型" },
        ]);
        expect(JSON.stringify(plan)).not.toContain("secret-value");
    });

    it("repairs an explicitly selected legacy text model without guessing media protocols", () => {
        const local = { id: "legacy", name: "Legacy", baseUrl: "https://relay.example/v1", apiKey: "private-key", apiFormat: "openai" as const, models: ["go-deepseek-v4.1-flash", "unclassified-image"], scope: "user" as const };
        const config: AiConfig = {
            ...defaultConfig,
            channels: [local],
            textModels: [encodeChannelModel(local.id, "go-deepseek-v4.1-flash")],
        };
        const plan = buildPortableLocalChannelSyncPlan(config);
        expect(plan.channels).toHaveLength(1);
        expect(plan.channels[0].models).toHaveLength(1);
        expect(plan.channels[0].models[0]).toMatchObject({
            modelKey: "go-deepseek-v4.1-flash",
            capability: "text",
            protocol: "chat-completion",
        });
        expect(plan.channels[0].models[0].capabilityConfig?.text).toBeDefined();
    });
});

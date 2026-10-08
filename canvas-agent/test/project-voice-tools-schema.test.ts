import { describe, expect, test } from "bun:test";

import { toolDescriptions, toolInputSchemas, toolNames } from "../src/schemas.js";

describe("project voice MCP tools schema", () => {
    test("publishes list and bind tools with REST-shaped inputs", () => {
        expect(toolNames).toContain("project_list_voices");
        expect(toolNames).toContain("project_bind_character_voice");
        expect(toolDescriptions.project_list_voices).toContain("VoiceProfile");

        expect(toolInputSchemas.project_list_voices.safeParse({ projectId: "project-1" }).success).toBe(true);
        expect(toolInputSchemas.project_list_voices.safeParse({ projectId: "project-1", voiceId: "invented" }).success).toBe(false);
        expect(toolInputSchemas.project_bind_character_voice.safeParse({
            projectId: "project-1",
            assetId: "character-1",
            voiceProfileId: "profile-1",
            voiceStrategy: "standard_tts",
            voiceModel: "CHANNEL_000003::indextts2-v1",
            capabilityRevision: "2",
            speakingRate: 1,
        }).success).toBe(true);
        expect(toolInputSchemas.project_bind_character_voice.safeParse({
            projectId: "project-1",
            assetId: "character-1",
            voiceStrategy: "other",
        }).success).toBe(false);
        expect(toolInputSchemas.project_bind_character_voice.safeParse({
            projectId: "project-1",
            assetId: "character-1",
            voiceId: "",
            voiceReference: "configured",
        }).success).toBe(false);
    });
});

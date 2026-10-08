import { describe, expect, spyOn, test } from "bun:test";

import * as projectsApi from "@/services/api/projects";
import { isProjectAgentReadTool, isProjectAgentToolName, runProjectAgentTool } from "@/services/api/project-agent-tools";

describe("project character voice MCP tools", () => {
    test("lists VoiceProfiles through the existing authenticated API", async () => {
        const response = { profiles: [{ id: "profile-1", name: "voice", provider: "builtin", voiceKey: "nova", language: "zh", timbre: "", compatibleModels: [], status: "active" }] };
        const list = spyOn(projectsApi, "listVoiceProfiles").mockResolvedValue(response);

        await expect(runProjectAgentTool("project_list_voices", { projectId: "project-1" })).resolves.toEqual(response);
        expect(list).toHaveBeenCalledTimes(1);
        expect(isProjectAgentReadTool("project_list_voices")).toBe(true);
        expect(isProjectAgentToolName("project_list_voices")).toBe(true);
    });

    test("passes only the real REST binding fields and preserves backend capability failures", async () => {
        const input = {
            projectId: "project-1",
            assetId: "character-1",
            voiceProfileId: "profile-1",
            voiceStrategy: "standard_tts" as const,
            voiceModel: "CHANNEL_000003::indextts2-v1",
            capabilityRevision: "2",
            speakingRate: 1,
            instructions: "保持角色声线稳定",
        };
        const bind = spyOn(projectsApi, "bindProjectCharacterVoice").mockRejectedValueOnce(new Error("当前音频模型能力目录未配置当前声音策略"));

        await expect(runProjectAgentTool("project_bind_character_voice", input)).rejects.toThrow("当前音频模型能力目录未配置当前声音策略");
        expect(bind).toHaveBeenCalledWith("project-1", "character-1", {
            voiceProfileId: "profile-1",
            voiceStrategy: "standard_tts",
            voiceModel: "CHANNEL_000003::indextts2-v1",
            capabilityRevision: "2",
            speakingRate: 1,
            instructions: "保持角色声线稳定",
        });
        expect(isProjectAgentReadTool("project_bind_character_voice")).toBe(false);
        expect(isProjectAgentToolName("project_bind_character_voice")).toBe(true);
    });

    test("preserves the backend unsupported-reference error without inventing a voice id", async () => {
        const bind = spyOn(projectsApi, "bindProjectCharacterVoice").mockRejectedValue(new Error("当前音频模型缺少所需的 voice ID / 参考音频上游字段映射"));
        await expect(runProjectAgentTool("project_bind_character_voice", {
            projectId: "project-1",
            assetId: "character-1",
            voiceStrategy: "voice_reference",
            sampleResourceId: "resource-voice-1",
            voiceModel: "CHANNEL_000003::indextts2-v1",
            referenceAudioAuthorized: true,
        })).rejects.toThrow("当前音频模型缺少所需的 voice ID / 参考音频上游字段映射");
        expect(bind).toHaveBeenCalledWith("project-1", "character-1", {
            voiceStrategy: "voice_reference",
            sampleResourceId: "resource-voice-1",
            voiceModel: "CHANNEL_000003::indextts2-v1",
            referenceAudioAuthorized: true,
        });
    });

    test("surfaces the existing authenticated REST permission failure", async () => {
        spyOn(projectsApi, "listVoiceProfiles").mockRejectedValue(new Error("HTTP 401: session_required"));
        await expect(runProjectAgentTool("project_list_voices", { projectId: "project-1" })).rejects.toThrow("HTTP 401: session_required");
    });
});

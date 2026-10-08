import { describe, expect, spyOn, test } from "bun:test";

import * as skillsApi from "@/services/api/skills";
import type { Skill } from "@/services/api/skills";
import { getPreparedFilmSkillEvidence, runAgentRuntimeTool } from "@/services/api/agent-runtime-tools";
import { buildPlanFromSpec } from "@/services/api/film-agent-tools";

const fixtureSkill = {
    skillId: "production-skill-test",
    skillName: "Production skill test",
    description: "video storyboard production",
    versionId: "version-1",
    version: "1.0.0",
    contentHash: "skill-hash-1",
    sourceType: "builtin",
    updatedAt: "2026-09-23T00:00:00Z",
    isAdded: true,
} as Skill;

function packageFile(path: string, sha256 = `sha-${path}`) {
    return { path, kind: "markdown", mimeType: "text/markdown", size: 10, sha256 };
}

function fileContent(path: string, content: string) {
    return { file: { file: packageFile(path), content, binary: false } };
}

describe("agent runtime skill preparation", () => {
    test("reads nested references and reports tool dependencies against the live inventory", async () => {
        const entry = "---\nphase: planning\nstage: consistency\n---\nUse `docs/guide.md` and call film_list_models.";
        const guide = "Planning guide references `docs/nested.md` before building the storyboard.";
        const nested = "Keep each video segment bound to its source row.";
        const addedSkills = spyOn(skillsApi, "listAddedSkills").mockResolvedValue({ skills: [fixtureSkill] } as Awaited<ReturnType<typeof skillsApi.listAddedSkills>>);
        const listFiles = spyOn(skillsApi, "listSkillFiles").mockResolvedValue({
            files: [packageFile("SKILL.md"), packageFile("docs/guide.md"), packageFile("docs/nested.md")],
        });
        const getFile = spyOn(skillsApi, "getSkillFile").mockImplementation(async (_id, path) => {
            if (path === "SKILL.md") return fileContent(path, entry);
            if (path === "docs/guide.md") return fileContent(path, guide);
            if (path === "docs/nested.md") return fileContent(path, nested);
            throw new Error(`unexpected path: ${path}`);
        });

        try {
            const ready = await runAgentRuntimeTool("skill_prepare", {
                prompt: "video storyboard production",
                selectedSkillIds: [fixtureSkill.skillId],
                availableToolNames: ["film_list_models", "canvas_get_storyboard"],
            });
            expect(ready.readyForUse).toBe(true);
            expect(ready.selected[0].requiredReads).toEqual(["docs/guide.md", "docs/nested.md"]);
            expect(ready.selected[0].files.map((file: { path: string }) => file.path)).toEqual(["docs/guide.md", "docs/nested.md"]);
            expect(ready.selected[0].toolMappings).toContainEqual({ name: "film_list_models", available: true });
            expect(getPreparedFilmSkillEvidence()).toEqual([{
                skillId: fixtureSkill.skillId,
                versionId: fixtureSkill.versionId,
                contentHash: fixtureSkill.contentHash,
                phase: "planning",
            }]);
            const plan = buildPlanFromSpec({
                productionSpec: {
                    version: 1,
                    targetDurationMs: 5000,
                    targetAspectRatio: "16:9",
                    audioPolicy: "none",
                    videoModels: [{ value: "video-test", supports: {
                        capabilityRevision: "video-test:1", operations: ["text_to_video"],
                        duration: { mode: "enum", values: [5], default: 5 }, ratios: ["16:9"], resolutions: ["1080p"],
                        maxReferenceImages: 0, maxReferenceVideos: 0, maxReferenceAudios: 0, generateAudio: false,
                    } }],
                    storyboardRows: [{ rowId: "row-1", durationMs: 5000, videoOperation: "text_to_video", segments: [
                        { segmentId: "seg-1", order: 0, durationSeconds: 5, estimatedCostMicros: 100 },
                    ] }],
                },
            }, {});
            expect((plan.plan.executionManifest as { skillEvidence: unknown[] }).skillEvidence).toEqual([{
                skillId: fixtureSkill.skillId,
                versionId: fixtureSkill.versionId,
                contentHash: fixtureSkill.contentHash,
                phase: "planning",
            }]);
            expect(() => buildPlanFromSpec({
                productionSpec: {
                    version: 1, targetDurationMs: 5000, targetAspectRatio: "16:9", audioPolicy: "none",
                    skillEvidence: [{ skillId: "spoofed", versionId: "v0", contentHash: "fake", phase: "planning" }],
                    videoModels: [], storyboardRows: [],
                },
            }, {})).toThrow("必须来自当前用户刚完成的 skill_prepare");

            const missingTool = await runAgentRuntimeTool("skill_prepare", {
                prompt: "video storyboard production",
                selectedSkillIds: [fixtureSkill.skillId],
                availableToolNames: ["canvas_get_storyboard"],
            });
            expect(missingTool.readyForUse).toBe(false);
            expect(missingTool.toolDependencyHealth.missingToolNames).toContain("film_list_models");
            expect(getPreparedFilmSkillEvidence()).toEqual([], "failed preparation must invalidate prior evidence for that phase");

            const unknownInventory = await runAgentRuntimeTool("skill_prepare", {
                prompt: "video storyboard production",
                selectedSkillIds: [fixtureSkill.skillId],
            });
            expect(unknownInventory.readyForUse).toBe(false);
            expect(unknownInventory.selected[0].toolMappings).toContainEqual({ name: "film_list_models", available: null });

            const unavailable = await runAgentRuntimeTool("skill_prepare", {
                prompt: "video storyboard production",
                selectedSkillIds: ["not-enabled"],
                availableToolNames: ["film_list_models"],
            });
            expect(unavailable.readyForUse).toBe(false);
            expect(unavailable.missingExplicit).toEqual(["not-enabled"]);

            const overLimitIds = ["skill-a", "skill-b", "skill-c", "skill-d", "skill-e"];
            const overLimit = await runAgentRuntimeTool("skill_prepare", {
                prompt: "video storyboard production",
                selectedSkillIds: overLimitIds,
                availableToolNames: ["film_list_models"],
            });
            expect(overLimit.readyForUse).toBe(false);
            expect(overLimit.code).toBe("skill_phase_limit_exceeded");
            expect(overLimit.requestedSkillIds).toEqual(overLimitIds);
            expect(addedSkills).toHaveBeenCalled();
            expect(listFiles).toHaveBeenCalled();
            expect(getFile).toHaveBeenCalled();

            const catalog = await runAgentRuntimeTool("skill_catalog", { phase: "continuity" }) as { skills: Array<{ skillId: string }> };
            expect(catalog.skills.map((skill) => skill.skillId)).toContain(fixtureSkill.skillId);
            const searched = await runAgentRuntimeTool("skill_search", { query: "production skill test", phase: "continuity" }) as { results: Array<{ skillId: string }> };
            expect(searched.results[0]?.skillId).toBe(fixtureSkill.skillId);
            const continuityPrepared = await runAgentRuntimeTool("skill_prepare", {
                prompt: "character continuity for storyboard production",
                phase: "continuity",
                selectedSkillIds: [fixtureSkill.skillId],
                availableToolNames: ["film_list_models"],
            });
            expect(continuityPrepared.readyForUse).toBe(true);
            expect(getPreparedFilmSkillEvidence()).toContainEqual({
                skillId: fixtureSkill.skillId,
                versionId: fixtureSkill.versionId,
                contentHash: fixtureSkill.contentHash,
                phase: "continuity",
            });
        } finally {
            addedSkills.mockRestore();
            listFiles.mockRestore();
            getFile.mockRestore();
        }
    });

    test("fails closed when a required linked file exceeds the read budget", async () => {
        const entry = "---\nphase: planning\n---\nRead `docs/long.md` before video generation.";
        const addedSkills = spyOn(skillsApi, "listAddedSkills").mockResolvedValue({ skills: [fixtureSkill] } as Awaited<ReturnType<typeof skillsApi.listAddedSkills>>);
        const listFiles = spyOn(skillsApi, "listSkillFiles").mockResolvedValue({ files: [packageFile("SKILL.md"), packageFile("docs/long.md")] });
        const getFile = spyOn(skillsApi, "getSkillFile").mockImplementation(async (_id, path) => fileContent(path, path === "SKILL.md" ? entry : "x".repeat(1500)));

        try {
            const result = await runAgentRuntimeTool("skill_prepare", {
                prompt: "video production",
                selectedSkillIds: [fixtureSkill.skillId],
                maxCharsPerSkill: 1024,
                availableToolNames: [],
            });
            expect(result.readyForUse).toBe(false);
            expect(result.selected[0].unreadRequiredFiles).toEqual(["docs/long.md"]);
            expect(result.failureReasons.join("\n")).toContain("docs/long.md 尚未完整读取");
        } finally {
            addedSkills.mockRestore();
            listFiles.mockRestore();
            getFile.mockRestore();
        }
    });
});

import { describe, expect, test } from "bun:test";

import { projectGenerationTaskResult } from "@/services/project-asset-sync";

describe("projectGenerationTaskResult", () => {
    test("retains resource identity for a recovered video with no data URL", () => {
        const projected = projectGenerationTaskResult({
            id: "task-recovered",
            type: "canvas_video",
            status: "succeeded",
            prompt: "sample",
            attempts: 1,
            createdAt: "2026-09-24T00:00:00.000Z",
            resultJson: JSON.stringify({
                mode: "video",
                video: { resourceId: "resource-recovered", mimeType: "video/mp4" },
            }),
        });

        expect(projected.outputs).toEqual([
            {
                outputIndex: 0,
                mediaType: "video",
                providerArtifactRef: "resource:resource-recovered",
            },
        ]);
        expect(projected.resultState).toBe("PENDING_MATERIALIZATION");
    });
});

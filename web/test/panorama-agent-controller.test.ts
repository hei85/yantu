import { afterEach, describe, expect, test } from "bun:test";

import {
    clampPanoramaAgentView,
    getPanoramaAgentController,
    registerPanoramaAgentController,
    type PanoramaAgentController,
} from "../src/lib/canvas/panorama-agent-controller";

const ids: string[] = [];
afterEach(() => ids.splice(0).forEach((id) => registerPanoramaAgentController(id, null)));

describe("panorama agent controller registry", () => {
    test("registers and removes the node's actual viewer controller", () => {
        const controller: PanoramaAgentController = {
            availability: "interactive",
            getView: () => ({ lon: 90, lat: 10, fov: 65 }),
            setView: async () => ({ lon: 90, lat: 10, fov: 65 }),
            capturePng: async () => ({ dataUrl: "data:image/png;base64,AA==", width: 2, height: 2 }),
            captureQuadPng: async () => ({ dataUrl: "data:image/png;base64,BB==", width: 4, height: 4 }),
        };
        ids.push("pano-test");
        registerPanoramaAgentController("pano-test", controller);
        expect(getPanoramaAgentController("pano-test")).toBe(controller);
        registerPanoramaAgentController("pano-test", null);
        expect(getPanoramaAgentController("pano-test")).toBeNull();
    });

    test("stale cleanup cannot unregister a replacement viewer for the same node", () => {
        const oldController: PanoramaAgentController = {
            availability: "interactive",
            getView: () => null, setView: async () => ({ lon: 0, lat: 0, fov: 75 }),
            capturePng: async () => ({ dataUrl: "data:image/png;base64,AA==", width: 1, height: 1 }),
            captureQuadPng: async () => ({ dataUrl: "data:image/png;base64,AA==", width: 2, height: 2 }),
        };
        const newController: PanoramaAgentController = {
            ...oldController,
            capturePng: async () => ({ dataUrl: "data:image/png;base64,BB==", width: 3, height: 3 }),
        };
        ids.push("pano-replaced");
        registerPanoramaAgentController("pano-replaced", oldController);
        registerPanoramaAgentController("pano-replaced", newController);
        registerPanoramaAgentController("pano-replaced", null, oldController);
        expect(getPanoramaAgentController("pano-replaced")).toBe(newController);
    });

    test("clamps latitude and field of view to renderer limits", () => {
        expect(clampPanoramaAgentView({ lon: 360, lat: 120, fov: 150 })).toEqual({ lon: 360, lat: 85, fov: 110 });
        expect(clampPanoramaAgentView({ lon: -45, lat: -120, fov: 10 })).toEqual({ lon: -45, lat: -85, fov: 25 });
    });

    test("normalizes non-finite view values to safe defaults", () => {
        expect(clampPanoramaAgentView({ lon: Number.NaN, lat: Number.POSITIVE_INFINITY, fov: Number.NaN }))
            .toEqual({ lon: 0, lat: 0, fov: 75 });
    });
});

import { describe, expect, test } from "bun:test";
import { createDirectorSceneFromTemplate } from "../src/lib/canvas/director/director-templates";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { DirectorScene } from "../src/types/director";
import { createCanvasAgentDirectorOperations } from "../src/pages/canvas/canvas-agent-director-operations";

function harness() {
    let scenes: DirectorScene[] = [];
    const nodes: CanvasNodeData[] = [];
    const operations = createCanvasAgentDirectorOperations({
        nodesRef: { current: nodes },
        getScenes: () => scenes,
        createDirectorShot: (templateId, position) => {
            const scene = createDirectorSceneFromTemplate(templateId, "镜头 1");
            const shot = scene.shots[0];
            nodes.push({ id: "shot-node", type: CanvasNodeType.Video, title: shot.name, position: position || { x: 0, y: 0 }, width: 320, height: 200, metadata: { workflowKind: "shot", directorSceneId: scene.id, directorShotId: shot.id } });
            scenes = [...scenes, scene];
        },
        saveDirectorScene: (scene) => { scenes = scenes.map((item) => item.id === scene.id ? structuredClone(scene) : item); },
    });
    return { operations, nodes, getScenes: () => scenes };
}

describe("canvas Agent director operations", () => {
    test("reads scenes and creates a shot through the native template callback with readback", () => {
        const { operations, nodes } = harness();
        expect(operations.listScenes()).toEqual([]);
        const result = operations.createShot({ templateId: "dialogue", position: { x: 20, y: 30 } });
        expect(result.node.id).toBe("shot-node");
        expect(result.scene.objects).toHaveLength(2);
        expect(operations.readScene({ sceneId: result.scene.id })).toEqual({ scene: result.scene, sceneHash: result.sceneHash });
        expect(nodes[0].position).toEqual({ x: 20, y: 30 });
    });

    test("restricts parameter patches and persists changes that pass readback", () => {
        const { operations, getScenes } = harness();
        const created = operations.createShot({ templateId: "empty" });
        const scene = operations.updateSceneParameters({ sceneId: created.scene.id, expectedSceneHash: created.sceneHash, patch: { title: "测试场景", environmentIntensity: 1.25, background: "#123456" } });
        const sceneHash = operations.readScene({ sceneId: scene.id }).sceneHash;
        const shot = operations.updateShotParameters({ sceneId: scene.id, shotId: scene.shots[0].id, expectedSceneHash: sceneHash, patch: { duration: 12, cameraMove: "pan_left", prompt: "缓慢横移" } });
        expect(getScenes()[0]).toEqual(shot);
        expect(shot.title).toBe("测试场景");
        expect(shot.shots[0]).toMatchObject({ duration: 12, cameraMove: "pan_left", prompt: "缓慢横移" });
        const addedCamera = operations.addCamera({ sceneId: shot.id, expectedSceneHash: awaitHash(operations, shot.id), name: "侧机" });
        const reassigned = operations.updateShotParameters({ sceneId: addedCamera.id, shotId: shot.shots[0].id, expectedSceneHash: awaitHash(operations, addedCamera.id), patch: { cameraId: addedCamera.cameras[1].id } });
        expect(reassigned.shots[0].cameraId).toBe(addedCamera.cameras[1].id);
        expect(() => operations.updateShotParameters({ sceneId: reassigned.id, shotId: shot.shots[0].id, expectedSceneHash: awaitHash(operations, reassigned.id), patch: { cameraId: "camera-from-another-scene" } })).toThrow("摄影机不存在于当前场景");
        expect(() => operations.updateShotParameters({ sceneId: scene.id, shotId: scene.shots[0].id, expectedSceneHash: sceneHash, patch: { id: "overwrite" } as never })).toThrow("不支持字段");
        expect(() => operations.updateSceneParameters({ sceneId: scene.id, expectedSceneHash: sceneHash, patch: { objects: [] } as never })).toThrow("不支持字段");
        expect(() => operations.updateShotParameters({ sceneId: scene.id, shotId: scene.shots[0].id, expectedSceneHash: sceneHash, patch: { duration: 1000 } })).toThrow("时长");
        expect(() => operations.updateSceneParameters({ sceneId: scene.id, expectedSceneHash: created.sceneHash, patch: { title: "不应覆盖" } })).toThrow("已变化");
    });

    test("adds placed objects, updates safe fields, and manages object and camera transform keyframes with CAS", () => {
        const { operations } = harness();
        const created = operations.createShot({ templateId: "empty" });
        const added = operations.addObject({ sceneId: created.scene.id, expectedSceneHash: created.sceneHash, object: { kind: "primitive", primitive: "sphere", name: "球体", color: "#123456" } });
        const object = added.objects.at(-1)!;
        expect(object).toMatchObject({ kind: "primitive", primitive: "sphere", name: "球体", color: "#123456" });
        const updated = operations.updateObjectParameters({ sceneId: added.id, objectId: object.id, expectedSceneHash: (awaitHash(operations, added.id)), patch: { name: "蓝球", visible: false, transform: { position: [3, 1, 2], rotation: [0, 1, 0], scale: [2, 2, 2] } } });
        const keyed = operations.upsertObjectKeyframe({ sceneId: updated.id, objectId: object.id, expectedSceneHash: (awaitHash(operations, updated.id)), time: 2, transform: { position: [4, 1, 2], rotation: [0, 1, 0], scale: [2, 2, 2] } });
        const cameraKeyed = operations.upsertCameraKeyframe({ sceneId: keyed.id, cameraId: keyed.cameras[0].id, expectedSceneHash: (awaitHash(operations, keyed.id)), time: 2, transform: keyed.cameras[0].transform });
        const frameId = cameraKeyed.cameras[0].keyframes[0].id;
        const removed = operations.removeKeyframe({ sceneId: cameraKeyed.id, expectedSceneHash: (awaitHash(operations, cameraKeyed.id)), target: { track: "camera", cameraId: cameraKeyed.cameras[0].id, keyframeId: frameId } });
        expect(removed.objects.find((item) => item.id === object.id)?.keyframes).toHaveLength(1);
        expect(removed.cameras[0].keyframes).toHaveLength(0);
        expect(() => operations.addObject({ sceneId: removed.id, expectedSceneHash: created.sceneHash, object: { kind: "primitive" } })).toThrow("已变化");
        expect(() => operations.updateObjectParameters({ sceneId: removed.id, objectId: object.id, expectedSceneHash: awaitHash(operations, removed.id), patch: { url: "https://evil.invalid/model.glb" } as never })).toThrow("不支持字段");
    });

    test("manages cameras safely, retargeting shots when deleting a camera", () => {
        const { operations } = harness();
        const created = operations.createShot({ templateId: "empty" });
        const added = operations.addCamera({ sceneId: created.scene.id, expectedSceneHash: created.sceneHash, name: "侧机" });
        expect(added.cameras).toHaveLength(2);
        const edited = operations.updateCameraParameters({ sceneId: added.id, cameraId: added.cameras[1].id, expectedSceneHash: awaitHash(operations, added.id), patch: { name: "侧面摄影机", target: [1, 2, 3], focalLength: 50 } });
        expect(edited.cameras[1]).toMatchObject({ name: "侧面摄影机", target: [1, 2, 3], focalLength: 50 });
        const deleted = operations.deleteCamera({ sceneId: edited.id, cameraId: edited.cameras[0].id, expectedSceneHash: awaitHash(operations, edited.id) });
        expect(deleted.cameras).toHaveLength(1);
        expect(deleted.shots[0].cameraId).toBe(deleted.cameras[0].id);
        expect(() => operations.deleteCamera({ sceneId: deleted.id, cameraId: deleted.cameras[0].id, expectedSceneHash: awaitHash(operations, deleted.id) })).toThrow("至少须保留一台");
        expect(() => operations.updateCameraParameters({ sceneId: deleted.id, cameraId: deleted.cameras[0].id, expectedSceneHash: awaitHash(operations, deleted.id), patch: { transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [0, 0, 0] } } })).toThrow("缩放");
    });

    test("manages lights and actor bone keyframes with CAS", () => {
        const { operations } = harness();
        const created = operations.createShot({ templateId: "empty" });
        const actorAdded = operations.addObject({ sceneId: created.scene.id, expectedSceneHash: created.sceneHash, object: { kind: "actor" } });
        const lit = operations.addLight({ sceneId: actorAdded.id, expectedSceneHash: awaitHash(operations, actorAdded.id), light: { type: "spot", name: "补光", color: "#abcdef", intensity: 1.5, position: [1, 2, 3] } });
        const light = lit.lights.at(-1)!;
        expect(light).toMatchObject({ type: "spot", name: "补光", color: "#abcdef", intensity: 1.5 });
        const updated = operations.updateLightParameters({ sceneId: lit.id, lightId: light.id, expectedSceneHash: awaitHash(operations, lit.id), patch: { intensity: 2, castShadow: false } });
        expect(updated.lights.at(-1)).toMatchObject({ intensity: 2, castShadow: false });
        const actor = updated.objects.find((item) => item.kind === "actor")!;
        const keyed = operations.upsertObjectBoneKeyframe({ sceneId: updated.id, objectId: actor.id, expectedSceneHash: awaitHash(operations, updated.id), bone: "head", time: 1, rotation: [0, 0.1, 0, 1] });
        const frame = keyed.objects.find((item) => item.id === actor.id)!.boneTracks![0].keyframes[0];
        expect(frame.rotation[1]).toBeCloseTo(0.0995, 3);
        const removed = operations.removeObjectBoneKeyframe({ sceneId: keyed.id, objectId: actor.id, bone: "head", keyframeId: frame.id, expectedSceneHash: awaitHash(operations, keyed.id) });
        expect(removed.objects.find((item) => item.id === actor.id)!.boneTracks).toEqual([]);
        const noLight = operations.deleteLight({ sceneId: removed.id, lightId: light.id, expectedSceneHash: awaitHash(operations, removed.id) });
        expect(noLight.lights.some((item) => item.id === light.id)).toBe(false);
    });
});

function awaitHash(operations: ReturnType<typeof createCanvasAgentDirectorOperations>, sceneId: string) {
    return operations.readScene({ sceneId }).sceneHash;
}

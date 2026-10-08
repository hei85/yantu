import { DIRECTOR_TEMPLATES, type DirectorTemplateId } from "@/lib/canvas/director/director-templates";
import { createDirectorActor, createDirectorCamera, createDirectorLight, createDirectorObject, removeDirectorBoneKeyframe, removeDirectorKeyframe, touchDirectorScene, upsertDirectorBoneKeyframe, upsertDirectorKeyframe } from "@/lib/canvas/director/director-scene";
import { resolveDirectorPlacement } from "@/lib/canvas/director/director-placement";
import type { CanvasNodeData, Position } from "@/types/canvas";
import type { DirectorCamera, DirectorCameraMove, DirectorHumanoidBone, DirectorKeyframe, DirectorLight, DirectorPrimitiveKind, DirectorScene, DirectorShot, DirectorShotSize, DirectorTransform, DirectorVec3 } from "@/types/director";

export type CanvasAgentDirectorShotPatch = Partial<Pick<DirectorShot, "name" | "duration" | "fps" | "shotSize" | "cameraMove" | "prompt" | "cameraId">>;
export type CanvasAgentDirectorScenePatch = Partial<Pick<DirectorScene, "title" | "background" | "environmentIntensity" | "gridVisible">>;

type Options = {
    nodesRef: { current: CanvasNodeData[] };
    getScenes: () => DirectorScene[];
    createDirectorShot: (templateId: DirectorTemplateId, position?: Position) => void;
    saveDirectorScene: (scene: DirectorScene) => void;
};

const shotSizes = new Set<DirectorShotSize>(["extreme_wide", "wide", "full", "medium", "close_up", "extreme_close_up"]);
const cameraMoves = new Set<DirectorCameraMove>(["static", "push_in", "pull_out", "pan_left", "pan_right", "tilt_up", "tilt_down", "orbit_left", "orbit_right", "handheld"]);
const primitives = new Set<DirectorPrimitiveKind>(["box", "sphere", "cylinder", "plane", "character"]);
const clone = <T,>(value: T): T => structuredClone(value);

export type CanvasAgentDirectorTransform = DirectorTransform;
export type CanvasAgentDirectorObjectPatch = Partial<Pick<import("@/types/director").DirectorObject, "name" | "color" | "visible" | "transform">>;
export type CanvasAgentDirectorAddObjectInput = { kind: "primitive"; primitive?: Exclude<DirectorPrimitiveKind, "character">; name?: string; color?: string; position?: DirectorVec3 } | { kind: "actor"; name?: string; color?: string; position?: DirectorVec3 };
export type CanvasAgentDirectorCameraPatch = Partial<Pick<DirectorCamera, "name" | "transform" | "target" | "focalLength" | "fov" | "aperture" | "focusDistance" | "near" | "far">>;
export type CanvasAgentDirectorLightPatch = Partial<Pick<DirectorLight, "name" | "type" | "transform" | "color" | "intensity" | "angle" | "penumbra" | "castShadow">>;
export type CanvasAgentDirectorAddLightInput = { type: DirectorLight["type"]; name?: string; color?: string; intensity?: number; position?: DirectorVec3; castShadow?: boolean; angle?: number; penumbra?: number };
export type CanvasAgentDirectorBoneKeyframeTarget = { objectId: string; bone: DirectorHumanoidBone; time: number; rotation: [number, number, number, number] };

export function hashDirectorScene(scene: DirectorScene) {
    let hash = 2166136261;
    const content = JSON.stringify(scene);
    for (let index = 0; index < content.length; index += 1) hash = Math.imul(hash ^ content.charCodeAt(index), 16777619);
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function validatePatch<T extends object>(patch: unknown, allowed: readonly (keyof T)[], label: string): asserts patch is Partial<T> {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error(`${label}必须是对象`);
    const keys = Object.keys(patch);
    if (!keys.length) throw new Error(`${label}不能为空`);
    const invalid = keys.find((key) => !allowed.includes(key as keyof T));
    if (invalid) throw new Error(`${label}不支持字段：${invalid}`);
}

function validateShotPatch(patch: unknown): asserts patch is CanvasAgentDirectorShotPatch {
    validatePatch<CanvasAgentDirectorShotPatch>(patch, ["name", "duration", "fps", "shotSize", "cameraMove", "prompt", "cameraId"], "镜头参数");
    const value = patch as CanvasAgentDirectorShotPatch;
    if (value.cameraId !== undefined && (typeof value.cameraId !== "string" || !value.cameraId.trim())) throw new Error("摄影机 ID 必须是非空字符串");
    if (value.name !== undefined && (typeof value.name !== "string" || !value.name.trim() || value.name.length > 120)) throw new Error("镜头名称须为 1 到 120 个字符");
    if (value.duration !== undefined && (!Number.isFinite(value.duration) || value.duration < 0.25 || value.duration > 600)) throw new Error("镜头时长须在 0.25 到 600 秒之间");
    if (value.fps !== undefined && ![24, 25, 30].includes(value.fps)) throw new Error("fps 仅支持 24、25 或 30");
    if (value.shotSize !== undefined && !shotSizes.has(value.shotSize)) throw new Error("不支持的景别");
    if (value.cameraMove !== undefined && !cameraMoves.has(value.cameraMove)) throw new Error("不支持的运镜方式");
    if (value.prompt !== undefined && (typeof value.prompt !== "string" || value.prompt.length > 12000)) throw new Error("镜头提示词不能超过 12000 个字符");
}

function validateScenePatch(patch: unknown): asserts patch is CanvasAgentDirectorScenePatch {
    validatePatch<CanvasAgentDirectorScenePatch>(patch, ["title", "background", "environmentIntensity", "gridVisible"], "场景参数");
    const value = patch as CanvasAgentDirectorScenePatch;
    if (value.title !== undefined && (typeof value.title !== "string" || !value.title.trim() || value.title.length > 120)) throw new Error("场景名称须为 1 到 120 个字符");
    if (value.background !== undefined && (typeof value.background !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value.background))) throw new Error("背景色须为 #RRGGBB");
    if (value.environmentIntensity !== undefined && (!Number.isFinite(value.environmentIntensity) || value.environmentIntensity < 0 || value.environmentIntensity > 5)) throw new Error("环境光强度须在 0 到 5 之间");
    if (value.gridVisible !== undefined && typeof value.gridVisible !== "boolean") throw new Error("gridVisible 须为布尔值");
}

function validateVec3(value: unknown, label: string): asserts value is DirectorVec3 {
    if (!Array.isArray(value) || value.length !== 3 || !value.every((item) => typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= 100000)) throw new Error(`${label}须为有限的 ±100000 范围内三维数值`);
}

function validateTransform(value: unknown): asserts value is DirectorTransform {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "position,rotation,scale") throw new Error("transform 仅支持 position、rotation、scale 三个字段");
    const transform = value as DirectorTransform;
    validateVec3(transform.position, "position");
    validateVec3(transform.rotation, "rotation");
    validateVec3(transform.scale, "scale");
    if (transform.scale.some((item) => Math.abs(item) < 0.001 || Math.abs(item) > 1000)) throw new Error("缩放绝对值须在 0.001 到 1000 之间");
}

function validateObjectPatch(patch: unknown): asserts patch is CanvasAgentDirectorObjectPatch {
    validatePatch<CanvasAgentDirectorObjectPatch>(patch, ["name", "color", "visible", "transform"], "对象参数");
    const value = patch as CanvasAgentDirectorObjectPatch;
    if (value.name !== undefined && (typeof value.name !== "string" || !value.name.trim() || value.name.length > 120)) throw new Error("对象名称须为 1 到 120 个字符");
    if (value.color !== undefined && (typeof value.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value.color))) throw new Error("对象颜色须为 #RRGGBB");
    if (value.visible !== undefined && typeof value.visible !== "boolean") throw new Error("visible 须为布尔值");
    if (value.transform !== undefined) validateTransform(value.transform);
}

function validateKeyframe(time: unknown, transform: unknown) {
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > 86400) throw new Error("关键帧时间须在 0 到 86400 秒之间");
    validateTransform(transform);
}

function validateCameraPatch(patch: unknown): asserts patch is CanvasAgentDirectorCameraPatch {
    validatePatch<CanvasAgentDirectorCameraPatch>(patch, ["name", "transform", "target", "focalLength", "fov", "aperture", "focusDistance", "near", "far"], "摄影机参数");
    const p = patch as CanvasAgentDirectorCameraPatch;
    if (p.name !== undefined && (typeof p.name !== "string" || !p.name.trim() || p.name.length > 120)) throw new Error("摄影机名称须为 1 到 120 个字符");
    if (p.transform !== undefined) validateTransform(p.transform);
    if (p.target !== undefined) validateVec3(p.target, "target");
    for (const key of ["focalLength", "fov", "aperture", "focusDistance", "near", "far"] as const) if (p[key] !== undefined && (!Number.isFinite(p[key]) || (p[key] as number) <= 0)) throw new Error(`${key} 须为正数`);
    if (p.fov !== undefined && p.fov >= 180) throw new Error("fov 须小于 180 度");
}

function validateLightPatch(patch: unknown): asserts patch is CanvasAgentDirectorLightPatch {
    validatePatch<CanvasAgentDirectorLightPatch>(patch, ["name", "type", "transform", "color", "intensity", "angle", "penumbra", "castShadow"], "灯光参数");
    const p = patch as CanvasAgentDirectorLightPatch;
    if (p.name !== undefined && (typeof p.name !== "string" || !p.name.trim() || p.name.length > 120)) throw new Error("灯光名称须为 1 到 120 个字符");
    if (p.type !== undefined && !["directional", "point", "spot", "ambient"].includes(p.type)) throw new Error("不支持的灯光类型");
    if (p.transform !== undefined) validateTransform(p.transform);
    if (p.color !== undefined && (typeof p.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(p.color))) throw new Error("灯光颜色须为 #RRGGBB");
    if (p.castShadow !== undefined && typeof p.castShadow !== "boolean") throw new Error("castShadow 须为布尔值");
    for (const key of ["intensity", "angle", "penumbra"] as const) if (p[key] !== undefined && (!Number.isFinite(p[key]) || (p[key] as number) < 0 || (key === "penumbra" && (p[key] as number) > 1))) throw new Error(`${key} 超出有效范围`);
    if (p.angle !== undefined && p.angle > Math.PI) throw new Error("angle 须在 0 到 π 之间");
}

export function createCanvasAgentDirectorOperations({ nodesRef, getScenes, createDirectorShot, saveDirectorScene }: Options) {
    const findScene = (sceneId: string) => {
        if (typeof sceneId !== "string" || !sceneId.trim()) throw new Error("必须指定导演场景 ID");
        const scene = getScenes().find((item) => item.id === sceneId);
        if (!scene) throw new Error(`导演场景不存在：${sceneId}`);
        return scene;
    };

    const requireSceneVersion = (scene: DirectorScene, expectedSceneHash: string) => {
        if (!expectedSceneHash || hashDirectorScene(scene) !== expectedSceneHash) {
            throw new Error("导演场景已变化，请重新读取场景后再修改");
        }
    };

    function persistAndReadback(next: DirectorScene) {
        saveDirectorScene(next);
        const saved = getScenes().find((item) => item.id === next.id);
        if (!saved || JSON.stringify(saved) !== JSON.stringify(next)) throw new Error("导演场景保存后回读校验失败");
        return clone(saved);
    }

    return {
        listScenes() {
            return getScenes().map((scene) => ({ id: scene.id, title: scene.title, objectCount: scene.objects.length, cameraCount: scene.cameras.length, shotCount: scene.shots.length, activeShotId: scene.activeShotId, sceneHash: hashDirectorScene(scene) }));
        },
        readScene(input: { sceneId: string }) {
            const scene = findScene(input.sceneId);
            return { scene: clone(scene), sceneHash: hashDirectorScene(scene) };
        },
        createShot(input: { templateId: DirectorTemplateId; position?: Position }) {
            if (!DIRECTOR_TEMPLATES.some((template) => template.id === input.templateId)) throw new Error(`未知导演模板：${String(input.templateId)}`);
            if (input.position && (!Number.isFinite(input.position.x) || !Number.isFinite(input.position.y) || Math.abs(input.position.x) > 100000 || Math.abs(input.position.y) > 100000)) throw new Error("镜头节点坐标须为有限的 ±100000 范围内坐标");
            const before = new Set(nodesRef.current.map((node) => node.id));
            createDirectorShot(input.templateId, input.position);
            const added = nodesRef.current.filter((node) => !before.has(node.id) && node.metadata?.workflowKind === "shot");
            if (added.length !== 1) throw new Error("原生导演镜头模板创建未成功");
            const node = added[0];
            const scene = getScenes().find((item) => item.id === node.metadata?.directorSceneId);
            if (!scene || !scene.shots.some((shot) => shot.id === node.metadata?.directorShotId)) throw new Error("镜头已创建，但场景或镜头回读失败");
            return { node: clone(node), scene: clone(scene), sceneHash: hashDirectorScene(scene) };
        },
        updateSceneParameters(input: { sceneId: string; expectedSceneHash: string; patch: CanvasAgentDirectorScenePatch }) {
            validateScenePatch(input.patch);
            const current = findScene(input.sceneId);
            requireSceneVersion(current, input.expectedSceneHash);
            return persistAndReadback(touchDirectorScene({ ...current, ...input.patch }));
        },
        updateShotParameters(input: { sceneId: string; shotId: string; expectedSceneHash: string; patch: CanvasAgentDirectorShotPatch }) {
            validateShotPatch(input.patch);
            const current = findScene(input.sceneId);
            requireSceneVersion(current, input.expectedSceneHash);
            if (!current.shots.some((shot) => shot.id === input.shotId)) throw new Error(`导演镜头不存在：${input.shotId}`);
            if (input.patch.cameraId !== undefined && !current.cameras.some((camera) => camera.id === input.patch.cameraId)) throw new Error(`摄影机不存在于当前场景：${input.patch.cameraId}`);
            const next = touchDirectorScene({ ...current, shots: current.shots.map((shot) => shot.id === input.shotId ? { ...shot, ...input.patch } : shot) });
            return persistAndReadback(next);
        },
        addObject(input: { sceneId: string; expectedSceneHash: string; object: CanvasAgentDirectorAddObjectInput }) {
            const current = findScene(input.sceneId);
            requireSceneVersion(current, input.expectedSceneHash);
            if (!input.object || typeof input.object !== "object" || !(input.object.kind === "primitive" || input.object.kind === "actor")) throw new Error("仅支持新增 primitive 或 actor 对象");
            const allowed = input.object.kind === "primitive" ? ["kind", "primitive", "name", "color", "position"] : ["kind", "name", "color", "position"];
            const extra = Object.keys(input.object).find((key) => !allowed.includes(key));
            if (extra) throw new Error(`新增对象不支持字段：${extra}`);
            const { name, color, position } = input.object;
            if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 120)) throw new Error("对象名称须为 1 到 120 个字符");
            if (color !== undefined && (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color))) throw new Error("对象颜色须为 #RRGGBB");
            if (position !== undefined) validateVec3(position, "position");
            if (input.object.kind === "primitive" && input.object.primitive !== undefined && !primitives.has(input.object.primitive)) throw new Error("primitive 仅支持 box、sphere、cylinder、plane");
            const object = input.object.kind === "actor"
                ? createDirectorActor(name || "演员", position || [0, 0, 0], color || undefined)
                : createDirectorObject(input.object.primitive || "box", name || "新对象", position || [0, 0.5, 0], color || undefined);
            object.transform.position = resolveDirectorPlacement({ object, existing: current.objects });
            return persistAndReadback(touchDirectorScene({ ...current, objects: [...current.objects, object] }));
        },
        updateObjectParameters(input: { sceneId: string; objectId: string; expectedSceneHash: string; patch: CanvasAgentDirectorObjectPatch }) {
            validateObjectPatch(input.patch);
            const current = findScene(input.sceneId);
            requireSceneVersion(current, input.expectedSceneHash);
            if (!current.objects.some((object) => object.id === input.objectId)) throw new Error(`导演对象不存在：${input.objectId}`);
            const next = touchDirectorScene({ ...current, objects: current.objects.map((object) => object.id === input.objectId ? { ...object, ...input.patch, transform: input.patch.transform ? clone(input.patch.transform) : object.transform } : object) });
            return persistAndReadback(next);
        },
        addCamera(input: { sceneId: string; expectedSceneHash: string; name?: string }) {
            const current = findScene(input.sceneId); requireSceneVersion(current, input.expectedSceneHash);
            if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim() || input.name.length > 120)) throw new Error("摄影机名称须为 1 到 120 个字符");
            const camera = createDirectorCamera(input.name || "摄影机");
            return persistAndReadback(touchDirectorScene({ ...current, cameras: [...current.cameras, camera] }));
        },
        updateCameraParameters(input: { sceneId: string; cameraId: string; expectedSceneHash: string; patch: CanvasAgentDirectorCameraPatch }) {
            validateCameraPatch(input.patch); const current = findScene(input.sceneId); requireSceneVersion(current, input.expectedSceneHash);
            if (!current.cameras.some((camera) => camera.id === input.cameraId)) throw new Error(`摄影机不存在：${input.cameraId}`);
            return persistAndReadback(touchDirectorScene({ ...current, cameras: current.cameras.map((camera) => camera.id === input.cameraId ? { ...camera, ...input.patch, transform: input.patch.transform ? clone(input.patch.transform) : camera.transform, target: input.patch.target ? clone(input.patch.target) : camera.target } : camera) }));
        },
        deleteCamera(input: { sceneId: string; cameraId: string; expectedSceneHash: string }) {
            const current = findScene(input.sceneId); requireSceneVersion(current, input.expectedSceneHash);
            if (!current.cameras.some((camera) => camera.id === input.cameraId)) throw new Error(`摄影机不存在：${input.cameraId}`);
            if (current.cameras.length <= 1) throw new Error("场景至少须保留一台摄影机");
            const replacement = current.cameras.find((camera) => camera.id !== input.cameraId)!;
            const cameras = current.cameras.filter((camera) => camera.id !== input.cameraId);
            const shots = current.shots.map((shot) => shot.cameraId === input.cameraId ? { ...shot, cameraId: replacement.id } : shot);
            return persistAndReadback(touchDirectorScene({ ...current, cameras, shots }));
        },
        addLight(input: { sceneId: string; expectedSceneHash: string; light: CanvasAgentDirectorAddLightInput }) {
            const current = findScene(input.sceneId); requireSceneVersion(current, input.expectedSceneHash);
            const value = input.light;
            if (!value || typeof value !== "object" || !["directional", "point", "spot", "ambient"].includes(value.type)) throw new Error("不支持的灯光类型");
            const extra = Object.keys(value).find((key) => !["type", "name", "color", "intensity", "position", "castShadow", "angle", "penumbra"].includes(key));
            if (extra) throw new Error(`新增灯光不支持字段：${extra}`);
            if (value.name !== undefined && (typeof value.name !== "string" || !value.name.trim() || value.name.length > 120)) throw new Error("灯光名称须为 1 到 120 个字符");
            if (value.intensity !== undefined && (!Number.isFinite(value.intensity) || value.intensity < 0)) throw new Error("intensity 须为非负有限数值");
            if (value.position !== undefined) validateVec3(value.position, "position");
            const light = createDirectorLight(value.type, value.name || "新灯光", value.position || [0, 3, 0], value.intensity ?? 1);
            const patch: CanvasAgentDirectorLightPatch = { color: value.color, castShadow: value.castShadow, angle: value.angle, penumbra: value.penumbra };
            const supplied = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
            if (Object.keys(supplied).length) validateLightPatch(supplied);
            Object.assign(light, supplied);
            return persistAndReadback(touchDirectorScene({ ...current, lights: [...current.lights, light] }));
        },
        updateLightParameters(input: { sceneId: string; lightId: string; expectedSceneHash: string; patch: CanvasAgentDirectorLightPatch }) {
            validateLightPatch(input.patch); const current = findScene(input.sceneId); requireSceneVersion(current, input.expectedSceneHash);
            if (!current.lights.some((light) => light.id === input.lightId)) throw new Error(`灯光不存在：${input.lightId}`);
            return persistAndReadback(touchDirectorScene({ ...current, lights: current.lights.map((light) => light.id === input.lightId ? { ...light, ...input.patch, transform: input.patch.transform ? clone(input.patch.transform) : light.transform } : light) }));
        },
        deleteLight(input: { sceneId: string; lightId: string; expectedSceneHash: string }) {
            const current = findScene(input.sceneId); requireSceneVersion(current, input.expectedSceneHash);
            if (!current.lights.some((light) => light.id === input.lightId)) throw new Error(`灯光不存在：${input.lightId}`);
            return persistAndReadback(touchDirectorScene({ ...current, lights: current.lights.filter((light) => light.id !== input.lightId) }));
        },
        upsertObjectBoneKeyframe(input: { sceneId: string; objectId: string; expectedSceneHash: string; bone: DirectorHumanoidBone; time: number; rotation: [number, number, number, number] }) {
            if (!Number.isFinite(input.time) || input.time < 0 || input.time > 86400) throw new Error("关键帧时间须在 0 到 86400 秒之间");
            if (!Array.isArray(input.rotation) || input.rotation.length !== 4 || !input.rotation.every((v) => Number.isFinite(v)) || Math.hypot(...input.rotation) < 0.0001) throw new Error("rotation 须为非零有限四元数");
            const current = findScene(input.sceneId); requireSceneVersion(current, input.expectedSceneHash);
            const object = current.objects.find((item) => item.id === input.objectId); if (!object) throw new Error(`导演对象不存在：${input.objectId}`);
            if (object.kind !== "actor") throw new Error("骨骼关键帧仅支持演员对象");
            const rotation = input.rotation.map((v) => v / Math.hypot(...input.rotation)) as [number, number, number, number];
            return persistAndReadback(touchDirectorScene({ ...current, objects: current.objects.map((item) => item.id === input.objectId ? { ...item, boneTracks: upsertDirectorBoneKeyframe(item.boneTracks || [], input.bone, input.time, rotation) } : item) }));
        },
        removeObjectBoneKeyframe(input: { sceneId: string; objectId: string; bone: DirectorHumanoidBone; keyframeId: string; expectedSceneHash: string }) {
            const current = findScene(input.sceneId); requireSceneVersion(current, input.expectedSceneHash);
            const object = current.objects.find((item) => item.id === input.objectId); if (!object) throw new Error(`导演对象不存在：${input.objectId}`);
            if (object.kind !== "actor") throw new Error("骨骼关键帧仅支持演员对象");
            if (!object.boneTracks?.find((track) => track.bone === input.bone)?.keyframes.some((frame) => frame.id === input.keyframeId)) throw new Error(`关键帧不存在：${input.keyframeId}`);
            return persistAndReadback(touchDirectorScene({ ...current, objects: current.objects.map((item) => item.id === input.objectId ? { ...item, boneTracks: removeDirectorBoneKeyframe(item.boneTracks || [], input.bone, input.keyframeId) } : item) }));
        },
        deleteObject(input: { sceneId: string; objectId: string; expectedSceneHash: string }) {
            const current = findScene(input.sceneId);
            requireSceneVersion(current, input.expectedSceneHash);
            if (!current.objects.some((object) => object.id === input.objectId)) throw new Error(`导演对象不存在：${input.objectId}`);
            return persistAndReadback(touchDirectorScene({ ...current, objects: current.objects.filter((object) => object.id !== input.objectId) }));
        },
        upsertObjectKeyframe(input: { sceneId: string; objectId: string; expectedSceneHash: string; time: number; transform: DirectorTransform }) {
            validateKeyframe(input.time, input.transform);
            const current = findScene(input.sceneId);
            requireSceneVersion(current, input.expectedSceneHash);
            if (!current.objects.some((object) => object.id === input.objectId)) throw new Error(`导演对象不存在：${input.objectId}`);
            const next = touchDirectorScene({ ...current, objects: current.objects.map((object) => object.id === input.objectId ? { ...object, keyframes: upsertDirectorKeyframe(object.keyframes, input.time, clone(input.transform)) } : object) });
            return persistAndReadback(next);
        },
        upsertCameraKeyframe(input: { sceneId: string; cameraId: string; expectedSceneHash: string; time: number; transform: DirectorTransform }) {
            validateKeyframe(input.time, input.transform);
            const current = findScene(input.sceneId);
            requireSceneVersion(current, input.expectedSceneHash);
            if (!current.cameras.some((camera) => camera.id === input.cameraId)) throw new Error(`摄影机不存在：${input.cameraId}`);
            const next = touchDirectorScene({ ...current, cameras: current.cameras.map((camera) => camera.id === input.cameraId ? { ...camera, keyframes: upsertDirectorKeyframe(camera.keyframes, input.time, clone(input.transform)) } : camera) });
            return persistAndReadback(next);
        },
        removeKeyframe(input: { sceneId: string; expectedSceneHash: string; target: { track: "object-transform"; objectId: string; keyframeId: string } | { track: "camera"; cameraId: string; keyframeId: string } }) {
            const current = findScene(input.sceneId);
            requireSceneVersion(current, input.expectedSceneHash);
            const target = input.target;
            if (!target || typeof target !== "object" || !["object-transform", "camera"].includes(target.track)) throw new Error("不支持的关键帧轨道");
            if (target.track === "object-transform") {
                const object = current.objects.find((item) => item.id === target.objectId);
                if (!object) throw new Error(`导演对象不存在：${target.objectId}`);
                if (!object.keyframes.some((item) => item.id === target.keyframeId)) throw new Error(`关键帧不存在：${target.keyframeId}`);
                return persistAndReadback(touchDirectorScene({ ...current, objects: current.objects.map((item) => item.id === target.objectId ? { ...item, keyframes: removeDirectorKeyframe(item.keyframes, target.keyframeId) } : item) }));
            }
            const camera = current.cameras.find((item) => item.id === target.cameraId);
            if (!camera) throw new Error(`摄影机不存在：${target.cameraId}`);
            if (!camera.keyframes.some((item) => item.id === target.keyframeId)) throw new Error(`关键帧不存在：${target.keyframeId}`);
            return persistAndReadback(touchDirectorScene({ ...current, cameras: current.cameras.map((item) => item.id === target.cameraId ? { ...item, keyframes: removeDirectorKeyframe(item.keyframes, target.keyframeId) } : item) }));
        },
    };
}

export type CanvasAgentDirectorOperations = ReturnType<typeof createCanvasAgentDirectorOperations>;

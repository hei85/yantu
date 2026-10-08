import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hashState } from "./canvas-context.js";
import type { LocalRuntimeConfig } from "./config.js";
import type { CanvasSnapshot } from "./types.js";

const toolsetVersion = "yingce-mcp-v3";
const schemaVersion = 3;
let cachedBuildId = "";

export function runtimeDiagnostics(
    config: LocalRuntimeConfig | undefined,
    state: CanvasSnapshot | null,
    connection: { clients: number; hasCanvas: boolean },
) {
    return {
        ok: true,
        buildId: buildId(),
        version: readVersion(),
        toolsetVersion,
        schemaVersion,
        process: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            pid: process.pid,
        },
        runtime: {
            url: config?.url || "http://127.0.0.1:17371",
            connected: connection.clients > 0,
            clients: connection.clients,
            hasCanvas: connection.hasCanvas,
        },
        binding: state ? {
            canvasId: state.projectId || "",
            domainProjectId: state.domainProjectId || "",
            revision: state.revision ?? 0,
            stateHash: hashState(state),
            selectedNodeIds: state.selectedNodeIds || [],
        } : null,
        capabilities: {
            canvas: true,
            skills: true,
            modelProfiles: true,
            shortTaskPolling: true,
            mediaProbe: true,
            serverTimelineRender: true,
        },
    };
}

function buildId() {
    if (cachedBuildId) return cachedBuildId;
    const distDir = path.dirname(fileURLToPath(import.meta.url));
    const hash = crypto.createHash("sha256");
    for (const file of listFiles(distDir).filter((item) => item.endsWith(".js")).sort()) {
        hash.update(path.relative(distDir, file));
        hash.update(fs.readFileSync(file));
    }
    cachedBuildId = `sha256:${hash.digest("hex")}`;
    return cachedBuildId;
}

function listFiles(root: string): string[] {
    const output: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const absolute = path.join(root, entry.name);
        if (entry.isDirectory()) output.push(...listFiles(absolute));
        else if (entry.isFile()) output.push(absolute);
    }
    return output;
}

function readVersion() {
    try {
        const packageFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
        const value = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { version?: unknown };
        return typeof value.version === "string" ? value.version : "0.0.0";
    } catch {
        return "0.0.0";
    }
}

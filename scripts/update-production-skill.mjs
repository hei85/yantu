import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [skillId, zipPath, outputPath] = process.argv.slice(2);
if (!skillId || !zipPath || !outputPath || !/^[a-zA-Z0-9_-]+$/.test(skillId)) {
  throw new Error("Usage: update-production-skill.mjs skillId package.zip result.json");
}
const sourcePath = path.resolve(zipPath);
const resultPath = path.resolve(outputPath);
const stat = fs.statSync(sourcePath);
if (stat.size <= 0 || stat.size > 20 * 1024 * 1024 || path.extname(sourcePath) !== ".zip") {
  throw new Error("Expected a nonempty ZIP package of at most 20 MiB");
}
const base = "http://127.0.0.1:8080/api";
async function request(apiPath, options = {}) {
  const response = await fetch(base + apiPath, { ...options, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  if (!response.ok || data.code !== 0 || !data.data) throw new Error(data.msg || `Skill API returned HTTP ${response.status}`);
  return data.data;
}
// Use this portable installation's ordinary API and author-owned skill ID.
// No cookies, caller-supplied backend URL or direct database edits.
const previous = (await request(`/skills/${encodeURIComponent(skillId)}`)).skill;
if (previous.sourceType !== "zip" || !previous.isOwner) throw new Error("The installed skill must be an author-owned ZIP package");
const form = new FormData();
form.append("file", new Blob([fs.readFileSync(sourcePath)], { type: "application/zip" }), path.basename(sourcePath));
const current = (await request(`/skills/${encodeURIComponent(skillId)}/package`, { method: "PUT", body: form })).skill;
if (current.skillId !== skillId || !current.versionId || current.versionId === previous.versionId) throw new Error("The API did not append a new version to the existing skill");
const files = (await request(`/skills/${encodeURIComponent(skillId)}/files`)).files;
if (!files.some(file => file.path === "references/formal-production-workflow.md")) throw new Error("The ordered production workflow is missing from the installed package");
const record = { at: new Date().toISOString(), portableRoot: root, skillId, previousVersionId: previous.versionId, versionId: current.versionId, version: current.version, contentHash: current.contentHash, files };
fs.mkdirSync(path.dirname(resultPath), { recursive: true });
fs.writeFileSync(resultPath, JSON.stringify(record, null, 2));
console.log(JSON.stringify({ skillId, version: current.version, versionId: current.versionId, contentHash: current.contentHash, fileCount: files.length }));

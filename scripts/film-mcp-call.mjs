import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "../canvas-agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../canvas-agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

// Use the portable installation's real MCP server, including newly registered tools.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error("Usage: film-mcp-call.mjs input.json output.json");
const requests = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const client = new Client({ name: "yingce-production-verification", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: path.join(root, "runtime", "node.exe"),
  args: [path.join(root, "canvas-agent", "dist", "index.js"), "mcp"],
  cwd: root,
  env: { ...process.env, FRAMEFIELD_LOCAL_RUNTIME_CONFIG_DIR: path.join(root, "canvas-agent-config") },
  stderr: "pipe",
});
const records = [];
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const toolNames = new Set(listed.tools.map(tool => tool.name));
  for (const request of Array.isArray(requests) ? requests : [requests]) {
    if (!toolNames.has(request.name)) throw new Error(`MCP tool unavailable: ${request.name}`);
    const result = await client.callTool({ name: request.name, arguments: request.arguments ?? {} }, undefined, { timeout: request.name === "film_self_check" ? 300000 : 45000 });
    const text = result.content?.find(item => item.type === "text")?.text;
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { message: text }; }
    const record = { at: new Date().toISOString(), tool: request.name, isError: !!result.isError, result: payload };
    records.push(record);
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(records, null, 2));
    console.log(JSON.stringify({ tool: request.name, isError: !!result.isError, projectId: payload?.projectId, runId: payload?.id, keys: Object.keys(payload || {}) }));
    if (result.isError) throw new Error(text || "MCP call failed");
  }
} finally {
  await client.close();
}

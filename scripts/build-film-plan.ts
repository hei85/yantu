import fs from "node:fs";
import { buildFilmProductionPlan } from "../web/src/services/api/production-plan";

const [inputFile, outputFile] = process.argv.slice(2);
if (!inputFile || !outputFile) throw new Error("Usage: build-film-plan.ts create-input.json result.json");
const request = JSON.parse(fs.readFileSync(inputFile, "utf8"));
const spec = request.plan.productionSpec;
const built = buildFilmProductionPlan({ ...spec, allowUnknownPricing: request.policy?.budgetPolicy === "unbounded" });
const payload = {
  ...request,
  plan: { ...request.plan, productionSpec: built.persistedSpec, executionManifest: built.manifest },
  steps: built.steps,
};
const response = await fetch("http://127.0.0.1:8080/api/production-runs", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
  redirect: "error",
  signal: AbortSignal.timeout(30000),
});
const result = await response.json();
fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
if (!response.ok || result.code !== 0) throw new Error(result.msg || `HTTP ${response.status}`);
if (result.data.canvasId !== request.canvasId) throw new Error("Created run belongs to a different canvas");
const authResponse = await fetch(`http://127.0.0.1:8080/api/production-runs/${encodeURIComponent(result.data.id)}/authorize`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ expectedRevision: result.data.revision, policy: request.policy }),
  redirect: "error", signal: AbortSignal.timeout(30000),
});
const auth = await authResponse.json();
fs.writeFileSync(outputFile, JSON.stringify(auth, null, 2));
if (!authResponse.ok || auth.code !== 0) throw new Error(auth.msg || `Authorization HTTP ${authResponse.status}`);
console.log(JSON.stringify({ id: auth.data.id, revision: auth.data.revision, status: auth.data.status, authorizationStatus: auth.data.policy.authorizationStatus, stepCount: auth.data.steps?.length }));

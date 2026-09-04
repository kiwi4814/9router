#!/usr/bin/env node
/**
 * Generate the OMP (models.yml) static model block for the local 9router
 * provider from the LIVE /v1/models advertisement.
 *
 * OMP renders max-out / thinking / images columns ONLY from static models.yml
 * entries (remote payload fields are ignored for those columns), so this
 * block keeps the OMP table in sync with what 9router actually serves.
 *
 * Usage:
 *   node scripts/qoder/gen-omp-models.mjs [baseUrl] [--legacy-aliases]
 *     baseUrl defaults to http://127.0.0.1:20127/v1
 * Prints YAML `models:` entries to paste under the 9router provider in
 * ~/.omp/agent/models.yml. Values are read from the server's live catalog
 * advertisement (windows / efforts / vision), not hardcoded.
 */
const args = process.argv.slice(2);
const withLegacyAliases = args.includes("--legacy-aliases");
const BASE = args.find((a) => !a.startsWith("--")) || "http://127.0.0.1:20127/v1";

const res = await fetch(`${BASE}/models`);
if (!res.ok) throw new Error(`GET /v1/models failed: ${res.status}`);
const { data } = await res.json();
const rows = (data || []).filter((m) => String(m.id).startsWith("qd/"));

if (rows.length === 0) {
  throw new Error("no qd/* models advertised — is the 9router qoder connection active?");
}

rows.sort((a, b) => a.id.localeCompare(b.id));

const out = [];
for (const m of rows) {
  const caps = m.capabilities || {};
  const ctx = m.context_length || caps.contextWindow;
  const maxOut = m.max_completion_tokens || caps.maxOutput;
  const inputs = caps.vision ? ["text", "image"] : ["text"];
  const efforts = Array.isArray(caps.reasoningEfforts) && caps.reasoningEfforts.length > 0;
  const canThink = caps.reasoning === true || efforts;
  out.push(`      - id: ${m.id}`);
  out.push(`        name: ${m.id.replace(/^qd\//, "")}`);
  out.push(`        reasoning: ${canThink ? "true" : "false"}`);
  out.push(`        supportsTools: ${caps.tools !== false ? "true" : "false"}`);
  out.push(`        input: [${inputs.join(", ")}]`);
  out.push(`        contextWindow: ${ctx || 200000}`);
  out.push(`        maxTokens: ${maxOut || 32768}`);
  out.push(`        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`);
}
if (withLegacyAliases) {
  // Map pretty id -> legacy internal key for clients that still send old names
  const LEGACY_MAP = {
    "glm-5.3-flash": "gfmodel",
    "glm-5.3": "gmodel",
    "glm-5.2": "gm51model",
    "qwen3.8-flash": "qfmodel",
    "qwen3.8-max": "qmodel_38max",
    "qwen3.7-max": "qmodel_latest",
    "qwen3.7-plus": "qmodel",
    "qwen3.7-flash": "q37fmodel",
    "deepseek-v4-pro": "dmodel",
    "deepseek-v4-flash": "dfmodel",
    "kimi-k2.7-code": "kmodel",
    "minimax-m2.7": "mmodel",
  };
  for (const m of rows) {
    const slug = m.id.replace(/^qd\//, "");
    const legacy = LEGACY_MAP[slug];
    if (legacy && legacy !== slug) {
      const caps = m.capabilities || {};
      const ctx = m.context_length || caps.contextWindow;
      const maxOut = m.max_completion_tokens || caps.maxOutput;
      const inputs = caps.vision ? ["text", "image"] : ["text"];
      const efforts = Array.isArray(caps.reasoningEfforts) && caps.reasoningEfforts.length > 0;
      const canThink = caps.reasoning === true || efforts;
      out.push(`      - id: qd/${legacy}`);
      out.push(`        name: ${legacy}`);
      out.push(`        reasoning: ${canThink ? "true" : "false"}`);
      out.push(`        supportsTools: ${caps.tools !== false ? "true" : "false"}`);
      out.push(`        input: [${inputs.join(", ")}]`);
      out.push(`        contextWindow: ${ctx || 200000}`);
      out.push(`        maxTokens: ${maxOut || 32768}`);
      out.push(`        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`);
    }
  }
}
console.log("    models:");
console.log(out.join("\n"));

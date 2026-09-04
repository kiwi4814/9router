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
 * advertisement (windows / efforts / vision / Qoder credit multipliers),
 * not hardcoded.
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

function optionalFactor(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function modelNameWithFactor(modelId, caps) {
  const base = String(modelId).replace(/^qd\//, "");
  const factor = optionalFactor(caps?.priceFactor);
  if (factor === null) return base;
  if (factor === 0) return `${base} · free`;

  const original = optionalFactor(caps?.originalPriceFactor);
  if (original !== null && original > 0 && original !== factor) {
    return `${base} · ${factor}× (orig ${original}×)`;
  }
  return `${base} · ${factor}×`;
}

const out = [];
for (const m of rows) {
  const caps = m.capabilities || {};
  const ctx = m.context_length || caps.contextWindow;
  const maxOut = m.max_completion_tokens || caps.maxOutput;
  const inputs = caps.vision ? ["text", "image"] : ["text"];
  const efforts = Array.isArray(caps.reasoningEfforts) && caps.reasoningEfforts.length > 0;
  const canThink = caps.reasoning === true || efforts;
  out.push(`      - id: ${m.id}`);
  out.push(`        name: ${modelNameWithFactor(m.id, caps)}`);
  out.push(`        reasoning: ${canThink ? "true" : "false"}`);
  out.push(`        supportsTools: ${caps.tools !== false ? "true" : "false"}`);
  out.push(`        input: [${inputs.join(", ")}]`);
  out.push(`        contextWindow: ${ctx || 200000}`);
  out.push(`        maxTokens: ${maxOut || 32768}`);
  // Qoder priceFactor is a relative Credits multiplier, NOT a per-million-token
  // currency rate. OMP's `cost` field is a per-1M-token rate card and is used
  // for monetary/session-cost accounting, so keep it zero to avoid fabricating
  // USD-like costs. The real multiplier is displayed in `name` above and stays
  // available structurally as capabilities.priceFactor/originalPriceFactor.
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
      out.push(`        name: ${modelNameWithFactor(`qd/${legacy}`, caps)}`);
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

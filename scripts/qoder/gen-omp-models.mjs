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
 * ~/.omp/agent/models.yml. Runtime capabilities come from the live catalog;
 * vendor API prices are verified static baselines because Qoder's priceFactor
 * is a Credits multiplier, not a per-token currency rate.
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

// OMP's `cost` schema is USD per 1M tokens. Several China-region vendor
// price lists are published in CNY, so freeze a clearly dated FX reference
// instead of putting raw CNY values under OMP's dollar-labelled cost UI.
// Reference: 2026-09-04, 1 CNY = 0.148882 USD.
const CNY_TO_USD_REFERENCE_RATE = 0.148882;

// Verified 2026-09-04 vendor API list prices per 1M tokens.
// Policy for this workstation:
// - standard/list prices only; ignore short-lived launch promos;
// - DeepSeek uses weekday PEAK/daytime pricing because usage is during work hours;
// - Qwen 3.7 Plus/Flash use the highest <=1M input tier because OMP custom
//   models.yml cannot express multiple context-length price tiers;
// - cacheRead is the vendor's cache-hit rate and cacheWrite is explicit cache
//   creation only when the original/vendor-supplied listing publishes it;
// - these are vendor API baselines, NOT the user's actual Qoder Enterprise bill.
const OFFICIAL_API_PRICES = Object.freeze({
  "glm-5.3-flash": { currency: "CNY", input: 0.8, output: 2.8, cacheRead: 0.23, cacheWrite: 0 },
  "glm-5.3": { currency: "CNY", input: 8, output: 28, cacheRead: 2, cacheWrite: 0 },
  "glm-5.2": { currency: "CNY", input: 8, output: 28, cacheRead: 2, cacheWrite: 0 },

  "qwen3.8-flash": { currency: "CNY", input: 0.8, output: 2.7, cacheRead: 0.1, cacheWrite: 1.25 },
  "qwen3.8-max": { currency: "CNY", input: 12, output: 36, cacheRead: 1.5, cacheWrite: 15 },
  "qwen3.7-max": { currency: "CNY", input: 12, output: 36, cacheRead: 2.4, cacheWrite: 15 },
  "qwen3.7-plus": { currency: "CNY", input: 6, output: 24, cacheRead: 1.2, cacheWrite: 7.5 },
  "qwen3.7-flash": { currency: "CNY", input: 1.2, output: 4.8, cacheRead: 0.24, cacheWrite: 1.5 },

  "deepseek-v4-flash": { currency: "USD", input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
  "deepseek-v4-pro": { currency: "USD", input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },

  // Moonshot's directly supplied Kimi listing publishes input/output/cache-hit
  // pricing but no explicit cache-creation rate, so cacheWrite remains 0 here.
  "kimi-k2.7-code": { currency: "CNY", input: 6.5, output: 27, cacheRead: 1.3, cacheWrite: 0 },
  "minimax-m2.7": { currency: "USD", input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
});

const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function normalizeModelKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function optionalFactor(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function modelNameWithFactor(modelId, caps) {
  const base = String(modelId).replace(/^qd\//, "");
  const parts = [base];
  const factor = optionalFactor(caps?.priceFactor);

  if (factor === 0) {
    parts.push("Qoder free");
  } else if (factor !== null) {
    const original = optionalFactor(caps?.originalPriceFactor);
    if (original !== null && original > 0 && original !== factor) {
      parts.push(`Qoder ${factor}× (orig ${original}×)`);
    } else {
      parts.push(`Qoder ${factor}×`);
    }
  }

  if (base === "auto") parts.push("API price variable");
  return parts.join(" · ");
}

function toUsd(value, currency) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  const usd = currency === "CNY" ? n * CNY_TO_USD_REFERENCE_RATE : n;
  return Number(usd.toFixed(6));
}

function officialPriceKey(model) {
  // Prefer the live display name. Public ids may gain a deterministic suffix
  // when Qoder returns colliding display names, so id-only lookup is brittle.
  const fromName = normalizeModelKey(model?.name);
  if (OFFICIAL_API_PRICES[fromName]) return fromName;

  const fromId = normalizeModelKey(String(model?.id || "").replace(/^qd\//, ""));
  if (OFFICIAL_API_PRICES[fromId]) return fromId;
  if (fromName === "auto" || fromId === "auto") return "auto";
  return null;
}

function officialCostFor(model) {
  const key = officialPriceKey(model);
  if (key === "auto") return ZERO_COST;

  const source = key ? OFFICIAL_API_PRICES[key] : null;
  if (!source) {
    throw new Error(
      `no verified official API price configured for ${model?.id || model?.name || "unknown model"}; ` +
        "refusing to emit a misleading OMP cost"
    );
  }

  return {
    input: toUsd(source.input, source.currency),
    output: toUsd(source.output, source.currency),
    cacheRead: toUsd(source.cacheRead, source.currency),
    cacheWrite: toUsd(source.cacheWrite, source.currency),
  };
}

function formatCost(cost) {
  return `{ input: ${cost.input}, output: ${cost.output}, cacheRead: ${cost.cacheRead}, cacheWrite: ${cost.cacheWrite} }`;
}

const out = [];
for (const m of rows) {
  const caps = m.capabilities || {};
  const ctx = m.context_length || caps.contextWindow;
  const maxOut = m.max_completion_tokens || caps.maxOutput;
  const inputs = caps.vision ? ["text", "image"] : ["text"];
  const efforts = Array.isArray(caps.reasoningEfforts) && caps.reasoningEfforts.length > 0;
  const canThink = caps.reasoning === true || efforts;
  const cost = officialCostFor(m);

  out.push(`      - id: ${m.id}`);
  out.push(`        name: ${modelNameWithFactor(m.id, caps)}`);
  out.push(`        reasoning: ${canThink ? "true" : "false"}`);
  out.push(`        supportsTools: ${caps.tools !== false ? "true" : "false"}`);
  out.push(`        input: [${inputs.join(", ")}]`);
  out.push(`        contextWindow: ${ctx || 200000}`);
  out.push(`        maxTokens: ${maxOut || 32768}`);
  out.push(`        cost: ${formatCost(cost)}`);
}

if (withLegacyAliases) {
  // Map pretty id -> legacy internal key for clients that still send old names.
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
      const cost = officialCostFor(m);

      out.push(`      - id: qd/${legacy}`);
      out.push(`        name: ${modelNameWithFactor(`qd/${legacy}`, caps)}`);
      out.push(`        reasoning: ${canThink ? "true" : "false"}`);
      out.push(`        supportsTools: ${caps.tools !== false ? "true" : "false"}`);
      out.push(`        input: [${inputs.join(", ")}]`);
      out.push(`        contextWindow: ${ctx || 200000}`);
      out.push(`        maxTokens: ${maxOut || 32768}`);
      out.push(`        cost: ${formatCost(cost)}`);
    }
  }
}

console.log("    models:");
console.log(out.join("\n"));

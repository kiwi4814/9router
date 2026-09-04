/**
 * Qoder model-key / capability metadata shared by the chat executor and the
 * /v1/models live resolver.
 *
 * v1.2.1 — identity is DERIVED FROM THE LIVE CATALOG, never a static table:
 *
 *   catalog entry (key `gfmodel`, display_name "GLM-5.3-Flash")
 *       ↓ slugify display_name
 *   public id (glm-5.3-flash)   ← what OpenAI-compatible clients see
 *
 * The public<->internal maps are built per catalog fetch (cached alongside
 * the catalog) and are consulted for chat routing, so when Qoder swaps what
 * an internal key points at, the advertised id follows the truth instead of
 * a hardcoded guess. Slug collisions get a deterministic `-<key>` suffix —
 * never a silent overwrite.
 *
 * A tiny LEGACY_PUBLIC_TO_INTERNAL table keeps the public ids published by
 * v1.2 resolvable even during a transient catalog fetch failure; the live
 * catalog always wins when it is available.
 *
 * Capability publishing follows the same rule: qoderCapabilitiesForEntry()
 * only states what the Qoder catalog actually says (VL, reasoning, windows,
 * efforts). Fields the catalog says NOTHING about (pdf, videoInput,
 * audioInput, search, thinkingFormat, ...) are omitted so /v1/models can
 * merge these live facts over the richer static capability knowledge the
 * generic resolver already has — no false `pdf:false` downgrades.
 */

/** Public ids released by v1.2 — last-resort reverse map when the live
 * catalog cannot be fetched (e.g. transient network failure). */
export const LEGACY_PUBLIC_TO_INTERNAL = Object.freeze({
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
});

function stripQoderPrefix(raw) {
  return String(raw || "").replace(/^qoder\//, "").replace(/^qd\//, "");
}

/**
 * Slugify a model display name into a stable public id fragment:
 * "GLM-5.3-Flash" → "glm-5.3-flash", "DeepSeek-V4-Pro" → "deepseek-v4-pro".
 */
export function slugifyModelName(name) {
  const slug = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug;
}

/**
 * Build public<->internal id maps from the raw catalog entries (only enabled
 * models are advertised). Colliding slugs get a deterministic "-<key>"
 * suffix instead of silently overwriting each other.
 *
 * @param {Array<{key:string, display_name?:string, enable?:boolean}>} entries
 * @returns {{ publicToInternal: Map<string,string>, internalToPublic: Map<string,string> }}
 */
export function buildPublicAliases(entries) {
  const publicToInternal = new Map();
  const internalToPublic = new Map();

  // Sort by internal key so public identity is a function of catalog
  // CONTENT, not catalog ORDER — reordering upstream must not reshuffle
  // which key owns the base slug vs a suffixed one.
  const normalized = (entries || [])
    .filter((entry) => entry && typeof entry === "object")
    .filter((entry) => entry.key && entry.enable !== false)
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));

  const claim = (key, base) => {
    // Never silently overwrite an existing claim from a different key.
    // First suffixed form keeps the v1.2.1 convention `-<raw key>`; if that
    // is somehow taken too, fall back to a numeric suffix.
    let candidate = base;
    let n = 2;
    if (publicToInternal.has(candidate) && publicToInternal.get(candidate) !== key) {
      candidate = `${base}-${key}`;
    }
    while (publicToInternal.has(candidate) && publicToInternal.get(candidate) !== key) {
      candidate = `${base}-${n++}`;
    }
    publicToInternal.set(candidate, key);
    internalToPublic.set(key, candidate);
  };

  for (const entry of normalized) {
    const key = entry.key;
    const slug = slugifyModelName(entry.display_name || key) || String(key).toLowerCase();
    // claim() handles both the free-slug and the collision case and always
    // guarantees a unique public id for this key.
    claim(key, slug);
  }
  return { publicToInternal, internalToPublic };
}

/** Strip prefixes then resolve a client-supplied model string to the
 * internal catalog key, falling back to the v1.2-released legacy table. */
export function legacyInternalQoderKey(model) {
  const raw = stripQoderPrefix(model);
  return LEGACY_PUBLIC_TO_INTERNAL[raw] || raw;
}

/**
 * Token counts of every context window a catalog entry advertises
 * (context_config.<label>.token_count buckets, plus any
 * available_context_windows/availableContextWindows arrays).
 */
export function contextWindowTokens(modelConfig) {
  const windows = new Set();
  const add = (v) => {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) windows.add(n);
  };
  const cc = modelConfig?.context_config ?? modelConfig?.contextConfig;
  if (Array.isArray(modelConfig?.available_context_windows)) {
    for (const w of modelConfig.available_context_windows) add(w);
  }
  if (Array.isArray(modelConfig?.availableContextWindows)) {
    for (const w of modelConfig.availableContextWindows) add(w);
  }
  if (cc && typeof cc === "object") {
    for (const key of Object.keys(cc)) {
      const bucket = cc[key];
      if (bucket && typeof bucket === "object") add(bucket.token_count);
    }
  }
  return windows;
}

/** Largest advertised context window (0 when none advertised). */
export function maxContextWindowTokens(modelConfig) {
  const windows = contextWindowTokens(modelConfig);
  let max = 0;
  for (const w of windows) if (w > max) max = w;
  return max;
}

/** Sorted advertised windows, or undefined when none are advertised. */
export function availableContextWindows(modelConfig) {
  const windows = contextWindowTokens(modelConfig);
  if (windows.size === 0) return undefined;
  return [...windows].sort((a, b) => a - b);
}

/** Window flagged default by the catalog (context_config bucket is_default),
 * falling back to the first bucket. Also honors the direct SDK fields
 * default_context_window / defaultContextWindow. Undefined when unknown. */
export function defaultContextWindowTokens(modelConfig) {
  // Official SDK metadata may state the default directly.
  const direct =
    modelConfig?.default_context_window ??
    modelConfig?.defaultContextWindow;
  if (direct !== undefined && direct !== null) {
    const n = Number(direct);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const cc = modelConfig?.context_config ?? modelConfig?.contextConfig;
  const buckets = [];
  if (cc && typeof cc === "object") {
    for (const key of Object.keys(cc)) {
      const bucket = cc[key];
      if (bucket && typeof bucket === "object" && Number.isFinite(Number(bucket.token_count))) {
        buckets.push({ tokens: Number(bucket.token_count), isDefault: bucket.is_default === true });
      }
    }
  }
  if (buckets.length === 0) return undefined;
  const flagged = buckets.find((b) => b.isDefault);
  if (flagged) return flagged.tokens;
  const directWindows =
    modelConfig?.available_context_windows ??
    modelConfig?.availableContextWindows;
  if (Array.isArray(directWindows) && directWindows.length > 0) {
    return Number(directWindows[0]) || buckets[0].tokens;
  }
  return buckets[0].tokens;
}

/**
 * Reasoning-effort levels a model advertises. The official Qoder SDK reads
 * either a top-level `efforts` list or thinking_config.enabled.efforts
 * (dict or array).
 */
export function supportedEfforts(modelConfig) {
  const result = new Set();
  if (Array.isArray(modelConfig?.efforts)) {
    for (const value of modelConfig.efforts) {
      if (typeof value === "string" && value.trim()) {
        result.add(value.trim().toLowerCase());
      }
    }
  }
  const tc = modelConfig?.thinking_config ?? modelConfig?.thinkingConfig;
  const configured = tc?.enabled?.efforts;
  if (configured && !Array.isArray(configured) && typeof configured === "object") {
    for (const value of Object.keys(configured)) {
      result.add(value.trim().toLowerCase());
    }
  }
  return result;
}

/** Effort the catalog flags as default (is_default), else undefined. */
export function defaultReasoningEffort(modelConfig) {
  const direct = modelConfig?.default_effort ?? modelConfig?.defaultEffort;
  if (typeof direct === "string" && direct.trim()) return direct.trim().toLowerCase();

  const tc = modelConfig?.thinking_config ?? modelConfig?.thinkingConfig;
  const configured = tc?.enabled?.efforts;
  if (configured && !Array.isArray(configured) && typeof configured === "object") {
    for (const [key, meta] of Object.entries(configured)) {
      if (meta && typeof meta === "object" && meta.is_default === true) {
        return String(key).trim().toLowerCase();
      }
    }
    if (tc?.enabled?.is_default === true) {
      const first = Object.keys(configured)[0];
      if (first) return String(first).trim().toLowerCase();
    }
  }
  return undefined;
}

/**
 * Tri-state truth about whether thinking can be turned off:
 *   true  — catalog explicitly supports disabling
 *   false — catalog explicitly says it cannot be disabled
 *   undefined — catalog says nothing (unknown; let base knowledge decide)
 */
export function thinkingCanDisableFact(modelConfig) {
  const tc = modelConfig?.thinking_config ?? modelConfig?.thinkingConfig;
  if (tc?.disabled && typeof tc.disabled === "object") return true;
  if (typeof modelConfig?.supports_disabled === "boolean") return modelConfig.supports_disabled;
  if (typeof modelConfig?.supportsDisabled === "boolean") return modelConfig.supportsDisabled;
  return undefined;
}

/** Boolean convenience for callers that need true/false (unknown = false). */
export function supportsDisabledThinking(modelConfig) {
  return thinkingCanDisableFact(modelConfig) === true;
}

/**
 * Capabilities that ONLY state what the Qoder catalog factually says.
 * Fields the catalog says nothing about are left undefined so the caller can
 * merge these facts over richer static knowledge instead of overwriting it
 * with `false`/`null` guesses.
 */
export function qoderCapabilitiesForEntry(entry) {
  const caps = { tools: true };
  if (typeof entry?.is_vl === "boolean") caps.vision = entry.is_vl;
  if (typeof entry?.is_reasoning === "boolean") caps.reasoning = entry.is_reasoning;
  const canDisable = thinkingCanDisableFact(entry);
  if (canDisable !== undefined) caps.thinkingCanDisable = canDisable;

  const maxWindow = maxContextWindowTokens(entry);
  const ctx = maxWindow > 0 ? maxWindow : (Number(entry?.max_input_tokens) || 0);
  if (ctx > 0) caps.contextWindow = ctx;
  const maxOut = Number(entry?.max_output_tokens) || 0;
  if (maxOut > 0) caps.maxOutput = maxOut;

  const windows = availableContextWindows(entry);
  if (windows) caps.availableContextWindows = windows;
  const defaultWindow = defaultContextWindowTokens(entry);
  if (Number.isFinite(defaultWindow)) caps.defaultContextWindow = defaultWindow;

  const efforts = [...supportedEfforts(entry)];
  if (efforts.length > 0) caps.reasoningEfforts = efforts.sort();
  const defaultEffort = defaultReasoningEffort(entry);
  if (defaultEffort) caps.defaultReasoningEffort = defaultEffort;
  return caps;
}

/** Drop undefined values (keep explicit null/false so callers may still
 * intentionally express "not supported"). */
export function definedOnly(caps) {
  const out = {};
  for (const [key, value] of Object.entries(caps || {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Merge live catalog facts over the richer base capability knowledge:
 * base provides the "not stated" defaults (pdf/video/thinkingFormat from
 * the static tables), live only overrides what it actually knows.
 * Returns undefined when neither source has anything to say.
 */
export function mergeCapabilities(baseCaps, liveCaps) {
  const base = baseCaps && typeof baseCaps === "object" ? baseCaps : {};
  const live = liveCaps && typeof liveCaps === "object" ? definedOnly(liveCaps) : {};
  const merged = { ...base, ...live };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

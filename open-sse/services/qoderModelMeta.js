/**
 * Qoder model-key / capability metadata shared by the chat executor and the
 * /v1/models live resolver.
 *
 * The Qoder catalog is keyed by opaque internal keys (gfmodel, qmodel_38max,
 * ...). OpenAI-compatible clients see the pretty ids below instead; the chat
 * path resolves pretty ids back to internal keys via internalQoderKey(), and
 * accepts the legacy internal keys unchanged so existing clients keep working.
 *
 * v1.2 — capability propagation: /v1/models advertises the same window /
 * effort / reasoning / VL facts the executor applies on the wire, so a
 * client that trusts the list ("1M context") gets a request that actually
 * runs at that window.
 */

// Public (pretty) ids exposed in /v1/models, keyed by the internal catalog key.
export const QODER_PUBLIC_MODEL_IDS = {
  auto: "auto",
  gfmodel: "glm-5.3-flash",
  gmodel: "glm-5.3",
  gm51model: "glm-5.2",
  qfmodel: "qwen3.8-flash",
  qmodel_38max: "qwen3.8-max",
  qmodel_latest: "qwen3.7-max",
  qmodel: "qwen3.7-plus",
  q37fmodel: "qwen3.7-flash",
  dmodel: "deepseek-v4-pro",
  dfmodel: "deepseek-v4-flash",
  kmodel: "kimi-k2.7-code",
  mmodel: "minimax-m2.7",
};

export const QODER_INTERNAL_MODEL_IDS = Object.fromEntries(
  Object.entries(QODER_PUBLIC_MODEL_IDS).map(([internal, pretty]) => [pretty, internal]),
);

/** Internal catalog key -> pretty public id (identity when unmapped). */
export function publicQoderId(internalKey) {
  return QODER_PUBLIC_MODEL_IDS[internalKey] || internalKey;
}

/**
 * Normalize any accepted client spelling to the internal catalog key:
 *   - strips qoder/ or qd/ prefixes
 *   - resolves pretty ids (glm-5.3-flash) to internal keys (gfmodel)
 *   - passes legacy internal keys through untouched
 */
export function internalQoderKey(model) {
  const raw = String(model || "")
    .replace(/^qoder\//, "")
    .replace(/^qd\//, "");
  return QODER_INTERNAL_MODEL_IDS[raw] || raw;
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

/** Whether a model advertises a way to turn thinking off. */
export function supportsDisabledThinking(modelConfig) {
  const tc = modelConfig?.thinking_config ?? modelConfig?.thinkingConfig;
  if (tc?.disabled && typeof tc.disabled === "object") return true;
  return !!(
    modelConfig?.supports_disabled ??
    modelConfig?.supportsDisabled
  );
}

/**
 * OpenAI-style capabilities object for a catalog entry — same shape the
 * generic capabilities resolver emits (camelCase, nested under
 * `capabilities`), so /v1/models can publish it verbatim.
 */
export function qoderCapabilitiesForEntry(entry) {
  const maxWindow = maxContextWindowTokens(entry);
  const efforts = [...supportedEfforts(entry)];
  const contextWindow = maxWindow > 0 ? maxWindow : (Number(entry?.max_input_tokens) || 0);
  const maxOutput = Number(entry?.max_output_tokens) || 0;
  return {
    vision: !!entry?.is_vl,
    pdf: false,
    audioInput: false,
    videoInput: false,
    imageOutput: false,
    audioOutput: false,
    search: false,
    tools: true,
    reasoning: !!entry?.is_reasoning,
    thinkingFormat: null,
    thinkingCanDisable: supportsDisabledThinking(entry),
    thinkingRange: efforts.length ? efforts.sort() : null,
    thinkingEffortSupported: efforts.length > 0 && !!entry?.is_reasoning,
    contextWindow: contextWindow > 0 ? contextWindow : undefined,
    maxOutput: maxOutput > 0 ? maxOutput : undefined,
  };
}

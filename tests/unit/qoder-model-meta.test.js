/**
 * Unit tests for qoderModelMeta — v1.2.1 identity + capability hardening:
 *   - public ids are slugified from the live catalog display_name and are
 *     collision-safe (no silent overwrite);
 *   - qoderCapabilitiesForEntry only states facts the catalog actually
 *     knows (no pdf/video/thinkingFormat guesses), with efforts surfaced as
 *     reasoningEfforts + defaultReasoningEffort and windows as
 *     availableContextWindows/defaultContextWindow;
 *   - mergeCapabilities merges live facts over base knowledge instead of
 *     replacing it, and treats an absent live field as "unknown".
 */
import { describe, it, expect } from "vitest";

import {
  slugifyModelName,
  buildPublicAliases,
  qoderCapabilitiesForEntry,
  mergeCapabilities,
  legacyInternalQoderKey,
  defaultReasoningEffort,
  defaultContextWindowTokens,
  thinkingCanDisableFact,
  supportsDisabledThinking,
} from "../../open-sse/services/qoderModelMeta.js";

describe("slugifyModelName", () => {
  it("slugs catalog display names", () => {
    expect(slugifyModelName("GLM-5.3-Flash")).toBe("glm-5.3-flash");
    expect(slugifyModelName("DeepSeek-V4-Pro")).toBe("deepseek-v4-pro");
    expect(slugifyModelName("Kimi-K2.7-Code")).toBe("kimi-k2.7-code");
    expect(slugifyModelName(" MiniMax M2.7 ")).toBe("minimax-m2.7");
  });
});

describe("buildPublicAliases", () => {
  const entries = [
    { key: "gfmodel", display_name: "GLM-5.3-Flash" },
    { key: "dmodel", display_name: "DeepSeek-V4-Pro" },
    { key: "hidden", display_name: "Hidden-Preview", enable: false },
  ];

  it("maps slug -> internal key and internal -> slug for enabled models", () => {
    const { publicToInternal, internalToPublic } = buildPublicAliases(entries);
    expect(publicToInternal.get("glm-5.3-flash")).toBe("gfmodel");
    expect(publicToInternal.get("deepseek-v4-pro")).toBe("dmodel");
    expect(internalToPublic.get("gfmodel")).toBe("glm-5.3-flash");
    // Disabled models are not advertised.
    expect(publicToInternal.has("hidden-preview")).toBe(false);
  });

  it("never silently overwrites a colliding slug — deterministic -<key> suffix", () => {
    const colliding = [
      { key: "a_model", display_name: "Alpha" },
      { key: "b_model", display_name: "Alpha" },
    ];
    const { publicToInternal, internalToPublic } = buildPublicAliases(colliding);
    expect(publicToInternal.size).toBe(2);
    expect(internalToPublic.get("a_model")).toBe("alpha");
    expect(internalToPublic.get("b_model")).toBe("alpha-b_model");
    expect(publicToInternal.get("alpha")).toBe("a_model");
    expect(publicToInternal.get("alpha-b_model")).toBe("b_model");
  });

  it("identity is order-independent (catalog content, not catalog order)", () => {
    const a = [
      { key: "a_model", display_name: "Alpha" },
      { key: "b_model", display_name: "Alpha" },
    ];
    const b = [
      { key: "b_model", display_name: "Alpha" },
      { key: "a_model", display_name: "Alpha" },
    ];
    const mapA = buildPublicAliases(a).internalToPublic;
    const mapB = buildPublicAliases(b).internalToPublic;
    expect(mapA.get("a_model")).toBe("alpha");
    expect(mapA.get("b_model")).toBe("alpha-b_model");
    // Reordering upstream must not reshuffle which key owns the base slug.
    expect(mapB.get("a_model")).toBe("alpha");
    expect(mapB.get("b_model")).toBe("alpha-b_model");
  });

  it("allocates unique public ids for many same-name entries, whichever the catalog order", () => {
    const entries = ["k1", "k2", "k3", "k4", "k5"].map((key) => ({ key, display_name: "Same" }));
    for (const shuffled of [entries, [...entries].reverse()]) {
      const { publicToInternal, internalToPublic } = buildPublicAliases(shuffled);
      const ids = [...internalToPublic.values()];
      expect(ids.length).toBe(5);
      expect(new Set(ids).size).toBe(5); // no duplicate public id ever
      // Base slug goes to the first key by sorted order; every id resolves
      // back to exactly its owning key.
      expect(internalToPublic.get("k1")).toBe("same");
      for (const [key, publicId] of internalToPublic) {
        expect(publicToInternal.get(publicId)).toBe(key);
      }
    }
  });
});

describe("qoderCapabilitiesForEntry (only-known-facts)", () => {
  const gfmodel = {
    key: "gfmodel",
    display_name: "GLM-5.3-Flash",
    is_vl: true,
    is_reasoning: true,
    max_output_tokens: 131072,
    thinking_config: {
      enabled: { is_default: true, efforts: { high: {}, max: { is_default: true } } },
    },
    context_config: {
      "200K": { token_count: 200000, is_default: true },
      "400K": { token_count: 400000 },
      "1M": { token_count: 1000000 },
    },
  };

  it("states vision/reasoning/tools/windows/efforts and nothing else", () => {
    const caps = qoderCapabilitiesForEntry(gfmodel);
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.tools).toBe(true);
    expect(caps.contextWindow).toBe(1000000);
    expect(caps.maxOutput).toBe(131072);
    expect(caps.availableContextWindows).toEqual([200000, 400000, 1000000]);
    expect(caps.defaultContextWindow).toBe(200000);
    expect(caps.reasoningEfforts).toEqual(["high", "max"]);
    expect(caps.defaultReasoningEffort).toBe("max");
    // Schema hygiene: no invented pdf/video/audio/thinkingFormat/thinkingRange.
    expect(caps.pdf).toBeUndefined();
    expect(caps.videoInput).toBeUndefined();
    expect(caps.audioInput).toBeUndefined();
    expect(caps.thinkingFormat).toBeUndefined();
    expect(caps.thinkingRange).toBeUndefined();
  });

  it("omits unknown fields (no is_vl/is_reasoning/metadata present)", () => {
    const caps = qoderCapabilitiesForEntry({ key: "minimal", display_name: "Minimal" });
    expect(caps.tools).toBe(true);
    expect(caps.vision).toBeUndefined();
    expect(caps.reasoning).toBeUndefined();
    expect(caps.contextWindow).toBeUndefined();
    expect(caps.thinkingCanDisable).toBeUndefined();
  });
});

describe("mergeCapabilities", () => {
  const base = {
    vision: true,
    videoInput: true,
    pdf: true,
    reasoning: true,
    thinkingFormat: "zai",
    contextWindow: 200000,
    maxOutput: 64000,
  };
  const live = qoderCapabilitiesForEntry({
    key: "gfmodel",
    display_name: "GLM-5.3-Flash",
    is_vl: true,
    is_reasoning: true,
    max_output_tokens: 131072,
    thinking_config: { enabled: { is_default: true, efforts: { high: {}, max: { is_default: true } } } },
    context_config: { "200K": { token_count: 200000, is_default: true }, "1M": { token_count: 1000000 } },
  });

  it("keeps base knowledge the live catalog does not state", () => {
    const merged = mergeCapabilities(base, live);
    expect(merged.videoInput).toBe(true); // base-only knowledge preserved
    expect(merged.pdf).toBe(true);
    expect(merged.thinkingFormat).toBe("zai");
  });

  it("lets live facts override base values", () => {
    const merged = mergeCapabilities(base, live);
    expect(merged.contextWindow).toBe(1000000); // live wins over base 200000
    expect(merged.maxOutput).toBe(131072);
    expect(merged.reasoningEfforts).toEqual(["high", "max"]);
    expect(merged.defaultContextWindow).toBe(200000);
  });

  it("returns undefined when neither source has anything", () => {
    expect(mergeCapabilities(undefined, undefined)).toBeUndefined();
  });
});

describe("legacy identity fallback (v1.2 released ids)", () => {
  it("keeps v1.2 public ids resolvable when catalog is unavailable", () => {
    expect(legacyInternalQoderKey("qd/glm-5.3-flash")).toBe("gfmodel");
    expect(legacyInternalQoderKey("glm-5.3-flash")).toBe("gfmodel");
    expect(legacyInternalQoderKey("qd/gfmodel")).toBe("gfmodel");
    expect(legacyInternalQoderKey("qwen3.7-max")).toBe("qmodel_latest");
  });
});

describe("default helpers", () => {
  it("reads the catalog-flagged default effort and window", () => {
    const model = {
      thinking_config: { enabled: { is_default: true, efforts: { high: {}, max: { is_default: true } } } },
      context_config: { "200K": { token_count: 200000, is_default: true }, "1M": { token_count: 1000000 } },
    };
    expect(defaultReasoningEffort(model)).toBe("max");
    expect(defaultContextWindowTokens(model)).toBe(200000);
  });

  it("falls back to top-level default_effort / first bucket", () => {
    expect(defaultReasoningEffort({ default_effort: "low" })).toBe("low");
    expect(defaultContextWindowTokens({ context_config: { "1M": { token_count: 1000000 } } })).toBe(1000000);
    expect(defaultContextWindowTokens({})).toBeUndefined();
  });

  it("honors the direct SDK defaultContextWindow/default_context_window fields", () => {
    expect(defaultContextWindowTokens({ defaultContextWindow: 1000000 })).toBe(1000000);
    expect(defaultContextWindowTokens({ default_context_window: 400000 })).toBe(400000);
    // Direct field wins over context_config when both are present.
    expect(
      defaultContextWindowTokens({
        defaultContextWindow: 1000000,
        context_config: { "200K": { token_count: 200000, is_default: true } },
      })
    ).toBe(1000000);
    // camelCase availableContextWindows fallback works too.
    expect(
      defaultContextWindowTokens({
        availableContextWindows: [400000, 1000000],
        context_config: { "200K": { token_count: 200000 } },
      })
    ).toBe(400000);
  });
});

describe("thinkingCanDisableFact (tri-state)", () => {
  it("returns true when disabled is described in thinking_config", () => {
    expect(thinkingCanDisableFact({ thinking_config: { disabled: { description: "off" } } })).toBe(true);
    expect(supportsDisabledThinking({ thinking_config: { disabled: { description: "off" } } })).toBe(true);
  });

  it("returns explicit false when supports_disabled/supportsDisabled is false", () => {
    expect(thinkingCanDisableFact({ supports_disabled: false })).toBe(false);
    expect(thinkingCanDisableFact({ supportsDisabled: false })).toBe(false);
    expect(thinkingCanDisableFact({ supportsDisabled: true })).toBe(true);
    expect(supportsDisabledThinking({ supports_disabled: false })).toBe(false);
  });

  it("returns undefined (unknown) when the catalog says nothing", () => {
    expect(thinkingCanDisableFact({})).toBeUndefined();
    expect(supportsDisabledThinking({})).toBe(false);
    // qoderCapabilitiesForEntry must not emit the field for unknown tri-state.
    expect(qoderCapabilitiesForEntry({ key: "m", display_name: "M" }).thinkingCanDisable).toBeUndefined();
    // ...but must emit explicit false (not drop it back to base true).
    expect(qoderCapabilitiesForEntry({ key: "m", display_name: "M", supports_disabled: false }).thinkingCanDisable).toBe(false);
  });
});

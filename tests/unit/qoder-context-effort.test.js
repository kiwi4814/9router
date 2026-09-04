/**
 * Unit tests for the v1.1 Qoder executor passthrough of OpenAI-style
 * `reasoning_effort` + `context_length` overrides.
 *
 * Regression surface (v1.1.1 semantics):
 *   - a valid advertised effort level must reach the Qoder wire as
 *     parameters.reasoning_effort + parameters.enable_thinking;
 *   - efforts may be advertised either top-level (`efforts: [...]`) or as
 *     thinking_config.enabled.efforts (dict or array);
 *   - `none`/`off`/`disabled` disable thinking only when the model advertises
 *     disabled support; `auto` and an absent field mean "no override";
 *   - unsupported efforts are ignored (platform default), never crash;
 *   - an EXPLICIT context_length must match an advertised window or the
 *     request FAILS LOUDLY (build throws → execute returns 400); malformed
 *     values throw as well. Absent field keeps v1 behavior;
 *   - two requests differing only in reasoning_effort or context_length must
 *     NOT share a stable request_set_id / chat_record_id.
 */
import { describe, it, expect, vi } from "vitest";

import { __test__ as qoderInternals } from "../../open-sse/executors/qoder.js";

const { buildQoderRequestBody } = qoderInternals;

let uid = 0;
function makeCredentials(userId = `user_v11_${++uid}`) {
  return {
    accessToken: "jt-mock-token-for-test",
    providerSpecificData: {
      userId,
      machineId: "mach_mock_456",
    },
  };
}

const gfmodelConfig = {
  key: "gfmodel",
  display_name: "GLM-5.3-Flash",
  is_reasoning: true,
  is_vl: true,
  max_output_tokens: 32000,
  max_input_tokens: 1000000,
  thinking_config: {
    enabled: {
      is_default: true,
      efforts: {
        high: {},
        max: { is_default: true },
      },
    },
  },
  context_config: {
    "200K": { token_count: 200000, is_default: true },
    "400K": { token_count: 400000 },
    "1M": { token_count: 1000000 },
  },
};

// Official-SDK style: top-level `efforts` list + context config windows.
const topLevelEffortsConfig = {
  key: "dmodel",
  display_name: "DeepSeek-V4-Pro",
  is_reasoning: true,
  max_output_tokens: 32000,
  efforts: ["high", "max"],
  context_config: {
    "200K": { token_count: 200000, is_default: true },
    "1M": { token_count: 1000000 },
  },
};

const disableableConfig = {
  ...gfmodelConfig,
  key: "qmodel_latest",
  thinking_config: {
    disabled: { description: "Disable thinking" },
    enabled: { description: "Enable thinking", is_default: true },
  },
};

const camelCaseConfig = {
  key: "dfmodel",
  display_name: "DeepSeek-V4-Flash",
  is_reasoning: true,
  max_output_tokens: 32000,
  thinkingConfig: {
    enabled: {
      is_default: true,
      efforts: { low: {}, high: {}, max: { is_default: true } },
    },
  },
  contextConfig: {
    "1M": { token_count: 1000000 },
    "200K": { token_count: 200000, is_default: true },
    "400K": { token_count: 400000 },
  },
};

function mockFetchFor(config) {
  return vi.fn(async (url) => {
    if (String(url).includes("model/list")) {
      return new Response(
        JSON.stringify({ chat: [config] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

async function build({ config = gfmodelConfig, body = {}, creds } = {}) {
  const credentials = creds || makeCredentials();
  const warn = vi.fn();
  const { payload } = await buildQoderRequestBody({
    model: config.key,
    body: { model: config.key, messages: [{ role: "user", content: "hi" }], ...body },
    credentials,
    log: { warn, error: vi.fn() },
    proxyOptions: { fetch: mockFetchFor(config) },
  });
  return { payload, warn };
}

describe("reasoning_effort passthrough", () => {
  it("forwards a supported effort + enables thinking (gfmodel / GLM-5.3-Flash)", async () => {
    const { payload } = await build({ body: { reasoning_effort: "max" } });
    expect(payload.parameters).toMatchObject({
      max_tokens: 32000,
      reasoning_effort: "max",
      enable_thinking: true,
    });
  });

  it("forwards an alternative supported effort", async () => {
    const { payload } = await build({ body: { reasoning_effort: "high" } });
    expect(payload.parameters.reasoning_effort).toBe("high");
    expect(payload.parameters.enable_thinking).toBe(true);
  });

  it("accepts a top-level efforts[] list (official SDK shape)", async () => {
    const { payload } = await build({ config: topLevelEffortsConfig, body: { reasoning_effort: "high" } });
    expect(payload.parameters.reasoning_effort).toBe("high");
    expect(payload.parameters.enable_thinking).toBe(true);
  });

  it("rejects a top-level-effort value that is not in the list", async () => {
    const { payload, warn } = await build({ config: topLevelEffortsConfig, body: { reasoning_effort: "low" } });
    expect(payload.parameters.reasoning_effort).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("treats off/disabled the same as none (disables thinking when allowed)", async () => {
    for (const off of ["none", "off", "disabled"]) {
      const { payload } = await build({ config: disableableConfig, body: { reasoning_effort: off } });
      expect(payload.parameters.enable_thinking).toBe(false);
      expect(payload.parameters.reasoning_effort).toBeUndefined();
    }
  });

  it("off/disabled/none are ignored for models without disabled support", async () => {
    for (const off of ["none", "off", "disabled"]) {
      const { payload, warn } = await build({ body: { reasoning_effort: off } });
      expect(payload.parameters.enable_thinking).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    }
  });

  it("auto and blank mean 'no override' (no params, no warning)", async () => {
    for (const value of ["auto", " AUTO ", ""]) {
      const { payload, warn } = await build({ body: { reasoning_effort: value } });
      expect(payload.parameters.reasoning_effort).toBeUndefined();
      expect(payload.parameters.enable_thinking).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it("trims whitespace around the effort value", async () => {
    const { payload } = await build({ body: { reasoning_effort: "  MAX  " } });
    expect(payload.parameters.reasoning_effort).toBe("max");
    expect(payload.parameters.enable_thinking).toBe(true);
  });

  it("ignores an effort the model does not advertise", async () => {
    const { payload, warn } = await build({ body: { reasoning_effort: "xhigh" } });
    expect(payload.parameters.reasoning_effort).toBeUndefined();
    expect(payload.parameters.enable_thinking).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("accepts camelCase model config metadata", async () => {
    const { payload } = await build({ config: camelCaseConfig, body: { reasoning_effort: "max" } });
    expect(payload.parameters.reasoning_effort).toBe("max");
    expect(payload.parameters.enable_thinking).toBe(true);
  });

  it("survives a minimal config with no thinking metadata", async () => {
    const minimal = { key: "auto", display_name: "Auto", max_output_tokens: 16384 };
    const { payload, warn } = await build({ config: minimal, body: { reasoning_effort: "max" } });
    expect(payload.parameters.max_tokens).toBe(16384);
    expect(payload.parameters.reasoning_effort).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe("context_length passthrough", () => {
  it("forwards an advertised 1M context window", async () => {
    const { payload } = await build({ body: { context_length: 1000000 } });
    expect(payload.parameters.context_length).toBe(1000000);
  });

  it("forwards the 400K window", async () => {
    const { payload } = await build({ body: { context_length: 400000 } });
    expect(payload.parameters.context_length).toBe(400000);
  });

  it("throws (fail-loud → HTTP 400) for a context the model does not advertise", async () => {
    await expect(build({ body: { context_length: 500000 } })).rejects.toThrow(
      /does not support context_length=500000/
    );
  });

  it("throws for malformed context_length values", async () => {
    await expect(build({ body: { context_length: "not-a-number" } })).rejects.toThrow(/invalid context_length/);
    await expect(build({ body: { context_length: -1 } })).rejects.toThrow(/invalid context_length/);
    await expect(build({ body: { context_length: 1.5 } })).rejects.toThrow(/invalid context_length/);
  });

  it("lists the supported windows in the 400 error", async () => {
    await expect(build({ body: { context_length: 500000 } })).rejects.toThrow(/200000, 400000, 1000000/);
  });

  it("combines effort + context overrides in one request", async () => {
    const { payload } = await build({
      body: { reasoning_effort: "max", context_length: 1000000 },
    });
    expect(payload.parameters).toMatchObject({
      reasoning_effort: "max",
      enable_thinking: true,
      context_length: 1000000,
    });
  });

  it("keeps v1 behavior (no context_length) when QODER_DEFAULT_MAX_CONTEXT is unset", async () => {
    const prev = process.env.QODER_DEFAULT_MAX_CONTEXT;
    delete process.env.QODER_DEFAULT_MAX_CONTEXT;
    try {
      const { payload } = await build();
      expect(payload.parameters).toEqual({ max_tokens: 32000 });
    } finally {
      if (prev !== undefined) process.env.QODER_DEFAULT_MAX_CONTEXT = prev;
    }
  });

  it("defaults to the largest advertised window when QODER_DEFAULT_MAX_CONTEXT=1", async () => {
    const prev = process.env.QODER_DEFAULT_MAX_CONTEXT;
    process.env.QODER_DEFAULT_MAX_CONTEXT = "1";
    try {
      const { payload } = await build();
      expect(payload.parameters).toEqual({ max_tokens: 32000, context_length: 1000000 });
    } finally {
      if (prev === undefined) delete process.env.QODER_DEFAULT_MAX_CONTEXT;
      else process.env.QODER_DEFAULT_MAX_CONTEXT = prev;
    }
  });
});

describe("stable record identity", () => {
  it("request_set_id/chat_record_id differ when only reasoning_effort changes", async () => {
    const low = await build({ body: { reasoning_effort: "high" } });
    const high = await build({ body: { reasoning_effort: "max" } });
    expect(low.payload.request_set_id).not.toBe(high.payload.request_set_id);
    expect(low.payload.chat_record_id).not.toBe(high.payload.chat_record_id);
  });

  it("request_set_id/chat_record_id differ when only context_length changes", async () => {
    const twoHundred = await build({ body: { context_length: 200000 } });
    const oneM = await build({ body: { context_length: 1000000 } });
    expect(twoHundred.payload.request_set_id).not.toBe(oneM.payload.request_set_id);
    expect(twoHundred.payload.chat_record_id).not.toBe(oneM.payload.chat_record_id);
  });

  it("identical requests still share a stable record id", async () => {
    const a = await build({ body: { reasoning_effort: "max", context_length: 1000000 } });
    const b = await build({ body: { reasoning_effort: "max", context_length: 1000000 } });
    expect(a.payload.request_set_id).toBe(b.payload.request_set_id);
    expect(a.payload.chat_record_id).toBe(b.payload.chat_record_id);
  });
});

describe("public model ids (v1.2)", () => {
  it("resolves a pretty id (glm-5.3-flash) to the internal gfmodel config", async () => {
    const credentials = makeCredentials();
    const { payload } = await buildQoderRequestBody({
      model: "qd/glm-5.3-flash",
      body: { model: "qd/glm-5.3-flash", messages: [{ role: "user", content: "hi" }] },
      credentials,
      log: { warn: vi.fn(), error: vi.fn() },
      proxyOptions: { fetch: mockFetchFor(gfmodelConfig) },
    });
    expect(payload.model_config.key).toBe("gfmodel");
  });

  it("still accepts legacy qd/gfmodel spelling", async () => {
    const { payload } = await build();
    expect(payload.model_config.key).toBe("gfmodel");
    expect(payload.chat_context.extra.modelConfig.key).toBe("gfmodel");
  });

  it("internal catalog key is used for the wire model_config lookup", async () => {
    const credentials = makeCredentials();
    const result = await buildQoderRequestBody({
      model: "glm-5.3-flash",
      body: { model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] },
      credentials,
      log: { warn: vi.fn(), error: vi.fn() },
      proxyOptions: { fetch: mockFetchFor(gfmodelConfig) },
    });
    expect(result.qoderKey).toBe("gfmodel");
  });
});

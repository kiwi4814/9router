/**
 * Unit tests for the v1.1 Qoder executor passthrough of OpenAI-style
 * `reasoning_effort` + `context_length` overrides.
 *
 * Regression surface:
 *   - a valid advertised effort level must reach the Qoder wire as
 *     parameters.reasoning_effort + parameters.enable_thinking;
 *   - reasoning_effort="none" must disable thinking only when the model
 *     advertises disabled support;
 *   - unsupported efforts must be ignored (never crash, never leak into the
 *     payload), matching the platform's default-effort behavior;
 *   - a supported context window (e.g. 1M for GLM-5.3-Flash / gfmodel) must
 *     reach the wire as parameters.context_length; unsupported or malformed
 *     values must be ignored.
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

  it("reasoning_effort=none disables thinking only when the model allows it", async () => {
    const { payload } = await build({ config: disableableConfig, body: { reasoning_effort: "none" } });
    expect(payload.parameters.enable_thinking).toBe(false);
    expect(payload.parameters.reasoning_effort).toBeUndefined();
  });

  it("reasoning_effort=none is ignored for models without disabled support", async () => {
    const { payload, warn } = await build({ body: { reasoning_effort: "none" } });
    expect(payload.parameters.reasoning_effort).toBeUndefined();
    expect(payload.parameters.enable_thinking).toBeUndefined();
    expect(warn).toHaveBeenCalled();
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

  it("ignores a context size the model does not advertise", async () => {
    const { payload, warn } = await build({ body: { context_length: 500000 } });
    expect(payload.parameters.context_length).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("ignores malformed context_length values", async () => {
    const { payload, warn } = await build({ body: { context_length: "not-a-number" } });
    expect(payload.parameters.context_length).toBeUndefined();
    expect(warn).toHaveBeenCalled();
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

  it("leaves parameters untouched when no overrides are sent", async () => {
    const { payload } = await build();
    expect(payload.parameters).toEqual({ max_tokens: 32000 });
  });
});

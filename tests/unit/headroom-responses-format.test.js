// #1998 — Headroom compression treated a Codex (openai-responses) body.input
// array as OpenAI messages: it sent Responses items to /v1/compress and then
// assigned the returned OpenAI messages back to body.input, violating the
// Responses format contract. body.input must stay Responses-shaped.
import { describe, it, expect, vi, afterEach } from "vitest";
import { compressWithHeadroom } from "../../open-sse/rtk/headroom.js";

describe("compressWithHeadroom openai-responses format (#1998)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps body.input in Responses format after compressing an openai-responses request", async () => {
    // Headroom always returns compressed OpenAI-style messages.
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        messages: [{ role: "user", content: "compressed text" }],
        tokens_before: 100,
        tokens_after: 90,
        tokens_saved: 10,
      }),
    }));

    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "a long original message ".repeat(20) }],
        },
      ],
    };

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
    });

    expect(data).not.toBeNull();
    // body.input must remain Responses items (type:"message" + content array),
    // NOT the raw OpenAI messages ({ role, content: "<string>" }) the bug produced.
    expect(Array.isArray(body.input)).toBe(true);
    expect(body.input[0]).toMatchObject({ type: "message", role: "user" });
    expect(Array.isArray(body.input[0].content)).toBe(true);
    expect(typeof body.input[0].content).not.toBe("string");
  });

  it("compresses Responses tool output in place without collapsing protocol items (#2132)", async () => {
    // The proxy only understands OpenAI messages, so a full round-trip would
    // collapse function_call / reasoning items into a plain message. Instead
    // only the plain-text leaf of function_call_output is compressed, and the
    // Responses items stay native and in order (#4070, #2132).
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        messages: [{ role: "tool", tool_call_id: "headroom-tool-0", content: "short summary" }],
        tokens_saved: 10,
      }),
    }));

    const longOutput = "a long tool output line ".repeat(40).trim();
    const input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "investigate bug" }],
      },
      {
        type: "function_call",
        call_id: "call_apply_patch_123",
        name: "apply_patch",
        arguments: "*** Begin Patch\n*** End Patch",
      },
      {
        type: "function_call_output",
        call_id: "call_apply_patch_123",
        output: longOutput,
      },
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Need a plan" }],
      },
    ];
    const body = {
      input: structuredClone(input),
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
        },
      ],
    };
    const diagnostics = {};

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
      diagnostics,
    });

    expect(data).not.toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(payload.messages).toEqual([
      { role: "tool", tool_call_id: "headroom-tool-0", content: longOutput },
    ]);
    expect(body.input.map((item) => item.type)).toEqual([
      "message", "function_call", "function_call_output", "reasoning",
    ]);
    expect(body.input[1]).toEqual(input[1]);
    expect(body.input[3]).toEqual(input[3]);
    expect(body.input[2]).toMatchObject({ call_id: "call_apply_patch_123", output: "short summary" });
    expect(diagnostics.after).toBeDefined();
  });

  it("skips compression when every Responses tool output is structured JSON", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ messages: [], tokens_saved: 0 }),
    }));

    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "check" }] },
      { type: "function_call", call_id: "call_x", name: "lookup", arguments: "{}" },
      { type: "function_call_output", call_id: "call_x", output: '{"ok":true}' },
    ];
    const body = { input: structuredClone(input) };
    const diagnostics = {};

    const data = await compressWithHeadroom(body, {
      enabled: true,
      url: "http://headroom.test",
      model: "gpt-5",
      format: "openai-responses",
      diagnostics,
    });

    expect(data).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(body.input).toEqual(input);
    expect(diagnostics.reason).toBe("no eligible plain-text tool output");
  });
});

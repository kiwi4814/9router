import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { QoderExecutor, __test__ as qoderInternals } from "../../open-sse/executors/qoder.js";

const { isQueueBlock, abortableSleep } = qoderInternals;

describe("isQueueBlock", () => {
  it("detects code 10605 as string", () => {
    expect(isQueueBlock('{"code":"10605","message":"Queue limit"}')).toBe(true);
  });

  it("detects code 10605 as number", () => {
    expect(isQueueBlock('{"code":10605,"message":"Queue limit"}')).toBe(true);
  });

  it("detects isQueued flag", () => {
    expect(isQueueBlock('{"isQueued":true,"message":"waiting"}')).toBe(true);
  });

  it("does not retry isQueued:false", () => {
    expect(isQueueBlock('{"isQueued":false,"message":"not queued"}')).toBe(false);
    expect(isQueueBlock('{\"isQueued\":false}')).toBe(false);
  });

  it("returns false for hard billing errors", () => {
    expect(isQueueBlock('{"code":"112","message":"Quota exhausted"}')).toBe(false);
    expect(isQueueBlock('{"message":"Upgrade required","pricingUrl":"https://qoder.sh/pricing"}')).toBe(false);
  });

  it("returns false for generic errors", () => {
    expect(isQueueBlock('{"code":"401","message":"Unauthorized"}')).toBe(false);
    expect(isQueueBlock('{"code":"500","message":"Internal Server Error"}')).toBe(false);
    expect(isQueueBlock("")).toBe(false);
    expect(isQueueBlock(null)).toBe(false);
  });
});

describe("abortableSleep", () => {
  it("resolves after delay when not aborted", async () => {
    const start = Date.now();
    await abortableSleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it("rejects immediately if signal already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("pre-aborted"));
    await expect(abortableSleep(1000, ctrl.signal)).rejects.toThrow("pre-aborted");
  });

  it("rejects when aborted mid-sleep", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error("mid-sleep abort")), 20);
    await expect(abortableSleep(1000, ctrl.signal)).rejects.toThrow("mid-sleep abort");
  });
});

describe("QoderExecutor queue retry", () => {
  const mockCredentials = {
    accessToken: "jt-mock-token-for-test",
    providerSpecificData: {
      userId: "user_mock_123",
      machineId: "mach_mock_456",
    },
  };

  const sampleChunkEnv = JSON.stringify({
    statusCodeValue: 200,
    body: JSON.stringify({
      id: "chatcmpl-test",
      choices: [{ delta: { content: "Hello" }, index: 0 }],
    }),
  });
  const normalSSE = `data: ${sampleChunkEnv}\n\ndata: [DONE]\n\n`;

  function makeSSEResponse(text, status = 200) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
    return new Response(stream, {
      status,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  function mockModelListResponse() {
    return new Response(
      JSON.stringify({
        chat: [
          {
            key: "auto",
            display_name: "Auto",
            is_reasoning: true,
            max_output_tokens: 16384,
            source: "system",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  beforeEach(() => {
    process.env.QODER_QUEUE_MAX_ATTEMPTS = "3";
    process.env.QODER_QUEUE_BASE_DELAY_MS = "10";
    process.env.QODER_QUEUE_MAX_DELAY_MS = "50";
  });

  afterEach(() => {
    delete process.env.QODER_QUEUE_MAX_ATTEMPTS;
    delete process.env.QODER_QUEUE_BASE_DELAY_MS;
    delete process.env.QODER_QUEUE_MAX_DELAY_MS;
  });

  it("HTTP 403 hard error is not retried", async () => {
    const chatCalls = [];
    const mockFetch = vi.fn(async (url, init) => {
      if (String(url).includes("model/list")) return mockModelListResponse();
      chatCalls.push({ url, init });
      return new Response(
        JSON.stringify({ error: "Unauthorized access", code: 403 }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    });

    const executor = new QoderExecutor();
    const result = await executor.execute({
      model: "auto",
      body: { model: "auto", messages: [{ role: "user", content: "hi" }] },
      credentials: mockCredentials,
      signal: null,
      log: { warn: () => {}, error: () => {} },
      proxyOptions: { fetch: mockFetch },
    });

    expect(chatCalls.length).toBe(1);
    expect(result.response.status).toBe(403);
  });

  it("HTTP 403 10605 is retried", async () => {
    const chatCalls = [];
    const mockFetch = vi.fn(async (url, init) => {
      if (String(url).includes("model/list")) return mockModelListResponse();
      chatCalls.push({ url, init });
      if (chatCalls.length === 1) {
        return new Response(
          JSON.stringify({ code: "10605", message: "Queue limit exceeded" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      return makeSSEResponse(normalSSE);
    });

    const executor = new QoderExecutor();
    const result = await executor.execute({
      model: "auto",
      body: { model: "auto", messages: [{ role: "user", content: "hi" }] },
      credentials: mockCredentials,
      signal: null,
      log: { warn: () => {}, error: () => {} },
      proxyOptions: { fetch: mockFetch },
    });

    expect(chatCalls.length).toBe(2);
    expect(result.response.status).toBe(200);
    const text = await result.response.text();
    expect(text).toContain("Hello");
  });

  it("HTTP 200 first-SSE 10605 is retried without leaking bytes", async () => {
    const chatCalls = [];
    const queueSSE = `data: ${JSON.stringify({
      statusCodeValue: 403,
      body: JSON.stringify({ code: "10605", message: "Queued", isQueued: true }),
    })}\n\n`;

    const mockFetch = vi.fn(async (url, init) => {
      if (String(url).includes("model/list")) return mockModelListResponse();
      chatCalls.push({ url, init });
      if (chatCalls.length === 1) {
        return makeSSEResponse(queueSSE);
      }
      return makeSSEResponse(normalSSE);
    });

    const executor = new QoderExecutor();
    const result = await executor.execute({
      model: "auto",
      body: { model: "auto", messages: [{ role: "user", content: "hi" }] },
      credentials: mockCredentials,
      signal: null,
      log: { warn: () => {}, error: () => {} },
      proxyOptions: { fetch: mockFetch },
    });

    expect(chatCalls.length).toBe(2);
    expect(result.response.status).toBe(200);
    const text = await result.response.text();
    expect(text).toContain("Hello");
    expect(text).not.toContain("10605");
  });

  it("second attempt uses different request IDs", async () => {
    const chatCalls = [];
    const mockFetch = vi.fn(async (url, init) => {
      if (String(url).includes("model/list")) return mockModelListResponse();
      chatCalls.push({ url, init });
      if (chatCalls.length === 1) {
        return new Response(
          JSON.stringify({ code: "10605", message: "Queue limit" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      return makeSSEResponse(normalSSE);
    });

    const executor = new QoderExecutor();
    await executor.execute({
      model: "auto",
      body: { model: "auto", messages: [{ role: "user", content: "hi" }] },
      credentials: mockCredentials,
      signal: null,
      log: { warn: () => {}, error: () => {} },
      proxyOptions: { fetch: mockFetch },
    });

    expect(chatCalls.length).toBe(2);
    const body1 = chatCalls[0].init.body;
    const body2 = chatCalls[1].init.body;
    expect(Buffer.compare(body1, body2)).not.toBe(0);
  });

  it("second attempt has a new COSY signature", async () => {
    const chatCalls = [];
    const mockFetch = vi.fn(async (url, init) => {
      if (String(url).includes("model/list")) return mockModelListResponse();
      chatCalls.push({ url, init });
      if (chatCalls.length === 1) {
        return new Response(
          JSON.stringify({ code: "10605", message: "Queue limit" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      return makeSSEResponse(normalSSE);
    });

    const executor = new QoderExecutor();
    await executor.execute({
      model: "auto",
      body: { model: "auto", messages: [{ role: "user", content: "hi" }] },
      credentials: mockCredentials,
      signal: null,
      log: { warn: () => {}, error: () => {} },
      proxyOptions: { fetch: mockFetch },
    });

    expect(chatCalls.length).toBe(2);
    const sig1 = chatCalls[0].init.headers["Authorization"];
    const sig2 = chatCalls[1].init.headers["Authorization"];
    expect(sig1).toBeDefined();
    expect(sig2).toBeDefined();
    expect(sig1).not.toBe(sig2);
  });

  it("client abort stops retry sleep/fetch", async () => {
    const chatCalls = [];
    const ctrl = new AbortController();

    const mockFetch = vi.fn(async (url, init) => {
      if (String(url).includes("model/list")) return mockModelListResponse();
      chatCalls.push({ url, init });
      setTimeout(() => ctrl.abort(new Error("Client cancelled")), 5);
      return new Response(
        JSON.stringify({ code: "10605", message: "Queue limit" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    });

    process.env.QODER_QUEUE_BASE_DELAY_MS = "500";

    const executor = new QoderExecutor();
    await expect(
      executor.execute({
        model: "auto",
        body: { model: "auto", messages: [{ role: "user", content: "hi" }] },
        credentials: mockCredentials,
        signal: ctrl.signal,
        log: { warn: () => {}, error: () => {} },
        proxyOptions: { fetch: mockFetch },
      })
    ).rejects.toThrow("Client cancelled");

    expect(chatCalls.length).toBe(1);
  });


  it("does not retry generic fetch failures", async () => {
    const chatCalls = [];
    const mockFetch = vi.fn(async (url, init) => {
      if (String(url).includes("model/list")) return mockModelListResponse();
      chatCalls.push({ url, init });
      throw new Error("TLS certificate error");
    });

    const executor = new QoderExecutor();
    await expect(
      executor.execute({
        model: "auto",
        body: { model: "auto", messages: [{ role: "user", content: "hi" }] },
        credentials: mockCredentials,
        signal: null,
        log: { warn: () => {}, error: () => {} },
        proxyOptions: { fetch: mockFetch },
      })
    ).rejects.toThrow("TLS certificate error");

    expect(chatCalls.length).toBe(1);
  });

  it("successful non-queued streams retain latest upstream terminal [DONE] behavior", async () => {
    const mockFetch = vi.fn(async (url) => {
      if (String(url).includes("model/list")) return mockModelListResponse();
      return makeSSEResponse(normalSSE);
    });

    const executor = new QoderExecutor();
    const result = await executor.execute({
      model: "auto",
      body: { model: "auto", messages: [{ role: "user", content: "hi" }] },
      credentials: mockCredentials,
      signal: null,
      log: { warn: () => {}, error: () => {} },
      proxyOptions: { fetch: mockFetch },
    });

    expect(result.response.status).toBe(200);
    const text = await result.response.text();
    expect(text).toContain("data: [DONE]");
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });
});

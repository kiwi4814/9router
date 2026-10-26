/**
 * Executor-level queue recovery.
 *
 * A `10605`/`isQueued` first frame is a transient capacity signal, not a
 * billing/quota block: the executor polls the queue-status endpoint and
 * replays with the SAME request_set_id so the queue entry it waits on is the
 * one it owns. These tests pin that behaviour at the execute() boundary.
 */

import { describe, it, expect, vi } from "vitest";
import { QoderExecutor } from "../../open-sse/executors/qoder.js";

const mockCredentials = {
  accessToken: "jt-mock-token-for-test",
  providerSpecificData: {
    userId: "user_mock_123",
    machineId: "mach_mock_456",
  },
};

const normalEnvelope = JSON.stringify({
  statusCodeValue: 200,
  body: JSON.stringify({
    id: "chatcmpl-test",
    choices: [{ delta: { content: "Hello" }, index: 0 }],
  }),
});
const normalSSE = `data: ${normalEnvelope}\n\ndata: [DONE]\n\n`;

const queueEnvelope = JSON.stringify({
  statusCodeValue: 403,
  body: JSON.stringify({
    code: "10605",
    subCode: "RESOURCE_LIMIT",
    message: JSON.stringify({
      isQueued: true,
      modelKey: "auto",
      queueCount: 0,
      queueType: "p3",
      retryAfterSeconds: 30,
      serviceAvailable: false,
      waitTime: 30,
    }),
  }),
});
const queueSSE = `data: ${queueEnvelope}\n\n`;

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
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const silentLog = { warn: () => {}, error: () => {}, info: () => {} };

describe("QoderExecutor queue recovery", () => {
  it("HTTP 403 hard error is not retried", async () => {
    const chatCalls = [];
    const mockFetch = vi.fn(async (url, init) => {
      if (String(url).includes("model/list")) return mockModelListResponse();
      chatCalls.push({ url, init });
      return new Response(
        JSON.stringify({ error: "Unauthorized access", code: 403 }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    });

    const executor = new QoderExecutor();
    const result = await executor.execute({
      model: "auto",
      body: { model: "auto", messages: [{ role: "user", content: "hi" }] },
      credentials: mockCredentials,
      signal: null,
      log: silentLog,
      proxyOptions: { fetch: mockFetch },
    });

    expect(chatCalls.length).toBe(1);
    expect(result.response.status).toBe(403);
  });

  it.each(["SSE", "HTTP 403"])("recovers a %s queue signal once the status endpoint reports ready", async (transport) => {
    const chatCalls = [];
    const statusCalls = [];
    const mockFetch = vi.fn(async (url, init) => {
      const href = String(url);
      if (href.includes("model/list")) return mockModelListResponse();
      if (href.includes("queue/status")) {
        statusCalls.push(href);
        return jsonResponse({ isQueued: false, modelKey: "auto", queueType: "p3" });
      }
      chatCalls.push({ url: href, init });
      if (chatCalls.length === 1) {
        return transport === "HTTP 403"
          ? new Response(JSON.parse(queueEnvelope).body, {
            status: 403,
            headers: { "Content-Type": "application/json" },
          })
          : makeSSEResponse(queueSSE);
      }
      return makeSSEResponse(normalSSE);
    });

    const executor = new QoderExecutor();
    const result = await executor.execute({
      model: "auto",
      body: { model: "auto", messages: [{ role: "user", content: "hi" }] },
      credentials: mockCredentials,
      signal: null,
      log: silentLog,
      proxyOptions: { fetch: mockFetch },
    });

    expect(statusCalls.length).toBe(1);
    expect(chatCalls.length).toBe(2);
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toContain("Hello");
  });

  it("holds the request while the status endpoint still reports queued", async () => {
    const chatCalls = [];
    const mockFetch = vi.fn(async (url, init) => {
      const href = String(url);
      if (href.includes("model/list")) return mockModelListResponse();
      if (href.includes("queue/status")) {
        return jsonResponse({ isQueued: true, modelKey: "auto", queueType: "p3", retryAfterSeconds: 30 });
      }
      chatCalls.push({ url: href, init });
      return makeSSEResponse(queueSSE);
    });

    const controller = new AbortController();
    const executor = new QoderExecutor();
    const pending = executor.execute({
      model: "auto",
      body: { model: "auto", messages: [{ role: "user", content: "hi" }] },
      credentials: mockCredentials,
      signal: controller.signal,
      log: silentLog,
      proxyOptions: { fetch: mockFetch },
    });

    // One upstream attempt, then a wait — no blind replay storm.
    await vi.waitFor(() => {
      expect(mockFetch.mock.calls.some(([url]) => String(url).includes("queue/status"))).toBe(true);
    });
    expect(chatCalls.length).toBe(1);

    controller.abort(new Error("client hung up"));
    await expect(pending).rejects.toThrow("client hung up");
  });
});

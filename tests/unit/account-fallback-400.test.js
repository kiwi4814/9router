import { describe, expect, it } from "vitest";

import {
  checkFallbackError,
  getQuotaCooldown,
} from "../../open-sse/services/accountFallback.js";

describe("checkFallbackError HTTP 400 ordering", () => {
  it("does not fallback for an ordinary client-side 400", () => {
    expect(checkFallbackError(400, "Bad request", 0)).toEqual({
      shouldFallback: false,
      cooldownMs: 0,
    });
  });

  it("keeps text-based rate-limit rules higher priority than generic 400", () => {
    expect(checkFallbackError(400, "upstream rate limit reached", 0)).toEqual({
      shouldFallback: true,
      cooldownMs: getQuotaCooldown(1),
      newBackoffLevel: 1,
    });
  });

  it("keeps request-not-allowed text fallback active even when status is 400", () => {
    const result = checkFallbackError(400, "request not allowed for this account", 0);
    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });

  it("preserves normal 429 rate-limit backoff semantics", () => {
    expect(checkFallbackError(429, "rate limit", 2)).toEqual({
      shouldFallback: true,
      cooldownMs: getQuotaCooldown(3),
      newBackoffLevel: 3,
    });
  });
});

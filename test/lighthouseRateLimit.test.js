import test from "node:test";
import assert from "node:assert/strict";
import { createLighthouseRateLimiter } from "../src/lighthouse/rateLimit.js";

test("limits repeated Lighthouse lookups per client and resets after the window", () => {
  let currentTime = 1_000;
  const limiter = createLighthouseRateLimiter({
    maxRequests: 2,
    windowMs: 5_000,
    now: () => currentTime,
  });

  assert.deepEqual(limiter.check("client-a"), { allowed: true, remaining: 1 });
  assert.deepEqual(limiter.check("client-a"), { allowed: true, remaining: 0 });
  assert.deepEqual(limiter.check("client-a"), { allowed: false, retryAfterSeconds: 5 });
  assert.deepEqual(limiter.check("client-b"), { allowed: true, remaining: 1 });

  currentTime += 5_000;
  assert.deepEqual(limiter.check("client-a"), { allowed: true, remaining: 1 });
});

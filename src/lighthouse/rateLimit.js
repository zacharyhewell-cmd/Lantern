export function createLighthouseRateLimiter({
  maxRequests = 10,
  windowMs = 60_000,
  now = Date.now,
} = {}) {
  const requestsByClient = new Map();
  let checks = 0;

  function removeExpiredEntries(currentTime) {
    for (const [key, entry] of requestsByClient) {
      if (currentTime >= entry.resetAt) {
        requestsByClient.delete(key);
      }
    }
  }

  return {
    check(key) {
      const currentTime = now();
      checks += 1;
      if (checks % 100 === 0) {
        removeExpiredEntries(currentTime);
      }

      const existing = requestsByClient.get(key);
      const entry = !existing || currentTime >= existing.resetAt
        ? { count: 0, resetAt: currentTime + windowMs }
        : existing;

      if (entry.count >= maxRequests) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1000)),
        };
      }

      entry.count += 1;
      requestsByClient.set(key, entry);
      return {
        allowed: true,
        remaining: Math.max(0, maxRequests - entry.count),
      };
    },
  };
}

/**
 * Per-session token bucket. One bucket per session, refilled lazily on each
 * check. Tiny and synchronous — no external dependency.
 */

export type RateLimiter = {
  /** Returns 0 if a take is allowed; otherwise the ms until one will be. */
  check: () => number;
};

export type RateLimitOpts = {
  perMinute: number; // sustained rate
  burst?: number;    // max tokens at once; defaults to perMinute
};

export function createRateLimiter(opts: RateLimitOpts): RateLimiter {
  const capacity = opts.burst ?? opts.perMinute;
  const refillRatePerMs = opts.perMinute / 60_000;
  let tokens = capacity;
  let lastRefillMs = Date.now();

  const refill = () => {
    const now = Date.now();
    const dt = now - lastRefillMs;
    if (dt > 0) {
      tokens = Math.min(capacity, tokens + dt * refillRatePerMs);
      lastRefillMs = now;
    }
  };

  return {
    check() {
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return 0;
      }
      const needed = 1 - tokens;
      return Math.ceil(needed / refillRatePerMs);
    },
  };
}

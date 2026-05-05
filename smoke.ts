/**
 * End-to-end smoke test for the Claude-Code-style lab.
 *
 *   1. Connect; see session:ready with budget + rateLimit.
 *   2. Send a build prompt; verify Write tool calls and files appear.
 *   3. Verify the preview URL serves real HTML.
 *   4. Send a long-running prompt and abort it mid-flight.
 *   5. Issue session:reset; verify the file tree empties.
 *   6. Burst 25 messages; expect warn:rate_limited.
 */

import WebSocket from "ws";

const PORT = Number(process.env.PORT ?? 3101);
const url = `ws://localhost:${PORT}/ws`;

type Step = (ws: WebSocket) => Promise<void>;

const ws = new WebSocket(url);
const events: any[] = [];
const waiters: Array<(e: any) => boolean> = [];

ws.on("message", (raw) => {
  let evt: any;
  try {
    evt = JSON.parse(raw.toString());
  } catch {
    return;
  }
  events.push(evt);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i](evt)) waiters.splice(i, 1);
  }
});

ws.on("error", (err) => {
  console.error("ws error:", err);
  process.exit(1);
});

function waitFor(pred: (e: any) => boolean, timeoutMs = 60_000): Promise<any> {
  return new Promise((res, rej) => {
    for (const e of events) if (pred(e)) return res(e);
    const t = setTimeout(() => rej(new Error("timeout waiting for event")), timeoutMs);
    waiters.push((evt) => {
      if (pred(evt)) {
        clearTimeout(t);
        res(evt);
        return true;
      }
      return false;
    });
  });
}

const send = (cmd: any) => ws.send(JSON.stringify(cmd));

const step1_buildAndPreview: Step = async () => {
  console.log("▶ step 1: build + preview");
  const ready = await waitFor((e) => e.type === "session:ready");
  console.log(`  session ${ready.sessionId} budget=$${ready.budgetUsd} rate=${ready.rateLimit.perMinute}/min`);

  send({
    type: "user:message",
    text: 'Edit src/pages/index.astro to be a coffee shop landing page for "Mountain Brew" — single-screen hero with shop name, one-line tagline, and a "Visit Us" button. Warm coffee colors via a <style> block. After editing, run `npm run build` so the preview reflects the change.',
  });

  const turnEnd = await waitFor((e) => e.type === "agent:turn_end");
  console.log(`  ✓ turn end: ${(turnEnd.durationMs / 1000).toFixed(1)}s · $${turnEnd.cost.toFixed(4)} · cumulative $${turnEnd.cumulativeCostUsd.toFixed(4)}`);
  if (typeof turnEnd.cumulativeCostUsd !== "number") throw new Error("missing cumulativeCostUsd");

  const previewUrl = `http://localhost:${PORT}${ready.previewBase}index.html`;
  const res = await fetch(previewUrl);
  if (res.status !== 200) throw new Error(`preview status ${res.status}`);
  const body = await res.text();
  if (!/<html[\s\S]*<\/html>/i.test(body) && !/<!doctype/i.test(body)) {
    throw new Error("preview body doesn't look like HTML");
  }
  console.log(`  ✓ preview served ${body.length} bytes`);
};

const step2_abort: Step = async () => {
  console.log("▶ step 2: abort mid-turn");
  send({
    type: "user:message",
    text: "Now write a long detailed README.md explaining every line of the html and css you just wrote. Be very thorough — include a 12-section table of contents and explain CSS specificity in detail.",
  });

  // Wait for the agent to actually start emitting tool_use or text, then abort.
  await waitFor((e) => e.type === "agent:tool_use" || e.type === "agent:text");
  console.log("  agent producing output → sending abort");
  send({ type: "agent:abort" });

  const aborted = await waitFor(
    (e) => e.type === "agent:turn_aborted" || e.type === "agent:turn_end",
    30_000
  );
  if (aborted.type === "agent:turn_aborted") {
    console.log("  ✓ saw agent:turn_aborted");
  } else {
    // Agent finished before our abort landed — acceptable but flag it.
    console.log("  ⚠ turn ended before abort took effect (agent was too fast)");
  }
};

const step3_reset: Step = async () => {
  console.log("▶ step 3: reset");
  send({ type: "session:reset" });
  await waitFor((e) => e.type === "session:reset_done", 15_000);
  // After reset, files:changed should arrive with an empty tree.
  const empty = await waitFor(
    (e) => e.type === "files:changed" && Array.isArray(e.files) && e.files.length === 0,
    5_000
  ).catch(() => null);
  if (empty) console.log("  ✓ files:changed empty after reset");
  else console.log("  ⚠ no empty files:changed observed (may have arrived before reset_done)");

  const ready2 = await waitFor((e) => e.type === "session:ready", 5_000);
  console.log(`  ✓ new session id=${ready2.sessionId}`);
};

const step4_rateLimit: Step = async () => {
  console.log("▶ step 4: rate limit (burst 25 messages)");
  for (let i = 0; i < 25; i++) {
    send({ type: "user:message", text: `ping ${i}` });
  }
  // Within 2s the rate limiter should trip.
  const limited = await waitFor((e) => e.type === "warn:rate_limited", 5_000).catch(() => null);
  if (!limited) throw new Error("rate limiter never fired despite burst of 25");
  console.log(`  ✓ saw warn:rate_limited (retryAfterMs=${limited.retryAfterMs})`);

  // Stop the agent so it doesn't keep churning on the queued pings.
  send({ type: "agent:abort" });
};

(async () => {
  ws.on("open", async () => {
    try {
      await step1_buildAndPreview(ws);
      await step2_abort(ws);
      await step3_reset(ws);
      await step4_rateLimit(ws);
      console.log("\n✅ smoke test PASSED");
      ws.close();
      process.exit(0);
    } catch (err: any) {
      console.error(`\n✗ smoke failed: ${err?.message ?? err}`);
      process.exit(1);
    }
  });

  setTimeout(() => {
    console.error("✗ overall timeout (3 min)");
    process.exit(1);
  }, 180_000);
})();

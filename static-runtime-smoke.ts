import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();

async function exists(path: string): Promise<boolean> {
  try {
    await access(resolve(root, path));
    return true;
  } catch {
    return false;
  }
}

async function read(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf-8");
}

async function assertOk(condition: boolean, message: string): Promise<void> {
  if (!condition) throw new Error(message);
}

async function assertMissing(path: string): Promise<void> {
  assertOk(!(await exists(path)), `${path} should not exist`);
}

async function assertFile(path: string): Promise<void> {
  const full = resolve(root, path);
  const s = await stat(full);
  assertOk(s.isFile(), `${path} should be a file`);
}

async function assertNoText(path: string, banned: string[]): Promise<void> {
  const text = await read(path);
  for (const token of banned) {
    assertOk(!text.includes(token), `${path} still contains ${token}`);
  }
}

await assertFile("templates/static-site/index.html");
await assertFile("templates/static-site/styles.css");
await assertFile("templates/static-site/script.js");
await assertMissing("templates/astro-basics");

await assertNoText("server/index.ts", [
  "startAutoBuilder",
  "startE2BPreviewRuntime",
  "E2B_RUNTIME_ENABLED",
  "isSrcNewerThanDist",
]);
await assertNoText("server/env.ts", ["LAB_RUNTIME", "E2B_API_KEY"]);
await assertNoText("server/agent.ts", [
  "Astro",
  "astro",
  "npm run build",
  "npm run dev",
  "src/pages",
  "settings: inlineSettings",
  "advisor",
  "Advisor",
  "ADVISOR",
  "cloudwise_advisor",
  "mcp__cloudwise_advisor",
  "createSdkMcpServer",
]);
await assertNoText("shared/events.ts", ["advisor", "Advisor", "ADVISOR"]);
await assertNoText("web/src/lib/models.ts", ["advisor", "Advisor", "ADVISOR"]);
await assertNoText("web/src/lib/useLabSession.ts", ["advisor", "Advisor", "ADVISOR"]);
await assertNoText("web/src/components/ChatPanel.tsx", ["advisor", "Advisor", "ADVISOR"]);
await assertNoText("web/src/components/SettingsPanel.tsx", ["advisor", "Advisor", "ADVISOR"]);
await assertNoText("render.yaml", [
  "LAB_RUNTIME",
  "E2B_API_KEY",
  "LAB_ADVISOR",
  "advisor",
  "Advisor",
  "ADVISOR",
]);
await assertNoText("README.md", ["advisor", "Advisor", "ADVISOR"]);

const agentSource = await read("server/agent.ts");
await assertOk(
  agentSource.includes("const visibleActivity = routeSdkMessage(msg, emit);"),
  "server/agent.ts should base the stall watchdog on visible SDK activity"
);
await assertOk(
  agentSource.includes("[agent] visible-activity timeout"),
  "server/agent.ts should log visible-activity watchdog timeouts for Render debugging"
);

const pkg = JSON.parse(await read("package.json")) as {
  dependencies?: Record<string, string>;
};
await assertOk(!pkg.dependencies?.e2b, "package.json should not depend on e2b");
await assertOk(
  !pkg.dependencies?.["@anthropic-ai/sdk"],
  "package.json should not directly depend on @anthropic-ai/sdk"
);

console.log("Static preview runtime smoke passed.");

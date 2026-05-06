/**
 * Loads .env and applies the two auth workarounds we discovered in Phase 0:
 *   1. dotenv `override: true` because some shells (e.g. Claude for Desktop) export
 *      ANTHROPIC_API_KEY="" empty, which would otherwise block the .env value.
 *   2. CLAUDE_CONFIG_DIR pinned to a fresh temp dir so the bundled claude CLI
 *      can't fall back to stale oauth in ~/.claude/credentials or the macOS keychain.
 *
 * Import this *before* importing anything from @anthropic-ai/claude-agent-sdk.
 */

import { config as loadDotenv } from "dotenv";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

loadDotenv({ override: true });

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("missing ANTHROPIC_API_KEY (check cloudwise-lab/.env)");
  process.exit(1);
}

if (process.env.LAB_RUNTIME === "e2b" && !process.env.E2B_API_KEY) {
  console.error("missing E2B_API_KEY while LAB_RUNTIME=e2b");
  process.exit(1);
}

const isolatedConfig = mkdtempSync(join(tmpdir(), "cloudwise-lab-"));
process.env.CLAUDE_CONFIG_DIR = isolatedConfig;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

export const PORT = Number(process.env.PORT ?? 3101);
export const MODEL = process.env.LAB_MODEL ?? "claude-sonnet-4-6";
export const ISOLATED_CLAUDE_CONFIG = isolatedConfig;
export const LAB_RUNTIME = process.env.LAB_RUNTIME === "e2b" ? "e2b" : "local";
export const E2B_RUNTIME_ENABLED = LAB_RUNTIME === "e2b";

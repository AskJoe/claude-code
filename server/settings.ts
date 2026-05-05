/**
 * Runtime settings cache. Loaded from the lab_settings table at boot, mutated
 * via the admin Settings tab, read by agent.ts (budget) and the WS handler
 * (rate limit) on every new session.
 *
 * Existing in-flight sessions keep their original cap until they reset — the
 * cache only affects NEW sessions started after a settings change.
 */

import { getAllSettings, setSetting } from "./db.ts";
import { log } from "./log.ts";

export type LabSettings = {
  defaultModel: string;
  defaultBudgetUsd: number;
  rateLimitPerMinute: number;
};

const DEFAULTS: LabSettings = {
  defaultModel: "claude-sonnet-4-6",
  defaultBudgetUsd: 1.0,
  rateLimitPerMinute: 20,
};

let cache: LabSettings = { ...DEFAULTS };

/** Loads the cache from the DB. Falls back to DEFAULTS for missing keys. */
export function reloadSettings(): LabSettings {
  const raw = getAllSettings();
  const next: LabSettings = {
    defaultModel: raw.default_model ?? DEFAULTS.defaultModel,
    defaultBudgetUsd: numFrom(raw.default_budget_usd, DEFAULTS.defaultBudgetUsd),
    rateLimitPerMinute: intFrom(
      raw.rate_limit_per_minute,
      DEFAULTS.rateLimitPerMinute
    ),
  };
  cache = next;
  return cache;
}

export function getSettings(): LabSettings {
  return cache;
}

export function updateSettings(patch: Partial<LabSettings>): LabSettings {
  if (patch.defaultModel !== undefined) {
    if (!patch.defaultModel.trim()) throw new Error("defaultModel cannot be empty");
    setSetting("default_model", patch.defaultModel.trim());
  }
  if (patch.defaultBudgetUsd !== undefined) {
    if (!Number.isFinite(patch.defaultBudgetUsd) || patch.defaultBudgetUsd <= 0) {
      throw new Error("defaultBudgetUsd must be a positive number");
    }
    setSetting("default_budget_usd", String(patch.defaultBudgetUsd));
  }
  if (patch.rateLimitPerMinute !== undefined) {
    if (
      !Number.isInteger(patch.rateLimitPerMinute) ||
      patch.rateLimitPerMinute <= 0
    ) {
      throw new Error("rateLimitPerMinute must be a positive integer");
    }
    setSetting("rate_limit_per_minute", String(patch.rateLimitPerMinute));
  }
  reloadSettings();
  log.info("lab settings updated", cache as unknown as Record<string, unknown>);
  return cache;
}

function numFrom(s: string | undefined, fallback: number): number {
  if (s == null) return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}
function intFrom(s: string | undefined, fallback: number): number {
  if (s == null) return fallback;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Initialize on import.
reloadSettings();

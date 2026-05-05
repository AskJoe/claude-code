/**
 * Executor + advisor presets.
 *
 * Each preset pairs an executor model (the one running tool calls and writing
 * the user-facing output) with an optional advisor model (Opus 4.7) that gets
 * called server-side via Anthropic's advisor tool when the executor needs
 * strategic guidance. The advisor returns a 400–700-token plan, and the
 * executor continues — all inside one /v1/messages request, advisor billed
 * separately at Opus rates.
 *
 * See https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool
 */

import type { ExecutorModel, AdvisorModel } from "../../../shared/events.ts";

export type PresetId =
  | "frugal"
  | "frugal-advisor"
  | "default"
  | "default-advisor"
  | "maximum";

export type Preset = {
  id: PresetId;
  label: string;
  executor: ExecutorModel;
  advisor: AdvisorModel; // null = advisor disabled
  hint: string;
  recommended?: boolean;
};

export const PRESETS: Preset[] = [
  {
    id: "frugal",
    label: "Frugal",
    executor: "haiku-4.5",
    advisor: null,
    hint: "Haiku alone. Cheapest; fewer features.",
  },
  {
    id: "frugal-advisor",
    label: "Frugal + advisor",
    executor: "haiku-4.5",
    advisor: "opus-4.7",
    hint: "Haiku driven, Opus consulted. Smart on a budget.",
  },
  {
    id: "default",
    label: "Default",
    executor: "sonnet-4.6",
    advisor: null,
    hint: "Sonnet alone. The current behavior.",
  },
  {
    id: "default-advisor",
    label: "Default + advisor",
    executor: "sonnet-4.6",
    advisor: "opus-4.7",
    hint: "Sonnet + Opus advisor. +2.7 pp uplift, ~12% cheaper than Default on benchmarks.",
    recommended: true,
  },
  {
    id: "maximum",
    label: "Maximum",
    executor: "opus-4.7",
    advisor: null,
    hint: "Opus alone. Top quality, top cost.",
  },
];

export const DEFAULT_PRESET_ID: PresetId = "default";

const STORAGE_KEY = "lab.modelPreset";
const LEGACY_STORAGE_KEY = "lab.modelPreference";

/** Map a legacy `lab.modelPreference` value to its closest new preset. */
function migrateLegacy(legacy: string | null): PresetId | null {
  if (!legacy) return null;
  if (legacy === "sonnet-4.6") return "default";
  if (legacy === "opus-4.7") return "maximum";
  if (legacy === "haiku") return "frugal";
  return null;
}

/** Read the user's preset choice, with one-time migration from the old key. */
export function loadPresetId(): PresetId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && PRESETS.some((p) => p.id === raw)) {
      return raw as PresetId;
    }
    const migrated = migrateLegacy(localStorage.getItem(LEGACY_STORAGE_KEY));
    if (migrated) {
      localStorage.setItem(STORAGE_KEY, migrated);
      try {
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch {}
      return migrated;
    }
  } catch {}
  return DEFAULT_PRESET_ID;
}

export function savePresetId(id: PresetId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {}
}

export function getPreset(id: PresetId): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[2]; // default
}

/** Display string for the chat header pill. */
export function presetPillLabel(p: Preset): string {
  return p.advisor ? `${p.label}` : p.label;
}

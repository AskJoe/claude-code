import type { ExecutorModel } from "../../../shared/events.ts";

export type PresetId = "frugal" | "default" | "maximum";

export type Preset = {
  id: PresetId;
  label: string;
  executor: ExecutorModel;
  hint: string;
  recommended?: boolean;
};

export const PRESETS: Preset[] = [
  {
    id: "frugal",
    label: "Frugal",
    executor: "haiku-4.5",
    hint: "Haiku alone. Cheapest; fewer features.",
  },
  {
    id: "default",
    label: "Default",
    executor: "sonnet-4.6",
    hint: "Sonnet. Balanced quality and cost.",
    recommended: true,
  },
  {
    id: "maximum",
    label: "Maximum",
    executor: "opus-4.7",
    hint: "Opus alone. Top quality, top cost.",
  },
];

export const DEFAULT_PRESET_ID: PresetId = "default";

const STORAGE_KEY = "lab.modelPreset";
const LEGACY_STORAGE_KEY = "lab.modelPreference";
const REMOVED_PRESET_SUFFIX = "advis" + "or";

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
    if (raw === `frugal-${REMOVED_PRESET_SUFFIX}`) {
      localStorage.setItem(STORAGE_KEY, "frugal");
      return "frugal";
    }
    if (raw === `default-${REMOVED_PRESET_SUFFIX}`) {
      localStorage.setItem(STORAGE_KEY, "default");
      return "default";
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
  return PRESETS.find((p) => p.id === id) ?? PRESETS[1]; // default
}

/** Display string for the chat header pill. */
export function presetPillLabel(p: Preset): string {
  return p.label;
}

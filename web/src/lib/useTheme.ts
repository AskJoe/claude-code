import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "lab.theme";

function readStored(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {}
  return "system";
}

function systemPrefers(): ResolvedTheme {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function resolve(choice: ThemeChoice): ResolvedTheme {
  return choice === "system" ? systemPrefers() : choice;
}

function applyToBody(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  document.body.setAttribute("data-theme", resolved);
}

/**
 * Manages the user's theme choice across the app.
 *
 * Choice persists to localStorage; resolved theme (after expanding "system")
 * is applied to <body data-theme>. Listens to system theme changes when in
 * "system" mode.
 */
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readStored());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(readStored()));

  // Apply to body whenever resolved value changes.
  useEffect(() => {
    applyToBody(resolved);
  }, [resolved]);

  // Re-resolve when choice changes; persist.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, choice);
    } catch {}
    setResolved(resolve(choice));
  }, [choice]);

  // Watch system preference if we're in "system" mode.
  useEffect(() => {
    if (choice !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(mql.matches ? "dark" : "light");
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, [choice]);

  const cycle = useCallback(() => {
    setChoice((prev) =>
      prev === "light" ? "dark" : prev === "dark" ? "system" : "light"
    );
  }, []);

  return { choice, resolved, setChoice, cycle };
}

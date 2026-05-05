import type { ThemeChoice } from "../lib/useTheme.ts";

/**
 * Small icon button that cycles light → dark → system → light.
 * The cycle/state is owned by the hook; this is a presentation control.
 */
export function ThemeToggle({
  choice,
  resolved,
  onCycle,
}: {
  choice: ThemeChoice;
  resolved: "light" | "dark";
  onCycle: () => void;
}) {
  const label =
    choice === "system"
      ? `Theme: system (${resolved}). Click to use light.`
      : choice === "light"
        ? "Theme: light. Click to use dark."
        : "Theme: dark. Click to use system.";

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onCycle}
      title={label}
      aria-label={label}
    >
      {choice === "system" ? <SystemIcon /> : resolved === "dark" ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13 9.5A6 6 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="3" width="12" height="8" rx="1" />
      <path d="M5 13h6M8 11v2" />
    </svg>
  );
}

/**
 * Keyboard shortcut help (`?`).
 *
 * Modal listing every binding from lib/shortcuts.ts, grouped by section.
 * Triggered globally from App.tsx; closed by Esc, the close button, or
 * clicking the backdrop.
 */

import { useEffect } from "react";
import { SHORTCUTS, SHORTCUT_GROUPS, type Shortcut } from "../lib/shortcuts.ts";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function ShortcutsOverlay({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // Group on the fly to keep shortcuts.ts a flat list (easier to scan).
  const grouped = SHORTCUT_GROUPS.map((group) => ({
    group,
    items: SHORTCUTS.filter((s) => s.group === group),
  }));

  return (
    <div className="shortcuts-backdrop" onMouseDown={onClose} role="dialog" aria-modal="true">
      <div
        className="shortcuts-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shortcuts-head">
          <h2 className="shortcuts-title">Keyboard shortcuts</h2>
          <button
            type="button"
            className="shortcuts-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="shortcuts-grid">
          {grouped.map(({ group, items }) =>
            items.length === 0 ? null : (
              <section key={group} className="shortcuts-section">
                <h3 className="shortcuts-section-title">{group}</h3>
                <dl className="shortcuts-dl">
                  {items.map((s) => (
                    <Row key={s.id} s={s} />
                  ))}
                </dl>
              </section>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ s }: { s: Shortcut }) {
  return (
    <>
      <dt className="shortcuts-keys">
        <kbd>{s.keys}</kbd>
      </dt>
      <dd className="shortcuts-desc">{s.description}</dd>
    </>
  );
}

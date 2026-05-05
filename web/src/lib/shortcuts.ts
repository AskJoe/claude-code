/**
 * Source-of-truth list of keyboard shortcuts.
 *
 * Drives the `?` overlay (ShortcutsOverlay.tsx). Drives copy in the command
 * palette hints. The actual key handlers are wired in App.tsx (global) and
 * ChatPanel.tsx (input-scoped).
 *
 * TODO(phase 2.4): user-customizable bindings live in a future SettingsPanel.
 * When that lands, layer a `localStorage.lab.keybindings` override on top of
 * this list before exporting.
 */

export type ShortcutGroup = "Chat" | "Navigation" | "Editor" | "View";

export type Shortcut = {
  id: string;
  /** Human-readable key combo for display, e.g. "⌘K", "⇧↵". */
  keys: string;
  description: string;
  group: ShortcutGroup;
};

export const SHORTCUTS: Shortcut[] = [
  // Chat
  { id: "send", keys: "⌘↵", description: "Send message", group: "Chat" },
  { id: "send-enter", keys: "↵", description: "Send message", group: "Chat" },
  { id: "newline", keys: "⇧↵", description: "Newline", group: "Chat" },
  { id: "stop", keys: "⌘.", description: "Stop agent", group: "Chat" },
  { id: "cancel", keys: "Esc", description: "Cancel current input", group: "Chat" },
  { id: "reset", keys: "⌘⌫", description: "Reset session", group: "Chat" },

  // Navigation
  { id: "palette", keys: "⌘K", description: "Command palette", group: "Navigation" },
  { id: "shortcuts", keys: "?", description: "This screen", group: "Navigation" },
  { id: "settings", keys: "⌘,", description: "Settings", group: "Navigation" },
  { id: "quick-file", keys: "⌘P", description: "Quick file picker", group: "Navigation" },
  { id: "global-search", keys: "⌘⇧F", description: "Global search", group: "Navigation" },

  // Editor
  { id: "edit-mode", keys: "⌘E", description: "Toggle preview edit mode", group: "Editor" },
  { id: "save", keys: "⌘S", description: "Save changes (when editing)", group: "Editor" },
  { id: "comment-toggle", keys: "⌘/", description: "Comment toggle (in editor)", group: "Editor" },

  // View
  { id: "theme", keys: "⌘L", description: "Cycle theme", group: "View" },
  { id: "sidebar", keys: "⌘B", description: "Toggle sidebar", group: "View" },
  { id: "view-files", keys: "⌘1", description: "Files pane", group: "View" },
  { id: "view-preview", keys: "⌘2", description: "Preview pane", group: "View" },
  { id: "view-code", keys: "⌘3", description: "Code pane", group: "View" },
];

export const SHORTCUT_GROUPS: ShortcutGroup[] = ["Chat", "Navigation", "Editor", "View"];

/**
 * Source-of-truth list for the command palette (CommandPalette.tsx).
 *
 * Each command receives a CommandContext with the actions it can call. The
 * caller (ChatPanel/Lab) wires the context up; commands that aren't yet
 * connected to real functionality fall through to ctx.notify which logs and
 * shows a system message in chat.
 */

export type CommandGroup = "Chat" | "View" | "Project" | "Theme" | "Help";

export type CommandContext = {
  reset: () => void;
  clearChat: () => void;
  setRightView: (v: "preview" | "code") => void;
  setTheme: (t: "light" | "dark" | "system") => void;
  exportTranscript: (format: "markdown" | "json") => void;
  showShortcuts: () => void;
  copyLastAssistant: () => void;
  showHistory: () => void;
  showSettings: () => void;
  showCost: () => void;
  /** Used by stub commands: "Not yet wired" notice surfaces to the user. */
  notify: (text: string) => void;
};

export type Command = {
  id: string;
  label: string;
  hint?: string;
  group: CommandGroup;
  action: (ctx: CommandContext) => void;
};

export const COMMANDS: Command[] = [
  // Chat
  { id: "clear", label: "Clear chat", group: "Chat", action: (c) => c.clearChat() },
  { id: "reset", label: "Reset session", hint: "wipes files too", group: "Chat", action: (c) => c.reset() },
  { id: "compact", label: "Compact context", hint: "summarize older turns", group: "Chat", action: (c) => c.notify("/compact — not yet wired") },
  { id: "copy-last", label: "Copy last assistant message", group: "Chat", action: (c) => c.copyLastAssistant() },

  // View
  { id: "view-preview", label: "Show preview", group: "View", action: (c) => c.setRightView("preview") },
  { id: "view-code", label: "Show source files", group: "View", action: (c) => c.setRightView("code") },
  { id: "history", label: "Toggle commit history", group: "View", action: (c) => c.showHistory() },

  // Theme
  { id: "theme-light", label: "Theme: light", group: "Theme", action: (c) => c.setTheme("light") },
  { id: "theme-dark", label: "Theme: dark", group: "Theme", action: (c) => c.setTheme("dark") },
  { id: "theme-system", label: "Theme: follow system", group: "Theme", action: (c) => c.setTheme("system") },

  // Project
  { id: "restart-preview", label: "Reload preview", group: "Project", action: (c) => c.notify("/reload preview — use the preview refresh button") },
  { id: "cost", label: "Show cost dashboard", group: "Project", action: (c) => c.showCost() },
  { id: "doctor", label: "Run connectivity + auth check", group: "Project", action: (c) => c.notify("/doctor — not yet wired") },
  { id: "share", label: "Generate share link", group: "Project", action: (c) => c.notify("/share — not yet wired") },
  { id: "export-md", label: "Export transcript as Markdown", group: "Project", action: (c) => c.exportTranscript("markdown") },
  { id: "export-json", label: "Export transcript as JSON", group: "Project", action: (c) => c.exportTranscript("json") },
  { id: "model-sonnet", label: "Use Sonnet model", group: "Project", action: (c) => c.notify("/model sonnet — not yet wired") },
  { id: "model-opus", label: "Use Opus model", group: "Project", action: (c) => c.notify("/model opus — not yet wired") },
  { id: "model-haiku", label: "Use Haiku model", group: "Project", action: (c) => c.notify("/model haiku — not yet wired") },

  // Help
  { id: "help", label: "Show keyboard shortcuts", hint: "?", group: "Help", action: (c) => c.showShortcuts() },
  { id: "open-settings", label: "Open settings", hint: "⌘,", group: "Help", action: (c) => c.showSettings() },
];

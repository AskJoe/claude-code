/**
 * Tiny logger. Human-readable in dev, JSON lines in prod (so Render/Datadog can
 * parse). No external dep — pino/winston are overkill for our handful of
 * call sites.
 */

const isProd = process.env.NODE_ENV === "production";

export type Logger = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
};

function emit(level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) {
  if (isProd) {
    const line = JSON.stringify({
      level,
      msg,
      ts: new Date().toISOString(),
      ...meta,
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
    return;
  }
  const tag = level === "error" ? "✗" : level === "warn" ? "⚠" : "▶";
  const m = meta ? ` ${JSON.stringify(meta)}` : "";
  if (level === "error") console.error(`${tag} ${msg}${m}`);
  else if (level === "warn") console.warn(`${tag} ${msg}${m}`);
  else console.log(`${tag} ${msg}${m}`);
}

export const log: Logger = {
  info: (msg, meta) => emit("info", msg, meta),
  warn: (msg, meta) => emit("warn", msg, meta),
  error: (msg, meta) => emit("error", msg, meta),
};

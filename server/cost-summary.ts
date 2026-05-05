/**
 * Cost summary for the cost dashboard.
 *
 * GET /api/projects/:id/cost-summary
 *
 * Aggregates the project's persisted messages into:
 *   - 30 days of daily total cost (date, costUsd)
 *   - top tool_use invocations grouped by tool name
 *   - top chat sessions by spend
 *   - all-time totals
 *
 * No new tables — derived entirely from `messages` + `chat_sessions`. The
 * lab logs every turn_end with cost_usd and every tool_use as a separate
 * row, so the math is just GROUP BY queries.
 */

import type { Hono } from "hono";

import { authMiddleware } from "./auth.ts";
import { getProjectFor } from "./projects.ts";
import { listChatSessions, listMessages } from "./db.ts";

type DailyTotal = { date: string; costUsd: number };
type ToolCount = { tool: string; count: number };
type SessionTotal = {
  id: number;
  title: string | null;
  costUsd: number;
  messageCount: number;
  createdAt: string;
  archived: boolean;
};

const DAYS_BACK = 30;

function startOfTodayUTC(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function dayKey(iso: string): string {
  // Take the YYYY-MM-DD prefix from any ISO timestamp.
  return iso.slice(0, 10);
}

export function mountCostSummary(app: Hono): void {
  app.get("/api/projects/:id/cost-summary", authMiddleware, (c) => {
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    const project = getProjectFor(user.id, id);
    if (!project) return c.json({ error: "not found" }, 404);

    // Bring in everything for the project. With message_count caps in the
    // hundreds per session and budgets capping cost per project, this is
    // typically a few hundred rows. Still, cap at 5000 for safety.
    const rows = listMessages(id, 5000);

    // ── Daily totals (last 30 days) ──────────────────────────────────────
    const today = startOfTodayUTC();
    const dailyMap = new Map<string, number>();
    for (let i = 0; i < DAYS_BACK; i += 1) {
      const d = new Date(today.getTime() - i * 86400_000);
      const key = d.toISOString().slice(0, 10);
      dailyMap.set(key, 0);
    }
    let allTimeTotal = 0;
    for (const r of rows) {
      const cost = r.cost_usd ?? 0;
      if (cost <= 0) continue;
      allTimeTotal += cost;
      const key = dayKey(r.created_at);
      if (dailyMap.has(key)) {
        dailyMap.set(key, (dailyMap.get(key) ?? 0) + cost);
      }
    }
    const daily: DailyTotal[] = Array.from(dailyMap.entries())
      .map(([date, costUsd]) => ({ date, costUsd }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    // ── Tool counts ──────────────────────────────────────────────────────
    const toolCounts = new Map<string, number>();
    for (const r of rows) {
      // Cheap pre-filter — only inspect rows whose JSON contains the tool
      // marker. Keeps us out of JSON.parse for every text row.
      if (!r.content_json.includes('"agent:tool_use"')) continue;
      try {
        const parsed = JSON.parse(r.content_json) as Record<string, unknown>;
        if (parsed.type !== "agent:tool_use") continue;
        const tool = String(parsed.tool ?? "unknown");
        toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
      } catch {}
    }
    const tools: ToolCount[] = Array.from(toolCounts.entries())
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count);

    // ── Per-session totals ──────────────────────────────────────────────
    const sessions: SessionTotal[] = listChatSessions(id).map((s) => ({
      id: s.id,
      title: s.title,
      costUsd: s.total_cost_usd ?? 0,
      messageCount: s.message_count ?? 0,
      createdAt: s.created_at,
      archived: s.archived_at !== null,
    }));

    // ── Quick totals ────────────────────────────────────────────────────
    const todayKey = today.toISOString().slice(0, 10);
    const todayCost = dailyMap.get(todayKey) ?? 0;
    const last7 = daily.slice(-7).reduce((n, d) => n + d.costUsd, 0);
    const last30 = daily.reduce((n, d) => n + d.costUsd, 0);

    return c.json({
      totals: {
        today: todayCost,
        week: last7,
        month: last30,
        allTime: allTimeTotal,
      },
      daily,
      tools,
      sessions,
    });
  });
}

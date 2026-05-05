/**
 * Cost dashboard — 3 panels:
 *   1. Spend totals (today / 7d / 30d / all time)
 *   2. Daily bar chart (last 30 days, SVG)
 *   3. Tool-use counts + per-session table
 *
 * No chart library — small inline SVG. Sized for the existing palette modal
 * shell (palette-modal-wide) so it inherits theme + dismiss UX.
 */

import { useEffect, useState } from "react";

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

type Summary = {
  totals: { today: number; week: number; month: number; allTime: number };
  daily: DailyTotal[];
  tools: ToolCount[];
  sessions: SessionTotal[];
};

type Props = {
  open: boolean;
  onClose: () => void;
  projectId: number;
};

export function CostDashboard({ open, onClose, projectId }: Props) {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(`/api/projects/${projectId}/cost-summary`, {
      credentials: "same-origin",
    })
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body?.error ?? `${r.status} ${r.statusText}`);
        }
        return r.json() as Promise<Summary>;
      })
      .then((s) => {
        if (!cancelled) setData(s);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? "could not load");
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="palette-backdrop"
      onMouseDown={onClose}
      role="dialog"
      aria-modal
    >
      <div
        className="palette-modal palette-modal-wide cost-dashboard"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="cost-dashboard-header">
          <h2 className="cost-dashboard-title">Cost dashboard</h2>
          <button
            type="button"
            className="archived-viewer-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="cost-dashboard-body">
          {error && <div className="palette-empty">Error: {error}</div>}
          {!error && !data && (
            <div className="palette-empty">Loading…</div>
          )}
          {data && (
            <>
              <SpendTotals totals={data.totals} />
              <DailyChart daily={data.daily} />
              <ToolList tools={data.tools} />
              <SessionTable sessions={data.sessions} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function fmt(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function SpendTotals({ totals }: { totals: Summary["totals"] }) {
  return (
    <div className="cost-totals-grid">
      <TotalCard label="Today" value={fmt(totals.today)} />
      <TotalCard label="Last 7 days" value={fmt(totals.week)} />
      <TotalCard label="Last 30 days" value={fmt(totals.month)} />
      <TotalCard label="All time" value={fmt(totals.allTime)} />
    </div>
  );
}

function TotalCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="cost-total-card">
      <div className="cost-total-label">{label}</div>
      <div className="cost-total-value">{value}</div>
    </div>
  );
}

function DailyChart({ daily }: { daily: DailyTotal[] }) {
  const w = 640;
  const h = 140;
  const pad = { top: 12, right: 12, bottom: 28, left: 36 };
  const innerW = w - pad.left - pad.right;
  const innerH = h - pad.top - pad.bottom;
  const max = Math.max(0.001, ...daily.map((d) => d.costUsd));
  const barWidth = innerW / Math.max(1, daily.length);

  const yTicks = [0, max / 2, max];

  return (
    <section className="cost-section">
      <h3 className="cost-section-title">Daily spend (last 30 days)</h3>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="cost-chart"
        role="img"
        aria-label="Daily spend bar chart"
      >
        {yTicks.map((t, i) => {
          const y = pad.top + innerH - (t / max) * innerH;
          return (
            <g key={i}>
              <line
                x1={pad.left}
                y1={y}
                x2={pad.left + innerW}
                y2={y}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text
                x={pad.left - 6}
                y={y + 3}
                textAnchor="end"
                className="cost-axis-tick"
              >
                {fmt(t)}
              </text>
            </g>
          );
        })}
        {daily.map((d, i) => {
          const x = pad.left + i * barWidth + 1;
          const barH = (d.costUsd / max) * innerH;
          const y = pad.top + innerH - barH;
          return (
            <g key={d.date}>
              <rect
                x={x}
                y={y}
                width={Math.max(1, barWidth - 2)}
                height={barH}
                rx={1}
                className="cost-bar-rect"
              >
                <title>{`${d.date}: ${fmt(d.costUsd)}`}</title>
              </rect>
            </g>
          );
        })}
        {/* Sparse x-axis labels — just first, mid, last */}
        {[0, Math.floor(daily.length / 2), daily.length - 1]
          .filter((i) => i >= 0 && i < daily.length)
          .map((i) => (
            <text
              key={`x-${i}`}
              x={pad.left + i * barWidth + barWidth / 2}
              y={h - 8}
              textAnchor="middle"
              className="cost-axis-tick"
            >
              {(daily[i]?.date ?? "").slice(5)}
            </text>
          ))}
      </svg>
    </section>
  );
}

function ToolList({ tools }: { tools: ToolCount[] }) {
  const top = tools.slice(0, 8);
  const max = Math.max(1, ...top.map((t) => t.count));
  if (top.length === 0) {
    return null;
  }
  return (
    <section className="cost-section">
      <h3 className="cost-section-title">Tool calls (top 8)</h3>
      <div className="cost-tool-list">
        {top.map((t) => (
          <div className="cost-tool-row" key={t.tool}>
            <span className="cost-tool-name">{t.tool}</span>
            <div className="cost-tool-bar">
              <div
                className="cost-tool-bar-fill"
                style={{ width: `${(t.count / max) * 100}%` }}
              />
            </div>
            <span className="cost-tool-count">{t.count}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function SessionTable({ sessions }: { sessions: SessionTotal[] }) {
  const top = [...sessions]
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 10);
  if (top.length === 0) return null;
  return (
    <section className="cost-section">
      <h3 className="cost-section-title">Sessions by spend (top 10)</h3>
      <table className="cost-table">
        <thead>
          <tr>
            <th>Session</th>
            <th className="num">Msgs</th>
            <th className="num">Cost</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {top.map((s) => (
            <tr key={s.id}>
              <td>
                {s.title || (s.archived ? "Archived chat" : "Current chat")}
                {!s.archived && (
                  <span className="cost-table-active-tag">Active</span>
                )}
              </td>
              <td className="num">{s.messageCount}</td>
              <td className="num">{fmt(s.costUsd)}</td>
              <td className="cost-table-date">
                {new Date(s.createdAt).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

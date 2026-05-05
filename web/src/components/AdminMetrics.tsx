import { useEffect, useState } from "react";
import { api, type AdminMetrics as Metrics } from "../lib/api.ts";

export function AdminMetrics() {
  const [m, setM] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .adminMetrics()
      .then(({ metrics }) => setM(metrics))
      .catch((err) => setError(err?.message ?? String(err)));
  }, []);

  if (error) return <div className="admin-error">⚠ {error}</div>;
  if (!m) return <div className="admin-empty">Loading…</div>;

  return (
    <div className="admin-metrics">
      <div className="metric-cards">
        <Card label="Total users" value={String(m.totalUsers)} />
        <Card label="Active in 7 days" value={String(m.activeLast7d)} />
        <Card label="Total projects" value={String(m.totalProjects)} />
        <Card label="Total cost" value={`$${m.totalCostUsd.toFixed(2)}`} />
        <Card
          label="Cost (last 24h)"
          value={`$${m.costLast24hUsd.toFixed(2)}`}
        />
      </div>

      <section className="metric-section">
        <h3>Signups (last 14 days)</h3>
        <SignupsChart data={m.signupsByDay} />
      </section>

      <section className="metric-section">
        <h3>Top spenders</h3>
        {m.topSpenders.length === 0 ? (
          <div className="admin-empty">No spending yet.</div>
        ) : (
          <table className="admin-table">
            <thead>
              <tr>
                <th>User</th>
                <th className="num">Turns</th>
                <th className="num">Cost</th>
              </tr>
            </thead>
            <tbody>
              {m.topSpenders.map((s) => (
                <tr key={s.userId}>
                  <td className="mono">{s.email}</td>
                  <td className="num">{s.turns}</td>
                  <td className="num">${s.costUsd.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}

function SignupsChart({ data }: { data: Array<{ day: string; count: number }> }) {
  // Render the last 14 days, filling in zeros for days with no signups.
  const today = new Date();
  const days: Array<{ day: string; count: number }> = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const found = data.find((row) => row.day === key);
    days.push({ day: key, count: found?.count ?? 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.count));
  const W = 560;
  const H = 110;
  const PAD = 24;
  const barW = (W - PAD * 2) / days.length - 4;
  return (
    <svg className="metric-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Signups per day">
      {days.map((d, i) => {
        const h = (d.count / max) * (H - PAD * 2);
        const x = PAD + i * ((W - PAD * 2) / days.length);
        const y = H - PAD - h;
        return (
          <g key={d.day}>
            <rect x={x} y={y} width={barW} height={h} className="metric-bar" />
            <text
              x={x + barW / 2}
              y={H - 8}
              textAnchor="middle"
              className="metric-axis"
            >
              {d.day.slice(-2)}
            </text>
          </g>
        );
      })}
      <text x={PAD} y={14} className="metric-axis">
        max {max}
      </text>
    </svg>
  );
}

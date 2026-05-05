import { useEffect, useRef, useState } from "react";
import { api, type ProjectSummary, type PublishStatus } from "../lib/api.ts";

type Props = {
  project: ProjectSummary | null;
  /** Epoch ms of the last files:changed event; drives the "Rebuilding…" indicator on the live link. */
  lastFilesChangedAt: number | null;
  /** Called after the lab confirms the site is live (auto or manual) so the parent can refresh. */
  onSiteUrlSet: () => void;
};

type ModalStage =
  | { kind: "closed" }
  | { kind: "confirm" }
  | {
      kind: "after-redirect";
      deployUrl: string;
      predictedSiteUrl: string;
    }
  | { kind: "busy" }
  | { kind: "error"; message: string };

const PROBE_INTERVAL_MS = 7_000;
const PROBE_MAX_DURATION_MS = 10 * 60_000;
const REBUILD_INDICATOR_MS = 2 * 60_000;
const PUBLISH_STATUS_POLL_MS = 18_000;

export function PublishButton({
  project,
  lastFilesChangedAt,
  onSiteUrlSet,
}: Props) {
  const [stage, setStage] = useState<ModalStage>({ kind: "closed" });
  const [pubStatus, setPubStatus] = useState<PublishStatus | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());

  const githubConnected = !!project?.github.connected;
  const liveUrl = project?.render.siteUrl ?? null;
  const deployed = !!liveUrl;

  // ── Auto-probe on mount when GitHub is connected but site isn't yet live.
  useEffect(() => {
    if (!project) return;
    if (liveUrl) return;
    if (!githubConnected) return;
    let cancelled = false;
    api
      .renderProbe(project.id)
      .then((res) => {
        if (cancelled) return;
        if (res.live && res.url) {
          api.renderConfirmDeployed(project.id, res.url).then(() => {
            if (!cancelled) onSiteUrlSet();
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [project?.id, githubConnected, liveUrl, onSiteUrlSet]);

  // ── Poll probe while the modal is in `after-redirect` stage.
  useEffect(() => {
    if (stage.kind !== "after-redirect") return;
    if (!project) return;
    let cancelled = false;
    const startedAt = Date.now();
    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await api.renderProbe(project.id);
        if (cancelled) return;
        if (res.live && res.url) {
          await api.renderConfirmDeployed(project.id, res.url);
          if (cancelled) return;
          onSiteUrlSet();
          setStage({ kind: "closed" });
          return;
        }
      } catch {}
      if (Date.now() - startedAt > PROBE_MAX_DURATION_MS) return;
      if (!cancelled) setTimeout(tick, PROBE_INTERVAL_MS);
    };
    const t = setTimeout(tick, PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [stage.kind, project?.id, onSiteUrlSet]);

  // ── Poll publish-status to drive the pending-changes badge.
  useEffect(() => {
    if (!project) return;
    if (!deployed) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const { status } = await api.publishStatus(project.id);
        if (!cancelled) setPubStatus(status);
      } catch {}
    };
    tick();
    const id = setInterval(tick, PUBLISH_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [project?.id, deployed]);

  // Refresh publish-status immediately when files:changed (after debounce wait).
  useEffect(() => {
    if (!project || !deployed || !lastFilesChangedAt) return;
    // Wait for the AutoSyncer debounce + push to land on GitHub before
    // re-checking. ~6s covers 3s debounce + 1-2s push.
    const t = setTimeout(async () => {
      try {
        const { status } = await api.publishStatus(project.id);
        setPubStatus(status);
      } catch {}
    }, 6_000);
    return () => clearTimeout(t);
  }, [lastFilesChangedAt, project?.id, deployed]);

  // ── Rebuild indicator ticker (only after promote, since that's the only
  // event that actually triggers a Render rebuild).
  const lastPromoteAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!liveUrl) return;
    if (!lastPromoteAtRef.current) return;
    const elapsed = Date.now() - lastPromoteAtRef.current;
    if (elapsed > REBUILD_INDICATOR_MS) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [liveUrl, now]);

  const promoteRebuildElapsed =
    liveUrl && lastPromoteAtRef.current ? now - lastPromoteAtRef.current : Infinity;
  const isRebuilding = promoteRebuildElapsed < REBUILD_INDICATOR_MS;

  // ── Outside-click close on the setup modal
  useEffect(() => {
    if (stage.kind !== "confirm") return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setStage({ kind: "closed" });
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [stage.kind]);

  if (!project) return null;

  // ── Action: promote (publish current draft to main)
  const promote = async () => {
    if (!project || promoting) return;
    setPromoting(true);
    setPromoteError(null);
    try {
      await api.publishPromote(project.id);
      lastPromoteAtRef.current = Date.now();
      // Pull fresh publish-status so the badge clears.
      const { status } = await api.publishStatus(project.id);
      setPubStatus(status);
    } catch (err: any) {
      setPromoteError(err?.message ?? String(err));
    } finally {
      setPromoting(false);
    }
  };

  // ── Render

  const aheadBy = pubStatus?.aheadBy ?? 0;
  const hasUnpublished = pubStatus?.hasUnpublished ?? false;

  return (
    <div className="publish-cluster" ref={wrapRef}>
      {/* "View live" pill when deployed */}
      {liveUrl && (
        <a
          className={`publish-btn live-link ${isRebuilding ? "rebuilding" : ""}`}
          href={liveUrl}
          target="_blank"
          rel="noreferrer noopener"
          title={
            isRebuilding
              ? `Render is rebuilding · ${liveUrl}`
              : `Live · ${liveUrl}`
          }
        >
          <Dot color={isRebuilding ? "var(--accent)" : "var(--ok)"} pulse={isRebuilding} />
          <span className="publish-btn-label">
            {isRebuilding ? `Rebuilding ${formatElapsed(promoteRebuildElapsed)}` : "View live"}
          </span>
        </a>
      )}

      {/* Publish action */}
      {!githubConnected ? (
        <button
          type="button"
          className="publish-btn locked"
          disabled
          title="Connect GitHub for this project first"
        >
          Publish
        </button>
      ) : !deployed ? (
        <button
          type="button"
          className="publish-btn ready"
          onClick={() => setStage({ kind: "confirm" })}
        >
          Publish
        </button>
      ) : promoting ? (
        <button type="button" className="publish-btn promoting" disabled>
          <span className="publish-spinner-inline" aria-hidden /> Publishing…
        </button>
      ) : hasUnpublished ? (
        <button
          type="button"
          className="publish-btn ready"
          onClick={promote}
          title={`${aheadBy} change${aheadBy === 1 ? "" : "s"} ready to publish`}
        >
          Publish · {aheadBy}
        </button>
      ) : (
        <button
          type="button"
          className="publish-btn published"
          disabled
          title="No unpublished changes"
        >
          Published
        </button>
      )}

      {/* Setup modal (initial Render setup only) */}
      {stage.kind !== "closed" && (
        <PublishModal
          stage={stage}
          project={project}
          onClose={() => setStage({ kind: "closed" })}
          setStage={setStage}
          onSiteUrlSet={onSiteUrlSet}
        />
      )}

      {/* Inline promote error */}
      {promoteError && (
        <div className="publish-promote-error" title={promoteError}>
          ⚠ {promoteError.length > 80 ? promoteError.slice(0, 80) + "…" : promoteError}
          <button
            type="button"
            className="link-button"
            onClick={() => setPromoteError(null)}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function PublishModal({
  stage,
  project,
  onClose,
  setStage,
  onSiteUrlSet,
}: {
  stage: ModalStage;
  project: ProjectSummary;
  onClose: () => void;
  setStage: (s: ModalStage) => void;
  onSiteUrlSet: () => void;
}) {
  const startPublish = async () => {
    setStage({ kind: "busy" });
    try {
      const { deployUrl, predictedSiteUrl } = await api.renderPrepareDeploy(
        project.id
      );
      window.open(deployUrl, "_blank", "noopener,noreferrer");
      setStage({ kind: "after-redirect", deployUrl, predictedSiteUrl });
    } catch (err: any) {
      setStage({ kind: "error", message: err?.message ?? String(err) });
    }
  };

  const confirmDeployed = async (siteUrl?: string) => {
    setStage({ kind: "busy" });
    try {
      await api.renderConfirmDeployed(project.id, siteUrl);
      onSiteUrlSet();
      setStage({ kind: "closed" });
    } catch (err: any) {
      setStage({ kind: "error", message: err?.message ?? String(err) });
    }
  };

  return (
    <div className="publish-modal">
      {stage.kind === "confirm" && (
        <>
          <div className="publish-modal-title">Set up the live site on Render</div>
          <p className="publish-modal-body">
            We'll add a config file to your repo, then send you to Render. They'll walk
            you through signing up (free) and authorizing access — about 30 seconds.
            After that, every time you click <strong>Publish</strong>, your latest
            changes go live.
          </p>
          <div className="publish-modal-actions">
            <button type="button" className="publish-modal-primary" onClick={startPublish}>
              Continue to Render →
            </button>
            <button type="button" className="link-button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}

      {stage.kind === "busy" && (
        <>
          <div className="publish-modal-title">Working…</div>
          <div className="publish-spinner-row">
            <span className="publish-spinner" aria-hidden />
            <span className="dim">Adding render.yaml to your repo and pushing to GitHub.</span>
          </div>
        </>
      )}

      {stage.kind === "after-redirect" && (
        <>
          <div className="publish-modal-title">Waiting for Render to finish</div>
          <p className="publish-modal-body">
            Render is now opening in a new tab. Click <strong>Create</strong> there. We'll
            detect when your site is live (usually 1–2 minutes) and update this panel
            automatically.
          </p>
          <code className="publish-predicted-url">{stage.predictedSiteUrl}</code>
          <div className="publish-spinner-row" style={{ marginTop: 10 }}>
            <span className="publish-spinner" aria-hidden />
            <span className="dim">Watching for your site…</span>
          </div>
          <div className="publish-modal-actions" style={{ marginTop: 14 }}>
            <a
              className="link-button"
              href={stage.deployUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Reopen Render →
            </a>
            <button
              type="button"
              className="link-button"
              onClick={() => confirmDeployed(stage.predictedSiteUrl)}
            >
              Mark deployed manually
            </button>
            <button type="button" className="link-button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}

      {stage.kind === "error" && (
        <>
          <div className="publish-modal-title">Couldn't publish</div>
          <div className="publish-modal-error">⚠ {stage.message}</div>
          <div className="publish-modal-actions">
            <button
              type="button"
              className="publish-modal-primary"
              onClick={() => setStage({ kind: "confirm" })}
            >
              Try again
            </button>
            <button type="button" className="link-button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: color,
        animation: pulse ? "pulse 1.4s ease-in-out infinite" : undefined,
      }}
    />
  );
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

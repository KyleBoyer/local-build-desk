import { useEffect, useState } from "react";
import type { Project, DesktopAPI } from "../../core/types";
import {
  EDITABLE_VERSION_STATES,
  type PublishAction,
} from "../../core/publishing";
import type { StoreActionPreview } from "../../core/store-actions";
import { StoreActionReview } from "./StoreActionReview";

export function Publishing({
  project,
  releaseId,
}: {
  project: Project;
  releaseId: string;
}) {
  const [data, setData] =
    useState<Awaited<ReturnType<DesktopAPI["readPublishing"]>>>();
  const [preview, setPreview] = useState<StoreActionPreview>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [mode, setMode] = useState<"MANUAL" | "AFTER_APPROVAL" | "SCHEDULED">(
      "MANUAL",
    ),
    [date, setDate] = useState(""),
    [build, setBuild] = useState("");
  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const v = await window.desk.readPublishing(project.id, releaseId);
      setData(v);
      setMode(v.releaseType ?? "MANUAL");
      const scheduled = new Date(v.earliestReleaseDate ?? "");
      setDate(
        Number.isFinite(scheduled.getTime())
          ? new Date(
              scheduled.getTime() - scheduled.getTimezoneOffset() * 60000,
            )
              .toISOString()
              .slice(0, 16)
          : "",
      );
      setBuild(v.buildId ?? v.builds[0]?.id ?? "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, [project.id, releaseId]);
  const prepare = async (action: PublishAction) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setPreview(
        await window.desk.preparePublishing(project.id, releaseId, action),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const editable = !!data && EDITABLE_VERSION_STATES.includes(data.state);
  return (
    <section
      className="promote-panel publishing-controls"
      aria-label="Publishing controls"
    >
      <div className="promote-head">
        <h3>Publish & review</h3>
        <button className="button" disabled={busy} onClick={() => void load()}>
          Refresh publishing state
        </button>
      </div>
      {busy && (
        <p className="muted" role="status">
          Checking App Store publishing state…
        </p>
      )}
      {data && (
        <>
          <p className="mono">
            {data.state} · build {data.buildNumber ?? "not attached"}
          </p>
          {data.state === "PENDING_DEVELOPER_RELEASE" && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => void prepare({ kind: "release" })}
            >
              Review release to App Store
            </button>
          )}
          {(editable ||
            ["WAITING_FOR_REVIEW", "IN_REVIEW"].includes(data.state)) && (
            <div className="form-grid">
              <label>
                Release timing
                <select
                  aria-label="Store release timing"
                  value={mode}
                  onChange={(e) => setMode(e.target.value as typeof mode)}
                >
                  <option value="MANUAL">Manually after approval</option>
                  <option value="AFTER_APPROVAL">
                    Automatically after approval
                  </option>
                  <option value="SCHEDULED">
                    After approval, no earlier than…
                  </option>
                </select>
              </label>
              {mode === "SCHEDULED" && (
                <label>
                  Release date & time (this Mac’s time zone)
                  <input
                    aria-label="Scheduled store release"
                    type="datetime-local"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </label>
              )}
              <button
                className="button"
                disabled={busy || (mode === "SCHEDULED" && !date)}
                onClick={() =>
                  void prepare({
                    kind: "schedule",
                    releaseType: mode,
                    ...(mode === "SCHEDULED" && date
                      ? { earliestReleaseDate: new Date(date).toISOString() }
                      : {}),
                  })
                }
              >
                Preview release timing
              </button>
            </div>
          )}
          {data.reviews.some((r: any) =>
            ["WAITING_FOR_REVIEW", "IN_REVIEW", "UNRESOLVED_ISSUES"].includes(
              r.state,
            ),
          ) && (
            <button
              className="button"
              disabled={busy}
              onClick={() => void prepare({ kind: "withdraw" })}
            >
              Review withdrawal from App Review
            </button>
          )}
          {editable && (
            <>
              <label>
                Processed build
                <select
                  aria-label="Replacement App Store build"
                  value={build}
                  onChange={(e) => setBuild(e.target.value)}
                >
                  {data.builds.map((b) => (
                    <option key={b.id} value={b.id}>
                      Build {b.number} ·{" "}
                      {new Date(b.uploadedAt).toLocaleDateString()}
                    </option>
                  ))}
                </select>
              </label>
              <div className="row-actions">
                <button
                  className="button"
                  disabled={busy || !build || build === data.buildId}
                  onClick={() =>
                    void prepare({ kind: "replaceBuild", buildId: build })
                  }
                >
                  Preview build replacement
                </button>
                <button
                  className="primary"
                  disabled={busy || !data.buildReady}
                  onClick={() => void prepare({ kind: "submit" })}
                >
                  Preview App Review submission
                </button>
              </div>
            </>
          )}
          {data.receipts
            .filter((r) => ["running", "uncertain"].includes(r.state))
            .map((r) => (
              <div className="store-source-note" key={r.id}>
                <p>
                  {r.title}: outcome uncertain. This change is blocked from
                  automatic retry.
                </p>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void window.desk
                      .reconcilePublishing(project.id, r.id)
                      .then(
                        (v) =>
                          setMessage(
                            v.state === "complete"
                              ? "Store change confirmed."
                              : "Still uncertain; no request was sent again.",
                          ),
                        (e) => setError(e.message),
                      )
                      .finally(() => void load());
                  }}
                >
                  Reconcile store outcome
                </button>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Have you checked this version in App Store Connect? This allows a fresh preview without claiming the earlier action succeeded. Review the next preview carefully before confirming.",
                      )
                    )
                      return;
                    setBusy(true);
                    void window.desk
                      .acknowledgeStoreAction(project.id, r.id, true)
                      .then(
                        () => load(),
                        (e) => {
                          setError(e.message);
                          setBusy(false);
                        },
                      );
                  }}
                >
                  I checked the store; allow a new preview
                </button>
              </div>
            ))}
        </>
      )}
      {error && (
        <p role="alert" className="workflow-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {preview && (
        <StoreActionReview
          projectId={project.id}
          preview={preview}
          onClose={() => {
            setPreview(undefined);
            void load();
          }}
          onDone={(text) => {
            setMessage(text);
            setPreview(undefined);
            void load();
          }}
        />
      )}
    </section>
  );
}

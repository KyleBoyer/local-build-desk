import { useEffect, useRef, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import type { MonitorJob, MonitorSession } from "../../mobile/types";
import type { StoreActionPreview } from "../../core/store-actions";
import { request, safeId } from "./api";

function useSession() {
  const [session, setSession] = useState<MonitorSession>();
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      void request<MonitorSession>("session")
        .then((value) => {
          if (alive) setSession(value);
        })
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return session;
}
function AccessNote({ secure }: { secure?: boolean }) {
  return (
    <p className="m-muted m-control-access">
      <ShieldCheck size={15} />
      {secure === false
        ? "Enable HTTPS on the Mac to use mobile controls."
        : "Enable this phone’s controls in Preferences → Mobile monitoring on your Mac."}
    </p>
  );
}
function Confirmation({
  title,
  children,
  busy,
  confirm,
  close,
  label,
}: {
  title: string;
  children: React.ReactNode;
  busy: boolean;
  confirm: () => void;
  close: () => void;
  label: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="m-confirm"
      aria-labelledby="mobile-confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <span className="m-eyebrow">REVIEW CHANGE</span>
      <h2 id="mobile-confirm-title">{title}</h2>
      {children}
      <div className="m-control-buttons">
        <button className="m-button" disabled={busy} onClick={close}>
          Cancel
        </button>
        <button
          className="m-button m-control-primary"
          disabled={busy}
          onClick={confirm}
        >
          {busy ? (
            <>
              <RefreshCw size={15} className="m-spin" /> Working…
            </>
          ) : (
            label
          )}
        </button>
      </div>
      {busy && (
        <p role="status" className="m-muted">
          Waiting for your Mac. Store requests can take a minute. Keep this page
          open.
        </p>
      )}
    </dialog>
  );
}
export function JobControls({
  job,
  onChanged,
}: {
  job: MonitorJob;
  onChanged: () => void;
}) {
  const session = useSession(),
    [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const queued = job.status === "queued",
    check =
      job.status !== "running" &&
      ["processing", "uncertain"].includes(job.submission?.state ?? "");
  if (!queued && !check) return null;
  const enabled =
    session?.writesAvailable && session.device.permissions.manageQueue;
  const run = async (action: "cancel-queued" | "reconcile") => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await request<{ message: string }>(
        `jobs/${safeId(job.id)}/${action}`,
        { method: "POST", body: "{}" },
      );
      setMessage(result.message);
      onChanged();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  return (
    <section className="m-controls" aria-label="Build controls">
      {enabled ? (
        <button
          className="m-button"
          disabled={busy}
          onClick={() => (queued ? setConfirm(true) : void run("reconcile"))}
        >
          {busy
            ? "Checking store status…"
            : queued
              ? "Cancel queued job"
              : "Check processing status"}
        </button>
      ) : (
        <AccessNote secure={session?.writesAvailable} />
      )}
      {busy && !confirm && (
        <p role="status" className="m-muted">
          Reading the store’s result. This can take a minute; no upload is
          repeated.
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="m-error">
          {error}
        </p>
      )}
      {confirm && (
        <Confirmation
          title="Cancel this queued job?"
          busy={busy}
          close={() => setConfirm(false)}
          confirm={() => void run("cancel-queued")}
          label="Cancel queued job"
        >
          <p>
            {job.projectName} · {job.platform} · {job.profile}
          </p>
          <p>
            Its build number stays reserved. If compilation has started, the Mac
            will leave it running.
          </p>
        </Confirmation>
      )}
    </section>
  );
}
type Receipt = { id: string; title: string; state: string; updatedAt: string };
export function ReleaseControls({
  project,
  release,
  pending,
  onChanged,
}: {
  project: string;
  release: string;
  pending: boolean;
  onChanged: () => void;
}) {
  const session = useSession(),
    [preview, setPreview] = useState<StoreActionPreview>(),
    [receipts, setReceipts] = useState<Receipt[]>([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const base = `projects/${safeId(project)}/releases/${safeId(release)}`,
    enabled =
      session?.writesAvailable && session.device.permissions.releaseApple,
    unresolved = receipts.some((r) =>
      ["running", "uncertain"].includes(r.state),
    );
  const status = async () => {
    const value = await request<{ receipts: Receipt[] }>(
      `${base}/release-status`,
    );
    setReceipts(value.receipts);
  };
  useEffect(() => {
    if (enabled) void status().catch(() => {});
  }, [enabled, base]);
  useEffect(() => {
    if (!enabled) setPreview(undefined);
  }, [enabled]);
  const run = async (
    kind: "release-preview" | "release-confirm" | "release-reconcile",
    body: unknown = {},
  ) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (kind === "release-preview") {
        setPreview(
          await request<StoreActionPreview>(`${base}/${kind}`, {
            method: "POST",
            body: JSON.stringify(body),
          }),
        );
      } else {
        // Discard the handle before sending. An uncertain response must be reconciled, never retried.
        setPreview(undefined);
        const result = await request<{ message: string }>(`${base}/${kind}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        setMessage(result.message);
        onChanged();
        await status();
      }
    } catch (error) {
      setError(
        (error as Error).message +
          (kind === "release-confirm"
            ? " Check release status before taking another action."
            : ""),
      );
      if (kind === "release-confirm") void status().catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="m-controls" aria-label="App Store release controls">
      {pending &&
        (enabled ? (
          <>
            <h3>Ready for the App Store</h3>
            <p className="m-muted">
              Apple approved this version. Releasing makes it available to
              customers.
            </p>
            <button
              className="m-button m-control-primary"
              disabled={busy || unresolved}
              onClick={() => void run("release-preview")}
            >
              Review release to App Store
            </button>
            {unresolved && (
              <p className="m-muted">
                A previous request still needs its outcome checked below before
                another release can be prepared.
              </p>
            )}
          </>
        ) : (
          <AccessNote secure={session?.writesAvailable} />
        ))}
      {enabled && (
        <button
          className="m-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await status();
              onChanged();
              setMessage(
                "Release status checked. No release request was sent.",
              );
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCw size={15} /> Check release status
        </button>
      )}
      {busy && (
        <p className="m-muted" role="status">
          <RefreshCw size={14} className="m-spin" /> Waiting for the store. This
          can take a minute…
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="m-error">
          {error}
        </p>
      )}
      {enabled &&
        receipts
          .slice(-5)
          .reverse()
          .map((r) => (
            <div className="m-control-receipt" key={r.id}>
              <strong>{r.title}</strong>
              <span>
                {r.state} · {new Date(r.updatedAt).toLocaleString()}
              </span>
              {["uncertain", "running"].includes(r.state) && (
                <button
                  className="m-button"
                  disabled={busy}
                  onClick={() =>
                    void run("release-reconcile", { receiptId: r.id })
                  }
                >
                  Check outcome without resending
                </button>
              )}
            </div>
          ))}
      {preview && (
        <Confirmation
          title={preview.title}
          busy={busy}
          close={() => setPreview(undefined)}
          label="Release to public App Store"
          confirm={() => void run("release-confirm", { token: preview.token })}
        >
          <p className="m-mono">{preview.identity}</p>
          <ul>
            {preview.changes.map((change, i) => (
              <li key={i}>{change}</li>
            ))}
          </ul>
          {preview.warnings.map((warning, i) => (
            <p className="m-control-warning" key={i}>
              {warning}
            </p>
          ))}
          <p className="m-muted">
            The Mac checks the app, version and store state again before sending
            this request. Preview expires{" "}
            {new Date(preview.expiresAt).toLocaleTimeString()}.
          </p>
        </Confirmation>
      )}
    </section>
  );
}

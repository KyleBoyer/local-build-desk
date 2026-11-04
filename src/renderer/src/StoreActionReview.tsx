import { useEffect, useRef, useState } from "react";
import type { StoreActionPreview } from "../../core/store-actions";
import type { WorkProgress as Progress } from "../../core/types";
import { WorkProgress } from "./WorkProgress";

export function StoreActionReview({
  projectId,
  preview,
  onClose,
  onDone,
}: {
  projectId: string;
  preview: StoreActionPreview;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [progress, setProgress] = useState<Progress>();
  useEffect(
    () =>
      window.desk.onEvent((e) => {
        if (
          e.type === "operation-progress" &&
          e.operationId === preview.token &&
          e.progress
        )
          setProgress(e.progress);
      }),
    [preview.token],
  );
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal store-action-dialog"
      aria-label="Review store change"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2>{preview.title}</h2>
      <p className="mono">{preview.identity}</p>
      <ul>
        {preview.changes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      {preview.warnings.map((w) => (
        <p className="store-source-note" key={w}>
          {w}
        </p>
      ))}
      <p className="muted">
        Preview expires {new Date(preview.expiresAt).toLocaleTimeString()}. The
        store will be checked again before applying.
      </p>
      {error && <p role="alert">{error}</p>}
      {busy && (
        <p role="status">
          Applying the reviewed change. This can take a minute…
        </p>
      )}
      {busy && progress && (
        <WorkProgress
          progress={progress}
          label={preview.title}
          startedAt={progress.startedAt}
          note="Store changes can take a minute. Completed counts reflect confirmed steps."
        />
      )}
      <div className="row-actions">
        <button className="button" disabled={busy} onClick={onClose}>
          {error ? "Close and refresh" : "Cancel"}
        </button>
        <button
          className="primary"
          autoFocus
          disabled={busy || !!error}
          onClick={() => {
            setBusy(true);
            void window.desk
              .applyStoreAction(projectId, preview.token)
              .then(
                (r) => onDone(r.message),
                (e) => setError(e.message),
              )
              .finally(() => setBusy(false));
          }}
        >
          Confirm {preview.title.toLowerCase()}
        </button>
      </div>
    </dialog>
  );
}

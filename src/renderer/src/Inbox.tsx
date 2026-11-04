import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import type { ReadableCrash } from "../../core/crash-symbols";
import { Bug, MessageSquare, RefreshCw, Star, X } from "lucide-react";
import type { Project } from "../../core/types";
import type { InboxItem, InboxView } from "../../core/inbox";
const api = window.desk;

// Reviews on both stores and TestFlight feedback in one list, kept on this
// Mac. Replies go straight to the store; Apple shows a reply after its own
// check, Google right away.

type Filter = "all" | "unread" | "low" | "apple" | "google" | "testflight";
const filters: [Filter, string][] = [
  ["all", "All"],
  ["unread", "Unread"],
  ["low", "1–2 ★"],
  ["apple", "App Store"],
  ["google", "Google Play"],
  ["testflight", "TestFlight"],
];
const source = (i: InboxItem) =>
  i.kind !== "review"
    ? "TestFlight"
    : i.store === "apple"
      ? "App Store"
      : "Google Play";
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

export function Inbox({ project }: { project: Project }) {
  const [view, setView] = useState<InboxView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [replying, setReplying] = useState<string>();
  const [draft, setDraft] = useState("");
  const [log, setLog] = useState<{
    id: string;
    report?: ReadableCrash;
    loading?: boolean;
    error?: string;
  }>();
  const [rawLog, setRawLog] = useState(false);
  const crashDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (log && !crashDialog.current?.open) crashDialog.current?.showModal();
  }, [!!log]);
  const crashRequest = useRef(0);
  const activeCrash = useRef<string | undefined>(undefined);
  const closeLog = () => {
    crashRequest.current++;
    if (log) void api.cancelReadableCrash(project.id, log.id).catch(() => {});
    activeCrash.current = undefined;
    setLog(undefined);
    setRawLog(false);
  };
  useEffect(
    () => () => {
      crashRequest.current++;
      if (activeCrash.current)
        void api
          .cancelReadableCrash(project.id, activeCrash.current)
          .catch(() => {});
      activeCrash.current = undefined;
    },
    [project.id],
  );

  const load = useCallback(
    (refresh = false) => {
      setBusy(true);
      setError("");
      return api
        .readInbox(project.id, refresh)
        .then(setView, (e: Error) => setError(e.message))
        .finally(() => setBusy(false));
    },
    [project.id],
  );
  useEffect(() => void load(), [load]);

  const items = useMemo(
    () =>
      (view?.items ?? []).filter((i) =>
        filter === "unread"
          ? !i.read
          : filter === "low"
            ? i.kind === "review" && (i.rating ?? 5) <= 2
            : filter === "apple"
              ? i.kind === "review" && i.store === "apple"
              : filter === "google"
                ? i.store === "google"
                : filter === "testflight"
                  ? i.kind !== "review"
                  : true,
      ),
    [view, filter],
  );
  const unread = (view?.items ?? []).filter((i) => !i.read).length;
  const act = async (work: () => Promise<InboxView>) => {
    setBusy(true);
    setError("");
    try {
      setView(await work());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const errors = Object.entries(view?.sources ?? {}).filter(([, s]) => s.error);
  const none = view && !Object.values(view.sources).some((s) => s.connected);

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">REVIEWS · TESTFLIGHT FEEDBACK</div>
          <h1>Feedback</h1>
          <p>
            App Store and Google Play reviews and TestFlight feedback for{" "}
            {project.name}, in one place. New 1–2★ reviews, feedback and crash
            reports also arrive as notifications.
          </p>
        </div>
      </div>
      <div className="monetization-toolbar">
        <div className="store-channel-tabs" role="tablist" aria-label="Filter">
          {filters.map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={filter === key}
              onClick={() => setFilter(key)}
            >
              {label}
              {key === "unread" && unread ? <span>{unread}</span> : null}
            </button>
          ))}
        </div>
        <div className="row-actions">
          {unread > 0 && (
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  api.markInbox(
                    project.id,
                    (view?.items ?? []).filter((i) => !i.read).map((i) => i.id),
                    true,
                  ),
                )
              }
            >
              Mark all read
            </button>
          )}
          <button
            className="button"
            disabled={busy}
            onClick={() => void load(true)}
          >
            <RefreshCw size={14} className={busy ? "spin" : ""} />{" "}
            {busy ? "Checking…" : "Check now"}
          </button>
        </div>
      </div>
      {none && (
        <p className="workflow-error">
          Connect App Store Connect or Google Play in Connections to see reviews
          and feedback.
        </p>
      )}
      {errors.map(([key, s]) => (
        <p key={key} role="alert" className="workflow-error">
          {key === "playReviews"
            ? "Google Play reviews"
            : key === "testflight"
              ? "TestFlight feedback"
              : "App Store reviews"}
          : {s.error}
        </p>
      ))}
      {view?.sources.playReviews.connected && (
        <p className="muted">
          Google Play's API only returns the last week of reviews; older ones
          stay here once seen.
        </p>
      )}
      {view && items.length === 0 && (
        <p className="muted">
          {filter === "all" ? "Nothing yet." : "Nothing matches this filter."}
        </p>
      )}
      <div className="inbox-list">
        {items.map((item) => (
          <article
            key={item.id}
            className={`inbox-item ${item.read ? "" : "unread"}`}
            onClick={() => {
              if (!item.read)
                void act(() => api.markInbox(project.id, [item.id], true));
            }}
          >
            <header>
              <span
                className={`badge ${item.kind === "crash" ? "failed" : item.kind === "feedback" ? "queued" : (item.rating ?? 5) <= 2 ? "failed" : "succeeded"}`}
              >
                {source(item)}
              </span>
              {item.kind === "review" && (
                <span
                  className="inbox-stars"
                  aria-label={`${item.rating} stars`}
                >
                  {Array.from({ length: 5 }, (_, i) => (
                    <Star
                      key={i}
                      size={13}
                      fill={i < (item.rating ?? 0) ? "currentColor" : "none"}
                    />
                  ))}
                </span>
              )}
              {item.kind === "crash" && <Bug size={14} />}
              {item.kind === "feedback" && <MessageSquare size={14} />}
              <span className="muted">{when(item.createdAt)}</span>
              {!item.read && <span className="nav-dot" aria-label="Unread" />}
            </header>
            {item.title && <strong>{item.title}</strong>}
            <p>{item.body || <span className="muted">No comment</span>}</p>
            <div className="inbox-meta muted">
              {[
                item.author,
                item.territory,
                item.language,
                item.appVersion,
                item.device,
                item.os,
                item.screenshots
                  ? `${item.screenshots} screenshot${item.screenshots === 1 ? "" : "s"} in App Store Connect`
                  : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
            {item.reply && replying !== item.id && (
              <blockquote className="inbox-reply">
                <span className="muted">
                  Your reply
                  {item.reply.state
                    ? ` · ${item.reply.state.replaceAll("_", " ").toLowerCase()}`
                    : ""}
                </span>
                {item.reply.body}
              </blockquote>
            )}
            <div className="row-actions" onClick={(e) => e.stopPropagation()}>
              {item.kind === "review" && replying !== item.id && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    setReplying(item.id);
                    setDraft(item.reply?.body ?? "");
                  }}
                >
                  {item.reply ? "Edit reply" : "Reply"}
                </button>
              )}
              {item.kind === "crash" && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    if (activeCrash.current)
                      void api
                        .cancelReadableCrash(project.id, activeCrash.current)
                        .catch(() => {});
                    activeCrash.current = item.id;
                    const request = ++crashRequest.current;
                    setLog({ id: item.id, loading: true });
                    setRawLog(false);
                    void api.readableCrash(project.id, item.id).then(
                      (report) => {
                        if (request === crashRequest.current)
                          setLog({ id: item.id, report });
                      },
                      (e: Error) => {
                        if (request === crashRequest.current)
                          setLog({ id: item.id, error: e.message });
                      },
                    );
                  }}
                >
                  Crash log
                </button>
              )}
              {item.read && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    void act(() => api.markInbox(project.id, [item.id], false))
                  }
                >
                  Mark unread
                </button>
              )}
            </div>
            {replying === item.id && (
              <div
                className="inbox-compose"
                onClick={(e) => e.stopPropagation()}
              >
                <textarea
                  aria-label="Reply"
                  rows={4}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div className="row-actions">
                  <span className="muted">
                    {item.store === "google"
                      ? `${draft.length}/350`
                      : `${draft.length} characters`}{" "}
                    · Replies are public.
                  </span>
                  <button
                    className="button"
                    onClick={() => setReplying(undefined)}
                  >
                    Cancel
                  </button>
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !draft.trim() ||
                      (item.store === "google" && draft.length > 350)
                    }
                    onClick={() =>
                      void act(() =>
                        api.replyInbox(project.id, item.id, draft),
                      ).then(() => setReplying(undefined))
                    }
                  >
                    {item.reply ? "Update reply" : "Send reply"}
                  </button>
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
      {error && (
        <p role="alert" className="workflow-error">
          {error}
        </p>
      )}
      {log && (
        <dialog
          ref={crashDialog}
          className="modal monetization-modal"
          aria-label="Crash log"
          onCancel={(e) => {
            e.preventDefault();
            closeLog();
          }}
        >
          <div className="modal-heading">
            <div>
              <h2>Crash log</h2>
              <p>
                {log.loading
                  ? "Matching retained dSYMs and decoding stack frames…"
                  : `${log.report?.state ?? "Unavailable"} · ${log.report?.resolved ?? 0} frames decoded locally`}
              </p>
            </div>
            <button
              className="icon-button"
              aria-label="Close dialog"
              autoFocus
              onClick={closeLog}
            >
              <X size={19} />
            </button>
          </div>
          {log.loading && (
            <p role="status">
              Reading the report and checking UUID/architecture matches. This
              can take a minute. Closing cancels the operation.
            </p>
          )}
          {log.error && <p role="alert">{log.error}</p>}
          {log.report?.notes.map((n) => (
            <p className="muted" key={n}>
              {n}
            </p>
          ))}
          {!!log.report?.missingUuids.length && (
            <details>
              <summary>
                Missing matching symbols ({log.report.missingUuids.length})
              </summary>
              <ul>
                {log.report.missingUuids.map((id) => (
                  <li key={id} className="mono">
                    {id}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {log.report && (
            <>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={rawLog}
                  onChange={(e) => setRawLog(e.target.checked)}
                />
                Show original report
              </label>
              <pre className="inbox-log">
                {(rawLog ? log.report.raw : log.report.text).slice(0, 200000) ||
                  "TestFlight has no log for this crash: the tester didn't share one. The report still shows the build, device and OS."}
              </pre>
            </>
          )}
          <div className="row-actions">
            <button
              className="button"
              disabled={!log.report}
              onClick={() =>
                void navigator.clipboard.writeText(
                  rawLog ? log.report!.raw : log.report!.text,
                )
              }
            >
              Copy
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}

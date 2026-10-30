import { useEffect, useState } from "react";
import { Search, Terminal } from "lucide-react";
import { useLogFollow } from "./useLogFollow";
import { logPreview, logWindow } from "../../core/log-window";
import { LOG_PAGE_ENTRIES, type LogPage, type LogRow } from "../../core/types";

export function BuildLogPanel({ jobId }: { jobId: string }) {
  const [search, setSearch] = useState("");
  const [request, setRequest] = useState<{
    search: string;
    before?: number;
    history: (number | undefined)[];
    retry: number;
  }>({ search: "", history: [], retry: 0 });
  const [view, setView] = useState<{
    page?: LogPage;
    loading: boolean;
    error?: string;
    revision: number;
    newOutput: boolean;
  }>({ loading: true, revision: 0, newOutput: false });
  const logsRef = useLogFollow(
    jobId,
    view.revision,
    !!search || request.before !== undefined,
  );
  useEffect(() => {
    if (search === request.search) return;
    const timer = setTimeout(
      () => setRequest({ search, history: [], retry: 0 }),
      200,
    );
    return () => clearTimeout(timer);
  }, [search, request.search]);
  useEffect(() => {
    let active = true,
      loading = true,
      timer: ReturnType<typeof setTimeout> | undefined,
      sequence = -1;
    let pending: LogRow[] = [];
    const query = request.search.toLowerCase();
    setView((v) => ({
      loading: true,
      revision: v.revision + 1,
      newOutput: false,
    }));
    const merge = (page: LogPage, fresh: LogRow[]): LogPage => {
      const known = new Set(page.rows.map((r) => r.offset));
      const merged = [
        ...page.rows,
        ...fresh.filter((r) => !known.has(r.offset)),
      ];
      const rows = logWindow(merged);
      const first = rows.find((r) => r.offset >= 0);
      return {
        ...page,
        rows,
        before: first?.offset ?? page.before,
        hasEarlier: page.hasEarlier || rows.length < merged.length,
      };
    };
    const flush = () => {
      timer = undefined;
      if (!active || loading) return;
      const fresh = pending;
      pending = [];
      setView((v) =>
        v.page
          ? { ...v, page: merge(v.page, fresh), revision: v.revision + 1 }
          : v,
      );
    };
    const stop = window.desk.onEvent((event) => {
      if (event.type !== "log" || event.jobId !== jobId || !event.entry) return;
      if (request.before !== undefined) {
        setView((v) => (v.newOutput ? v : { ...v, newOutput: true }));
        return;
      }
      if (query && !event.entry.text.toLowerCase().includes(query)) return;
      pending = logWindow([
        ...pending,
        {
          offset: event.logOffset ?? sequence--,
          entry: { ...event.entry, text: logPreview(event.entry.text) },
        },
      ]);
      if (!timer) timer = setTimeout(flush, 100);
    });
    window.desk
      .logPage(jobId, { before: request.before, search: request.search })
      .then((page) => {
        if (!active) return;
        loading = false;
        const merged = merge(page, pending);
        pending = [];
        setView((v) => ({
          page: merged,
          loading: false,
          revision: v.revision + 1,
          newOutput: v.newOutput,
        }));
      })
      .catch((error) => {
        if (active) {
          loading = false;
          setView((v) => ({ ...v, loading: false, error: String(error) }));
        }
      });
    return () => {
      active = false;
      stop();
      clearTimeout(timer);
      void window.desk.cancelLogRead(jobId).catch(() => {});
    };
  }, [jobId, request]);
  const page = view.page;
  const latest = () =>
    setRequest((r) => ({
      ...r,
      before: undefined,
      history: [],
      retry: r.retry + 1,
    }));
  return (
    <>
      <div className="log-toolbar">
        <span>
          <Terminal size={14} /> BUILD OUTPUT{" "}
          <span className="mono subtle">
            {page?.rows.length ?? 0} entries shown
          </span>
        </span>
        <label className="log-search">
          <Search size={13} />
          <input
            aria-label="Search build logs"
            placeholder="Search entire log…"
            maxLength={300}
            value={search}
            onChange={(e) => {
              const value = e.target.value;
              setSearch(value);
              if (!value) setRequest({ search: "", history: [], retry: 0 });
            }}
          />
        </label>
      </div>
      <div
        ref={logsRef}
        className="logs"
        role="log"
        aria-label="Build output"
        aria-busy={view.loading}
      >
        {page?.rows.map((row) => (
          <div
            className={row.entry.text.startsWith("ERROR") ? "error-line" : ""}
            key={row.offset}
          >
            <time>
              {new Date(row.entry.time).toLocaleTimeString(undefined, {
                hour12: false,
              })}
            </time>
            <pre>{row.entry.text}</pre>
          </div>
        ))}
        {view.loading && (
          <span className="subtle">
            {request.search
              ? "Searching the entire saved log…"
              : "Loading output…"}
          </span>
        )}
        {view.error && (
          <span role="alert">
            {view.error}{" "}
            <button className="button" onClick={latest}>
              Retry log read
            </button>
          </span>
        )}
        {!view.loading && !view.error && !page?.rows.length && (
          <span className="subtle">
            {request.search
              ? "No matching entries in this part of the saved log."
              : "Waiting for the local runner…"}
          </span>
        )}
      </div>
      <div className="log-paging">
        <span className="muted">
          {request.search
            ? "Full-history search"
            : `Up to ${LOG_PAGE_ENTRIES} entries per window`}
          {page && (page.shortened > 0 || page.skipped > 0)
            ? " · Some long or unreadable entries are shortened or omitted; open the complete log."
            : ""}
          {view.newOutput ? " · New output available" : ""}
        </span>
        <div className="row-actions">
          <button
            className="button"
            disabled={view.loading || !page?.hasEarlier}
            onClick={() =>
              setRequest((r) => ({
                ...r,
                before: page!.before,
                history: [...r.history, r.before],
              }))
            }
          >
            {request.search ? "Older matches" : "Older output"}
          </button>
          <button
            className="button"
            disabled={view.loading || !request.history.length}
            onClick={() =>
              setRequest((r) => ({
                ...r,
                before: r.history.at(-1),
                history: r.history.slice(0, -1),
              }))
            }
          >
            Newer output
          </button>
          <button className="button" disabled={view.loading} onClick={latest}>
            Latest output
          </button>
          <button
            className="button"
            disabled={!page?.path}
            onClick={() =>
              void window.desk
                .reveal(page!.path)
                .catch((error) =>
                  setView((v) => ({ ...v, error: String(error) })),
                )
            }
          >
            Show complete log
          </button>
        </div>
      </div>
    </>
  );
}

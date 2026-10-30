import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useLayoutEffect,
} from "react";
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  History,
  Layers3,
  LogOut,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  Smartphone,
  X,
  Image as ImageIcon,
  Package,
} from "lucide-react";
import type {
  MonitorSnapshot,
  MonitorJob,
  MonitorLogs,
} from "../../mobile/types";
import type {
  StoreReleaseSnapshot,
  StoreReleaseDetail,
  StoreChannel,
} from "../../core/store-release-types";
import { elapsedLabel, stageGuidance } from "../../core/progress";
import { request, safeId } from "./api";
import { useClock, useMonitor } from "./hooks";
const human = (s: string) =>
  s.replaceAll("_", " ").replaceAll("-", " ").toLowerCase();
const time = (s?: string) =>
  s
    ? new Date(s).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";
const active = (j: MonitorJob) =>
  ["running", "queued"].includes(j.status) ||
  j.submission?.state === "processing";
const failed = (j: MonitorJob) =>
  (j.status === "needs-attention" && j.submission?.state !== "processing") ||
  ["failed", "interrupted", "cancelled"].includes(j.status) ||
  ["rejected", "uncertain"].includes(j.submission?.state ?? "");
const label = (j: MonitorJob) =>
  j.submission?.state === "processing"
    ? "Apple processing"
    : j.status === "needs-attention"
      ? "Needs attention"
      : j.submission?.state === "accepted"
        ? "Store accepted"
        : j.submission?.state === "draft"
          ? "Play draft"
          : j.status === "running"
            ? human(j.stage)
            : human(j.status);
const bytes = (value: number) =>
  value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(2)} GB`
    : value >= 1024 ** 2
      ? `${(value / 1024 ** 2).toFixed(1)} MB`
      : `${Math.round(value / 1024)} KB`;
const channelNames: Record<StoreChannel, string> = {
  appstore: "App review",
  testflight: "TestFlight",
  play: "Google Play",
};
type Route = { tab: "now" | "history" | "releases" | "projects"; job?: string };
function route(): Route {
  const value = location.hash.slice(1);
  if (value.startsWith("job="))
    return {
      tab: "now",
      job: (() => {
        try {
          return decodeURIComponent(value.slice(4));
        } catch {
          return "invalid";
        }
      })(),
    };
  return {
    tab: ["now", "history", "releases", "projects"].includes(value)
      ? (value as Route["tab"])
      : "now",
  };
}
function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={`m-badge ${tone}`}>{children}</span>;
}
function Progress({ job, now }: { job: MonitorJob; now: number }) {
  const processing = job.submission?.state === "processing";
  const progress = processing ? undefined : job.progress,
    pct =
      progress?.totalBytes && progress.completedBytes !== undefined
        ? (progress.completedBytes / progress.totalBytes) * 100
        : progress?.percent;
  const value =
    typeof pct === "number" && Number.isFinite(pct)
      ? Math.max(0, Math.min(100, pct))
      : undefined;
  const start = Date.parse(
    progress?.startedAt ?? job.stageStartedAt ?? job.startedAt ?? job.createdAt,
  );
  return (
    <div className="m-progress">
      <div>
        <strong>
          {progress?.label ??
            (job.submission?.state === "processing"
              ? "Apple processing"
              : human(job.stage))}
        </strong>
        <span className="m-mono">
          {value !== undefined
            ? `${Math.floor(value)}%`
            : elapsedLabel(now - start)}
        </span>
      </div>
      <div
        className={`m-progress-track ${value === undefined ? "indeterminate" : ""}`}
        role="progressbar"
        aria-label="Build progress"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <i style={value === undefined ? undefined : { width: `${value}%` }} />
      </div>
      <p>
        {progress?.completedBytes !== undefined && progress.totalBytes
          ? `${bytes(progress.completedBytes)} / ${bytes(progress.totalBytes)} · `
          : ""}
        {progress?.detail ??
          stageGuidance[
            job.submission?.state === "processing" ? "processing" : job.stage
          ]}
      </p>
    </div>
  );
}
function JobCard({
  job,
  onOpen,
  now,
  compact = false,
}: {
  job: MonitorJob;
  onOpen: () => void;
  now: number;
  compact?: boolean;
}) {
  return (
    <button
      className={`m-job ${compact ? "compact" : ""} ${failed(job) ? "failed" : ""}`}
      onClick={onOpen}
    >
      <div className="m-job-heading">
        <div>
          <span className="m-eyebrow">
            {job.platform === "ios" ? "iOS" : "ANDROID"} · {job.profile} ·{" "}
            {job.kind === "test"
              ? "CHECKS"
              : job.kind === "submit"
                ? "UPLOAD"
                : "BUILD"}
          </span>
          <h3>{job.projectName}</h3>
        </div>
        <ChevronRight size={18} />
      </div>
      <div className="m-job-meta">
        <span>
          {job.version ?? "Version pending"}
          {job.buildNumber ? ` (${job.buildNumber})` : ""}
        </span>
        <Badge tone={failed(job) ? "danger" : active(job) ? "amber" : "green"}>
          {label(job)}
        </Badge>
      </div>
      {!compact && active(job) && <Progress job={job} now={now} />}
      <div className="m-job-footer">
        <span>{time(job.createdAt)}</span>
        {job.startedAt && (
          <span>
            {elapsedLabel(
              (job.finishedAt ? Date.parse(job.finishedAt) : now) -
                Date.parse(job.startedAt),
            )}
            {!job.finishedAt ? " elapsed" : " total"}
          </span>
        )}
      </div>
    </button>
  );
}
function Pair({
  initial,
  error,
  onPaired,
}: {
  initial: string | null;
  error?: string;
  onPaired: () => void;
}) {
  const [code, setCode] = useState(initial ?? ""),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState(error ?? "");
  const [name, setName] = useState(
    /iPhone|iPad/.test(navigator.userAgent)
      ? "iPhone / iPad"
      : /Android/.test(navigator.userAgent)
        ? "Android phone"
        : "Browser",
  );
  const pair = useCallback(
    async (value: string) => {
      setBusy(true);
      setFailure("");
      try {
        await request("pair", {
          method: "POST",
          body: JSON.stringify({ code: value, name }),
        });
        onPaired();
      } catch (error) {
        setFailure((error as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [name, onPaired],
  );
  const attempted = useRef(false);
  useEffect(() => {
    if (initial && !attempted.current) {
      attempted.current = true;
      void pair(initial);
    }
  }, [initial, pair]);
  return (
    <main className="m-pair">
      <div className="m-brand">
        <img src="/monitor-icon.png" alt="" />
        <span>LOCAL BUILD DESK</span>
      </div>
      <div className="m-pair-art">
        <Layers3 size={62} />
        <span className="m-crosshair one" />
        <span className="m-crosshair two" />
      </div>
      <span className="m-eyebrow">YOUR MAC, IN YOUR POCKET</span>
      <h1>
        A window into
        <br />
        your next release.
      </h1>
      <p>
        Pair with the Mac running Local Build Desk to follow its builds, logs,
        checks and store submissions.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void pair(code);
        }}
      >
        <label>
          Pairing code
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="XXXX-XXXX-XXXX"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            spellCheck={false}
            required
            maxLength={80}
          />
        </label>
        <label>
          Device name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            required
            autoComplete="off"
          />
        </label>
        <button className="m-primary" disabled={busy || !code.trim()}>
          {busy ? (
            <RefreshCw size={16} className="m-spin" />
          ) : (
            <ShieldCheck size={16} />
          )}{" "}
          {busy ? "Pairing…" : "Connect to my Mac"}
        </button>
      </form>
      {failure && (
        <p className="m-error" role="alert">
          {failure}
        </p>
      )}
      <footer>
        <Smartphone size={16} />
        <span>
          On the Mac: Preferences → Mobile monitoring.
          <br />
          Scan its QR code or enter the code here.
        </span>
      </footer>
    </main>
  );
}
export function MobileApp({ initialPair }: { initialPair: string | null }) {
  const [auth, setAuth] = useState<"loading" | "paired" | "pair">("loading"),
    [device, setDevice] = useState(""),
    [current, setCurrent] = useState<Route>(route),
    [filter, setFilter] = useState("");
  const initialCode = useRef(initialPair);
  const [bootError, setBootError] = useState("");
  const now = useClock();
  const { snapshot, connected, lastContact } = useMonitor(auth === "paired");
  const paired = useCallback(() => {
    initialCode.current = null;
    setAuth("paired");
    void request<{ device: { name: string } }>("session")
      .then((v) => setDevice(v.device.name))
      .catch(() => {});
  }, []);
  useEffect(() => {
    void request<{ device: { name: string } }>("session")
      .then((value) => {
        setDevice(value.device.name);
        setAuth("paired");
      })
      .catch((error) => {
        if (error.status !== 401)
          setBootError(
            "The Mac could not be reached. Check your Wi-Fi or private VPN.",
          );
        setAuth("pair");
      });
    const expired = () => setAuth("pair");
    window.addEventListener("monitor-session-expired", expired);
    const pop = () => setCurrent(route());
    window.addEventListener("popstate", pop);
    return () => {
      window.removeEventListener("monitor-session-expired", expired);
      window.removeEventListener("popstate", pop);
    };
  }, []);
  const navigate = (next: Route) => {
    history.pushState(
      null,
      "",
      next.job ? `#job=${encodeURIComponent(next.job)}` : `#${next.tab}`,
    );
    setCurrent(next);
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  if (auth === "loading")
    return (
      <div className="m-boot">
        <img src="/monitor-icon.png" alt="Local Build Desk" />
        <RefreshCw className="m-spin" />
        <p>Connecting to your Mac…</p>
      </div>
    );
  if (auth === "pair")
    return (
      <Pair initial={initialCode.current} error={bootError} onPaired={paired} />
    );
  const jobs =
    snapshot?.jobs.filter((j) => !filter || j.projectId === filter) ?? [];
  const open = (id: string) => navigate({ tab: current.tab, job: id });
  return (
    <div className="m-app">
      <header className="m-header">
        <a
          href="#now"
          onClick={(event) => {
            event.preventDefault();
            navigate({ tab: "now" });
          }}
          className="m-brand"
        >
          <img src="/monitor-icon.png" alt="" />
          <span>
            LOCAL BUILD DESK<small>MOBILE MONITOR</small>
          </span>
        </a>
        <span className={`m-connection ${connected ? "live" : ""}`}>
          <i />
          {connected ? "Live" : document.hidden ? "Paused" : "Reconnecting"}
        </span>
      </header>
      {!connected && (
        <div className="m-offline" role="status">
          Connection paused.{" "}
          {snapshot
            ? `Last contact ${elapsedLabel(now - lastContact)} ago. Showing the last received state.`
            : "Waiting for your Mac. Keep it awake and connected."}
        </div>
      )}
      {!current.job && current.tab !== "releases" && (
        <div className="m-filter">
          <span>
            {current.tab === "now"
              ? "ACTIVITY"
              : current.tab === "history"
                ? "BUILD HISTORY"
                : "YOUR PROJECTS"}
          </span>
          <select
            aria-label="Project filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="">All projects</option>
            {snapshot?.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <main className="m-content">
        {current.job ? (
          <JobDetail
            key={current.job}
            id={current.job}
            snapshot={snapshot}
            now={now}
            onBack={() => navigate({ tab: current.tab })}
          />
        ) : current.tab === "now" ? (
          <>
            <div className="m-summary">
              <div>
                <span className="m-eyebrow">RUNNING ON YOUR MAC</span>
                <h1>
                  {snapshot
                    ? filter
                      ? jobs.filter((j) => j.status === "running").length
                      : snapshot.counts.active
                    : "—"}
                  <span>active</span>
                </h1>
              </div>
              <div className="m-summary-side">
                <span>
                  {filter
                    ? jobs.filter((j) => j.status === "queued").length
                    : (snapshot?.counts.queued ?? 0)}
                  <small>queued</small>
                </span>
                <span>
                  {filter
                    ? jobs.filter((j) => j.submission?.state === "processing")
                        .length
                    : (snapshot?.counts.processing ?? 0)}
                  <small>processing</small>
                </span>
              </div>
            </div>
            {jobs.filter(active).length ? (
              jobs
                .filter(active)
                .map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    onOpen={() => open(job.id)}
                    now={now}
                  />
                ))
            ) : (
              <div className="m-standby">
                <Radio size={24} />
                <h2>Your Mac is ready.</h2>
                <p>
                  New desktop and CLI jobs appear here as soon as they start.
                </p>
              </div>
            )}
            {!!jobs.filter(
              (j) =>
                failed(j) &&
                Date.parse(j.finishedAt ?? j.createdAt) > now - 86400000,
            ).length && (
              <>
                <Section title="Needs a look" />
                <div className="m-job-stack">
                  {jobs
                    .filter(
                      (j) =>
                        failed(j) &&
                        Date.parse(j.finishedAt ?? j.createdAt) >
                          now - 86400000,
                    )
                    .slice(0, 3)
                    .map((job) => (
                      <JobCard
                        key={job.id}
                        job={job}
                        onOpen={() => open(job.id)}
                        now={now}
                        compact
                      />
                    ))}
                </div>
              </>
            )}
            <Section
              title="Recently finished"
              action="Full history"
              onAction={() => navigate({ tab: "history" })}
            />
            <div className="m-job-stack">
              {jobs
                .filter((j) => !active(j))
                .slice(0, 4)
                .map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    onOpen={() => open(job.id)}
                    now={now}
                    compact
                  />
                ))}
            </div>
            {!snapshot && (
              <p className="m-muted" role="status">
                Receiving build state…
              </p>
            )}
          </>
        ) : current.tab === "history" ? (
          <HistoryView project={filter} onOpen={open} now={now} />
        ) : current.tab === "releases" ? (
          <Releases
            projects={snapshot?.projects ?? []}
            initialProject={filter}
          />
        ) : (
          <>
            <h1 className="m-page-title">Your projects.</h1>
            <div className="m-projects">
              {snapshot?.projects
                .filter((p) => !filter || p.id === filter)
                .map((project) => (
                  <button
                    key={project.id}
                    onClick={() => {
                      setFilter(project.id);
                      navigate({ tab: "now" });
                    }}
                  >
                    <div>
                      <h2>{project.name}</h2>
                      <p>{project.bundleId ?? project.packageName}</p>
                      <span className="m-mono">
                        {project.type ?? "expo"} · {project.version ?? "—"}
                      </span>
                    </div>
                    <ChevronRight size={18} />
                  </button>
                ))}
            </div>
            <section className="m-about">
              <ShieldCheck size={20} />
              <h2>Paired with your Mac</h2>
              <p>
                {device} · Local Build Desk {snapshot?.server.version ?? ""}
              </p>
              <p>
                Use Safari's Share menu to add this dashboard to your Home
                Screen. Your Mac must stay awake and connected.
              </p>
              <button
                className="m-button"
                onClick={() =>
                  void request("logout", { method: "POST", body: "{}" }).then(
                    () => setAuth("pair"),
                  )
                }
              >
                <LogOut size={15} />
                Forget this browser
              </button>
            </section>
          </>
        )}
      </main>
      {!current.job && (
        <nav className="m-nav" aria-label="Mobile navigation">
          {(
            [
              { tab: "now", label: "Now", icon: Activity },
              { tab: "history", label: "History", icon: History },
              { tab: "releases", label: "Releases", icon: Layers3 },
              { tab: "projects", label: "Projects", icon: Package },
            ] as const
          ).map((item) => (
            <button
              key={item.tab}
              aria-current={current.tab === item.tab ? "page" : undefined}
              onClick={() => navigate({ tab: item.tab })}
            >
              <item.icon size={20} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
function Section({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="m-section-heading">
      <h2>{title}</h2>
      {action && (
        <button onClick={onAction}>
          {action}
          <ArrowUpRight size={13} />
        </button>
      )}
    </div>
  );
}
function HistoryView({
  project,
  onOpen,
  now,
}: {
  project: string;
  onOpen: (id: string) => void;
  now: number;
}) {
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState(""),
    [jobs, setJobs] = useState<MonitorJob[]>([]),
    [total, setTotal] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const sequence = useRef(0);
  const load = async (reset: boolean) => {
    const token = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      const result = await request<{ jobs: MonitorJob[]; total: number }>(
        `history?${new URLSearchParams({ project, query, status, offset: String(reset ? 0 : jobs.length) })}`,
      );
      if (token !== sequence.current) return;
      setJobs((old) => (reset ? result.jobs : [...old, ...result.jobs]));
      setTotal(result.total);
    } catch (error) {
      if (token === sequence.current) setError((error as Error).message);
    } finally {
      if (token === sequence.current) setBusy(false);
    }
  };
  useEffect(() => {
    const timer = setTimeout(() => void load(true), 250);
    return () => {
      clearTimeout(timer);
      sequence.current++;
    };
  }, [project, query, status]);
  return (
    <>
      <h1 className="m-page-title">
        Every build.
        <br />
        <span>The full picture.</span>
      </h1>
      <label className="m-search">
        <Search size={17} />
        <input
          aria-label="Search build history"
          placeholder="Project, version, build number…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="m-history-tools">
        <select
          aria-label="History status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">All statuses</option>
          <option value="running">Running</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="needs-attention">Needs attention</option>
          <option value="interrupted">Interrupted</option>
        </select>
        <span className="m-mono">{total} jobs</span>
      </div>
      {error && (
        <p className="m-error" role="alert">
          {error}
        </p>
      )}
      <div className="m-job-stack">
        {jobs.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            onOpen={() => onOpen(job.id)}
            now={now}
            compact
          />
        ))}
      </div>
      {busy && (
        <p className="m-muted" role="status">
          Reading build history…
        </p>
      )}
      {!busy && !jobs.length && (
        <p className="m-empty">No builds match this search.</p>
      )}
      {jobs.length < total && (
        <button
          className="m-button m-wide"
          disabled={busy}
          onClick={() => void load(false)}
        >
          Load more
        </button>
      )}
    </>
  );
}
function JobDetail({
  id,
  snapshot,
  now,
  onBack,
}: {
  id: string;
  snapshot?: MonitorSnapshot;
  now: number;
  onBack: () => void;
}) {
  const [job, setJob] = useState<MonitorJob>(),
    [tab, setTab] = useState<"overview" | "logs" | "tests" | "artifacts">(
      "overview",
    ),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const existing = snapshot?.jobs.find((j) => j.id === id);
    if (existing) setJob(existing);
    else
      void request<MonitorJob>(`jobs/${safeId(id)}`)
        .then((value) => active && setJob(value))
        .catch((error) => active && setError(error.message));
    return () => {
      active = false;
    };
  }, [id, snapshot]);
  return (
    <>
      <button className="m-back" onClick={onBack}>
        <ArrowLeft size={17} />
        Back
      </button>
      {error && <p className="m-error">{error}</p>}
      {job ? (
        <>
          <div className="m-detail-heading">
            <span className="m-eyebrow">
              {job.platform.toUpperCase()} · {job.profile} · {job.kind}
            </span>
            <h1>{job.projectName}</h1>
            <div>
              <span>
                {job.version ?? "—"}
                {job.buildNumber ? ` (${job.buildNumber})` : ""}
              </span>
              <Badge
                tone={failed(job) ? "danger" : active(job) ? "amber" : "green"}
              >
                {label(job)}
              </Badge>
            </div>
          </div>
          {active(job) && <Progress job={job} now={now} />}
          <div className="m-detail-tabs">
            {(["overview", "logs", "tests", "artifacts"] as const).map(
              (name) => (
                <button
                  key={name}
                  aria-pressed={tab === name}
                  onClick={() => setTab(name)}
                >
                  {name === "tests" ? "Checks" : name}
                </button>
              ),
            )}
          </div>
          {tab === "logs" ? (
            <Logs job={job} />
          ) : tab === "tests" ? (
            <>
              <Section title="Local checks & captures" />
              {job.validation ? (
                <>
                  <Badge
                    tone={
                      job.validation.state === "passed" ? "green" : "danger"
                    }
                  >
                    {job.validation.state}
                  </Badge>
                  <p className="m-muted">
                    {job.validation.configuration} · {job.validation.mode}
                  </p>
                  {job.validation.error && (
                    <p className="m-error">{job.validation.error}</p>
                  )}
                  {job.validation.runs.map((run, i) => (
                    <div className="m-check-run" key={i}>
                      <strong>{run.device}</strong>
                      <span>
                        {run.runtime ? `iOS ${run.runtime} · ` : ""}
                        {run.passed ?? 0} passed · {run.failed ?? 0} failed ·{" "}
                        {run.status}
                      </span>
                    </div>
                  ))}
                  <div className="m-image-grid">
                    {job.validation.screenshots.map((image) => (
                      <ImageTile
                        key={image.index}
                        name={image.name}
                        src={`/api/jobs/${safeId(id)}/captures/${image.index}`}
                        width={image.width}
                        height={image.height}
                        caption={image.device}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <p className="m-empty">
                  No check results were recorded for this job.
                </p>
              )}
            </>
          ) : tab === "artifacts" ? (
            <>
              <Section title="Verified artifacts" />
              {job.artifacts.map((artifact) => (
                <div className="m-artifact" key={artifact.id}>
                  <div>
                    <Package size={19} />
                    <strong>{artifact.kind.toUpperCase()}</strong>
                    <span>{bytes(artifact.size)}</span>
                  </div>
                  <p>
                    {artifact.bundleId} · {artifact.version} (
                    {artifact.buildNumber})
                  </p>
                  <details>
                    <summary>SHA-256 checksum</summary>
                    <code>{artifact.sha256}</code>
                  </details>
                </div>
              ))}
              {!job.artifacts.length && (
                <p className="m-empty">No verified artifacts yet.</p>
              )}
            </>
          ) : (
            <>
              {job.error && (
                <div className="m-error">
                  <strong>This job needs attention</strong>
                  <p>{job.error}</p>
                </div>
              )}
              {job.submission && (
                <section className="m-delivery">
                  <Layers3 size={18} />
                  <h2>{human(job.submission.state)}</h2>
                  <p>{job.submission.destination}</p>
                  <p>{job.submission.message}</p>
                  {job.submission.lastCheckedAt && (
                    <small>
                      Store last checked {time(job.submission.lastCheckedAt)}
                    </small>
                  )}
                </section>
              )}
              <dl className="m-facts">
                <div>
                  <dt>Created</dt>
                  <dd>{time(job.createdAt)}</dd>
                </div>
                <div>
                  <dt>Started</dt>
                  <dd>{time(job.startedAt)}</dd>
                </div>
                {job.finishedAt && (
                  <div>
                    <dt>Finished</dt>
                    <dd>{time(job.finishedAt)}</dd>
                  </div>
                )}
                {job.bundleId && (
                  <div>
                    <dt>Identity</dt>
                    <dd>{job.bundleId}</dd>
                  </div>
                )}
                {job.toolchain && (
                  <>
                    <div>
                      <dt>Xcode</dt>
                      <dd>{job.toolchain.xcodeVersion}</dd>
                    </div>
                    <div>
                      <dt>iOS SDK</dt>
                      <dd>{job.toolchain.iosSdk}</dd>
                    </div>
                  </>
                )}
                {job.source?.hash && (
                  <div>
                    <dt>Source</dt>
                    <dd className="m-mono">{job.source.hash.slice(0, 16)}</dd>
                  </div>
                )}
              </dl>
              <Section title="Stage history" />
              {job.checkpoints?.map((step, i) => (
                <div key={i} className={`m-checkpoint ${step.state}`}>
                  <i />
                  <div>
                    <strong>{human(step.stage)}</strong>
                    <span>
                      {human(step.state)}
                      {step.finishedAt
                        ? ` · ${elapsedLabel(Date.parse(step.finishedAt) - Date.parse(step.startedAt))}`
                        : ""}
                    </span>
                    {step.detail && <p>{step.detail}</p>}
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      ) : (
        <p className="m-muted" role="status">
          Loading the build…
        </p>
      )}
    </>
  );
}
function Logs({ job }: { job: MonitorJob }) {
  const [lines, setLines] = useState<
      { time: string; stage: string; text: string }[]
    >([]),
    [search, setSearch] = useState(""),
    [error, setError] = useState(""),
    [follow, setFollow] = useState(true),
    [loading, setLoading] = useState(true);
  const cursor = useRef<number | undefined>(undefined),
    busy = useRef(false),
    pane = useRef<HTMLDivElement>(null),
    following = useRef(true);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    cursor.current = undefined;
    setLines([]);
    const load = async () => {
      if (busy.current || document.hidden) return;
      busy.current = true;
      try {
        const result = await request<MonitorLogs>(
          `jobs/${safeId(job.id)}/logs${cursor.current === undefined ? "" : `?after=${cursor.current}`}`,
          { signal: controller.signal },
        );
        if (!alive) return;
        cursor.current = result.cursor;
        setLines((old) =>
          (result.reset ? result.entries : [...old, ...result.entries]).slice(
            -2000,
          ),
        );
        setError("");
      } catch (error) {
        if (alive) setError((error as Error).message);
      } finally {
        busy.current = false;
        if (alive) setLoading(false);
      }
    };
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail === job.id) void load();
    };
    void load();
    const timer = setInterval(() => void load(), 2500);
    window.addEventListener("monitor-log", changed);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("monitor-log", changed);
    };
  }, [job.id]);
  useLayoutEffect(() => {
    const element = pane.current;
    if (!element || !following.current) return;
    const bounds = element.getBoundingClientRect();
    if (
      bounds.top >=
        (document.querySelector(".m-header")?.getBoundingClientRect().bottom ??
          0) &&
      bounds.bottom <= window.innerHeight
    )
      element.scrollTop = element.scrollHeight;
  }, [lines]);
  const filtered = lines.filter(
    (line) =>
      !search ||
      line.text.toLowerCase().includes(search.toLowerCase()) ||
      line.stage.includes(search.toLowerCase()),
  );
  return (
    <div className="m-logs">
      <label className="m-search">
        <Search size={16} />
        <input
          aria-label="Search loaded logs"
          placeholder="Search loaded logs…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div className="m-log-tools">
        <span>{filtered.length} lines · latest 2,000</span>
        <button
          className={follow ? "selected" : ""}
          onClick={() => {
            following.current = true;
            setFollow(true);
            if (pane.current)
              pane.current.scrollTop = pane.current.scrollHeight;
          }}
        >
          Follow latest
        </button>
      </div>
      {error && <p className="m-error">{error}</p>}
      <div
        ref={pane}
        className="m-log-pane"
        tabIndex={0}
        aria-label="Build logs"
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current =
            element.scrollTop + element.clientHeight >=
            element.scrollHeight - 35;
          setFollow(following.current);
        }}
      >
        {loading ? (
          <p className="m-muted">Loading retained logs…</p>
        ) : !filtered.length ? (
          <p className="m-muted">
            {search ? "No matching log lines." : "No log output yet."}
          </p>
        ) : (
          filtered.map((line, i) => (
            <div
              className={`m-log-line ${/\berror\b|failed/i.test(line.text) ? "error" : ""}`}
              key={line.time + ":" + i}
            >
              <span>
                {new Date(line.time).toLocaleTimeString([], { hour12: false })}
              </span>
              <pre>{line.text}</pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
function ImageTile({
  src,
  name,
  width,
  height,
  caption,
}: {
  src: string;
  name: string;
  width?: number;
  height?: number;
  caption?: string;
}) {
  const [error, setError] = useState(false),
    [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  return (
    <figure className="m-image">
      <button
        onClick={() => setOpen(true)}
        disabled={error}
        style={{
          aspectRatio:
            width && height
              ? `${width}/${height}`
              : name.includes("featureGraphic")
                ? "16/9"
                : name.startsWith("icon")
                  ? "1"
                  : "9/16",
        }}
      >
        {error ? (
          <span>
            <ImageIcon size={22} />
            Preview unavailable
          </span>
        ) : (
          <img
            src={src}
            alt={name}
            loading="lazy"
            onError={() => setError(true)}
          />
        )}
      </button>
      <figcaption>
        {name}
        {caption && <span>{caption}</span>}
      </figcaption>
      {open && (
        <dialog
          ref={dialog}
          className="m-image-dialog"
          aria-label={name}
          onCancel={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
        >
          <div>
            <strong>{name}</strong>
            <button
              aria-label="Close screenshot"
              onClick={() => setOpen(false)}
              autoFocus
            >
              <X size={20} />
            </button>
          </div>
          <img src={src} alt={name} />
        </dialog>
      )}
    </figure>
  );
}
function Releases({
  projects,
  initialProject,
}: {
  projects: MonitorSnapshot["projects"];
  initialProject: string;
}) {
  const [project, setProject] = useState(
      initialProject || projects[0]?.id || "",
    ),
    [snapshot, setSnapshot] = useState<StoreReleaseSnapshot>(),
    [channel, setChannel] = useState<StoreChannel>("appstore"),
    [selected, setSelected] = useState<string>(),
    [detail, setDetail] = useState<StoreReleaseDetail>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const sequence = useRef(0);
  useEffect(() => {
    if (!project && projects[0]) setProject(projects[0].id);
  }, [projects, project]);
  const refresh = async () => {
    if (!project) return;
    const token = ++sequence.current;
    setBusy(true);
    setError("");
    setSelected(undefined);
    setDetail(undefined);
    try {
      const result = await request<StoreReleaseSnapshot>(
        `projects/${safeId(project)}/releases`,
      );
      if (token !== sequence.current) return;
      setSnapshot(result);
      if (!result.channels.appstore.connected && result.channels.play.connected)
        setChannel("play");
    } catch (error) {
      if (token === sequence.current) setError((error as Error).message);
    } finally {
      if (token === sequence.current) setBusy(false);
    }
  };
  useEffect(() => {
    setSnapshot(undefined);
    void refresh();
    return () => {
      sequence.current++;
    };
  }, [project]);
  const show = async (id: string, locale?: string) => {
    const token = ++sequence.current;
    setSelected(id);
    setDetail(undefined);
    setBusy(true);
    setError("");
    try {
      const result = await request<StoreReleaseDetail>(
        `projects/${safeId(project)}/releases/${safeId(id)}${locale ? `?locale=${encodeURIComponent(locale)}` : ""}`,
      );
      if (token === sequence.current) setDetail(result);
    } catch (error) {
      if (token === sequence.current) setError((error as Error).message);
    } finally {
      if (token === sequence.current) setBusy(false);
    }
  };
  const release = snapshot?.releases.find((r) => r.id === selected),
    source = snapshot?.channels[channel];
  return (
    <>
      <div className="m-store-heading">
        <span className="m-eyebrow">LIVE STORE RECORDS</span>
        <h1>Your releases.</h1>
        <p className="m-muted">
          The version in review. The builds being tested. The assets attached.
        </p>
      </div>
      <label className="m-store-project">
        App
        <select
          aria-label="Store project"
          value={project}
          onChange={(event) => setProject(event.target.value)}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <div className="m-store-tabs">
        {(Object.keys(channelNames) as StoreChannel[]).map((key) => (
          <button
            key={key}
            disabled={busy && !snapshot}
            aria-pressed={channel === key}
            onClick={() => {
              sequence.current++;
              setChannel(key);
              setSelected(undefined);
              setDetail(undefined);
              setBusy(false);
              setError("");
            }}
          >
            {channelNames[key]}
          </button>
        ))}
      </div>
      {source?.note && <p className="m-store-note">{source.note}</p>}
      {source?.error && <p className="m-error">{source.error}</p>}
      {error && (
        <p className="m-error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p className="m-muted" role="status">
          <RefreshCw size={14} className="m-spin" /> Reading the store. This can
          take a minute…
        </p>
      )}
      {release ? (
        <>
          <button
            className="m-back"
            onClick={() => {
              sequence.current++;
              setSelected(undefined);
              setDetail(undefined);
              setBusy(false);
            }}
          >
            <ArrowLeft size={15} />
            All {channelNames[channel]} records
          </button>
          <section className="m-store-detail">
            <h2>{release.version ?? "Uploaded build"}</h2>
            <Badge tone="amber">{human(release.status)}</Badge>
            <p className="m-mono">
              Build {release.buildNumbers.join(", ") || "not attached"}
              {release.track ? ` · ${release.track}` : ""}
            </p>
            {release.internalState && (
              <p>Internal: {human(release.internalState)}</p>
            )}
            {release.externalState && (
              <p>External: {human(release.externalState)}</p>
            )}
            {release.betaReviewState && (
              <p>Beta review: {human(release.betaReviewState)}</p>
            )}
            {release.fraction !== undefined && (
              <p>Rollout: {Math.round(release.fraction * 100)}%</p>
            )}
            <a
              href={release.consoleUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="m-button"
            >
              Open store console <ArrowUpRight size={15} />
            </a>
          </section>
          {detail && (
            <>
              <div className="m-store-note">
                {detail.notes.map((note, i) => (
                  <p key={i}>{note}</p>
                ))}
              </div>
              {detail.groups.length > 0 && (
                <p className="m-muted">Groups: {detail.groups.join(", ")}</p>
              )}
              {detail.listings.length > 1 && (
                <label className="m-store-project">
                  Language
                  <select
                    aria-label="Listing language"
                    value={detail.imageLocale ?? detail.listings[0]?.locale}
                    onChange={(event) =>
                      void show(release.id, event.target.value)
                    }
                  >
                    {detail.listings.map((l) => (
                      <option key={l.locale}>{l.locale}</option>
                    ))}
                  </select>
                </label>
              )}
              {detail.listings
                .filter(
                  (l) =>
                    l.locale ===
                    (detail.imageLocale ?? detail.listings[0]?.locale),
                )
                .map((listing) => (
                  <section className="m-store-copy" key={listing.locale}>
                    {listing.title && <h3>{listing.title}</h3>}
                    {listing.whatsNew && (
                      <>
                        <Section
                          title={
                            channel === "testflight"
                              ? "What to test"
                              : "What's new"
                          }
                        />
                        <p>{listing.whatsNew}</p>
                      </>
                    )}
                    {listing.shortDescription && (
                      <p>{listing.shortDescription}</p>
                    )}
                    {listing.description && (
                      <details>
                        <summary>Submitted description</summary>
                        <p>{listing.description}</p>
                      </details>
                    )}
                  </section>
                ))}
              <Section title="Listing assets & captures" />
              <div className="m-image-grid">
                {detail.images.map((image) => (
                  <ImageTile
                    key={image.id}
                    name={image.name}
                    src={`/api/projects/${safeId(project)}/images/${safeId(image.id)}`}
                    width={image.width}
                    height={image.height}
                    caption={
                      image.origin === "local"
                        ? "Local build capture"
                        : image.displayType
                    }
                  />
                ))}
              </div>
              {!detail.images.length && (
                <p className="m-empty">No screenshot previews available.</p>
              )}
            </>
          )}
        </>
      ) : (
        <div className="m-store-list">
          {snapshot?.releases
            .filter((r) => r.channel === channel)
            .map((row) => (
              <button key={row.id} onClick={() => void show(row.id)}>
                <div>
                  <strong>{row.version ?? "Uploaded build"}</strong>
                  <span>
                    Build {row.buildNumbers.join(", ") || "not attached"}
                    {row.track ? ` · ${row.track}` : ""}
                  </span>
                  <Badge tone="amber">{human(row.status)}</Badge>
                </div>
                <ChevronRight size={17} />
              </button>
            ))}
        </div>
      )}
      {!selected &&
        snapshot &&
        !snapshot.releases.some((r) => r.channel === channel) &&
        !busy && (
          <p className="m-empty">
            {source?.connected
              ? "No records returned for this destination."
              : "Connect this store in Local Build Desk on the Mac."}
          </p>
        )}
      {snapshot && (
        <p className="m-store-note">
          Store last checked {time(detail?.checkedAt ?? snapshot.checkedAt)}.
          Refresh to check for changes.
        </p>
      )}
      {snapshot && !selected && (
        <button
          className="m-button m-wide"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} />
          Refresh store status
        </button>
      )}
    </>
  );
}

import { useLogFollow } from "./useLogFollow";
import { WorkProgress } from "./WorkProgress";
import {
  BuildChanges,
  DeskPreferences,
  ReleaseAssistant,
  ReusePicker,
  DeviceInstaller,
} from "./WorkflowTools";
import { stageGuidance } from "../../core/progress";
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  ArrowRight,
  ArrowDownToLine,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CircuitBoard,
  Clock3,
  Code2,
  Download,
  ExternalLink,
  FileCode2,
  FileKey2,
  Folder,
  FolderOpen,
  GitBranch,
  HardDrive,
  KeyRound,
  Layers3,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Smartphone,
  Square,
  Terminal,
  Trash2,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { Setup } from "./Setup";
import type {
  Artifact,
  Check as ToolCheck,
  CredentialSummary,
  DeskState,
  DesktopAPI,
  Inspection,
  Job,
  LogEntry,
  Platform,
  Profile,
  Project,
  ProjectSettings,
  UpdateStatus,
} from "../../core/types";
declare global {
  interface Window {
    desk: DesktopAPI;
  }
}
const api = window.desk;
const initial: DeskState = {
  projects: [],
  jobs: [],
  credentials: [],
  artifacts: [],
  dataPath: "",
};
const pageNames = {
  project: "Project",
  setup: "Guided setup",
  builds: "Builds",
  signing: "Signing",
  connections: "Connections",
  toolchain: "Toolchain",
  preferences: "Preferences",
  release: "Release",
} as const;
type Page = keyof typeof pageNames;
const statusLabel = (value: string) =>
  value.replace(/-/g, " ").replace(/^./, (x) => x.toUpperCase());
const shortDate = (date: string) =>
  new Date(date).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const bytes = (n: number) =>
  n > 1e9
    ? `${(n / 1e9).toFixed(1)} GB`
    : n > 1e6
      ? `${(n / 1e6).toFixed(1)} MB`
      : `${(n / 1e3).toFixed(0)} KB`;
function Badge({ value }: { value: string }) {
  return (
    <span className={`badge ${value}`}>
      <i />
      {statusLabel(value)}
    </span>
  );
}
function PlatformIcon({
  platform,
  size = 16,
}: {
  platform: string;
  size?: number;
}) {
  return platform === "ios" ? (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M16.5 2c.1 1.2-.4 2.4-1.1 3.2-.8.9-1.8 1.4-2.8 1.3-.2-1.1.3-2.3 1-3.1.7-.8 1.9-1.4 2.9-1.4M19.8 17.1c-.4.9-.7 1.3-1.2 2.1-.8 1.1-1.8 2.5-3.1 2.5-1.1 0-1.4-.7-2.9-.7s-1.9.7-3 .7c-1.3 0-2.2-1.2-3-2.4C4.4 16 3.7 11.6 5.2 9.3c1.1-1.7 2.8-2.6 4.4-2.6 1.3 0 2.1.7 3.1.7.9 0 1.5-.7 3-.7 1.2 0 2.6.7 3.6 1.8-3.1 1.7-2.6 6.2.5 7.4-.1.4-.1.7 0 1.2" />
    </svg>
  ) : (
    <Smartphone size={size} />
  );
}
function Button({
  children,
  onClick,
  primary = false,
  disabled = false,
  className = "",
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      className={`${primary ? "primary" : "button"} ${className}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function UpdateControl({
  notify,
}: {
  notify: (text: string, error?: boolean) => void;
}) {
  const [update, setUpdate] = useState<UpdateStatus>();
  useEffect(() => {
    let active = true;
    void api.updateStatus().then((status) => active && setUpdate(status));
    const stop = api.onEvent((e) => {
      if (e.type === "update" && e.update) setUpdate(e.update);
    });
    return () => {
      active = false;
      stop();
    };
  }, []);
  if (!update || update.state === "disabled") return null;
  if (update.state === "ready")
    return (
      <button
        className="update-pill ready"
        title={`Local Build Desk ${update.version} is ready to install`}
        onClick={() =>
          void api.installUpdate().catch((e) => notify(e.message, true))
        }
      >
        <ArrowDownToLine size={13} />
        Restart to update
      </button>
    );
  if (update.state === "downloading")
    return (
      <span className="update-pill">
        <LoaderCircle size={13} className="spin" />
        UPDATING TO {update.version} · {update.percent ?? 0}%
        <progress
          aria-label="Downloading app update"
          max={100}
          value={update.percent ?? 0}
        />
      </span>
    );
  const checking = update.state === "checking";
  return (
    <button
      className="icon-button"
      aria-label="Check for updates"
      title={`Version ${update.currentVersion}. Check for updates`}
      disabled={checking}
      onClick={() =>
        void api
          .checkForUpdates()
          .then((status) => {
            if (status.state === "current")
              notify(
                `Local Build Desk ${status.currentVersion} is up to date.`,
              );
            else if (status.state === "error")
              notify(`Could not check for updates: ${status.error}`, true);
          })
          .catch((e) => notify(e.message, true))
      }
    >
      {checking ? (
        <LoaderCircle size={16} className="spin" />
      ) : (
        <ArrowDownToLine size={16} />
      )}
    </button>
  );
}
function playDestination(settings: ProjectSettings) {
  const track = settings.track ?? "internal";
  return track === "internal" && settings.playAutoRollout !== false
    ? `${track} · rolled out to testers`
    : `${track} · draft`;
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function SelectCredential({
  kind,
  value,
  onChange,
  credentials,
  label,
}: {
  kind: CredentialSummary["kind"];
  value?: string;
  onChange: (id: string) => void;
  credentials: CredentialSummary[];
  label: string;
}) {
  return (
    <Field label={label}>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a credential…</option>
        {credentials
          .filter((c) => c.kind === kind)
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
      </select>
    </Field>
  );
}
function Empty({
  icon,
  heading,
  children,
  action,
}: {
  icon: ReactNode;
  heading: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{heading}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
function Modal({
  title,
  subtitle,
  close,
  children,
}: {
  title: string;
  subtitle?: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const focusable = () =>
      [
        ...ref.current!.querySelectorAll<HTMLElement>(
          "button,input,select,textarea,a[href]",
        ),
      ].filter((e) => !e.hasAttribute("disabled"));
    focusable()[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "Tab") {
        const list = focusable();
        if (e.shiftKey && document.activeElement === list[0]) {
          e.preventDefault();
          list.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === list.at(-1)) {
          e.preventDefault();
          list[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="modal"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={close}
          >
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function App() {
  const [reuseChoice, setReuseChoice] = useState<{
    candidates: import("../../core/types").ReusableBuild[];
    projectId: string;
    profile: string;
    platform: Platform;
    autoSubmit: boolean;
  }>();
  const [reuseSearching, setReuseSearching] = useState(false);
  const [state, setState] = useState(initial),
    [page, setPage] = useState<Page>("project"),
    [projectId, setProjectId] = useState("");
  const [profile, setProfile] = useState("production"),
    [platform, setPlatform] = useState<Platform | "all">("ios"),
    [clean, setClean] = useState(false);
  const [inspection, setInspection] = useState<{
      inspection: Inspection;
      profile?: Profile;
    }>(),
    [checks, setChecks] = useState<ToolCheck[]>([]);
  const [busy, setBusy] = useState(false),
    [toast, setToast] = useState<{ text: string; error?: boolean }>(),
    [modal, setModal] = useState<string>(),
    [selectedJob, setSelectedJob] = useState<string>();
  const project =
    state.projects.find((p) => p.id === projectId) ?? state.projects[0];
  const checkRequest = useRef(0);
  const checkProject = useRef<string | undefined>(project?.id);
  checkProject.current = project?.id;
  const refreshChecks = useCallback(async (target?: string) => {
    if (target !== checkProject.current) return;
    const request = ++checkRequest.current;
    const result = await api.doctor(target);
    if (request === checkRequest.current && target === checkProject.current)
      setChecks(result);
  }, []);
  const notify = useCallback(
    (text: string, error = false) => setToast({ text, error }),
    [],
  );
  const refresh = useCallback(async () => {
    try {
      const next = await api.state();
      setState(next);
    } catch (e) {
      notify(String(e), true);
    }
  }, [notify]);
  useEffect(() => {
    void refresh();
    return api.onEvent((e) => {
      if (e.type === "state") void refresh();
      if (e.type === "focus-job" && e.jobId) {
        void api.state().then((next) => {
          setState(next);
          const job = next.jobs.find((j) => j.id === e.jobId);
          if (job) {
            setProjectId(job.projectId);
            setSelectedJob(job.id);
            setPage("builds");
          }
        });
      }
    });
  }, [refresh]);
  useEffect(() => {
    if (toast) {
      const timeout = setTimeout(() => setToast(undefined), 8000);
      return () => clearTimeout(timeout);
    }
  }, [toast]);
  useEffect(() => {
    if (!project) return;
    let active = true;
    api
      .inspect(project.id, profile, platform === "all" ? "ios" : platform)
      .then((result) => {
        if (active) setInspection(result);
      })
      .catch((e) => notify(e.message, true));
    return () => {
      active = false;
    };
  }, [project?.id, profile, platform, project?.settings.envCredentialId]);
  useEffect(() => {
    refreshChecks(project?.id).catch((e) => notify(e.message, true));
    return () => {
      checkRequest.current++;
    };
  }, [
    project?.id,
    project?.settings.nodePath,
    project?.settings.javaHome,
    project?.settings.androidSdk,
    project?.settings.xcodePath,
    project?.settings.buildDirectory,
    project?.settings.minimumIosSdk,
    project?.settings.iosSdk,
  ]);
  const action = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
      if (success) notify(success);
    } catch (e: any) {
      notify(e.message, true);
    } finally {
      setBusy(false);
    }
  };
  const importProject = () =>
    action(async () => {
      const paths = await api.choose({ kind: "directory" });
      if (!paths[0]) return;
      const p = await api.importProject(paths[0]);
      setProjectId(p.id);
      setProfile(
        p.profiles.includes("production") ? "production" : p.profiles[0],
      );
      setPage("setup");
    }, undefined);
  const build = (autoSubmit: boolean, fresh = false) =>
    action(async () => {
      if (!project) return;
      if (
        !fresh &&
        !clean &&
        platform !== "all" &&
        state.jobs.some(
          (j) =>
            j.projectId === project.id &&
            j.profile === profile &&
            j.platform === platform &&
            j.reuseFingerprint,
        )
      ) {
        setReuseSearching(true);
        try {
          const candidates = await api.findReusableBuilds(
            project.id,
            profile,
            platform,
          );
          if (candidates.length) {
            setReuseChoice({
              candidates,
              projectId: project.id,
              profile,
              platform,
              autoSubmit,
            });
            return;
          }
        } finally {
          setReuseSearching(false);
        }
      }
      const jobs = await api.build({
        projectId: project.id,
        platform,
        profile,
        autoSubmit,
        clean,
      });
      setSelectedJob(jobs[0].id);
      setPage("builds");
      notify("Build added to your local queue.");
    });
  const localJobs = state.jobs.filter((j) => j.projectId === project?.id),
    running = state.jobs.filter((j) =>
      ["running", "queued"].includes(j.status),
    );
  const saveSettings = (settings: ProjectSettings) =>
    action(
      () =>
        api.saveSettings(
          project!.id,
          Object.fromEntries(
            Object.entries(settings).filter(([, v]) => v !== ""),
          ),
        ),
      "Project settings saved.",
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="drag-region" />
        <div className="brand">
          <div className="brand-mark">
            <Layers3 size={21} />
          </div>
          <div>
            Local Build<span>DESK</span>
          </div>
          <span className="version">0.1</span>
        </div>
        <div className="workspace-label">
          WORKSPACE{" "}
          <button
            aria-label="Import project"
            onClick={() => void importProject()}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="project-picker">
          <div className="project-symbol">
            {project?.name.slice(0, 1) ?? "L"}
          </div>
          <select
            aria-label="Current project"
            value={project?.id ?? ""}
            onChange={(e) => {
              setProjectId(e.target.value);
              setSelectedJob(undefined);
            }}
          >
            {!state.projects.length && (
              <option value="">No project selected</option>
            )}
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {state.projects.filter((o) => o.name === p.name).length > 1
                  ? ` · ${p.path.split("/").at(-1)}`
                  : ""}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </div>
        <nav aria-label="Main navigation">
          {(Object.keys(pageNames) as Page[]).map((p) => {
            const Icon = {
              project: Box,
              setup: Zap,
              builds: Layers3,
              signing: ShieldCheck,
              connections: Link2,
              toolchain: CircuitBoard,
              preferences: Settings2,
              release: FileCode2,
            }[p];
            return (
              <button
                key={p}
                className={page === p ? "active" : ""}
                onClick={() => setPage(p)}
              >
                <Icon size={18} />
                <span>{pageNames[p]}</span>
                {p === "builds" && running.length > 0 && (
                  <b>{running.length}</b>
                )}
                {page === p && <span className="nav-dot" />}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="machine">
            <span className="machine-icon">
              <Monitor size={17} />
            </span>
            <div>
              This Mac
              <small>
                <i /> Local execution
              </small>
            </div>
            <LockKeyhole size={14} />
          </div>
          <button
            className="storage-link"
            onClick={() =>
              state.dataPath && void action(() => api.reveal(state.dataPath))
            }
          >
            <HardDrive size={13} />
            Local storage
            <ArrowUpRight size={13} />
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <span>{project?.name ?? "Getting started"}</span>
            <ChevronRight size={13} />
            <strong>{pageNames[page]}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-pill">
              <i /> ON YOUR MACHINE
            </span>
            <UpdateControl notify={notify} />
            <button
              className="icon-button"
              aria-label="Refresh"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await refresh();
                  await refreshChecks(project?.id);
                  if (project)
                    setInspection(
                      await api.inspect(
                        project.id,
                        profile,
                        platform === "all" ? "ios" : platform,
                      ),
                    );
                })
              }
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </header>
        <div className="content">
          {page === "preferences" && <DeskPreferences />}
          {page === "release" &&
            (project ? (
              <ReleaseAssistant
                key={project.id}
                project={project}
                jobs={state.jobs}
              />
            ) : (
              <p className="muted">Import a project to prepare a release.</p>
            ))}
          {page === "project" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">YOUR RELEASE WORKBENCH</div>
                  <h1>
                    {project
                      ? `${project.name}, ready when you are.`
                      : "Your next build starts here."}
                  </h1>
                  <p>From source code to the stores. Powered by your Mac.</p>
                </div>
                <div className="row-actions">
                  {project && (
                    <Button onClick={() => setPage("setup")}>
                      <Zap size={15} />
                      Guided setup
                    </Button>
                  )}
                  <Button onClick={() => void importProject()} disabled={busy}>
                    <Plus size={15} />
                    {project ? "Import project" : "Choose project"}
                  </Button>
                </div>
              </div>
              {!project ? (
                <div className="welcome-panel">
                  <div className="welcome-art">
                    <div className="art-orbit one" />
                    <div className="art-orbit two" />
                    <div className="art-center">
                      <Layers3 size={47} strokeWidth={1} />
                    </div>
                    <div className="art-chip code">
                      <Code2 size={18} />
                      source
                    </div>
                    <div className="art-chip mac">
                      <Monitor size={18} />
                      this Mac
                    </div>
                    <div className="art-chip output">
                      <Box size={18} />
                      your build
                    </div>
                  </div>
                  <div className="welcome-copy">
                    <span className="eyebrow">A SHORTER PATH TO SHIPPING</span>
                    <h2>
                      Bring the build
                      <br />
                      back to your desk.
                    </h2>
                    <p>
                      Import an Expo project to bring its profiles, app
                      configuration, and native plugins into a local release
                      workflow.
                    </p>
                    <Button
                      primary
                      onClick={() => void importProject()}
                      disabled={busy}
                    >
                      <FolderOpen size={17} />
                      Import an Expo project
                      <ArrowRight size={16} />
                    </Button>
                    <small>
                      Works with app.json, app.config.ts, and eas.json
                    </small>
                  </div>
                </div>
              ) : (
                <>
                  <div className="project-strip">
                    <div className="app-emblem">{project.name[0]}</div>
                    <div>
                      <strong>{project.name}</strong>
                      <span className="mono">
                        {project.bundleId ?? project.packageName}
                      </span>
                    </div>
                    <span className="divider" />
                    <div>
                      <small>APP VERSION</small>
                      <strong className="mono">{project.version ?? "—"}</strong>
                    </div>
                    <div>
                      <small>EXPO</small>
                      <strong className="mono">{project.sdk ?? "—"}</strong>
                    </div>
                    <button
                      className="path-link"
                      title={project.path}
                      onClick={() =>
                        void action(() => api.reveal(project.path))
                      }
                    >
                      <Folder size={14} />
                      {project.path.split("/").at(-1)}
                      <ArrowUpRight size={13} />
                    </button>
                  </div>
                  <section className="build-panel">
                    <div className="section-heading">
                      <div>
                        <span className="step-number">01</span>
                        <h2>Make your next build</h2>
                      </div>
                      <span className="muted">
                        <Zap size={13} /> Compiles locally
                      </span>
                    </div>
                    <div className="build-form">
                      <div>
                        <label className="control-label">PLATFORM</label>
                        <div className="platform-toggle">
                          {(["ios", "android", "all"] as const).map((p) => (
                            <button
                              key={p}
                              onClick={() => setPlatform(p)}
                              className={platform === p ? "selected" : ""}
                            >
                              {p === "all" ? (
                                <Layers3 size={16} />
                              ) : (
                                <PlatformIcon platform={p} />
                              )}{" "}
                              {p === "ios"
                                ? "iOS"
                                : p === "android"
                                  ? "Android"
                                  : "Both"}
                            </button>
                          ))}
                        </div>
                      </div>
                      <Field label="BUILD PROFILE">
                        <select
                          value={profile}
                          onChange={(e) => setProfile(e.target.value)}
                        >
                          {project.profiles.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <div className="build-actions">
                        <Button
                          onClick={() => void build(false)}
                          disabled={busy}
                        >
                          <Play size={14} fill="currentColor" />
                          Build
                        </Button>
                        <Button
                          primary
                          onClick={() => void build(true)}
                          disabled={busy}
                        >
                          <Upload size={15} />
                          Build & Upload
                          <ArrowUpRight size={15} />
                        </Button>
                      </div>
                    </div>
                    <div className="build-options">
                      <span>
                        <GitBranch size={14} />
                        Current working tree, including uncommitted files
                      </span>
                      <label>
                        <input
                          type="checkbox"
                          checked={clean}
                          onChange={(e) => setClean(e.target.checked)}
                        />
                        Clean native cache
                      </label>
                    </div>
                    <div className="destination">
                      <span>
                        <ArrowRight size={14} />
                        {platform === "ios"
                          ? "App Store Connect / TestFlight"
                          : platform === "android"
                            ? `Google Play · ${playDestination(project.settings)}`
                            : `App Store Connect + Google Play · ${playDestination(project.settings)}`}
                      </span>
                      <span>Build & Upload destination</span>
                    </div>
                  </section>
                  <div className="overview-grid">
                    <section className="readiness">
                      <div className="section-heading">
                        <h2>Release setup</h2>
                        <button
                          className="text-button"
                          onClick={() => setModal("migration")}
                        >
                          Migration
                          <ArrowUpRight size={13} />
                        </button>
                      </div>
                      {[
                        {
                          label: "Apple signing",
                          detail: project.settings.iosSigningId
                            ? "Certificate & profiles selected"
                            : "Import a certificate and provisioning profiles",
                          ready: !!project.settings.iosSigningId,
                          page: "signing",
                        },
                        {
                          label: "Android signing",
                          detail: project.settings.androidSigningId
                            ? "Existing upload key selected"
                            : "Bring your existing upload keystore",
                          ready: !!project.settings.androidSigningId,
                          page: "signing",
                        },
                        {
                          label: "Store connections",
                          detail:
                            project.settings.appleConnectionId &&
                            project.settings.googleConnectionId
                              ? "Apple & Google connected"
                              : "Connect your developer accounts",
                          ready:
                            !!project.settings.appleConnectionId &&
                            !!project.settings.googleConnectionId,
                          page: "connections",
                        },
                      ].map((item) => (
                        <button
                          className="readiness-row"
                          key={item.label}
                          onClick={() => setPage(item.page as Page)}
                        >
                          {item.ready ? (
                            <CheckCircle2 size={18} className="green" />
                          ) : (
                            <Circle size={18} />
                          )}
                          <span>
                            <strong>{item.label}</strong>
                            <small>{item.detail}</small>
                          </span>
                          <ChevronRight size={15} />
                        </button>
                      ))}
                    </section>
                    <section className="config-panel">
                      <div className="section-heading">
                        <h2>Profile details</h2>
                        <span className="mono subtle">eas.json</span>
                      </div>
                      <dl>
                        <div>
                          <dt>Distribution</dt>
                          <dd>{inspection?.profile?.distribution ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>Build configuration</dt>
                          <dd>{inspection?.profile?.configuration ?? "—"}</dd>
                        </div>
                        <div>
                          <dt>Native project</dt>
                          <dd>
                            {inspection?.inspection.native[
                              platform === "all" ? "ios" : platform
                            ]
                              ? "Maintained"
                              : "Generated from Expo"}
                          </dd>
                        </div>
                        <div>
                          <dt>Versioning</dt>
                          <dd>
                            {inspection?.profile?.autoIncrement
                              ? "Local auto-increment"
                              : "Configured build number"}
                          </dd>
                        </div>
                      </dl>
                      <p className="config-note">
                        <FileCode2 size={14} />
                        Your Expo plugins and app identity travel with the
                        build.
                      </p>
                    </section>
                  </div>
                  {!!inspection && (
                    <Compatibility
                      issues={[
                        ...inspection.inspection.issues,
                        ...(inspection.profile?.issues ?? []),
                      ]}
                    />
                  )}
                </>
              )}
              <section className="recent-builds">
                <div className="section-heading">
                  <h2>
                    Recent builds{" "}
                    <span className="count">{localJobs.length}</span>
                  </h2>
                  <button
                    className="text-button"
                    onClick={() => setPage("builds")}
                  >
                    View all
                    <ArrowRight size={14} />
                  </button>
                </div>
                {localJobs.length ? (
                  <JobTable
                    jobs={localJobs.slice(0, 5)}
                    selected={selectedJob}
                    onSelect={(j) => {
                      setSelectedJob(j.id);
                      setPage("builds");
                    }}
                  />
                ) : (
                  <div className="empty-row">
                    <span className="empty-line-icon">
                      <Terminal size={20} />
                    </span>
                    <div>
                      <strong>A clean build history.</strong>
                      <p>
                        Your local builds, logs, and artifacts will appear here.
                      </p>
                    </div>
                    <span className="mono subtle">.ipa / .aab / .apk</span>
                  </div>
                )}
              </section>
              <footer>
                <span>
                  <ShieldCheck size={13} />
                  Credentials encrypted with macOS Keychain
                </span>
                <span>Source → Local build → Your stores</span>
              </footer>
            </>
          )}
          {page === "setup" &&
            (project ? (
              <Setup
                project={project}
                credentials={state.credentials}
                checks={checks}
                openModal={setModal}
                refresh={async () => {
                  await refresh();
                  await refreshChecks(project.id);
                }}
                onBuild={async (platform, profile) => {
                  const jobs = await api.build({
                    projectId: project.id,
                    platform,
                    profile,
                    autoSubmit: true,
                  });
                  setSelectedJob(jobs[0].id);
                  setPage("builds");
                }}
              />
            ) : (
              <Empty
                icon={<Zap size={25} />}
                heading="Start with your Expo project"
                action={
                  <Button primary onClick={() => void importProject()}>
                    Choose project
                  </Button>
                }
              >
                Import your project folder to start guided setup.
              </Empty>
            ))}
          {page === "builds" && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">EVERY BUILD, ON YOUR TERMS</div>
                  <h1>Build history</h1>
                  <p>
                    Inspect the process. Keep the artifact. Ship when it’s
                    ready.
                  </p>
                </div>
                <Button
                  primary
                  disabled={!project}
                  onClick={() => setPage("project")}
                >
                  <Plus size={15} />
                  New build
                </Button>
              </div>
              {localJobs.length ? (
                <div className="builds-layout">
                  <section className="history-panel">
                    <JobTable
                      jobs={localJobs}
                      selected={selectedJob}
                      onSelect={(j) => setSelectedJob(j.id)}
                    />
                  </section>
                  <JobDetail
                    job={
                      localJobs.find((j) => j.id === selectedJob) ??
                      localJobs[0]
                    }
                    artifacts={state.artifacts}
                    action={action}
                    onSelect={(job) => setSelectedJob(job.id)}
                  />
                </div>
              ) : (
                <section className="large-empty">
                  <Empty
                    icon={<Layers3 size={27} />}
                    heading="Your build history is waiting."
                    action={
                      <Button onClick={() => setPage("project")}>
                        Go to project
                        <ArrowRight size={15} />
                      </Button>
                    }
                  >
                    Run your first build to see stage progress, logs, and signed
                    artifacts here.
                  </Empty>
                </section>
              )}
            </>
          )}
          {page === "signing" && (
            <>
              <PageHeader
                eyebrow="YOUR KEYS STAY HERE"
                title="Signing & provisioning"
                description="The same app identity. Credentials under your control."
                action={
                  <Button primary onClick={() => setModal("ios")}>
                    <Plus size={15} />
                    Import signing credentials
                  </Button>
                }
              />
              <div className="two-columns">
                <CredentialList
                  title="Apple signing"
                  description="Certificates and provisioning profiles"
                  icon={<PlatformIcon platform="ios" size={23} />}
                  credentials={state.credentials.filter(
                    (c) => c.kind === "ios",
                  )}
                  action={action}
                  onImport={() => setModal("ios")}
                />
                <CredentialList
                  title="Android signing"
                  description="Existing upload keys for your apps"
                  icon={<PlatformIcon platform="android" size={23} />}
                  credentials={state.credentials.filter(
                    (c) => c.kind === "android",
                  )}
                  action={action}
                  onImport={() => setModal("android")}
                />
              </div>
              {project && (
                <SettingsSection
                  project={project}
                  credentials={state.credentials}
                  mode="signing"
                  save={saveSettings}
                />
              )}
              <section className="section-card">
                <div className="section-heading">
                  <div>
                    <ShieldCheck size={18} />
                    <h2>Provisioning tools</h2>
                  </div>
                  <span className="muted">
                    Uses your selected Apple team connection
                  </span>
                </div>
                <div className="tool-actions">
                  <ToolAction
                    icon={<FileKey2 size={21} />}
                    title="Create distribution certificate"
                    description="Generate a private key on this Mac and request an Apple certificate."
                    onClick={() => setModal("certificate")}
                  />
                  <ToolAction
                    icon={<Smartphone size={21} />}
                    title="Register a device"
                    description="Add an iPhone or iPad UDID for development and ad hoc builds."
                    onClick={() => setModal("device")}
                  />
                  <ToolAction
                    icon={<ShieldCheck size={21} />}
                    title="Create or renew a profile"
                    description="Create a profile for a bundle ID using your imported certificate."
                    onClick={() => setModal("profile")}
                  />
                </div>
              </section>
              <section className="inline-callout">
                <KeyRound size={18} />
                <div>
                  <strong>Already using EAS?</strong>
                  <p>
                    Export credentials once with <code>eas credentials</code>,
                    then import credentials.json here.
                  </p>
                </div>
                <Button
                  disabled={!project}
                  onClick={() => setModal("migration")}
                >
                  Open migration
                  <ArrowRight size={14} />
                </Button>
              </section>
              <div className="subtle-action">
                <Button
                  disabled={!project || !!project.settings.androidSigningId}
                  onClick={() => setModal("keystore")}
                >
                  <Plus size={14} />
                  Generate an upload key for a new app
                </Button>
              </div>
            </>
          )}
          {page === "connections" && (
            <>
              <PageHeader
                eyebrow="DIRECT TO THE STORES"
                title="Your developer accounts"
                description="Connect once. Build and upload from your Mac."
              />
              <div className="two-columns">
                <CredentialList
                  title="App Store Connect"
                  description="Team API key · Apple Developer"
                  icon={<PlatformIcon platform="ios" size={24} />}
                  credentials={state.credentials.filter(
                    (c) => c.kind === "apple",
                  )}
                  action={action}
                  onImport={() => setModal("apple")}
                  connection
                />
                <CredentialList
                  title="Google Play Console"
                  description="Service account · Android Publisher API"
                  icon={<PlatformIcon platform="android" size={24} />}
                  credentials={state.credentials.filter(
                    (c) => c.kind === "google",
                  )}
                  action={action}
                  onImport={() => setModal("google")}
                  connection
                />
              </div>
              {project && (
                <SettingsSection
                  project={project}
                  credentials={state.credentials}
                  mode="connections"
                  save={saveSettings}
                />
              )}
              <section className="section-card">
                <div className="section-heading">
                  <h2>A one-time move from EAS</h2>
                  <span className="tag">LOCAL FROM HERE</span>
                </div>
                <div className="migration-steps">
                  <div>
                    <span>01</span>
                    <h3>Export your signing keys</h3>
                    <p>
                      Use <code>eas credentials</code> to download certificates,
                      profiles, and your existing Android keystore.
                    </p>
                  </div>
                  <div>
                    <span>02</span>
                    <h3>Bring your environment</h3>
                    <p>
                      Import local .env files or a JSON map. Secret EAS values
                      may need to be re-entered from their original source.
                    </p>
                  </div>
                  <div>
                    <span>03</span>
                    <h3>Continue your versions</h3>
                    <p>
                      Enter the last used build numbers. New reservations are
                      shared by app identity across project folders.
                    </p>
                  </div>
                </div>
                <Button
                  disabled={!project}
                  onClick={() => setModal("migration")}
                >
                  Start migration
                  <ArrowRight size={15} />
                </Button>
              </section>
              <section className="section-card">
                <div className="section-heading">
                  <h2>Environment vault</h2>
                  <span className="muted">
                    <LockKeyhole size={13} /> Values stay encrypted
                  </span>
                </div>
                {state.credentials
                  .filter((c) => c.kind === "environment")
                  .map((c) => (
                    <div className="environment-row" key={c.id}>
                      <FileKey2 size={16} />
                      <strong>{c.label}</strong>
                      <span>{c.detail}</span>
                    </div>
                  ))}
                {!state.credentials.some((c) => c.kind === "environment") && (
                  <p className="muted">
                    Import environment values through Migration to keep them out
                    of source files and build logs.
                  </p>
                )}
              </section>
            </>
          )}
          {page === "toolchain" && (
            <>
              <PageHeader
                eyebrow="YOUR MACHINE IS THE RUNNER"
                title="The local toolchain"
                description="Use the tools installed on this Mac, with per-project overrides."
                action={
                  <Button
                    onClick={() =>
                      void action(async () => refreshChecks(project?.id))
                    }
                    disabled={busy}
                  >
                    <RefreshCw size={15} />
                    Run checks
                  </Button>
                }
              />
              <section className="section-card toolchain-checks">
                <div className="section-heading">
                  <h2>System readiness</h2>
                  <span className="mono subtle">
                    {checks.filter((c) => c.status === "ok").length} /{" "}
                    {checks.length} checks ready
                  </span>
                </div>
                {checks.map((c) => (
                  <div className="toolchain-row" key={c.name}>
                    <div className={`check-icon ${c.status}`}>
                      {c.status === "ok" ? (
                        <Check size={17} />
                      ) : (
                        <CircleAlert size={17} />
                      )}
                    </div>
                    <div>
                      <strong>{c.name}</strong>
                      <span>{c.detail}</span>
                      {c.status !== "ok" && c.action && (
                        <small>{c.action}</small>
                      )}
                    </div>
                    <Badge
                      value={
                        c.status === "ok"
                          ? "ready"
                          : c.status === "error"
                            ? "missing"
                            : "check"
                      }
                    />
                  </div>
                ))}
              </section>
              {project && (
                <ToolchainSettings project={project} save={saveSettings} />
              )}
              <section className="inline-callout">
                <Terminal size={20} />
                <div>
                  <strong>The same engine, from your terminal.</strong>
                  <p>
                    <code>
                      ios-submit build --project /path/to/app --platform all
                      --profile production
                    </code>
                  </p>
                </div>
              </section>
            </>
          )}
        </div>
      </main>
      {busy && (
        <div className="busy-indicator" role="status">
          <LoaderCircle className="spin" size={15} />
          {reuseSearching ? "Checking local build compatibility…" : "Working…"}
        </div>
      )}
      {toast && (
        <div
          className={`toast ${toast.error ? "error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          {toast.error ? <CircleAlert size={18} /> : <CheckCircle2 size={18} />}
          <span>{toast.text}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast(undefined)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {modal && (
        <Modal
          title={
            {
              apple: "Connect App Store Connect",
              google: "Connect Google Play",
              ios: "Import Apple signing",
              android: "Import Android upload key",
              migration: "Move your project from EAS",
              certificate: "Create distribution certificate",
              device: "Register an Apple device",
              profile: "Create a provisioning profile",
              keystore: "Generate a new upload key",
            }[modal] ?? modal
          }
          close={() => setModal(undefined)}
        >
          <CredentialForm
            kind={modal}
            project={project}
            credentials={state.credentials}
            action={action}
            close={() => setModal(undefined)}
          />
        </Modal>
      )}
      {reuseChoice && (
        <Modal
          title="Reuse an existing build"
          close={() => setReuseChoice(undefined)}
        >
          <ReusePicker
            {...reuseChoice}
            onUse={(job) => {
              setReuseChoice(undefined);
              setSelectedJob(job.id);
              setPage("builds");
            }}
            onFresh={() => {
              const submit = reuseChoice.autoSubmit;
              setReuseChoice(undefined);
              void build(submit, true);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
function Compatibility({
  issues,
}: {
  issues: { severity: string; message: string; code: string }[];
}) {
  const useful = issues.filter((i) => i.severity !== "info");
  return useful.length ? (
    <details
      className={`compatibility ${useful.some((i) => i.severity === "error") ? "has-errors" : ""}`}
    >
      <summary>
        <CircleAlert size={15} />
        {useful.length} configuration note{useful.length !== 1 ? "s" : ""}
        <ChevronDown size={14} />
      </summary>
      <div>
        {useful.map((i, n) => (
          <p key={n}>
            <span className="mono">{i.code}</span>
            {i.message}
          </p>
        ))}
      </div>
    </details>
  ) : null;
}
function JobTable({
  jobs,
  selected,
  onSelect,
}: {
  jobs: Job[];
  selected?: string;
  onSelect: (job: Job) => void;
}) {
  return (
    <table className="job-table">
      <thead>
        <tr>
          <th>BUILD / PLATFORM</th>
          <th>PROFILE</th>
          <th>STATUS</th>
          <th>CREATED</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <tr
            key={j.id}
            className={selected === j.id ? "selected" : ""}
            onClick={() => onSelect(j)}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSelect(j);
            }}
            aria-label={`${j.platform} ${j.profile} ${j.status} build`}
          >
            <td>
              <span className="table-platform">
                <PlatformIcon platform={j.platform} />
                <strong>{j.platform === "ios" ? "iOS" : "Android"}</strong>
                <span className="mono">
                  {j.buildNumber ? `#${j.buildNumber}` : j.id.slice(0, 7)}
                </span>
                {j.kind === "submit" && <Upload size={12} />}
              </span>
            </td>
            <td>
              <span className="profile-tag">{j.profile}</span>
            </td>
            <td>
              <Badge
                value={
                  j.submission?.state === "processing" ? "processing" : j.status
                }
              />
            </td>
            <td className="subtle">{shortDate(j.createdAt)}</td>
            <td>
              <ChevronRight size={14} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
function JobDetail({
  job,
  artifacts,
  action,
  onSelect,
}: {
  job: Job;
  artifacts: Artifact[];
  action: (fn: () => Promise<unknown>, success?: string) => Promise<void>;
  onSelect: (job: Job) => void;
}) {
  const [logs, setLogs] = useState<LogEntry[]>([]),
    [search, setSearch] = useState("");
  const logsRef = useLogFollow(job.id, logs.length, !!search);
  useEffect(() => {
    let active = true;
    api.logs(job.id).then((v) => {
      if (active) setLogs(v);
    });
    const stop = api.onEvent((e) => {
      if (e.type === "log" && e.jobId === job.id && e.entry)
        setLogs((v) => [...v, e.entry!]);
    });
    return () => {
      active = false;
      stop();
    };
  }, [job.id]);
  const stages =
    job.kind === "submit"
      ? ["verify", "upload"]
      : [
          "preflight",
          "snapshot",
          "install",
          "configure",
          "signing",
          "compile",
          "export",
          "verify",
          "upload",
        ];
  const index = stages.indexOf(job.stage);
  const output = artifacts.filter(
    (a) => a.jobId === (job.parentJobId ?? job.id),
  );
  return (
    <section className="job-detail">
      <div className="section-heading">
        <div>
          <PlatformIcon platform={job.platform} size={20} />
          <h2>
            {job.platform === "ios" ? "iOS" : "Android"}{" "}
            {job.kind === "submit" ? "submission" : "build"}
            <span className="mono subtle">
              {job.buildNumber
                ? ` #${job.buildNumber}`
                : ` ${job.id.slice(0, 8)}`}
            </span>
          </h2>
        </div>
        <div className="row-actions">
          {["running", "queued"].includes(job.status) && (
            <Button onClick={() => void action(() => api.cancel(job.id))}>
              <Square size={12} />
              Cancel
            </Button>
          )}
          {["failed", "cancelled", "interrupted"].includes(job.status) &&
            !job.submission && (
              <Button
                onClick={() =>
                  void action(async () => {
                    const retried = await api.retry(job.id);
                    if (retried[0]) onSelect(retried[0]);
                  })
                }
              >
                <RefreshCw size={13} />
                Retry
              </Button>
            )}
          {job.submission && (
            <Button
              disabled={job.status === "running"}
              onClick={() =>
                void action(
                  () => api.reconcile(job.id),
                  "Store status updated.",
                )
              }
            >
              <RefreshCw size={13} />
              Check store status
            </Button>
          )}
        </div>
      </div>
      <div className="job-metadata">
        <Badge
          value={
            job.submission?.state === "processing" ? "processing" : job.status
          }
        />
        <span className="mono">{job.bundleId ?? "Waiting for preflight"}</span>
        <span>{job.version && `v${job.version}`}</span>
        {job.toolchain && (
          <span>
            iOS SDK {job.toolchain.iosSdk} · {job.toolchain.xcodeVersion}
          </span>
        )}
      </div>
      <BuildChanges job={job} />
      {job.restoredFromBackup && (
        <p className="muted">
          Restored history. Check this Mac’s project/tool paths and use “Check
          store status” for pending uploads. Build files and logs are not
          included in the backup.
        </p>
      )}
      <div className="stage-track">
        {stages
          .filter(
            (s) =>
              !(job.platform === "android" && s === "export") &&
              !(s === "upload" && !job.autoSubmit),
          )
          .map((s) => (
            <div
              key={s}
              className={
                job.stage === s
                  ? "current"
                  : index > stages.indexOf(s) || job.status === "succeeded"
                    ? "done"
                    : ""
              }
            >
              {index > stages.indexOf(s) || job.status === "succeeded" ? (
                <Check size={12} />
              ) : job.stage === s && job.status === "running" ? (
                <LoaderCircle size={12} className="spin" />
              ) : (
                <Circle size={10} />
              )}
              <span>{s}</span>
            </div>
          ))}
      </div>
      {(job.status === "running" ||
        job.status === "queued" ||
        job.submission?.state === "processing") && (
        <WorkProgress
          progress={job.stage === "processing" ? undefined : job.progress}
          startedAt={
            job.stageStartedAt ??
            [...logs].reverse().find((entry) => entry.text === `→ ${job.stage}`)
              ?.time ??
            (job.stage === "processing"
              ? job.submission?.uploadedAt
              : (job.startedAt ?? job.createdAt))
          }
          label={
            job.stage === "processing"
              ? "Waiting for Apple processing"
              : `${job.stage.charAt(0).toUpperCase()}${job.stage.slice(1)}`
          }
          note={stageGuidance[job.stage]}
        />
      )}
      {job.error && (
        <div className="job-error">
          <CircleAlert size={16} />
          <pre>{job.error}</pre>
        </div>
      )}
      {job.submission && (
        <div className="submission-state">
          <Upload size={17} />
          <div>
            <strong>{job.submission.destination}</strong>
            <p>{job.submission.message ?? job.submission.state}</p>
          </div>
        </div>
      )}
      <div className="log-toolbar">
        <span>
          <Terminal size={14} />
          BUILD OUTPUT <span className="mono subtle">{logs.length} lines</span>
        </span>
        <label className="log-search">
          <Search size={13} />
          <input
            aria-label="Search build logs"
            placeholder="Filter output…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      <div ref={logsRef} className="logs" role="log" aria-label="Build output">
        {logs
          .filter((l) => l.text.toLowerCase().includes(search.toLowerCase()))
          .map((l, i) => (
            <div
              className={l.text.startsWith("ERROR") ? "error-line" : ""}
              key={i}
            >
              <time>
                {new Date(l.time).toLocaleTimeString(undefined, {
                  hour12: false,
                })}
              </time>
              <pre>{l.text}</pre>
            </div>
          ))}
        {!logs.length && (
          <span className="subtle">Waiting for the local runner…</span>
        )}
      </div>
      {output.length > 0 && (
        <div className="artifact-list">
          <div className="section-heading">
            <h3>Build artifacts</h3>
            <span className="subtle">SHA-256 verified</span>
          </div>
          {output.map((a) => (
            <div className="artifact-row" key={a.id}>
              <Box size={19} />
              <div>
                <strong>{a.path.split("/").at(-1)}</strong>
                <span className="mono">
                  {bytes(a.size)} · {a.sha256.slice(0, 16)}…
                </span>
              </div>
              <button
                className="icon-button"
                aria-label={`Reveal ${a.kind}`}
                onClick={() => void action(() => api.reveal(a.path))}
              >
                <FolderOpen size={16} />
              </button>
              <Button
                onClick={() =>
                  void action(async () => {
                    const paths = await api.choose({
                      kind: ["app", "archive", "dsym"].includes(a.kind)
                        ? "directory"
                        : "file",
                      extensions: ["ipa", "aab", "apk"].includes(a.kind)
                        ? [a.kind]
                        : undefined,
                    });
                    if (paths[0]) await api.relinkArtifact(a.id, paths[0]);
                  }, "Artifact location verified and updated.")
                }
              >
                Locate file
              </Button>
              {["ipa", "aab"].includes(a.kind) &&
                (!job.submission || job.submission.state === "rejected") && (
                  <Button
                    onClick={() =>
                      void action(() => api.submit(a.id), "Upload queued.")
                    }
                  >
                    <Upload size={13} />
                    Upload
                  </Button>
                )}
              {["app", "apk"].includes(a.kind) && (
                <DeviceInstaller artifact={a} />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
function CredentialList({
  title,
  description,
  icon,
  credentials,
  action,
  onImport,
  connection = false,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  credentials: CredentialSummary[];
  action: (fn: () => Promise<unknown>, success?: string) => Promise<void>;
  onImport: () => void;
  connection?: boolean;
}) {
  const [result, setResult] = useState("");
  return (
    <section className="credential-panel">
      <div className="credential-heading">
        <span className="credential-icon">{icon}</span>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <button
          className="icon-button"
          aria-label={`Add ${title}`}
          onClick={onImport}
        >
          <Plus size={18} />
        </button>
      </div>
      {credentials.length ? (
        credentials.map((c) => (
          <div className="credential-item" key={c.id}>
            <span className="key-icon">
              <KeyRound size={17} />
            </span>
            <div>
              <strong>{c.label}</strong>
              <span>{c.detail}</span>
            </div>
            {connection && (
              <button
                className="text-button"
                onClick={() =>
                  void action(async () =>
                    setResult(await api.validateConnection(c.id)),
                  )
                }
              >
                Test
                <ArrowUpRight size={13} />
              </button>
            )}
            <button
              className="icon-button"
              aria-label={`Delete ${c.label}`}
              onClick={() =>
                void action(
                  () => api.removeCredential(c.id),
                  "Credential removed.",
                )
              }
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))
      ) : (
        <Empty
          icon={<KeyRound size={23} />}
          heading={
            connection ? "Ready to connect." : "Bring your signing identity."
          }
          action={
            <Button onClick={onImport}>
              <Plus size={14} />
              {connection ? "Connect account" : "Import credentials"}
            </Button>
          }
        >
          {connection
            ? "Credentials stay encrypted on this Mac."
            : "Import the keys you already use to keep updating the same app."}
        </Empty>
      )}
      {result && (
        <p className="connection-result">
          <CheckCircle2 size={14} />
          {result}
        </p>
      )}
    </section>
  );
}
function SettingsSection({
  project,
  credentials,
  mode,
  save,
}: {
  project: Project;
  credentials: CredentialSummary[];
  mode: "signing" | "connections";
  save: (settings: ProjectSettings) => Promise<void>;
}) {
  const [settings, setSettings] = useState(project.settings);
  useEffect(
    () => setSettings(project.settings),
    [project.id, JSON.stringify(project.settings)],
  );
  const update = (key: keyof ProjectSettings, value: string) =>
    setSettings({ ...settings, [key]: value || undefined });
  return (
    <section className="section-card">
      <div className="section-heading">
        <h2>
          {project.name} · selected{" "}
          {mode === "signing" ? "signing credentials" : "store connections"}
        </h2>
        <span className="tag">PROJECT SETTINGS</span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(settings);
        }}
      >
        <div className="form-grid">
          {mode === "signing" ? (
            <>
              <SelectCredential
                label="Apple certificate & profiles"
                kind="ios"
                value={settings.iosSigningId}
                onChange={(v) => update("iosSigningId", v)}
                credentials={credentials}
              />
              <SelectCredential
                label="Android upload key"
                kind="android"
                value={settings.androidSigningId}
                onChange={(v) => update("androidSigningId", v)}
                credentials={credentials}
              />
            </>
          ) : (
            <>
              <SelectCredential
                label="Apple team connection"
                kind="apple"
                value={settings.appleConnectionId}
                onChange={(v) => update("appleConnectionId", v)}
                credentials={credentials}
              />
              <SelectCredential
                label="Google Play service account"
                kind="google"
                value={settings.googleConnectionId}
                onChange={(v) => update("googleConnectionId", v)}
                credentials={credentials}
              />
              <Field
                label="Google Play track"
                hint={
                  (settings.track ?? "internal") === "internal" &&
                  settings.playAutoRollout !== false
                    ? "Internal uploads go live to testers after Google accepts them."
                    : "Uploads create a draft. Review and rollout happen in Play Console."
                }
              >
                <input
                  value={settings.track ?? "internal"}
                  onChange={(e) => update("track", e.target.value)}
                />
              </Field>
              <PlayRolloutToggle
                track={settings.track ?? "internal"}
                value={settings.playAutoRollout}
                onChange={(playAutoRollout) =>
                  setSettings({ ...settings, playAutoRollout })
                }
              />
              <SelectCredential
                label="Build environment"
                kind="environment"
                value={settings.envCredentialId}
                onChange={(v) => update("envCredentialId", v)}
                credentials={credentials}
              />
            </>
          )}
        </div>
        <div className="form-footer">
          <Button primary type="submit">
            <Check size={15} />
            Save settings
          </Button>
        </div>
      </form>
    </section>
  );
}
const ROLLOUT_NOTICE = "play-auto-rollout-notice-seen";
function PlayRolloutToggle({
  track,
  value,
  onChange,
}: {
  track: string;
  value?: boolean;
  onChange: (value: boolean) => void;
}) {
  // One-time note for projects that picked up the new default implicitly.
  const [noticeSeen, setNoticeSeen] = useState(() => {
    try {
      return localStorage.getItem(ROLLOUT_NOTICE) === "1";
    } catch {
      return false;
    }
  });
  const dismiss = () => {
    setNoticeSeen(true);
    try {
      localStorage.setItem(ROLLOUT_NOTICE, "1");
    } catch {}
  };
  if (track !== "internal")
    return (
      <div className="field">
        <span>Automatic rollout</span>
        <label className="checkbox-line">
          <input type="checkbox" checked={false} disabled />
          Roll out internal builds to testers automatically
        </label>
        <small>
          Uploads to {track} stay drafts. Automatic rollout applies to the
          internal track only.
        </small>
      </div>
    );
  return (
    <div className="field">
      <span>Automatic rollout</span>
      <label className="checkbox-line">
        <input
          type="checkbox"
          checked={value !== false}
          onChange={(e) => {
            dismiss();
            onChange(e.target.checked);
          }}
        />
        Roll out internal builds to testers automatically
      </label>
      <small>
        On: each upload replaces the current internal release. Off: uploads stay
        drafts for Play Console.
      </small>
      {value === undefined && !noticeSeen && (
        <span className="rollout-notice">
          New: internal uploads now roll out automatically instead of waiting as
          drafts.{" "}
          <button type="button" onClick={dismiss}>
            Got it
          </button>
        </span>
      )}
    </div>
  );
}
function ToolchainSettings({
  project,
  save,
}: {
  project: Project;
  save: (settings: ProjectSettings) => Promise<void>;
}) {
  const [s, setS] = useState(project.settings);
  const [xcodes, setXcodes] = useState<
    import("../../core/xcode-toolchain").XcodeInstallation[]
  >([]);
  const [xcodeError, setXcodeError] = useState("");
  useEffect(() => {
    api
      .xcodeInstallations(project.id)
      .then(setXcodes)
      .catch((error) => setXcodeError(error.message));
  }, [project.id, project.settings.xcodePath, project.settings.buildDirectory]);
  useEffect(
    () => setS(project.settings),
    [project.id, JSON.stringify(project.settings)],
  );
  const pick = async (
    key: keyof ProjectSettings,
    kind: "file" | "directory",
  ) => {
    const paths = await api.choose({ kind });
    if (paths[0]) setS({ ...s, [key]: paths[0] });
  };
  return (
    <section className="section-card">
      <div className="section-heading">
        <h2>{project.name} · toolchain overrides</h2>
        <span className="muted">Empty fields use system defaults</span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(s);
        }}
      >
        <div className="form-grid">
          <Field label="Installed Xcode">
            <select
              value={s.xcodePath ?? ""}
              onChange={(event) =>
                setS({
                  ...s,
                  xcodePath: event.target.value || undefined,
                  iosSdk: undefined,
                })
              }
            >
              <option value="">System default</option>
              {xcodes.map((xcode) => (
                <option
                  key={xcode.developerDirectory}
                  value={xcode.developerDirectory}
                >
                  Xcode {xcode.version} — iOS {xcode.iosSdks.join(", ")} ·{" "}
                  {xcode.developerDirectory}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Minimum iOS SDK"
            hint="Optional for an existing Xcode. Set the SDK version required by your project before downloading another Xcode."
          >
            <input
              value={s.minimumIosSdk ?? ""}
              placeholder="e.g. 27.2"
              onChange={(event) =>
                setS({ ...s, minimumIosSdk: event.target.value })
              }
            />
          </Field>
          <Field label="iOS SDK selection">
            <select
              value={s.iosSdk ?? ""}
              onChange={(event) =>
                setS({ ...s, iosSdk: event.target.value || undefined })
              }
            >
              <option value="">Default SDK in selected Xcode</option>
              {xcodes
                .find(
                  (xcode) =>
                    xcode.developerDirectory === s.xcodePath ||
                    (!s.xcodePath && xcode.selected),
                )
                ?.iosSdks.map((sdk) => (
                  <option key={sdk} value={sdk}>
                    iOS {sdk}
                  </option>
                ))}
            </select>
          </Field>
          <div>
            <button
              type="button"
              className="button"
              disabled={!s.minimumIosSdk}
              onClick={() =>
                void (async () => {
                  try {
                    await save(s);
                    await api.openXcodeDownload(project.id);
                  } catch (error: any) {
                    setXcodeError(error.message);
                  }
                })()
              }
            >
              Download & set up Xcode{" "}
              {s.minimumIosSdk
                ? `/ iOS ${s.minimumIosSdk}`
                : "(choose an SDK first)"}
            </button>
            <p className="subtle">
              Downloads Apple’s signed archive in this app, verifies and expands
              it, installs platform components, and selects it for this project.
              License and system authentication pause when needed.
            </p>
            {xcodeError && <p role="alert">{xcodeError}</p>}
          </div>
          {(
            [
              { key: "nodePath", label: "Node executable", kind: "file" },
              {
                key: "buildDirectory",
                label: "Build storage folder",
                kind: "directory",
              },
              { key: "javaHome", label: "JAVA_HOME", kind: "directory" },
              {
                key: "androidSdk",
                label: "Android SDK folder",
                kind: "directory",
              },
              {
                key: "xcodePath",
                label: "Xcode developer directory",
                kind: "directory",
              },
            ] as const
          ).map((f) => (
            <Field label={f.label} key={f.key}>
              <div className="input-with-button">
                <input
                  value={s[f.key] ?? ""}
                  onChange={(e) => setS({ ...s, [f.key]: e.target.value })}
                  placeholder="System default"
                />
                <button
                  type="button"
                  aria-label={`Choose ${f.label}`}
                  onClick={() => void pick(f.key, f.kind)}
                >
                  <FolderOpen size={15} />
                </button>
              </div>
            </Field>
          ))}
          <Field
            label="Xcode workspace"
            hint="Path relative to the ios folder."
          >
            <input
              value={s.workspace ?? ""}
              onChange={(e) => setS({ ...s, workspace: e.target.value })}
              placeholder="Auto-detect"
            />
          </Field>
          <Field label="Xcode scheme">
            <input
              value={s.scheme ?? ""}
              onChange={(e) => setS({ ...s, scheme: e.target.value })}
              placeholder="Auto-detect"
            />
          </Field>
          <Field label="Native project mode">
            <select
              value={s.nativeMode ?? "auto"}
              onChange={(e) =>
                setS({
                  ...s,
                  nativeMode: e.target.value as ProjectSettings["nativeMode"],
                })
              }
            >
              <option value="auto">Auto-detect tracked native projects</option>
              <option value="generated">
                Generate native projects with Expo
              </option>
              <option value="maintained">
                Preserve existing native projects
              </option>
            </select>
          </Field>
        </div>
        <div className="form-footer">
          <Button primary type="submit">
            <Check size={15} />
            Save overrides
          </Button>
        </div>
      </form>
    </section>
  );
}
function ToolAction({
  icon,
  title,
  description,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button className="tool-action" onClick={onClick}>
      {icon}
      <strong>{title}</strong>
      <span>{description}</span>
      <ArrowUpRight size={15} />
    </button>
  );
}
function CredentialForm({
  kind,
  project,
  credentials,
  action,
  close,
}: {
  kind: string;
  project?: Project;
  credentials: CredentialSummary[];
  action: (fn: () => Promise<unknown>, success?: string) => Promise<void>;
  close: () => void;
}) {
  const [form, setForm] = useState<Record<string, any>>({
    kind,
    label:
      kind === "apple"
        ? "Apple Developer"
        : kind === "google"
          ? "Google Play"
          : project
            ? `${project.name} · ${kind === "ios" ? "Apple signing" : "upload key"}`
            : "",
    password: "",
    storePassword: "",
    keyPassword: "",
    profilePaths: [],
    connectionId:
      project?.settings.appleConnectionId ??
      credentials.find((c) => c.kind === "apple")?.id ??
      "",
    signingId:
      project?.settings.iosSigningId ??
      credentials.find((c) => c.kind === "ios")?.id ??
      "",
    bundleId: project?.bundleId ?? "",
    profileType: "IOS_APP_STORE",
    environmentPaths: [],
    newApp: false,
  });
  const [working, setWorking] = useState(false),
    [error, setError] = useState("");
  const set = (key: string, value: any) =>
    setForm((v) => ({ ...v, [key]: value }));
  const input = (
    key: string,
    label: string,
    secret = false,
    placeholder?: string,
  ) => (
    <Field label={label} key={key}>
      <input
        type={secret ? "password" : "text"}
        value={form[key] ?? ""}
        onChange={(e) => set(key, e.target.value)}
        required
        placeholder={placeholder}
        autoComplete="off"
      />
    </Field>
  );
  const file = (
    key: string,
    label: string,
    extensions?: string[],
    multiple = false,
  ) => (
    <Field label={label}>
      <button
        type="button"
        className="file-picker"
        onClick={() =>
          void api
            .choose({ kind: multiple ? "files" : "file", extensions })
            .then((p) => {
              if (p.length) {
                set(key, multiple ? p : p[0]);
                if (kind === "apple" && key === "keyPath") {
                  const match = p[0].match(/AuthKey_([A-Za-z0-9]+)\.p8$/);
                  if (match) set("keyId", match[1]);
                }
              }
            })
            .catch((e) => setError(e.message))
        }
      >
        <FolderOpen size={16} />
        <span>
          {(multiple
            ? form[key]?.map((p: string) => p.split("/").at(-1)).join(", ")
            : form[key]?.split("/").at(-1)) || "Choose file…"}
        </span>
        <Plus size={14} />
      </button>
    </Field>
  );
  const connection = (
    <SelectCredential
      label="Apple team connection"
      kind="apple"
      value={form.connectionId}
      onChange={(v) => set("connectionId", v)}
      credentials={credentials}
    />
  );
  const submit = async () => {
    setWorking(true);
    setError("");
    try {
      if (["apple", "google", "ios", "android"].includes(kind)) {
        const allowed: Record<string, string[]> = {
          apple: ["label", "keyPath", "keyId", "issuerId", "teamId"],
          google: ["label", "keyPath"],
          ios: ["label", "p12Path", "password", "profilePaths"],
          android: [
            "label",
            "keystorePath",
            "storePassword",
            "alias",
            "keyPassword",
          ],
        };
        const payload = Object.fromEntries(
          ["kind", ...allowed[kind]].map((k) => [k, form[k]]),
        );
        const saved = await api.saveCredential(payload);
        if (project) {
          const key = {
            apple: "appleConnectionId",
            google: "googleConnectionId",
            ios: "iosSigningId",
            android: "androidSigningId",
          }[kind]!;
          await api.saveSettings(project.id, {
            ...project.settings,
            [key]: saved.id,
          });
        }
      } else if (kind === "migration") {
        if (!project) throw new Error("Import a project first.");
        await api.migrate(project.id, {
          credentialsPath: form.credentialsPath,
          environmentPaths: form.environmentPaths,
          iosBuildNumber:
            form.iosBuildNumber !== undefined && form.iosBuildNumber !== ""
              ? Number(form.iosBuildNumber)
              : undefined,
          androidBuildNumber:
            form.androidBuildNumber !== undefined &&
            form.androidBuildNumber !== ""
              ? Number(form.androidBuildNumber)
              : undefined,
        });
      } else if (kind === "certificate")
        await api.createCertificate(form.connectionId, form.label);
      else if (kind === "device")
        await api.registerDevice(form.connectionId, form.label, form.udid);
      else if (kind === "profile")
        await api.createProfile(
          form.connectionId,
          form.signingId,
          form.bundleId,
          form.profileType,
        );
      else if (kind === "keystore") {
        if (!project || !form.newApp)
          throw new Error("Confirm this app has no existing upload key.");
        await api.generateKeystore(
          project.id,
          form.label,
          form.alias,
          form.password,
        );
      }
      await action(async () => {}, "Saved.");
      close();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {kind === "apple" && (
        <>
          <p className="form-explanation">
            Create a <strong>team API key</strong> with provisioning
            permissions. Your .p8 key stays encrypted on this Mac.
          </p>
          <button
            type="button"
            className="text-button"
            onClick={() =>
              void api.openExternal(
                "https://appstoreconnect.apple.com/access/integrations/api",
              )
            }
          >
            Open Apple API keys
            <ExternalLink size={13} />
          </button>
          <div className="form-grid">
            {input("label", "Connection name")}
            {input("teamId", "Apple Developer team ID")}
            {input("keyId", "Key ID")}
            {input("issuerId", "Issuer ID")}
          </div>
          {file("keyPath", "Private API key", ["p8"])}
        </>
      )}
      {kind === "google" && (
        <>
          <p className="form-explanation">
            Enable the Android Publisher API and grant this service account
            access to your app in Google Play Console.
          </p>
          <button
            type="button"
            className="text-button"
            onClick={() =>
              void api.openExternal(
                "https://console.cloud.google.com/iam-admin/serviceaccounts",
              )
            }
          >
            Open service accounts
            <ExternalLink size={13} />
          </button>
          {input("label", "Connection name")}
          {file("keyPath", "Service-account JSON key", ["json"])}
        </>
      )}
      {kind === "ios" && (
        <>
          <p className="form-explanation">
            Import a certificate with its private key, plus a profile for each
            app or extension target. Profiles are checked against your app
            entitlements at build time.
          </p>
          {input("label", "Credential name")}
          {file("p12Path", "Certificate and private key", ["p12", "pfx"])}
          <Field label="Certificate password">
            <input
              type="password"
              value={form.password}
              onChange={(e) => set("password", e.target.value)}
              autoComplete="off"
            />
          </Field>
          {file(
            "profilePaths",
            "Provisioning profiles",
            ["mobileprovision"],
            true,
          )}
        </>
      )}
      {kind === "android" && (
        <>
          <p className="form-explanation">
            Use the upload key that already signs your app. Keeping this
            identity lets you publish updates to the same Play Store listing.
          </p>
          {input("label", "Credential name")}
          {file("keystorePath", "Upload keystore", ["jks", "keystore"])}
          <div className="form-grid">
            {input("alias", "Key alias")}
            {input("storePassword", "Keystore password", true)}
            {input("keyPassword", "Key password", true)}
          </div>
        </>
      )}
      {kind === "migration" && (
        <>
          <p className="form-explanation">
            Import an EAS export and local environment files. Enter the{" "}
            <strong>last used</strong> build numbers, including EAS builds that
            haven’t been uploaded. Use 0 only for a new app.
          </p>
          <div className="migration-command">
            <Terminal size={15} />
            <code>eas credentials</code>
            <span>Download → credentials.json</span>
          </div>
          {file("credentialsPath", "EAS credentials.json (optional)", ["json"])}
          {file(
            "environmentPaths",
            "Environment files (optional)",
            undefined,
            true,
          )}
          <div className="form-grid">
            <Field label="Last used iOS build number">
              <input
                type="number"
                min="0"
                step="1"
                value={form.iosBuildNumber ?? ""}
                onChange={(e) => set("iosBuildNumber", e.target.value)}
                placeholder="e.g. 12"
              />
            </Field>
            <Field label="Last used Android version code">
              <input
                type="number"
                min="0"
                step="1"
                value={form.androidBuildNumber ?? ""}
                onChange={(e) => set("androidBuildNumber", e.target.value)}
                placeholder="e.g. 12"
              />
            </Field>
          </div>
          <small className="form-note">
            Counters only move forward. EAS Secret values cannot be recovered
            from a build export; import them from their original source.
          </small>
        </>
      )}
      {kind === "certificate" && (
        <>
          <p className="form-explanation">
            Generate a local private key and request a new Apple Distribution
            certificate. Existing certificates are preserved.
          </p>
          {connection}
          {input("label", "Certificate name")}
        </>
      )}
      {kind === "device" && (
        <>
          {connection}
          {input("label", "Device name")}
          {input("udid", "Device UDID")}
        </>
      )}
      {kind === "profile" && (
        <>
          <p className="form-explanation">
            Create a new profile using capabilities already configured in Apple
            Developer. Configure NFC or iCloud identifiers and containers in the
            portal first when needed.
          </p>
          {connection}
          <SelectCredential
            label="Signing certificate"
            kind="ios"
            value={form.signingId}
            onChange={(v) => set("signingId", v)}
            credentials={credentials}
          />
          {input("bundleId", "Bundle identifier")}
          <Field label="Profile type">
            <select
              value={form.profileType}
              onChange={(e) => set("profileType", e.target.value)}
            >
              <option value="IOS_APP_STORE">App Store distribution</option>
              <option value="IOS_APP_ADHOC">Ad hoc / internal devices</option>
              <option value="IOS_APP_DEVELOPMENT">Development</option>
            </select>
          </Field>
        </>
      )}
      {kind === "keystore" && (
        <>
          <p className="form-explanation">
            Generate a new RSA upload key for an app with no existing signing
            identity. For an app already built with EAS, import its existing
            keystore instead.
          </p>
          {input("label", "Key name")}
          {input("alias", "Key alias")}
          {input("password", "Key password", true)}
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={form.newApp}
              onChange={(e) => set("newApp", e.target.checked)}
            />
            This app has no existing upload key.
          </label>
        </>
      )}
      {error && (
        <div className="form-error" role="alert">
          <CircleAlert size={16} />
          {error}
        </div>
      )}
      <div className="modal-footer">
        <span>
          <LockKeyhole size={13} />
          Stored on this Mac
        </span>
        <Button onClick={close} disabled={working}>
          Cancel
        </Button>
        <Button primary type="submit" disabled={working}>
          {working ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Check size={15} />
          )}{" "}
          {kind === "migration"
            ? "Import & migrate"
            : ["device", "profile", "certificate", "keystore"].includes(kind)
              ? "Create"
              : "Save securely"}
        </Button>
      </div>
    </form>
  );
}

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  FlaskConical,
  Camera,
  Play,
  RefreshCw,
  Plus,
  Trash2,
  FolderOpen,
  ArrowRight,
  ShieldCheck,
  ArrowLeft,
  Settings2,
} from "lucide-react";
import {
  releaseChecksSchema,
  screenshotPlanSchema,
  type ReleaseCheckPolicy,
} from "../../core/release-check-schema";
import type { Job, Project, ReleaseReadiness } from "../../core/types";
import { useDetailNavigation } from "./useDetailNavigation";
const api = window.desk;
const issues = (error: {
  issues: { path: PropertyKey[]; message: string }[];
}) =>
  error.issues
    .map((i) =>
      i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message,
    )
    .join(" ");
const initial = () => releaseChecksSchema.parse({ enabled: false });
/** A saved policy with defaults for fields added since it was saved. */
const normalized = (saved?: ReleaseCheckPolicy): ReleaseCheckPolicy => {
  if (!saved) return initial();
  const parsed = releaseChecksSchema.safeParse(saved);
  return parsed.success
    ? parsed.data
    : { ...initial(), ...saved, androidDevices: saved.androidDevices ?? [] };
};
const captureExample = {
  appearance: "light",
  language: "en",
  locale: "en_US",
  captures: [
    {
      name: "home",
      readyIdentifier: "home-screen",
      launchArguments: ["--demo-data"],
      launchEnvironment: {},
      steps: [],
    },
  ],
};
const modeLabel = (job: Job) => {
  const mode = job.validation?.mode ?? job.checksMode ?? "all";
  const what =
    mode === "tests"
      ? "Tests"
      : mode === "screenshots"
        ? "Screenshots"
        : "Tests + screenshots";
  return job.kind === "build" ? `${what} · before upload` : what;
};
const stateClass = (state?: string) =>
  state === "passed"
    ? "succeeded"
    : state === "cancelled" || state === "interrupted"
      ? "interrupted"
      : (state ?? "queued");
function StateBadge({ job }: { job: Job }) {
  const state =
    job.validation?.state ??
    (["queued", "running"].includes(job.status) ? job.status : "interrupted");
  return (
    <span className={`badge ${stateClass(state)}`}>
      <i />
      {state.replace(/^./, (x) => x.toUpperCase())}
    </span>
  );
}
const when = (date: string) =>
  new Date(date).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const duration = (job: Job) => {
  const v = job.validation;
  if (!v?.finishedAt) return "";
  const seconds = Math.max(
    0,
    Math.round((Date.parse(v.finishedAt) - Date.parse(v.startedAt)) / 1000),
  );
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
const results = (job: Job) => {
  const v = job.validation;
  if (!v) return "Waiting to start";
  const tested = v.runs.filter((r) => !r.attachments);
  const passed = tested.reduce((n, r) => n + (r.passed ?? 0), 0),
    failed = tested.reduce((n, r) => n + (r.failed ?? 0), 0);
  return [
    tested.length ? `${passed} passed · ${failed} failed` : "",
    v.screenshots.length
      ? `${v.screenshots.length} screenshot${v.screenshots.length === 1 ? "" : "s"}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
};
const devices = (job: Job) =>
  [...new Set(job.validation?.runs.map((r) => r.device) ?? [])].join(", ");

/** The Tests tab: each project's check runs, newest first. A run opens its
 * results and screenshots; setup is its own view. */
export function ValidationWorkflow({
  project,
  jobs,
  profile,
  onRun,
  onChanged,
}: {
  project: Project;
  jobs: Job[];
  profile: string;
  onRun: (job: Job) => void;
  onChanged: () => void;
}) {
  const [policy, setPolicy] = useState<ReleaseCheckPolicy>(
    normalized(project.settings.releaseChecks),
  );
  const [targets, setTargets] =
    useState<Awaited<ReturnType<typeof api.checkTargets>>>();
  const [captureJSON, setCaptureJSON] = useState(
    JSON.stringify(policy.screenshots ?? captureExample, null, 2),
  );
  const [command, setCommand] = useState(
    JSON.stringify(policy.command ?? ["npm", "test"]),
  );
  const [screenshots, setScreenshots] = useState(
    !!policy.screenshots || !!policy.screenshotPlanFile,
  );
  const [planFile, setPlanFile] = useState(policy.screenshotPlanFile ?? "");
  const [planSource, setPlanSource] = useState<"inline" | "file">(
    policy.screenshotPlanFile ? "file" : "inline",
  );
  const [view, setView] = useState<"runs" | "setup">("runs");
  const android = project.platforms?.includes("android") ?? false,
    ios = project.platforms?.includes("ios") ?? !android;
  const [platform, setPlatform] = useState<"ios" | "android" | "all">(
    ios ? "ios" : "android",
  );
  const [showRaw, setShowRaw] = useState(false);
  const [selected, setSelected] = useState<string>();
  const navigation = useDetailNavigation(view === "setup" ? "setup" : selected);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [preview, setPreview] = useState<Record<string, string>>({});
  const runs = jobs.filter((j) => j.projectId === project.id && j.validation);
  // A queued check has no validation record until it starts.
  const pending = jobs.filter(
    (j) =>
      j.projectId === project.id &&
      j.kind === "test" &&
      !j.validation &&
      ["queued", "running"].includes(j.status),
  );
  const history = [...pending, ...runs];
  const active = jobs.find(
    (j) =>
      j.projectId === project.id && ["running", "queued"].includes(j.status),
  );
  const current = history.find((j) => j.id === selected);
  const saved = project.settings.releaseChecks;
  const configured = !!saved?.enabled;
  const savedScreenshots = !!saved?.screenshots || !!saved?.screenshotPlanFile;
  useEffect(() => {
    const saved = normalized(project.settings.releaseChecks);
    setPolicy(saved);
    setScreenshots(!!saved.screenshots || !!saved.screenshotPlanFile);
    setPlanFile(saved.screenshotPlanFile ?? "");
    setPlanSource(saved.screenshotPlanFile ? "file" : "inline");
    setCaptureJSON(
      JSON.stringify(saved.screenshots ?? captureExample, null, 2),
    );
    setCommand(JSON.stringify(saved.command ?? ["npm", "test"]));
  }, [project.id, JSON.stringify(project.settings.releaseChecks)]);
  // Load a run's captures when it opens, one at a time.
  // Framed store images show by default; the raw captures are a toggle away.
  const shotCount = current?.validation?.screenshots.length ?? 0;
  const anyFramed = !!current?.validation?.screenshots.some((s) => s.framed);
  const framedView = anyFramed && !showRaw;
  const previewKey = (i: number) =>
    `${current?.id}:${i}:${framedView && current?.validation?.screenshots[i]?.framed ? "framed" : "raw"}`;
  useEffect(() => {
    if (!current || !shotCount) return;
    let live = true;
    void (async () => {
      for (let i = 0; i < shotCount; i++) {
        const key = previewKey(i);
        if (preview[key]) continue;
        try {
          const url = await api.screenshotPreview(
            current.id,
            i,
            key.endsWith(":framed"),
          );
          if (live) setPreview((v) => ({ ...v, [key]: url }));
        } catch {}
      }
    })();
    return () => {
      live = false;
    };
  }, [current?.id, shotCount, framedView]);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    const json = (text: string, field: string) => {
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${field} is not valid JSON.`);
      }
    };
    const plan =
      screenshots && planSource === "inline"
        ? screenshotPlanSchema.safeParse(json(captureJSON, "The capture plan"))
        : undefined;
    if (plan && !plan.success)
      throw new Error(`Capture plan: ${issues(plan.error)}`);
    const parsed = releaseChecksSchema.safeParse({
      ...policy,
      command:
        policy.runner === "command"
          ? json(command, "The test command")
          : undefined,
      screenshots: plan?.data,
      screenshotPlanFile:
        screenshots && planSource === "file" ? planFile.trim() : undefined,
    });
    if (!parsed.success) throw new Error(issues(parsed.error));
    const next = parsed.data;
    await api.saveSettings(project.id, {
      ...project.settings,
      releaseChecks: next,
    });
    onChanged();
    setMessage(
      next.required
        ? "Saved. These checks also run before a store build can upload."
        : "Saved.",
    );
    return next;
  };
  const open = (id: string) => {
    navigation.enter(id);
    setSelected(id);
  };
  const back = () => {
    navigation.back();
    setSelected(undefined);
    setView("runs");
  };
  const run = (mode: "all" | "tests" | "screenshots") =>
    perform(async () => {
      await save();
      const result = await api.runChecks(project.id, profile, mode, platform);
      if (result[0]) {
        setView("runs");
        open(result[0].id);
      }
    });
  const shots = current?.validation?.screenshots ?? [];
  const byDevice = shots.reduce<Map<string, number[]>>((groups, s, i) => {
    groups.set(s.device, [...(groups.get(s.device) ?? []), i]);
    return groups;
  }, new Map());
  const status = (
    <>
      {busy && (
        <p role="status" className="muted">
          Preparing checks. Scheme discovery and first-time package resolution
          can take a minute…
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </>
  );
  const runButtons = (
    <>
      {android && ios && (
        <select
          aria-label="Platforms to check"
          value={platform}
          onChange={(e) => setPlatform(e.target.value as typeof platform)}
        >
          <option value="ios">iOS</option>
          <option value="android">Android</option>
          <option value="all">iOS + Android</option>
        </select>
      )}
      <button
        className="primary"
        disabled={busy || !policy.enabled || !!active}
        onClick={() => void run("all")}
      >
        <Play size={14} />
        Run checks
      </button>
      {screenshots && (
        <button
          className="button"
          disabled={busy || !policy.enabled || !!active}
          onClick={() => void run("screenshots")}
        >
          <Camera size={14} />
          Capture screenshots
        </button>
      )}
    </>
  );
  return (
    <section
      ref={navigation.root}
      aria-label={
        view === "setup"
          ? "Check settings"
          : current
            ? "Check run details"
            : "Check runs"
      }
    >
      <div className="page-heading">
        <div>
          <div className="eyebrow">PROOF BEFORE PUBLISH</div>
          <h1>Tests & screenshots</h1>
          <p>
            Runs your app's tests and captures store screenshots on fresh
            simulators, from one snapshot of the source.
          </p>
        </div>
        <FlaskConical size={30} className="muted" />
      </div>
      {view === "setup" ? (
        <div className="validation-setup">
          <div className="detail-navigation">
            <button className="button" onClick={back}>
              <ArrowLeft size={14} />
              Back to test runs
            </button>
          </div>
          <section className="section-card validation-policy">
            <div className="section-heading">
              <h2 data-detail-heading>Check settings</h2>
              <span className="mono subtle">{profile}</span>
            </div>
            <fieldset disabled={busy} className="workflow-fieldset">
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={policy.enabled}
                  onChange={(e) =>
                    setPolicy({ ...policy, enabled: e.target.checked })
                  }
                />
                Enable release checks
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={policy.required}
                  onChange={(e) =>
                    setPolicy({ ...policy, required: e.target.checked })
                  }
                />
                Block upload when checks fail or are missing
              </label>
              <label>
                Test runner
                <select
                  value={policy.runner}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      runner: e.target.value as "xcode" | "command",
                    })
                  }
                >
                  <option value="xcode">
                    Xcode tests · XCTest / Swift Testing
                  </option>
                  <option value="command">Project-owned test command</option>
                </select>
              </label>
              {policy.runner === "xcode" ? (
                <div className="form-grid">
                  <label>
                    Test scheme
                    <input
                      list="check-schemes"
                      placeholder="Application scheme"
                      value={policy.scheme ?? ""}
                      onChange={(e) =>
                        setPolicy({
                          ...policy,
                          scheme: e.target.value || undefined,
                        })
                      }
                    />
                    <datalist id="check-schemes">
                      {targets?.schemes.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </datalist>
                  </label>
                  <label>
                    Test plan
                    <input
                      list="check-plans"
                      placeholder="Scheme's active plan"
                      value={policy.testPlan ?? ""}
                      onChange={(e) =>
                        setPolicy({
                          ...policy,
                          testPlan: e.target.value || undefined,
                        })
                      }
                    />
                    <datalist id="check-plans">
                      {targets?.testPlans.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </datalist>
                  </label>
                </div>
              ) : (
                <label>
                  Executable and arguments · JSON array
                  <input
                    className="mono"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                  />
                  <span className="muted">
                    Runs in the installed snapshot without a shell. Use the
                    project's locked test tools.
                  </span>
                </label>
              )}
              <div className="form-grid">
                <label>
                  Configuration
                  <input
                    placeholder="Same as build profile"
                    value={policy.configuration ?? ""}
                    onChange={(e) =>
                      setPolicy({
                        ...policy,
                        configuration: e.target.value || undefined,
                      })
                    }
                  />
                </label>
                <label>
                  Timeout per command (seconds)
                  <input
                    type="number"
                    min={30}
                    max={7200}
                    value={policy.timeoutSeconds}
                    onChange={(e) =>
                      setPolicy({
                        ...policy,
                        timeoutSeconds: Number(e.target.value),
                      })
                    }
                  />
                </label>
              </div>
              <div className="section-heading">
                <h3>Simulator matrix</h3>
                <button
                  className="button"
                  onClick={() =>
                    void perform(async () =>
                      setTargets(await api.checkTargets(project.id)),
                    )
                  }
                >
                  <RefreshCw size={13} />
                  Discover targets
                </button>
              </div>
              <p className="muted">
                Devices run one at a time on disposable simulators. Your
                existing devices are left alone.
              </p>
              {policy.destinations.map((d, i) => (
                <div className="simulator-choice" key={i}>
                  <label>
                    Device {i + 1}
                    <select
                      value={d.deviceType}
                      onChange={(e) =>
                        setPolicy({
                          ...policy,
                          destinations: policy.destinations.map((v, n) =>
                            n === i ? { ...v, deviceType: e.target.value } : v,
                          ),
                        })
                      }
                    >
                      <option value={d.deviceType}>
                        {targets?.devices.find((v) => v.id === d.deviceType)
                          ?.name ?? d.deviceType}
                      </option>
                      {targets?.devices
                        .filter((v) => v.id !== d.deviceType)
                        .map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Runtime
                    <select
                      value={d.runtime ?? ""}
                      onChange={(e) =>
                        setPolicy({
                          ...policy,
                          destinations: policy.destinations.map((v, n) =>
                            n === i
                              ? { ...v, runtime: e.target.value || undefined }
                              : v,
                          ),
                        })
                      }
                    >
                      <option value="">Match selected iOS SDK</option>
                      {d.runtime &&
                        !targets?.runtimes.some((r) => r.id === d.runtime) && (
                          <option value={d.runtime}>{d.runtime}</option>
                        )}
                      {targets?.runtimes.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="icon"
                    aria-label={`Remove simulator ${i + 1}`}
                    onClick={() =>
                      setPolicy({
                        ...policy,
                        destinations: policy.destinations.filter(
                          (_, n) => n !== i,
                        ),
                      })
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              <button
                className="button"
                disabled={
                  !targets?.devices.length || policy.destinations.length >= 8
                }
                onClick={() =>
                  setPolicy({
                    ...policy,
                    destinations: [
                      ...policy.destinations,
                      {
                        deviceType:
                          targets!.devices
                            .filter((d) => /Pro Max/.test(d.name))
                            .at(-1)?.id ?? targets!.devices[0]!.id,
                      },
                    ],
                  })
                }
              >
                <Plus size={14} />
                Add simulator
              </button>
              {android && (
                <>
                  <div className="section-heading">
                    <h3>Android emulators</h3>
                  </div>
                  <p className="muted">
                    Android captures boot a disposable emulator per device,
                    stored with the job. Device profiles come from{" "}
                    <code>avdmanager list device</code>; the newest installed
                    Google APIs image is used unless you name one.
                  </p>
                  {policy.androidDevices.map((d, i) => (
                    <div className="simulator-choice" key={i}>
                      <label>
                        Emulator {i + 1}
                        <input
                          className="mono"
                          list="android-device-profiles"
                          value={d.device}
                          onChange={(e) =>
                            setPolicy({
                              ...policy,
                              androidDevices: policy.androidDevices.map(
                                (v, n) =>
                                  n === i
                                    ? { ...v, device: e.target.value.trim() }
                                    : v,
                              ),
                            })
                          }
                        />
                      </label>
                      <label>
                        System image
                        <input
                          className="mono"
                          placeholder="Newest installed"
                          value={d.systemImage ?? ""}
                          onChange={(e) =>
                            setPolicy({
                              ...policy,
                              androidDevices: policy.androidDevices.map(
                                (v, n) =>
                                  n === i
                                    ? {
                                        ...v,
                                        systemImage:
                                          e.target.value.trim() || undefined,
                                      }
                                    : v,
                              ),
                            })
                          }
                        />
                      </label>
                      <button
                        className="icon"
                        aria-label={`Remove emulator ${i + 1}`}
                        onClick={() =>
                          setPolicy({
                            ...policy,
                            androidDevices: policy.androidDevices.filter(
                              (_, n) => n !== i,
                            ),
                          })
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}
                  <datalist id="android-device-profiles">
                    {[
                      "pixel_9_pro",
                      "pixel_9",
                      "pixel_9_pro_xl",
                      "pixel_tablet",
                      "medium_tablet",
                    ].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </datalist>
                  <button
                    className="button"
                    disabled={policy.androidDevices.length >= 4}
                    onClick={() =>
                      setPolicy({
                        ...policy,
                        androidDevices: [
                          ...policy.androidDevices,
                          { device: "pixel_9_pro" },
                        ],
                      })
                    }
                  >
                    <Plus size={14} />
                    Add emulator
                  </button>
                  <label>
                    Android capture build task
                    <input
                      className="mono"
                      value={policy.androidCaptureTask}
                      onChange={(e) =>
                        setPolicy({
                          ...policy,
                          androidCaptureTask: e.target.value.trim(),
                        })
                      }
                    />
                    <span className="muted">
                      An assemble task for an installable APK.{" "}
                      <code>:app:assembleDebug</code> makes a debuggable build,
                      which <code>sharedPreferences</code> needs.
                    </span>
                  </label>
                </>
              )}
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={screenshots}
                  onChange={(e) => setScreenshots(e.target.checked)}
                />
                Capture store screenshots after tests
              </label>
              {screenshots && (
                <>
                  <div
                    className="segmented"
                    role="radiogroup"
                    aria-label="Capture plan source"
                  >
                    {(
                      [
                        ["file", "Plan file in the project"],
                        ["inline", "Edit here"],
                      ] as const
                    ).map(([value, label]) => (
                      <label key={value} className="check-label">
                        <input
                          type="radio"
                          name="capture-plan-source"
                          checked={planSource === value}
                          onChange={() => setPlanSource(value)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                  {planSource === "file" ? (
                    <label>
                      Plan file
                      <input
                        className="mono"
                        placeholder="assets/store/screenshots.json"
                        value={planFile}
                        onChange={(e) => setPlanFile(e.target.value)}
                      />
                      <span className="muted">
                        A JSON capture plan, relative to the project. Each run
                        reads it from the same source snapshot it builds, so the
                        plan is versioned with your app.
                      </span>
                    </label>
                  ) : (
                    <label>
                      Capture plan
                      <textarea
                        className="mono capture-editor"
                        value={captureJSON}
                        onChange={(e) => setCaptureJSON(e.target.value)}
                        spellCheck={false}
                      />
                    </label>
                  )}
                  <p className="muted capture-help">
                    Each capture launches the app with its own arguments and
                    environment, runs its steps, then takes the screenshot.
                    Steps: <code>tap</code>, <code>type</code>,{" "}
                    <code>wait</code>, <code>assertText</code> and swipes find
                    an element by <code>identifier</code> or visible{" "}
                    <code>label</code> (<code>*</code> at either end matches
                    part of it); <code>tap</code> also takes an <code>x</code>/
                    <code>y</code> point (0–1); <code>sleep</code> pauses for{" "}
                    <code>seconds</code>. A capture can set{" "}
                    <code>delaySeconds</code> to let animations settle and{" "}
                    <code>devices</code> to limit it to some simulators or
                    emulators. <code>drag</code> moves from <code>fromX</code>/
                    <code>fromY</code> to <code>toX</code>/<code>toY</code> for
                    sliders and dials. Seed app state with{" "}
                    <code>userDefaults</code> (iOS) or{" "}
                    <code>sharedPreferences</code> (Android). Add a plan-level{" "}
                    <code>frame</code> and per-capture <code>headline</code> to
                    make store images with a caption, background and rounded
                    border; raw captures are kept. Use demonstration data only.
                  </p>
                </>
              )}
              <div className="row-actions">
                <button
                  className="button"
                  onClick={() =>
                    void perform(async () => {
                      await save();
                    })
                  }
                >
                  Save policy
                </button>
                {runButtons}
              </div>
            </fieldset>
            {status}
          </section>
        </div>
      ) : current ? (
        <div className="validation-run">
          <div className="detail-navigation">
            <button className="button" onClick={back}>
              <ArrowLeft size={14} />
              Back to test runs
            </button>
          </div>
          <section className="section-card">
            <div className="section-heading">
              <h2 data-detail-heading>{modeLabel(current)}</h2>
              <StateBadge job={current} />
            </div>
            <p className="muted">
              {when(current.validation?.startedAt ?? current.createdAt)}
              {duration(current) && ` · ${duration(current)}`}
              {current.validation &&
                ` · ${current.validation.configuration} · source ${current.validation.sourceHash.slice(0, 12)}`}
              {` · ${current.platform === "ios" ? "iOS" : "Android"} ${current.profile}`}
            </p>
            {current.validation?.error && (
              <p role="alert" className="inline-error">
                {current.validation.error}
              </p>
            )}
            {!current.validation && (
              <p className="muted" role="status">
                Waiting for the queue. Results appear here as each simulator
                finishes.
              </p>
            )}
            <div className="check-run-list">
              {current.validation?.runs.map((r, i) => (
                <div key={i}>
                  <div>
                    <strong>{r.device}</strong>
                    <span className="muted">
                      {r.runtime ? `iOS ${r.runtime} · ` : ""}
                      {r.attachments
                        ? `screenshots · ${r.status}`
                        : `${r.passed ?? 0} passed · ${r.failed ?? 0} failed · ${r.status}`}
                    </span>
                  </div>
                  {r.resultBundle && (
                    <button
                      className="button"
                      onClick={() =>
                        void perform(async () => {
                          await api.reveal(r.resultBundle!);
                        })
                      }
                    >
                      <FolderOpen size={14} />
                      Results
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="row-actions">
              <button className="button" onClick={() => onRun(current)}>
                Open build log <ArrowRight size={13} />
              </button>
              {current.kind === "build" && shots.length > 0 && (
                <button
                  className="primary"
                  disabled={busy || current.validation?.state !== "passed"}
                  onClick={() =>
                    void perform(async () => {
                      const path = await api.useScreenshots(current.id);
                      setMessage(`Prepared local listing: ${path}`);
                      onChanged();
                    })
                  }
                >
                  Use screenshots in listing
                </button>
              )}
            </div>
            {status}
          </section>
          {anyFramed && (
            <label className="check-label">
              <input
                type="checkbox"
                checked={showRaw}
                onChange={(e) => setShowRaw(e.target.checked)}
              />
              Show raw captures instead of framed store images
            </label>
          )}
          {[...byDevice].map(([device, indexes]) => (
            <section className="section-card" key={device}>
              <div className="section-heading">
                <h3>{device}</h3>
                <span className="mono subtle">
                  {indexes.length} screenshot{indexes.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="capture-gallery">
                {indexes.map((i) => {
                  const s = shots[i]!,
                    key = previewKey(i);
                  return (
                    <figure key={key}>
                      <div className="capture-preview">
                        {preview[key] ? (
                          <img
                            alt={`${s.name} on ${s.device}`}
                            src={preview[key]}
                          />
                        ) : (
                          <Camera size={28} />
                        )}
                      </div>
                      <figcaption>
                        {s.name}
                        <span>
                          {s.width} × {s.height}
                          {s.displayType ? ` · ${s.displayType}` : ""}
                          {key.endsWith(":framed") ? " · framed" : ""}
                        </span>
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <>
          <div className="row-actions validation-actions">
            {configured && runButtons}
            <button
              className="button"
              onClick={() => {
                navigation.enter("setup", false);
                setView("setup");
              }}
            >
              <Settings2 size={14} />
              {configured ? "Check settings" : "Set up checks"}
            </button>
          </div>
          {status}
          {!configured ? (
            <section className="section-card validation-empty">
              <h2>No checks set up for {project.name}</h2>
              <p>
                Checks run on disposable simulators from a clean snapshot of
                your source, so results don't depend on your working copy.
              </p>
              <ul>
                <li>
                  <strong>Tests</strong> — your Xcode test plan, or a test
                  command you choose, on each simulator in the matrix.
                </li>
                <li>
                  <strong>Screenshots</strong> — a capture plan launches the
                  app, taps through it, and saves App Store–sized images per
                  device.
                </li>
                <li>
                  <strong>Upload gate</strong> — optionally, a store build can't
                  upload until its checks pass.
                </li>
              </ul>
            </section>
          ) : !history.length ? (
            <section className="section-card validation-empty">
              <h2>No runs yet</h2>
              <p>
                Run checks to test {project.name} on{" "}
                {saved!.destinations.length} simulator
                {saved!.destinations.length === 1 ? "" : "s"}
                {savedScreenshots ? " and capture its screenshots" : ""}.
                Production builds also run these checks before upload
                {saved!.required ? " and stop if they fail" : ""}.
              </p>
            </section>
          ) : (
            <section className="section-card">
              <table className="job-table check-run-table">
                <thead>
                  <tr>
                    <th>RUN</th>
                    <th>STATUS</th>
                    <th>RESULTS</th>
                    <th>DEVICES</th>
                    <th>STARTED</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((j) => (
                    <tr
                      key={j.id}
                      data-detail-id={j.id}
                      tabIndex={0}
                      aria-label={`${modeLabel(j)} ${j.validation?.state ?? j.status} run`}
                      onClick={() => open(j.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          open(j.id);
                        }
                      }}
                    >
                      <td>
                        <strong>{modeLabel(j)}</strong>
                        <span className="subtle">
                          {" "}
                          · {j.platform === "ios" ? "iOS" : "Android"}
                        </span>
                        <span className="mono subtle"> {j.id.slice(0, 7)}</span>
                      </td>
                      <td>
                        <StateBadge job={j} />
                      </td>
                      <td>{results(j)}</td>
                      <td className="subtle">{devices(j)}</td>
                      <td className="subtle">
                        {when(j.validation?.startedAt ?? j.createdAt)}
                        {duration(j) && ` · ${duration(j)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </section>
  );
}

export function ReadinessWorkflow({
  project,
  onBuild,
}: {
  project: Project;
  onBuild: () => void;
}) {
  const [report, setReport] = useState<ReleaseReadiness>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [destination, setDestination] = useState<"testflight" | "appstore">(
    "testflight",
  );
  const check = async () => {
    setBusy(true);
    setError("");
    try {
      setReport(await api.readiness(project.id, destination));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    setReport(undefined);
  }, [project.id, destination]);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ONE RELEASE, EVERY PREREQUISITE</div>
          <h1>Release readiness</h1>
          <p>
            See what is proven, what needs attention, and where delivery stands.
          </p>
        </div>
        <ShieldCheck size={30} className="muted" />
      </div>
      <section className="section-card">
        <div className="row-actions">
          <label className="field readiness-destination">
            <span>Destination</span>
            <select
              value={destination}
              onChange={(e) =>
                setDestination(e.target.value as typeof destination)
              }
            >
              <option value="testflight">Internal TestFlight</option>
              <option value="appstore">App Store review</option>
            </select>
          </label>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void check()}
          >
            <RefreshCw size={14} />
            {busy ? "Checking…" : "Check readiness"}
          </button>
          <button className="button" onClick={onBuild}>
            Open build workflow <ArrowRight size={14} />
          </button>
        </div>
        {busy && (
          <p role="status" className="muted">
            Inspecting tools, signing and store state. This read-only check can
            take a minute.
          </p>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </section>
      {report && (
        <>
          <div className="delivery-strip">
            {(
              [
                ["built", "Built"],
                ["uploaded", "Uploaded"],
                ["processed", "Apple processed"],
                ["assigned", "TestFlight assigned"],
              ] as const
            ).map(([key, label]) => (
              <div
                key={key}
                className={report.delivery[key] ? "ready" : "pending"}
              >
                {report.delivery[key] ? (
                  <CheckCircle2 size={17} />
                ) : (
                  <span className="delivery-dot" />
                )}
                <span>{label}</span>
              </div>
            ))}
          </div>
          <section className="section-card">
            <div className="section-heading">
              <h2>
                {report.delivery.review
                  ? report.delivery.review.replaceAll("_", " ")
                  : report.delivery.assigned
                    ? "Available in internal TestFlight"
                    : report.delivery.processed
                      ? "Apple processing complete"
                      : report.delivery.uploaded
                        ? "Uploaded · awaiting Apple processing"
                        : report.canUpload
                          ? "Upload prerequisites satisfied"
                          : "Work remains before release"}
              </h2>
              <span className="mono subtle">
                {new Date(report.checkedAt).toLocaleTimeString()}
              </span>
            </div>
            <div className="readiness-list">
              {report.items.map((item) => (
                <article key={item.id} className={item.status}>
                  <div className="readiness-mark">
                    {item.status === "ready" ? (
                      <CheckCircle2 size={18} />
                    ) : (
                      <CircleAlert size={18} />
                    )}
                  </div>
                  <div>
                    <h3>
                      {item.title}
                      <span className="mono">{item.status}</span>
                    </h3>
                    <p>{item.detail}</p>
                    {item.action && <p className="muted">{item.action}</p>}
                  </div>
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </>
  );
}

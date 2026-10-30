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
} from "lucide-react";
import {
  releaseChecksSchema,
  screenshotPlanSchema,
  type ReleaseCheckPolicy,
} from "../../core/release-check-schema";
import type { Job, Project, ReleaseReadiness } from "../../core/types";
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
    project.settings.releaseChecks ?? initial(),
  );
  const [targets, setTargets] =
    useState<Awaited<ReturnType<typeof api.checkTargets>>>();
  const [captureJSON, setCaptureJSON] = useState(
    JSON.stringify(policy.screenshots ?? captureExample, null, 2),
  );
  const [command, setCommand] = useState(
    JSON.stringify(policy.command ?? ["npm", "test"]),
  );
  const [screenshots, setScreenshots] = useState(!!policy.screenshots);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [preview, setPreview] = useState<Record<string, string>>({});
  const local = jobs.filter((j) => j.projectId === project.id);
  const latest = local.find((j) => j.validation);
  const active = local.find((j) => ["running", "queued"].includes(j.status));
  useEffect(() => {
    const saved = project.settings.releaseChecks ?? initial();
    setPolicy(saved);
    setScreenshots(!!saved.screenshots);
    setCaptureJSON(
      JSON.stringify(saved.screenshots ?? captureExample, null, 2),
    );
    setCommand(JSON.stringify(saved.command ?? ["npm", "test"]));
  }, [project.id, JSON.stringify(project.settings.releaseChecks)]);
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
    const plan = screenshots
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
    });
    if (!parsed.success) throw new Error(issues(parsed.error));
    const next = parsed.data;
    await api.saveSettings(project.id, {
      ...project.settings,
      releaseChecks: next,
    });
    onChanged();
    setMessage(
      "Saved. Required checks will run before a store artifact can upload.",
    );
    return next;
  };
  const run = (mode: "all" | "tests" | "screenshots") =>
    perform(async () => {
      await save();
      const result = await api.runChecks(project.id, profile, mode);
      if (result[0]) onRun(result[0]);
    });
  const shots = latest?.validation?.screenshots ?? [];
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">PROOF BEFORE PUBLISH</div>
          <h1>Tests & screenshots</h1>
          <p>
            One source snapshot. Repeatable checks. Evidence you can inspect.
          </p>
        </div>
        <FlaskConical size={30} className="muted" />
      </div>
      <div className="validation-layout">
        <section className="section-card validation-policy">
          <div className="section-heading">
            <h2>Release check policy</h2>
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
              Devices run one at a time on disposable simulators. Your existing
              devices are left alone.
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
            <label className="check-label">
              <input
                type="checkbox"
                checked={screenshots}
                onChange={(e) => setScreenshots(e.target.checked)}
              />
              Capture store screenshots after tests
            </label>
            {screenshots && (
              <label>
                Capture plan
                <textarea
                  className="mono capture-editor"
                  value={captureJSON}
                  onChange={(e) => setCaptureJSON(e.target.value)}
                  spellCheck={false}
                />
                <span className="muted">
                  Each screen launches the app with its own demo
                  arguments/environment. Steps support tap, type, wait,
                  assertText and swipes, using accessibility identifiers or
                  labels. Use demonstration data only. The captured app must
                  remain in the foreground.
                </span>
              </label>
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
              <button
                className="primary"
                disabled={!policy.enabled || !!active}
                onClick={() => void run("all")}
              >
                <Play size={14} />
                Run checks
              </button>
              {screenshots && (
                <button
                  className="button"
                  disabled={!policy.enabled || !!active}
                  onClick={() => void run("screenshots")}
                >
                  <Camera size={14} />
                  Capture only
                </button>
              )}
            </div>
          </fieldset>
          {busy && (
            <p role="status" className="muted">
              Preparing checks. Scheme discovery and first-time package
              resolution can take a minute…
            </p>
          )}
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {message && <p role="status">{message}</p>}
        </section>
        <section className="section-card validation-evidence">
          <div className="section-heading">
            <h2>Latest evidence</h2>
            <ShieldCheck size={18} />
          </div>
          {!latest ? (
            <p className="muted">
              Run the first check to collect results. Production builds run the
              same enabled policy before upload.
            </p>
          ) : (
            <>
              <div className={`evidence-state ${latest.validation?.state}`}>
                <strong>{latest.validation?.state}</strong>
                <span className="mono">
                  {latest.id.slice(0, 8)} · {latest.validation?.mode}
                </span>
              </div>
              <p className="muted">
                {latest.validation?.configuration} · source{" "}
                {latest.validation?.sourceHash.slice(0, 12)}
              </p>
              {latest.validation?.error && (
                <p role="alert" className="inline-error">
                  {latest.validation.error}
                </p>
              )}
              <div className="check-run-list">
                {latest.validation?.runs.map((r, i) => (
                  <div key={i}>
                    <div>
                      <strong>{r.device}</strong>
                      <span className="muted">
                        {r.runtime ? `iOS ${r.runtime} · ` : ""}
                        {r.passed ?? 0} passed · {r.failed ?? 0} failed ·{" "}
                        {r.status}
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
              <button className="button" onClick={() => onRun(latest)}>
                Open live logs <ArrowRight size={13} />
              </button>
              <div className="capture-gallery">
                {shots.map((s, i) => {
                  const key = latest.id + ":" + i;
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
                          {s.device} · {s.width} × {s.height}
                        </span>
                      </figcaption>
                      <button
                        className="button"
                        onClick={() =>
                          void perform(async () => {
                            const url = await api.screenshotPreview(
                              latest.id,
                              i,
                            );
                            setPreview((v) => ({ ...v, [key]: url }));
                          })
                        }
                      >
                        Preview capture
                      </button>
                    </figure>
                  );
                })}
              </div>
              {latest.kind === "build" && shots.length > 0 && (
                <button
                  className="primary"
                  disabled={busy || latest.validation?.state !== "passed"}
                  onClick={() =>
                    void perform(async () => {
                      const path = await api.useScreenshots(latest.id);
                      setMessage(`Prepared local listing: ${path}`);
                      onChanged();
                    })
                  }
                >
                  Use screenshots in listing
                </button>
              )}
            </>
          )}
        </section>
      </div>
    </>
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

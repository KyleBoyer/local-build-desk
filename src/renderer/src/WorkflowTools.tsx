import { useEffect, useState } from "react";
import type { BuildComparison, Job } from "../../core/types";
const api = window.desk;
export function BuildChanges({ job }: { job: Job }) {
  const [comparison, setComparison] = useState<BuildComparison>();
  const [error, setError] = useState("");
  const [all, setAll] = useState(false);
  useEffect(() => {
    let active = true;
    api
      .compareBuild(job.id)
      .then((value) => active && setComparison(value))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [job.id, job.status, job.artifactId]);
  return (
    <details className="workflow-details">
      <summary>
        What changed?{" "}
        <span className="muted">
          {comparison?.baselineLabel
            ? `Compared with ${comparison.baselineLabel}`
            : "Previous successful build"}
        </span>
      </summary>
      {error && <p role="alert">{error}</p>}
      {comparison?.note && <p className="muted">{comparison.note}</p>}
      {!!comparison?.fields.length && (
        <>
          <label className="check-label">
            <input
              type="checkbox"
              checked={all}
              onChange={(e) => setAll(e.target.checked)}
            />
            Show unchanged values
          </label>
          <div className="comparison-scroll">
            <table className="comparison-table">
              <thead>
                <tr>
                  <th>Detail</th>
                  <th>Previous</th>
                  <th>This build</th>
                </tr>
              </thead>
              <tbody>
                {comparison.fields
                  .filter((f) => all || f.changed)
                  .map((f) => (
                    <tr key={f.field} className={f.changed ? "changed" : ""}>
                      <th>{f.field}</th>
                      <td>
                        <pre>{f.before}</pre>
                      </td>
                      <td>
                        <pre>{f.after}</pre>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </details>
  );
}
export function DeskPreferences() {
  const [settings, setSettings] = useState<{
    enabled: boolean;
    supported: boolean;
    error?: string;
  }>();
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  useEffect(() => {
    api
      .notificationSettings()
      .then(setSettings)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR MAC, YOUR WORKFLOW</div>
          <h1>Desk preferences</h1>
          <p>Local conveniences for builds and releases.</p>
        </div>
      </div>
      <section className="section-card">
        <div className="section-heading">
          <h2>Completion notifications</h2>
          <span className="mono subtle">macOS Notification Center</span>
        </div>
        <p className="muted">
          Build completion, upload results, Apple processing, and failures.
          Click a notification to open its build. Applies while the desktop app
          is running, including CLI jobs forwarded to it.
        </p>
        <label className="check-label">
          <input
            type="checkbox"
            checked={settings?.enabled ?? true}
            disabled={!settings}
            onChange={(e) => {
              const previous = settings;
              setSettings(
                previous && { ...previous, enabled: e.target.checked },
              );
              void api
                .notificationSettings(e.target.checked)
                .then(setSettings)
                .catch((e) => {
                  setSettings(previous);
                  setError(e.message);
                });
            }}
          />
          Notify me when a build or upload needs attention
        </label>
        <button
          className="button"
          disabled={!settings?.supported || !settings.enabled}
          onClick={() => {
            void api
              .testNotification()
              .then(() =>
                setResult(
                  "Test sent. Allow Local Build Desk in System Settings → Notifications if it does not appear.",
                ),
              )
              .catch((e) => setError(e.message));
          }}
        >
          Send test notification
        </button>
        {(!settings?.supported || settings?.error) && (
          <p className="muted">
            {settings?.error ??
              "Native notifications are available in the signed desktop app. Test windows do not send notifications."}
          </p>
        )}
        {result && <p role="status">{result}</p>}
        {error && <p role="alert">{error}</p>}
      </section>
      <BackupTools />
    </>
  );
}

export function ReleaseAssistant({
  project,
  jobs,
}: {
  project: import("../../core/types").Project;
  jobs: Job[];
}) {
  const choices = jobs.filter(
    (j) =>
      j.projectId === project.id &&
      j.kind === "build" &&
      j.storeEligible &&
      j.artifactId &&
      ["succeeded", "needs-attention"].includes(j.status),
  );
  const [jobId, setJobId] = useState(choices[0]?.id ?? "");
  const [destination, setDestination] = useState<
    "testflight" | "appstore" | "play"
  >("testflight");
  const [locale, setLocale] = useState("en-US");
  const [notes, setNotes] = useState({
    testflight: "",
    appstore: "",
    play: project.settings.playReleaseNotes ?? "",
  });
  const [listing, setListing] = useState(false),
    [createVersion, setCreateVersion] = useState(false);
  const [fields, setFields] = useState({
    description: "",
    keywords: "",
    promotionalText: "",
    supportUrl: "",
    marketingUrl: "",
  });
  const [preview, setPreview] =
    useState<import("../../core/types").ReleasePreview>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  useEffect(
    () => setPreview(undefined),
    [jobId, destination, locale, notes, fields, listing, createVersion],
  );
  useEffect(() => setListing(false), [jobId, destination, locale]);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  const available = choices.filter(
    (j) => j.platform === (destination === "play" ? "android" : "ios"),
  );
  useEffect(() => {
    if (!available.some((j) => j.id === jobId))
      setJobId(available[0]?.id ?? "");
  }, [destination, project.id, jobs.length]);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">PREPARE · REVIEW · APPLY</div>
          <h1>Release assistant</h1>
          <p>
            Write release notes once, with an explicit destination and preview.
          </p>
        </div>
      </div>
      <section className="section-card">
        <fieldset disabled={busy} className="workflow-fieldset">
          <div className="form-grid">
            <label>
              Destination
              <select
                aria-label="Destination"
                value={destination}
                onChange={(e) =>
                  setDestination(e.target.value as typeof destination)
                }
              >
                <option value="testflight">TestFlight · What to Test</option>
                <option value="appstore">App Store draft · What's New</option>
                <option value="play">
                  Google Play · notes for next upload
                </option>
              </select>
            </label>
            <label>
              Build
              <select
                aria-label="Build"
                value={jobId}
                onChange={(e) => setJobId(e.target.value)}
              >
                <option value="">Choose a successful store build</option>
                {available.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.platform} #{j.buildNumber} · {j.version} · {j.profile}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Language
              <input
                value={locale}
                onChange={(e) => setLocale(e.target.value)}
                placeholder="en-US"
              />
            </label>
          </div>
          <label className="workflow-notes">
            {destination === "testflight" ? "What to Test" : "What's New"}
            <textarea
              rows={7}
              maxLength={destination === "play" ? 500 : 4000}
              value={notes[destination]}
              onChange={(e) =>
                setNotes({ ...notes, [destination]: e.target.value })
              }
              placeholder="Describe changes that testers or users should know about."
            />
          </label>
          <div className="row-actions">
            <button
              className="button"
              disabled={!jobId}
              onClick={() =>
                void perform(async () => {
                  const draft = await api.releaseNoteDraft(jobId);
                  setNotes({
                    ...notes,
                    [destination]: draft.text.slice(
                      0,
                      destination === "play" ? 500 : 4000,
                    ),
                  });
                  setMessage(
                    draft.note + " Uncommitted changes are not included.",
                  );
                })
              }
            >
              Draft from git commits
            </button>
            <span className="muted">
              {notes[destination].length} /{" "}
              {destination === "play" ? 500 : 4000} characters
            </span>
          </div>
          {destination === "appstore" && (
            <>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={createVersion}
                  onChange={(e) => setCreateVersion(e.target.checked)}
                />
                Create a draft version if this version does not exist
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={listing}
                  onChange={(e) => {
                    if (!e.target.checked) {
                      setListing(false);
                      return;
                    }
                    void perform(async () => {
                      const current = await api.readRelease(jobId, {
                        destination: "appstore",
                        locale,
                        createVersion,
                        fields: {},
                      });
                      setFields({
                        description: current.description ?? "",
                        keywords: current.keywords ?? "",
                        promotionalText: current.promotionalText ?? "",
                        supportUrl: current.supportUrl ?? "",
                        marketingUrl: current.marketingUrl ?? "",
                      });
                      setListing(true);
                    });
                  }}
                />
                Also edit listing details for this language
              </label>
              {listing && (
                <div className="form-grid">
                  {Object.entries(fields).map(([key, value]) => (
                    <label key={key}>
                      {
                        (
                          {
                            description: "Description",
                            keywords: "Keywords",
                            promotionalText: "Promotional text",
                            supportUrl: "Support URL",
                            marketingUrl: "Marketing URL",
                          } as any
                        )[key]
                      }
                      <textarea
                        rows={key === "description" ? 5 : 2}
                        value={value}
                        onChange={(e) =>
                          setFields({ ...fields, [key]: e.target.value })
                        }
                      />
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
          <div className="row-actions">
            <button
              className="primary"
              disabled={destination !== "play" && !jobId}
              onClick={() =>
                void perform(async () => {
                  if (destination === "play") {
                    await api.savePlayNotes(project.id, notes.play, locale);
                    setMessage(
                      "Play notes saved locally for future uploads. Existing store releases were not changed.",
                    );
                    return;
                  }
                  setPreview(
                    await api.prepareRelease(jobId, {
                      destination,
                      locale,
                      createVersion,
                      fields: {
                        whatsNew: notes[destination],
                        ...(listing && destination === "appstore"
                          ? fields
                          : {}),
                      },
                    }),
                  );
                })
              }
            >
              {destination === "play"
                ? "Save for next Play upload"
                : "Preview Apple changes"}
            </button>
          </div>
        </fieldset>
        {busy && (
          <p role="status">
            Working with release metadata. This can take a few moments…
          </p>
        )}
        {error && (
          <p role="alert" className="workflow-error">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        {preview && (
          <div className="release-preview">
            <h3>
              Review{" "}
              {preview.destination === "testflight"
                ? "TestFlight"
                : "App Store draft"}{" "}
              changes
            </h3>
            <p className="mono">
              {preview.identity} · v{preview.version} · {preview.locale}
              {preview.destination === "testflight"
                ? ` · build ${preview.buildNumber}`
                : ""}
            </p>
            {preview.createsVersion && (
              <p>
                A new editable version will be created with manual release
                selected.
              </p>
            )}
            <div className="comparison-scroll">
              <table className="comparison-table">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Current Apple value</th>
                    <th>Proposed value</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.changes.map((change) => (
                    <tr key={change.field}>
                      <th>{change.field}</th>
                      <td>
                        <pre>{change.before || "(empty)"}</pre>
                      </td>
                      <td>
                        <pre>{change.after || "(clear value)"}</pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted">
              This saves metadata. It does not submit for App Review, release to
              production, or invite testers.
            </p>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const token = preview.token;
                  setPreview(undefined);
                  setMessage(await api.applyRelease(token));
                })
              }
            >
              Apply these exact changes to Apple
            </button>
          </div>
        )}
      </section>
    </>
  );
}

function BackupTools() {
  const [mode, setMode] = useState<"export" | "restore">("export");
  const [password, setPassword] = useState(""),
    [confirmation, setConfirmation] = useState("");
  const [preview, setPreview] =
    useState<import("../../core/types").BackupPreview>();
  const [mappings, setMappings] = useState<Record<string, string>>({}),
    [reset, setReset] = useState(true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPassword("");
      setConfirmation("");
      setBusy(false);
    }
  };
  return (
    <section className="section-card">
      <div className="section-heading">
        <h2>Encrypted backup & restore</h2>
        <span className="mono subtle">Portable · password protected</span>
      </div>
      <p className="muted">
        Includes projects, signing keys, connections, environment values,
        counters, and build history metadata. Source code, build files, logs,
        and browser logins stay outside the backup. Restoring preserves existing
        credentials and counter floors; settings for matching project folders
        are updated from the backup.
      </p>
      <fieldset disabled={busy} className="workflow-fieldset">
        <div className="form-grid">
          <label>
            Action
            <select
              aria-label="Action"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as typeof mode);
                setPreview(undefined);
                setPassword("");
                setConfirmation("");
              }}
            >
              <option value="export">Create encrypted backup</option>
              <option value="restore">Restore encrypted backup</option>
            </select>
          </label>
          <label>
            Backup passphrase
            <input
              type="password"
              autoComplete={mode === "export" ? "new-password" : "off"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={
                mode === "export"
                  ? "At least 12 characters"
                  : "Backup passphrase"
              }
            />
          </label>
          {mode === "export" && (
            <label>
              Confirm passphrase
              <input
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
              />
            </label>
          )}
        </div>
        <button
          className="button"
          disabled={!password}
          onClick={() =>
            void perform(async () => {
              if (mode === "export") {
                if (password !== confirmation)
                  throw Error("The passphrases do not match.");
                const path = await api.exportBackup(password);
                if (path)
                  setMessage(
                    "Encrypted backup saved. Keep its passphrase separately; the app does not store it.",
                  );
              } else {
                const value = await api.previewBackup(password);
                setPreview(value);
                setMappings(
                  Object.fromEntries(
                    value?.projects.map((p) => [p.id, p.path]) ?? [],
                  ),
                );
              }
            })
          }
        >
          {mode === "export"
            ? "Choose backup destination"
            : "Choose and preview backup"}
        </button>
      </fieldset>
      {preview && (
        <div className="release-preview">
          <h3>Review restore</h3>
          <p>
            {preview.projects.length} projects · {preview.credentials}{" "}
            credentials · {preview.jobs} historical jobs · {preview.counters}{" "}
            version counters
          </p>
          <p className="muted">
            Backup created {new Date(preview.createdAt).toLocaleString()}.
            Select each project's source folder on this Mac. Missing build
            artifacts must be restored separately before installation or upload.
          </p>
          {preview.projects.map((project) => (
            <div key={project.id} className="restore-path">
              <strong>{project.name}</strong>
              <span className="mono">{mappings[project.id]}</span>
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const paths = await api.choose({ kind: "directory" });
                    if (paths[0])
                      setMappings({ ...mappings, [project.id]: paths[0] });
                  })
                }
              >
                Choose source folder
              </button>
            </div>
          ))}
          <label className="check-label">
            <input
              type="checkbox"
              checked={reset}
              onChange={(e) => setReset(e.target.checked)}
            />
            Reset machine-specific tool and storage paths (recommended for a new
            Mac)
          </label>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const token = preview.token;
                setPreview(undefined);
                const result = await api.restoreBackup(token, mappings, reset);
                setMessage(
                  `Restored ${result.projects} projects and ${result.credentials} credentials. Run Toolchain checks before building.`,
                );
              })
            }
          >
            Restore this backup
          </button>
        </div>
      )}
      {busy && (
        <p role="status">
          Encrypting or checking backup data. This may take a few moments…
        </p>
      )}
      {error && (
        <p role="alert" className="workflow-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

export function ReusePicker({
  candidates,
  projectId,
  profile,
  platform,
  autoSubmit,
  onUse,
  onFresh,
}: {
  candidates: import("../../core/types").ReusableBuild[];
  projectId: string;
  profile: string;
  platform: import("../../core/types").Platform;
  autoSubmit: boolean;
  onUse: (job: Job) => void;
  onFresh: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <p className="muted">
        Reuse keeps the existing version and build number. No new counter is
        reserved. Checksums and compatibility are checked again when you choose
        a build.
      </p>
      {candidates.map((candidate) => (
        <div className="reuse-choice" key={candidate.artifact.id}>
          <h3>
            {candidate.job.platform} #{candidate.artifact.buildNumber} · v
            {candidate.artifact.version}
          </h3>
          <p>
            {candidate.match === "exact"
              ? "Matches recorded source, configuration, credentials, and tools."
              : "Native-compatible development client. Run your project’s Metro server to load current JavaScript; this does not update a production app."}
          </p>
          {candidate.alreadySubmitted && (
            <p className="muted">
              This artifact already has a store submission. Open its existing
              build to check status.
            </p>
          )}
          <button
            className="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError("");
              void api
                .useReusableBuild(
                  projectId,
                  profile,
                  platform,
                  candidate.artifact.id,
                  autoSubmit &&
                    !candidate.alreadySubmitted &&
                    candidate.match === "exact",
                )
                .then(onUse)
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            {autoSubmit &&
            !candidate.alreadySubmitted &&
            candidate.match === "exact"
              ? "Reuse and upload"
              : "Open existing build"}
          </button>
        </div>
      ))}
      {error && (
        <p role="alert" className="workflow-error">
          {error}
        </p>
      )}
      <div className="row-actions">
        <button className="primary" disabled={busy} onClick={onFresh}>
          Build fresh instead
        </button>
        {busy && <span role="status">Rechecking compatibility…</span>}
      </div>
    </>
  );
}

export function DeviceInstaller({
  artifact,
}: {
  artifact: import("../../core/types").Artifact;
}) {
  const [expanded, setExpanded] = useState(false),
    [targets, setTargets] = useState<
      import("../../core/types").InstallTarget[]
    >([]),
    [notes, setNotes] = useState<string[]>([]),
    [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false),
    [progress, setProgress] =
      useState<import("../../core/types").WorkProgress>(),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!busy) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(
    () =>
      api.onEvent((event) => {
        if (
          event.type === "operation-progress" &&
          event.operationId === artifact.id
        )
          setProgress(event.progress);
      }),
    [artifact.id],
  );
  const refresh = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api.installTargets(artifact.id);
      setTargets(result.targets);
      setNotes(result.notes);
      setSelected(result.targets.find((t) => t.available)?.id ?? "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="device-install">
      <button
        className="button"
        onClick={() => {
          setExpanded(!expanded);
          if (!expanded) void refresh();
        }}
      >
        {expanded ? "Close devices" : "Install & launch"}
      </button>
      {expanded && (
        <div className="device-picker">
          <label>
            Device or simulator
            <select
              disabled={busy}
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Select a compatible target</option>
              {targets.map((target) => (
                <option
                  key={target.id}
                  value={target.id}
                  disabled={!target.available}
                >
                  {target.name} · {target.detail}
                </option>
              ))}
            </select>
          </label>
          <div className="row-actions">
            <button
              className="primary"
              disabled={busy || !selected}
              onClick={() => {
                setBusy(true);
                setError("");
                setMessage("");
                setProgress({
                  kind: "work",
                  label: "Checking artifact and device",
                  startedAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                });
                void api
                  .installArtifact(artifact.id, selected)
                  .then(() => setMessage("Installed and launched."))
                  .catch((e) => setError(e.message))
                  .finally(() => {
                    setBusy(false);
                    setProgress(undefined);
                  });
              }}
            >
              Install & launch on selected target
            </button>
            <button
              className="button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              Refresh devices
            </button>
            {busy && progress && (
              <button
                className="button"
                onClick={() => void api.cancelInstall(artifact.id)}
              >
                Cancel install
              </button>
            )}
          </div>
          {busy && (
            <p role="status">
              {progress?.label ?? "Finding compatible devices…"}
              {progress &&
                ` · ${Math.max(0, Math.floor((clock - Date.parse(progress.startedAt)) / 1000))}s elapsed.`}{" "}
              This can take a minute when a simulator starts for the first time.
            </p>
          )}
          {busy && progress && (
            <progress aria-label="Device installation progress" />
          )}
          {notes.map((note) => (
            <p className="muted" key={note}>
              {note}
            </p>
          ))}
          {message && <p role="status">{message}</p>}
          {error && (
            <p role="alert" className="workflow-error">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

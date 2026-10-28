import { useState, useEffect } from "react";
import type { Project, Inspection, ProjectSettings } from "../../core/types";
const api = window.desk;
const defaults = {
  development: {
    configuration: "Debug",
    distribution: "internal",
    simulator: true,
    debug: true,
    autoIncrement: true,
    buildType: "apk",
  },
  preview: {
    configuration: "Release",
    distribution: "internal",
    autoIncrement: true,
    buildType: "apk",
  },
  production: {
    configuration: "Release",
    distribution: "store",
    autoIncrement: true,
    buildType: "app-bundle",
  },
};
export function ProjectBuildSettings({
  project,
  inspection,
  onSave,
}: {
  project: Project;
  inspection?: Inspection;
  onSave: () => void;
}) {
  const [settings, setSettings] = useState(project.settings),
    [profiles, setProfiles] = useState(
      JSON.stringify(project.settings.localProfiles ?? defaults, null, 2),
    );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  useEffect(() => {
    setSettings(project.settings);
    setProfiles(
      JSON.stringify(project.settings.localProfiles ?? defaults, null, 2),
    );
  }, [project.id, JSON.stringify(project.settings)]);
  const native = (project.type ?? "expo") !== "expo";
  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      onSave();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const field = (key: keyof ProjectSettings, value: string) =>
    setSettings({ ...settings, [key]: value || undefined });
  return (
    <section className="section-card adapter-settings">
      <div className="section-heading">
        <h2>Project build settings</h2>
        <span className="mono subtle">{project.type ?? "expo"}</span>
      </div>
      <p className="muted">
        Select the app and its native build target. Overrides apply inside build
        snapshots.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void perform(async () => {
            await api.saveSettings(project.id, {
              ...settings,
              ...(native ? { localProfiles: JSON.parse(profiles) } : {}),
            });
            await api.inspect(project.id);
            setMessage("Build settings saved.");
          });
        }}
      >
        <fieldset disabled={busy} className="workflow-fieldset">
          <div className="form-grid">
            <label>
              Project type
              <select
                aria-label="Project type"
                value={settings.projectType ?? project.type ?? "expo"}
                onChange={(e) => field("projectType", e.target.value)}
              >
                <option value="expo">Expo</option>
                <option value="capacitor">Capacitor</option>
                <option value="native-ios">Native iOS · SwiftUI / UIKit</option>
              </select>
            </label>
            <label>
              App directory
              <input
                value={settings.appDirectory ?? ""}
                placeholder="Repository root"
                onChange={(e) => field("appDirectory", e.target.value)}
              />
            </label>
            {(project.platforms ?? ["ios", "android"]).includes("ios") && (
              <>
                <label>
                  Xcode app container
                  <select
                    aria-label="Xcode app container"
                    value={settings.iosTarget ?? ""}
                    onChange={(e) => field("iosTarget", e.target.value)}
                  >
                    <option value="">Auto-detect</option>
                    {inspection?.containers?.map((c) => (
                      <option key={c.path} value={c.path}>
                        {c.path} · {c.kind}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Application scheme
                  <input
                    value={settings.scheme ?? ""}
                    list="desk-xcode-schemes"
                    placeholder="Auto-detect"
                    onChange={(e) => field("scheme", e.target.value)}
                  />
                  <datalist id="desk-xcode-schemes">
                    {inspection?.schemes?.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </label>
              </>
            )}
            {project.type === "capacitor" && (
              <>
                <label>
                  Web build script
                  <input
                    value={settings.webBuildScript ?? "build"}
                    onChange={(e) => field("webBuildScript", e.target.value)}
                  />
                </label>
                <label>
                  New iOS dependency manager
                  <select
                    aria-label="New iOS dependency manager"
                    value={settings.iosDependencyManager ?? "SPM"}
                    onChange={(e) =>
                      field("iosDependencyManager", e.target.value)
                    }
                  >
                    <option value="SPM">Swift Package Manager</option>
                    <option value="CocoaPods">CocoaPods</option>
                  </select>
                </label>
                {(project.platforms ?? []).includes("android") && (
                  <label>
                    Android application module
                    <input
                      value={settings.androidModule ?? ":app"}
                      onChange={(e) => field("androidModule", e.target.value)}
                    />
                  </label>
                )}
              </>
            )}
          </div>
          {inspection?.capacitor && (
            <p className="mono muted">
              Web: {inspection.capacitor.webDir} · iOS dependencies:{" "}
              {inspection.capacitor.dependencyManager} · Plugins:{" "}
              {inspection.capacitor.plugins.join(", ") || "none detected"}
            </p>
          )}
          {inspection?.iosTarget && (
            <div className="target-list">
              {inspection.iosTarget.targets.map((t) => (
                <div key={t.bundleId}>
                  <strong>{t.name}</strong>
                  <span className="mono">{t.bundleId}</span>
                  <span className="muted">
                    {t.productType} · v{t.version} · build {t.buildNumber}
                  </span>
                </div>
              ))}
            </div>
          )}
          {native && (
            <details className="workflow-details">
              <summary>Local build profiles</summary>
              <p className="muted">
                Development, preview, and production settings. Each profile can
                set configuration, distribution, simulator, debug, buildType,
                scheme, androidVariant, autoIncrement, env, or extends. Imported
                secret environment values stay in the encrypted vault.
              </p>
              <label>
                Profiles JSON
                <textarea
                  aria-label="Profiles JSON"
                  className="profile-json"
                  rows={16}
                  spellCheck={false}
                  value={profiles}
                  onChange={(e) => setProfiles(e.target.value)}
                />
              </label>
            </details>
          )}
          <div className="row-actions">
            <button className="primary" type="submit">
              Save build settings
            </button>
            {native && (
              <>
                <button
                  className="button"
                  type="button"
                  onClick={() =>
                    void perform(() => api.exportBuildSettings(project.id))
                  }
                >
                  Export portable settings
                </button>
                <button
                  className="button"
                  type="button"
                  onClick={() =>
                    void perform(async () => {
                      await api.importBuildSettings(project.id);
                      await api.inspect(project.id);
                    })
                  }
                >
                  Import settings
                </button>
              </>
            )}
          </div>
        </fieldset>
      </form>
      {busy && (
        <p role="status">
          Inspecting project settings. Dependency resolution can take a few
          minutes…
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

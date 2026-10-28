import { StoreOnboarding, TestFlightSetup } from "./StoreOnboarding";
import { WorkProgress } from "./WorkProgress";
import { toolProgress } from "../../core/progress";
import type { WorkProgress as Progress } from "../../core/types";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  FileKey2,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  Monitor,
  Play,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Terminal,
  Upload,
  Zap,
} from "lucide-react";
import type {
  Check as ToolCheck,
  CredentialSummary,
  DesktopAPI,
  LogEntry,
  Platform,
  Project,
  SetupReport,
} from "../../core/types";
const api = window.desk;
export function Setup({
  project,
  credentials,
  checks,
  openModal,
  refresh,
  onBuild,
}: {
  project: Project;
  credentials: CredentialSummary[];
  checks: ToolCheck[];
  openModal: (kind: string) => void;
  refresh: () => Promise<void>;
  onBuild: (platform: Platform, profile: string) => Promise<void>;
}) {
  const [progress, setProgress] = useState<Progress>();
  const [operationStart, setOperationStart] = useState<string>();
  const [buildProfile, setBuildProfile] = useState(
      project.profiles.includes("production")
        ? "production"
        : project.profiles[0],
    ),
    [platform, setPlatform] = useState<Platform>("ios"),
    [newApp, setNewApp] = useState(false),
    [working, setWorking] = useState(""),
    [error, setError] = useState(""),
    [report, setReport] = useState<SetupReport>(),
    [logs, setLogs] = useState<LogEntry[]>([]),
    [license, setLicense] = useState(false),
    [cloudProject, setCloudProject] = useState(""),
    [googleEmail, setGoogleEmail] = useState(""),
    [lastNumber, setLastNumber] = useState(""),
    [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const connection =
    platform === "ios"
      ? project.settings.appleConnectionId
      : project.settings.googleConnectionId;
  const signing =
    platform === "ios"
      ? project.settings.iosSigningId
      : project.settings.androidSigningId;
  useEffect(() => {
    setReport(undefined);
    setError("");
  }, [project.id, platform]);
  useEffect(() => {
    let active = true;
    api.setupLogs(project.id).then((value) => {
      if (active) setLogs(value);
    });
    const stop = api.onEvent((event) => {
      if (
        event.type === "log" &&
        event.jobId === `setup:${project.id}` &&
        event.entry
      ) {
        setLogs((v) => [...v, event.entry!]);
        setProgress((value) => toolProgress(event.entry!.text, value) ?? value);
      }
    });
    return () => {
      active = false;
      stop();
    };
  }, [project.id]);
  const operation = async (name: string, fn: () => Promise<unknown>) => {
    setWorking(name);
    setOperationStart(new Date().toISOString());
    setProgress(undefined);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setWorking("");
    }
  };
  const prepare = () =>
    operation("signing", async () => {
      const last = lastNumber !== "" ? Number(lastNumber) : undefined;
      if (last !== undefined && (!Number.isSafeInteger(last) || last < 0))
        throw new Error(
          "Enter a nonnegative integer for the last used build number.",
        );
      setReport(
        await api.prepareProject(project.id, {
          platform,
          newApp,
          lastIosBuildNumber: platform === "ios" ? last : undefined,
          lastAndroidBuildNumber: platform === "android" ? last : undefined,
        }),
      );
    });
  const required =
    platform === "ios"
      ? [
          "Node.js",
          "Xcode",
          "iOS SDK",
          "iOS platform",
          "CocoaPods",
          "Git",
          "Build storage",
        ]
      : ["Node.js", "Java", "Android SDK", "Git", "Build storage"];
  const toolErrors = checks.filter(
    (c) => required.includes(c.name) && c.status === "error",
  );
  const toolsReady = required.every((name) =>
    checks.some(
      (c) =>
        c.name === name &&
        (name === "iOS platform" ? c.status === "ok" : c.status !== "error"),
    ),
  );
  const ready =
    platform === "ios" ? project.settings.setupAppleComplete : report?.ready;
  const saveConnection = (value: string) =>
    operation("connection", () =>
      api.saveSettings(project.id, {
        ...project.settings,
        [platform === "ios" ? "appleConnectionId" : "googleConnectionId"]:
          value || undefined,
      }),
    );
  const external = (url: string) =>
    void operation("link", () => api.openExternal(url));
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">FROM ZERO TO YOUR FIRST RELEASE</div>
          <h1>
            {platform === "ios"
              ? "Let’s get you to TestFlight."
              : "Let’s get you to Google Play."}
          </h1>
          <p>Connect your account. We’ll handle the signing and the build.</p>
        </div>
        <div className="setup-platform">
          <button
            className={platform === "ios" ? "selected" : ""}
            onClick={() => setPlatform("ios")}
          >
            iOS / TestFlight
          </button>
          <button
            className={platform === "android" ? "selected" : ""}
            onClick={() => setPlatform("android")}
          >
            Android / Play
          </button>
        </div>
      </div>
      <div className="setup-intro">
        <Zap size={21} />
        <div>
          <strong>A guided path, with the busywork handled.</strong>
          <p>
            {platform === "ios"
              ? "We register your bundle ID, enable supported capabilities, create a local signing key and matching profile, then build and upload to TestFlight."
              : "We help install the Android tools, create or import your upload key, connect Google Play, and prepare a draft release."}
          </p>
        </div>
      </div>
      {working && (
        <WorkProgress
          progress={progress}
          startedAt={operationStart}
          label="Setting up this project"
          note="Tool downloads, installation and signing setup can take several minutes."
        />
      )}
      <div className="setup-layout">
        <div className="setup-steps">
          <section className="setup-step">
            <StepTitle
              number="01"
              title="Get this Mac ready"
              done={toolsReady}
            />
            <div className="setup-step-body">
              <p>
                {toolsReady
                  ? "Your required build tools are available."
                  : "A few local tools need attention before your first build."}
              </p>
              <div className="setup-checks">
                {checks
                  .filter((c) => required.includes(c.name))
                  .map((c) => (
                    <span
                      key={c.name}
                      className={c.status === "error" ? "missing" : ""}
                    >
                      {c.status === "ok" ? (
                        <Check size={12} />
                      ) : (
                        <CircleAlert size={12} />
                      )}{" "}
                      {c.name}
                    </span>
                  ))}
              </div>
              {toolErrors.some((c) => c.name === "Node.js") && (
                <button
                  className="button"
                  disabled={!!working}
                  onClick={() =>
                    void operation("node", () =>
                      api.installTool(project.id, "node", false),
                    )
                  }
                >
                  {working === "node" ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <DownloadIcon />
                  )}
                  Install Node LTS
                </button>
              )}
              {toolErrors.some((c) => c.name === "Xcode") && (
                <button
                  className="button"
                  onClick={() =>
                    external("https://apps.apple.com/app/xcode/id497799835")
                  }
                >
                  <ExternalLink size={14} />
                  Get Xcode
                </button>
              )}
              {toolErrors.some((c) => c.name === "CocoaPods") && (
                <button
                  className="button"
                  disabled={!!working}
                  onClick={() =>
                    void operation("cocoapods", () =>
                      api.installTool(project.id, "cocoapods", false),
                    )
                  }
                >
                  {working === "cocoapods" ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <DownloadIcon />
                  )}
                  Install CocoaPods
                </button>
              )}
              {platform === "ios" &&
                checks.some(
                  (c) => c.name === "iOS platform" && c.status !== "ok",
                ) && (
                  <div className="sdk-install">
                    <p>
                      Xcode’s matching iOS platform is missing. The download can
                      require several gigabytes. Use Toolchain to choose build
                      storage on another disk if needed.
                    </p>
                    <button
                      className="button"
                      disabled={!!working}
                      onClick={() =>
                        void operation("ios-platform", async () => {
                          await api.installTool(
                            project.id,
                            "ios-platform",
                            false,
                          );
                          await refresh();
                        })
                      }
                    >
                      {working === "ios-platform" ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <DownloadIcon />
                      )}{" "}
                      Install iOS platform
                    </button>
                  </div>
                )}
              {platform === "android" &&
                (toolErrors.some((c) => c.name === "Android SDK") ||
                  checks.find((c) => c.name === "Java")?.status !== "ok") && (
                  <div className="sdk-install">
                    <p>
                      Install the Android SDK tools and JDK 17 through Homebrew.
                      Additional project-specific SDK/NDK packages are detected
                      during your first build.
                    </p>
                    <button
                      className="text-button"
                      onClick={() =>
                        external("https://developer.android.com/studio/terms")
                      }
                    >
                      Read Android SDK license
                      <ExternalLink size={12} />
                    </button>
                    <label>
                      <input
                        type="checkbox"
                        checked={license}
                        onChange={(e) => setLicense(e.target.checked)}
                      />
                      I have reviewed and accept the Android SDK license.
                    </label>
                    <button
                      className="button"
                      disabled={!license || !!working}
                      onClick={() =>
                        void operation("android", () =>
                          api.installTool(project.id, "android", license),
                        )
                      }
                    >
                      {working === "android" ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <DownloadIcon />
                      )}
                      Install Android tools & JDK
                    </button>
                  </div>
                )}
            </div>
          </section>
          <section className="setup-step">
            <StepTitle
              number="02"
              title={
                platform === "ios"
                  ? "Connect your Apple team"
                  : "Connect Google Play"
              }
              done={!!connection}
            />
            <div className="setup-step-body">
              <p>
                {platform === "ios"
                  ? "Use a team API key with Admin access for automatic signing. Apple enrollment and the initial API key are quick account-owner steps."
                  : "Use a service account with release access to this app. We can create the Cloud account/key, then guide the required Play Console permission step."}
              </p>
              <div className="setup-connect-row">
                <select
                  aria-label="Setup store connection"
                  value={connection ?? ""}
                  onChange={(e) => void saveConnection(e.target.value)}
                >
                  <option value="">Choose a connection…</option>
                  {credentials
                    .filter(
                      (c) =>
                        c.kind === (platform === "ios" ? "apple" : "google"),
                    )
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                </select>
                <button
                  className="button"
                  onClick={() =>
                    void operation("account", () =>
                      api.openAccountSetup(
                        project.id,
                        platform === "ios" ? "apple" : "google",
                      ),
                    )
                  }
                >
                  <KeyRound size={14} />
                  {connection ? "Add another" : "Connect account"}
                </button>
                {connection && (
                  <button
                    className="icon-button"
                    aria-label="Test setup connection"
                    disabled={!!working}
                    onClick={() =>
                      void operation("test", async () => {
                        const text = await api.validateConnection(connection);
                        setReport({
                          actions: [text],
                          handoffs: [],
                          ready: false,
                        });
                      })
                    }
                  >
                    <RefreshCw size={15} />
                  </button>
                )}
              </div>
              {platform === "ios" ? (
                <details className="setup-help">
                  <summary>
                    Starting with no Apple account or API key?
                    <ChevronDown size={13} />
                  </summary>
                  <ol>
                    <li>
                      <button
                        onClick={() =>
                          external(
                            "https://developer.apple.com/programs/enroll/",
                          )
                        }
                      >
                        Enroll in the Apple Developer Program
                        <ArrowUpRight size={11} />
                      </button>{" "}
                      and accept Apple’s current agreements.
                    </li>
                    <li>
                      <button
                        onClick={() =>
                          external(
                            "https://appstoreconnect.apple.com/access/integrations/api",
                          )
                        }
                      >
                        Open Users and Access → Integrations → Team Keys
                        <ArrowUpRight size={11} />
                      </button>
                      . Generate an Admin key and download the .p8 once.
                    </li>
                    <li>
                      Choose Connect account. Select that .p8 and enter its Key
                      ID, Issuer ID, and your Developer Team ID. The app takes
                      over certificate and profile setup from there.
                    </li>
                  </ol>
                </details>
              ) : (
                <details className="setup-help">
                  <summary>
                    Google Cloud CLI fallback
                    <ChevronDown size={13} />
                  </summary>
                  <div className="google-helper">
                    <p>
                      Use this fallback if Google declines sign-in in the
                      embedded browser. Select an existing Google Cloud project.
                      This enables Android Publisher and IAM APIs, creates a
                      Local Build Desk service account, and saves its new key
                      directly into your encrypted vault.
                    </p>
                    <div className="row-actions">
                      <button
                        className="button"
                        disabled={!!working}
                        onClick={() =>
                          void operation("gcloud", () =>
                            api.installTool(project.id, "gcloud", false),
                          )
                        }
                      >
                        Install Google Cloud CLI
                      </button>
                      <button
                        className="button"
                        disabled={!!working}
                        onClick={() =>
                          void operation("login", () =>
                            api.googleLogin(project.id),
                          )
                        }
                      >
                        Sign in with Google
                        <ArrowUpRight size={12} />
                      </button>
                    </div>
                    <label className="field">
                      <span>Google Cloud project ID</span>
                      <input
                        value={cloudProject}
                        onChange={(e) => setCloudProject(e.target.value)}
                        placeholder="my-release-project"
                      />
                    </label>
                    <button
                      className="primary"
                      disabled={!cloudProject || !!working}
                      onClick={() =>
                        void operation("google", async () => {
                          const result = await api.createGoogleConnection(
                            project.id,
                            cloudProject,
                          );
                          setGoogleEmail(result.email);
                          await api.openAccountSetup(
                            project.id,
                            "google",
                            result.connectionId,
                          );
                        })
                      }
                    >
                      {working === "google" ? (
                        <LoaderCircle className="spin" size={14} />
                      ) : (
                        <Zap size={14} />
                      )}
                      Create & connect service account
                    </button>
                    {googleEmail && (
                      <div className="google-handoff">
                        <strong>One Play Console handoff</strong>
                        <p>
                          Invite <code>{googleEmail}</code> under Users and
                          permissions, grant this app’s release permissions,
                          then return here.
                        </p>
                        <button
                          className="text-button"
                          onClick={() =>
                            external(
                              "https://play.google.com/console/developers",
                            )
                          }
                        >
                          Open Google Play Console
                          <ArrowUpRight size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                </details>
              )}
            </div>
          </section>
          <section className="setup-step">
            <StepTitle
              number="03"
              title="Let us handle the signing"
              done={!!signing && !!ready}
            />
            <div className="setup-step-body">
              <div className="setup-app-choice">
                <label>
                  <input
                    type="radio"
                    name="app-history"
                    checked={!newApp}
                    onChange={() => setNewApp(false)}
                  />
                  Existing app / previously built with EAS
                </label>
                <label>
                  <input
                    type="radio"
                    name="app-history"
                    checked={newApp}
                    onChange={() => setNewApp(true)}
                  />
                  Brand-new app, no existing signing history
                </label>
              </div>
              <p>
                {platform === "ios"
                  ? "A signing key is created on this Mac, or reused from the local vault. The matching provisioning profile is selected or generated automatically. Existing Apple certificates are preserved."
                  : newApp
                    ? "We’ll generate an upload key and secure its passwords automatically."
                    : "Import your existing EAS upload key to preserve your app’s Android identity."}
              </p>
              <div className="setup-counter">
                <label className="field">
                  <span>
                    Last used{" "}
                    {platform === "ios"
                      ? "iOS build number"
                      : "Android version code"}{" "}
                    (optional)
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={lastNumber}
                    onChange={(e) => setLastNumber(e.target.value)}
                    placeholder={
                      newApp
                        ? "New app starts at 1"
                        : "We also check the store’s latest version"
                    }
                  />
                </label>
                <button
                  className="text-button"
                  onClick={() => openModal("migration")}
                >
                  Import EAS keys & environment
                  <ArrowUpRight size={12} />
                </button>
              </div>
              <button
                className="primary"
                disabled={!!working || (platform === "ios" && !connection)}
                onClick={() => void prepare()}
              >
                {working === "signing" ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Zap size={15} />
                )}{" "}
                {signing
                  ? "Check & repair setup"
                  : "Set up signing automatically"}
                <ArrowRight size={14} />
              </button>
            </div>
          </section>
          <section className="setup-step">
            <div className="setup-step-body">
              <StoreOnboarding
                project={project}
                platform={platform}
                newApp={newApp}
                busy={!!working}
                operation={operation}
              />
            </div>
          </section>
          {report && (
            <section className="setup-report">
              {report.actions.map((text, i) => (
                <div className="setup-result" key={i}>
                  <CheckCircle2 size={15} />
                  <span>{text}</span>
                </div>
              ))}
              {report.handoffs.map((handoff, i) => (
                <div className="setup-handoff" key={i}>
                  <CircleAlert size={17} />
                  <div>
                    <strong>{handoff.title}</strong>
                    <p>{handoff.detail}</p>
                    {handoff.automation && (
                      <button
                        className="button"
                        onClick={() => {
                          const details =
                            document.querySelector<HTMLDetailsElement>(
                              ".store-onboarding",
                            );
                          if (details) {
                            details.open = true;
                            details.querySelector("summary")?.focus();
                            details.scrollIntoView({
                              block: "center",
                              behavior: "smooth",
                            });
                          }
                        }}
                      >
                        Show automated store setup <ArrowRight size={12} />
                      </button>
                    )}
                    {handoff.url && (
                      <button
                        className="text-button"
                        onClick={() => external(handoff.url!)}
                      >
                        Open the exact setup page
                        <ExternalLink size={12} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {report.handoffs.length > 0 && (
                <button
                  className="button"
                  disabled={!!working}
                  onClick={() => void prepare()}
                >
                  <RefreshCw size={14} />
                  I’ve completed that — check again
                </button>
              )}
            </section>
          )}
          <section className="setup-step">
            <StepTitle
              number="04"
              title={
                platform === "ios"
                  ? "Build, upload, and watch TestFlight"
                  : "Build & upload to Google Play internal testing"
              }
              done={false}
            />
            <div className="setup-step-body">
              <p>
                {platform === "ios"
                  ? "Your production build runs locally, uploads directly to Apple, and waits for processing. You can follow every stage in Builds."
                  : project.settings.playAutoRollout === false
                    ? "Your signed AAB is built locally and uploaded to the internal track as a draft. Review and rollout remain in Play Console."
                    : "Your signed AAB is built locally, uploaded to the internal track, and rolled out to internal testers. A new app's first release stays a draft until you publish it in Play Console."}
              </p>
              {platform === "ios" && connection && (
                <details className="setup-help">
                  <summary
                    onClick={() =>
                      void operation("groups", async () =>
                        setGroups(await api.testFlightGroups(project.id)),
                      )
                    }
                  >
                    Distribute to an internal TestFlight group
                    <ChevronDown size={13} />
                  </summary>
                  <label className="field">
                    <span>Internal tester group</span>
                    <select
                      value={project.settings.testFlightGroupId ?? ""}
                      onChange={(e) =>
                        void operation("group", () =>
                          api.saveSettings(project.id, {
                            ...project.settings,
                            testFlightGroupId: e.target.value || undefined,
                            testFlightGroupName: groups.find(
                              (g) => g.id === e.target.value,
                            )?.name,
                          }),
                        )
                      }
                    >
                      <option value="">
                        Upload only — choose testers later
                      </option>
                      {groups.map((g) => (
                        <option value={g.id} key={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                    <small>
                      Selecting a group grants it access after Apple processing.
                      Create a group and invite eligible teammates below.
                    </small>
                  </label>
                </details>
              )}
              {platform === "ios" && (
                <TestFlightSetup
                  project={project}
                  busy={!!working}
                  operation={operation}
                  refresh={refresh}
                />
              )}
              <label className="field">
                <span>Store build profile</span>
                <select
                  value={buildProfile}
                  onChange={(e) => setBuildProfile(e.target.value)}
                >
                  {project.profiles.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="primary"
                disabled={
                  !!working ||
                  !toolsReady ||
                  !connection ||
                  !signing ||
                  (platform === "ios" && !ready)
                }
                onClick={() =>
                  void operation("build", () => onBuild(platform, buildProfile))
                }
              >
                <Upload size={15} />
                {platform === "ios"
                  ? "Build & send to TestFlight"
                  : "Build & upload draft"}
                <ArrowUpRight size={14} />
              </button>
              {(!toolsReady ||
                !connection ||
                !signing ||
                (platform === "ios" && !ready)) && (
                <small className="setup-build-note">
                  Complete the steps above to unlock your first upload.
                </small>
              )}
            </div>
          </section>
        </div>
        <aside className="setup-side">
          <div className="setup-project-card">
            <span className="eyebrow">YOUR APP</span>
            <h2>{project.name}</h2>
            <code>
              {platform === "ios" ? project.bundleId : project.packageName}
            </code>
            <div>
              <Monitor size={14} />
              <span>Builds on this Mac</span>
            </div>
            <div>
              <ShieldCheck size={14} />
              <span>Private keys stay encrypted</span>
            </div>
            <div>
              <Upload size={14} />
              <span>
                {platform === "ios"
                  ? "Uploads directly to Apple"
                  : "Uploads directly to Google"}
              </span>
            </div>
          </div>
          <div className="setup-log">
            <header>
              <Terminal size={13} />
              SETUP ACTIVITY{" "}
              {working && <LoaderCircle size={12} className="spin" />}
            </header>
            <div role="log" aria-label="Setup activity">
              {logs.length ? (
                logs.slice(-70).map((entry, i) => <p key={i}>{entry.text}</p>)
              ) : (
                <p>
                  Setup activity will appear here. You can leave and come back;
                  saved keys and settings are preserved.
                </p>
              )}
            </div>
          </div>
          {error && (
            <div className="setup-error" role="alert">
              <CircleAlert size={17} />
              <p>{error}</p>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
function StepTitle({
  number,
  title,
  done,
}: {
  number: string;
  title: string;
  done: boolean;
}) {
  return (
    <div className="setup-step-title">
      <span className={done ? "done" : ""}>
        {done ? <Check size={15} /> : number}
      </span>
      <h2>{title}</h2>
      {done && <span className="setup-ready">Ready</span>}
    </div>
  );
}
function DownloadIcon() {
  return <FolderOpen size={14} />;
}

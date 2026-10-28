import { WorkProgress } from "./WorkProgress";
import type { Job } from "../../core/types";
import { useEffect, useState } from "react";
import { ArrowRight, RefreshCw, ShieldCheck } from "lucide-react";
import type {
  Artifact,
  Platform,
  Project,
  StoreSetupRequest,
} from "../../core/types";
const api = window.desk;
export function StoreOnboarding({
  project,
  platform,
  newApp,
  busy,
  operation,
}: {
  project: Project;
  platform: Platform;
  newApp: boolean;
  busy: boolean;
  operation: (name: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(project.name),
    [language, setLanguage] = useState("en-US"),
    [sku, setSku] = useState(project.bundleId ?? ""),
    [kind, setKind] = useState<"app" | "game">("app"),
    [pricing, setPricing] = useState<"free" | "paid">("free"),
    [artifacts, setArtifacts] = useState<Artifact[]>([]),
    [artifactId, setArtifactId] = useState(""),
    [buildId, setBuildId] = useState(""),
    [firstBuild, setFirstBuild] = useState<Job>(),
    [profile, setProfile] = useState(
      project.profiles.includes("production")
        ? "production"
        : project.profiles[0],
    );
  useEffect(() => {
    setName(project.name);
    setSku(project.bundleId ?? "");
    setArtifactId("");
    setBuildId("");
    setFirstBuild(undefined);
  }, [project.id, project.name, project.bundleId]);
  useEffect(() => {
    let active = true;
    const load = () =>
      api
        .state()
        .then((state) => {
          if (active) {
            const job = state.jobs.find((item) => item.id === buildId);
            setFirstBuild(job);
            if (job?.status === "succeeded" && job.artifactId)
              setArtifactId(job.artifactId);
            setArtifacts(
              state.artifacts.filter(
                (artifact) =>
                  artifact.kind === "aab" &&
                  artifact.bundleId === project.packageName &&
                  state.jobs.some(
                    (job) =>
                      job.id === artifact.jobId &&
                      job.projectId === project.id &&
                      job.status === "succeeded",
                  ),
              ),
            );
          }
        })
        .catch(() => {});
    void load();
    const stop = api.onEvent((event) => {
      if (event.type === "state") void load();
    });
    return () => {
      active = false;
      stop();
    };
  }, [project.id, project.packageName, buildId]);
  const request = (mode: StoreSetupRequest["mode"]): StoreSetupRequest => ({
    provider: platform === "ios" ? "apple" : "google",
    mode,
    appName: name,
    language,
    sku: sku || project.bundleId,
    appType: kind,
    pricing,
    newApp,
    artifactId: mode === "bootstrap" ? artifactId : undefined,
  });
  const open = (mode: StoreSetupRequest["mode"]) =>
    operation("store-" + mode, () =>
      api.openStoreSetup(project.id, request(mode)),
    );
  return (
    <details className="setup-advanced store-onboarding">
      <summary>
        Store app record & first upload <ArrowRight size={13} />
      </summary>
      <p>
        Prepare the provider pages here. We reuse matching records and pause for
        sign-in, agreements, and approval of the exact action.
      </p>
      <div className="store-fields">
        <label className="field">
          <span>Store app name</span>
          <input
            value={name}
            maxLength={platform === "ios" ? 30 : 50}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Primary language</span>
          <input
            value={language}
            placeholder="en-US"
            onChange={(e) => setLanguage(e.target.value)}
          />
        </label>
        {platform === "ios" ? (
          <label className="field">
            <span>SKU</span>
            <input value={sku} onChange={(e) => setSku(e.target.value)} />
          </label>
        ) : (
          <>
            <label className="field">
              <span>App type</span>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as "app" | "game")}
              >
                <option value="app">App</option>
                <option value="game">Game</option>
              </select>
            </label>
            <label className="field">
              <span>Pricing</span>
              <select
                value={pricing}
                onChange={(e) => setPricing(e.target.value as "free" | "paid")}
              >
                <option value="free">Free</option>
                <option value="paid">Paid</option>
              </select>
            </label>
          </>
        )}
      </div>
      <button
        className="button"
        disabled={busy || !name || !language}
        onClick={() => void open("record")}
      >
        Set up store app record <ArrowRight size={13} />
      </button>
      {platform === "ios" ? (
        <button
          className="button"
          disabled={busy || !project.settings.appleConnectionId}
          onClick={() => void open("capabilities")}
        >
          Assign iCloud containers & App Groups
        </button>
      ) : (
        <div className="store-bootstrap">
          {newApp && (
            <>
              <label className="field">
                <span>First AAB build profile</span>
                <select
                  value={profile}
                  onChange={(e) => setProfile(e.target.value)}
                >
                  {project.profiles.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <button
                className="button"
                disabled={
                  busy ||
                  !project.settings.androidSigningId ||
                  firstBuild?.status === "queued" ||
                  firstBuild?.status === "running"
                }
                onClick={() =>
                  void operation("first-aab-build", async () => {
                    const jobs = await api.build({
                      projectId: project.id,
                      platform: "android",
                      profile,
                      autoSubmit: false,
                    });
                    setBuildId(jobs[0].id);
                  })
                }
              >
                Build first AAB locally
              </button>
              {firstBuild && (
                <p>
                  First AAB: {firstBuild.status} · {firstBuild.stage}
                  {firstBuild.error ? " · " + firstBuild.error : ""}
                </p>
              )}
              {firstBuild &&
                ["queued", "running"].includes(firstBuild.status) && (
                  <WorkProgress
                    progress={firstBuild.progress}
                    startedAt={
                      firstBuild.stageStartedAt ?? firstBuild.startedAt
                    }
                    label="Building first AAB"
                    note="This build stays local until you approve its console upload."
                  />
                )}
            </>
          )}
          <label className="field">
            <span>First signed AAB</span>
            <select
              value={artifactId}
              onChange={(e) => setArtifactId(e.target.value)}
            >
              <option value="">Choose a successful build…</option>
              {artifacts.map((artifact) => (
                <option key={artifact.id} value={artifact.id}>
                  {artifact.bundleId} · {artifact.version} (
                  {artifact.buildNumber}) ·{" "}
                  {(artifact.size / 1048576).toFixed(1)} MB
                </option>
              ))}
            </select>
          </label>
          <p>
            For a new Play app, configure App Signing and upload this exact
            build to an internal draft. Build an AAB first and set up its store
            record above.
          </p>
          <button
            className="button"
            disabled={busy || !newApp || !artifactId}
            onClick={() => void open("bootstrap")}
          >
            Set up first Play upload <ArrowRight size={13} />
          </button>
          {!newApp && (
            <small>
              Select “New app” above to use first-upload setup. Existing apps
              use normal Build & Upload.
            </small>
          )}
        </div>
      )}
    </details>
  );
}
export function TestFlightSetup({
  project,
  busy,
  operation,
  refresh,
}: {
  project: Project;
  busy: boolean;
  operation: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [users, setUsers] = useState<
      { id: string; email: string; name: string }[]
    >([]),
    [ids, setIds] = useState<string[]>([]),
    [name, setName] = useState("Internal testing"),
    [review, setReview] = useState(false),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setUsers([]);
    setIds([]);
    setReview(false);
    setLoaded(false);
  }, [project.id]);
  return (
    <details className="setup-advanced store-onboarding">
      <summary>
        Create an internal TestFlight group <ShieldCheck size={13} />
      </summary>
      <p>
        Use existing teammates who already have access to this app. This can
        send TestFlight invitations and grant access to builds in the group,
        including builds already present in a reused group.
      </p>
      <label className="field">
        <span>Group name</span>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setReview(false);
          }}
          maxLength={100}
        />
      </label>
      <button
        className="text-button"
        disabled={busy}
        onClick={() =>
          void operation("testflight-users", async () => {
            setUsers(await api.testFlightUsers(project.id));
            setLoaded(true);
            setReview(false);
          })
        }
      >
        <RefreshCw size={13} />
        Load eligible teammates
      </button>
      {loaded && !users.length && (
        <p>
          No eligible teammates are visible. Add your team members and app
          access in App Store Connect, then refresh.
        </p>
      )}
      <div className="store-testers">
        {users.map((user) => (
          <label key={user.id}>
            <input
              type="checkbox"
              checked={ids.includes(user.id)}
              onChange={(e) => {
                setIds(
                  e.target.checked
                    ? [...ids, user.id]
                    : ids.filter((id) => id !== user.id),
                );
                setReview(false);
              }}
            />
            <span>
              {user.name}
              <small>{user.email}</small>
            </span>
          </label>
        ))}
      </div>
      {!review ? (
        <button
          className="button"
          disabled={busy || !name.trim()}
          onClick={() => setReview(true)}
        >
          Review group & invitations
        </button>
      ) : (
        <div className="account-approval">
          <strong>Confirm internal testing setup</strong>
          <p>
            Create or reuse “{name}” for {project.bundleId}, select it for
            future processed builds, and invite{" "}
            {ids.length
              ? users
                  .filter((user) => ids.includes(user.id))
                  .map((user) => user.email)
                  .join(", ")
              : "no testers yet"}
            .
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void operation("testflight-group", async () => {
                await api.configureTestFlight(project.id, {
                  name,
                  userIds: ids,
                });
                setReview(false);
                await refresh();
              })
            }
          >
            Create group{ids.length ? " & invite selected teammates" : ""}
          </button>
        </div>
      )}
    </details>
  );
}

import { useEffect, useState } from "react";
import { Publishing } from "./Publishing";
import { ArrowUpRight, Pause, Play, RefreshCw } from "lucide-react";
import type {
  Project,
  PromotionOptions,
  RolloutHealth,
} from "../../core/types";
import type { RolloutGuard } from "../../core/rollout-guard";
import type { StoreRelease } from "../../core/store-release-types";
const api = window.desk;

// Moves a release that's already in a store onward without uploading again:
// a Play build to another track (optionally a staged production rollout), or
// a TestFlight build to external groups with Beta App Review. Staged Play
// rollouts can be widened, halted, resumed or completed here too.

const pct = (f?: number) =>
  f === undefined ? "" : `${Math.round(f * 1000) / 10}%`;

export function Promote({
  project,
  release,
  onDone,
}: {
  project: Project;
  release: StoreRelease;
  onDone: () => void;
}) {
  const [options, setOptions] = useState<PromotionOptions>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const load = () => {
    setError("");
    return api
      .promotionOptions(project.id, release.id)
      .then(setOptions, (e: Error) => setError(e.message));
  };
  useEffect(() => {
    setOptions(undefined);
    setLog([]);
    void load();
  }, [project.id, release.id]);

  const run = async (
    request: Parameters<typeof api.promoteRelease>[2],
    confirmText: string,
  ) => {
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.promoteRelease(project.id, release.id, request);
      setLog([
        ...result.log,
        ...(result.review
          ? [
              "Google holds these changes until you choose Send for review in Play Console's Publishing overview.",
            ]
          : []),
      ]);
      onDone();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (release.channel === "appstore")
    return (
      <>
        <Publishing project={project} releaseId={release.id} />
        <AppStorePhased project={project} release={release} />
      </>
    );
  return (
    <section className="promote-panel">
      <div className="promote-head">
        <h3>
          {release.channel === "play"
            ? "Promote or roll out"
            : "Send to external testers"}
        </h3>
        <button
          className="icon-button"
          aria-label="Reload promotion options"
          disabled={busy}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <p className="muted">
        Uses the build already in the store; nothing is uploaded again.
      </p>
      {release.channel === "play" && (
        <div className="tester-group">
          <p className="muted">
            Google review and managed publishing are separate from track status.
            Finish those steps in the app-owned Console window. Pre-launch
            reports may be unavailable; no automatic pass is inferred.
          </p>
          <div className="row-actions">
            <button
              className="button"
              onClick={() =>
                void api
                  .openStoreConsole(project.id, "publishing")
                  .catch((e) => setError(e.message))
              }
            >
              Review pending Play changes
            </button>
            <button
              className="button"
              onClick={() =>
                void api
                  .openStoreConsole(
                    project.id,
                    "prelaunch",
                    [],
                    release.track,
                    release.buildNumbers[0],
                  )
                  .catch((e) => setError(e.message))
              }
            >
              Review Google pre-launch report
            </button>
          </div>
        </div>
      )}
      {!options && !error && (
        <p className="muted">Reading tracks and groups…</p>
      )}
      {options?.channel === "play" && (
        <PlayPromote
          options={options}
          busy={busy}
          run={run}
          release={release}
        />
      )}
      {options?.channel === "play" &&
        (options.status === "inProgress" || options.status === "halted") && (
          <RolloutGuardPanel project={project} release={release} />
        )}
      {options?.channel === "testflight" && (
        <TestFlightPromote options={options} busy={busy} run={run} />
      )}
      {log.length > 0 && (
        <ul className="monetization-log" role="status">
          {log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="workflow-error">
          {error}
        </p>
      )}
    </section>
  );
}

type Run = (
  request: Parameters<typeof api.promoteRelease>[2],
  confirmText: string,
) => Promise<void>;

function PlayPromote({
  options,
  busy,
  run,
  release,
}: {
  options: Extract<PromotionOptions, { channel: "play" }>;
  busy: boolean;
  run: Run;
  release: StoreRelease;
}) {
  const others = options.tracks.filter((t) => t.track !== options.track);
  const [to, setTo] = useState(
    others.find((t) => t.track === "production")?.track ??
      others[0]?.track ??
      "",
  );
  const [staged, setStaged] = useState(true);
  const [percent, setPercent] = useState("10");
  const [widen, setWiden] = useState("");
  const label = release.version ?? options.versionCodes.join(", ");
  const name = (track: string) =>
    options.tracks.find((t) => t.track === track)?.name ?? track;
  const rollout =
    options.status === "inProgress" || options.status === "halted";
  const fraction = Number(percent) / 100;
  const nextFraction = Number(widen) / 100;
  return (
    <>
      {rollout && (
        <div className="promote-rollout">
          <strong>
            {options.status === "halted" ? "Rollout halted" : "Staged rollout"}{" "}
            at {pct(options.fraction)}
          </strong>
          <div className="row-actions">
            <label className="field promote-inline">
              <span>Widen to %</span>
              <input
                aria-label="Widen rollout to percent"
                value={widen}
                placeholder={String(
                  Math.min(
                    100,
                    Math.round((options.fraction ?? 0) * 100 * 2 || 20),
                  ),
                )}
                onChange={(e) => setWiden(e.target.value)}
              />
            </label>
            <button
              className="button"
              disabled={
                busy ||
                !(nextFraction > (options.fraction ?? 0) && nextFraction < 1)
              }
              onClick={() =>
                void run(
                  {
                    kind: "rollout",
                    change: { action: "fraction", fraction: nextFraction },
                  },
                  `Widen ${label} on ${name(options.track)} to ${pct(nextFraction)} of users?`,
                )
              }
            >
              <ArrowUpRight size={14} /> Widen
            </button>
            {options.status === "halted" ? (
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    { kind: "rollout", change: { action: "resume" } },
                    `Resume the rollout of ${label}?`,
                  )
                }
              >
                <Play size={14} /> Resume
              </button>
            ) : (
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    { kind: "rollout", change: { action: "halt" } },
                    `Halt the rollout of ${label}? Users who already have it keep it; nobody new gets it.`,
                  )
                }
              >
                <Pause size={14} /> Halt
              </button>
            )}
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                void run(
                  { kind: "rollout", change: { action: "complete" } },
                  `Release ${label} to everyone on ${name(options.track)}?`,
                )
              }
            >
              Release to 100%
            </button>
          </div>
        </div>
      )}
      <div className="form-grid">
        <label className="field">
          <span>Promote to</span>
          <select
            aria-label="Promote to track"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          >
            {others.map((t) => (
              <option key={t.track} value={t.track}>
                {t.name}
                {t.releases[0]
                  ? ` · now ${t.releases[0].name ?? t.releases[0].versionCodes.join(", ")}`
                  : ""}
              </option>
            ))}
          </select>
        </label>
        {to === "production" && (
          <label className="field">
            <span>Users who get it</span>
            <div className="row-actions">
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={staged}
                  onChange={(e) => setStaged(e.target.checked)}
                />
                Staged
              </label>
              {staged && (
                <input
                  aria-label="Staged rollout percent"
                  value={percent}
                  onChange={(e) => setPercent(e.target.value)}
                  style={{ width: 70 }}
                />
              )}
              {staged && <span className="muted">%</span>}
            </div>
          </label>
        )}
      </div>
      <div className="row-actions">
        <button
          className="primary"
          disabled={
            busy ||
            !to ||
            (to === "production" && staged && !(fraction > 0 && fraction < 1))
          }
          onClick={() =>
            void run(
              {
                kind: "play",
                to,
                ...(to === "production" && staged ? { fraction } : {}),
              },
              `Promote ${label} from ${name(options.track)} to ${name(to)}${to === "production" ? (staged ? ` for ${pct(fraction)} of users` : " for everyone") : ""}?${to === "production" ? " This publishes to the Play Store." : ""}`,
            )
          }
        >
          {busy ? "Working…" : `Promote to ${name(to)}`}
        </button>
      </div>
    </>
  );
}

function TestFlightPromote({
  options,
  busy,
  run,
}: {
  options: Extract<PromotionOptions, { channel: "testflight" }>;
  busy: boolean;
  run: Run;
}) {
  const external = options.groups.filter((g) => !g.internal);
  const [chosen, setChosen] = useState<string[]>([]);
  const [newGroup, setNewGroup] = useState("");
  const [newLink, setNewLink] = useState(true);
  const [limit, setLimit] = useState("");
  const [links, setLinks] = useState<Record<string, boolean>>({});
  const [contact, setContact] = useState(options.reviewDetail);
  const missing = options.missingContact.filter(
    (k) => !contact[k as keyof typeof contact],
  );
  const needsReview = options.externalState === "READY_FOR_BETA_SUBMISSION";
  const linkChanges = Object.entries(links)
    .filter(
      ([id, on]) => external.find((g) => g.id === id)?.publicLinkEnabled !== on,
    )
    .map(([groupId, enabled]) => ({
      groupId,
      enabled,
      ...(enabled && Number(limit) > 0 ? { limit: Number(limit) } : {}),
    }));
  const anything =
    chosen.length > 0 || !!newGroup.trim() || linkChanges.length > 0;
  return (
    <>
      <p className="muted">
        External testing:{" "}
        {options.externalState?.replaceAll("_", " ").toLowerCase() ?? "unknown"}
        {options.betaReviewState
          ? ` · Beta App Review ${options.betaReviewState.replaceAll("_", " ").toLowerCase()}`
          : ""}
      </p>
      {external.length === 0 && (
        <p className="muted">No external groups yet; create one below.</p>
      )}
      {external.map((g) => (
        <div className="promote-group" key={g.id}>
          <label className="check-label">
            <input
              type="checkbox"
              disabled={g.hasBuild}
              checked={g.hasBuild || chosen.includes(g.id)}
              onChange={(e) =>
                setChosen(
                  e.target.checked
                    ? [...chosen, g.id]
                    : chosen.filter((x) => x !== g.id),
                )
              }
            />
            {g.name}
            {g.hasBuild ? " · has this build" : ""}
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={links[g.id] ?? g.publicLinkEnabled}
              onChange={(e) => setLinks({ ...links, [g.id]: e.target.checked })}
            />
            Public link
          </label>
          {g.publicLinkEnabled && g.publicLink && (
            <button
              className="text-button"
              onClick={() => void navigator.clipboard.writeText(g.publicLink!)}
            >
              Copy link
              {g.publicLinkLimit ? ` (limit ${g.publicLinkLimit})` : ""}
            </button>
          )}
        </div>
      ))}
      <div className="form-grid">
        <label className="field">
          <span>New external group</span>
          <input
            aria-label="New external group"
            placeholder="Beta testers"
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Public link tester limit (optional)</span>
          <input
            aria-label="Public link limit"
            placeholder="No limit"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
          />
        </label>
      </div>
      {newGroup.trim() && (
        <label className="check-label">
          <input
            type="checkbox"
            checked={newLink}
            onChange={(e) => setNewLink(e.target.checked)}
          />
          Turn on a public link for {newGroup.trim()}
        </label>
      )}
      {needsReview && missing.length > 0 && (
        <>
          <p className="muted">
            Beta App Review needs a contact before external testers get this
            build.
          </p>
          <div className="form-grid">
            {(
              [
                ["contactFirstName", "First name"],
                ["contactLastName", "Last name"],
                ["contactEmail", "Email"],
                ["contactPhone", "Phone"],
              ] as const
            ).map(([key, label]) => (
              <label className="field" key={key}>
                <span>{label}</span>
                <input
                  aria-label={`Beta review ${label}`}
                  value={contact[key] ?? ""}
                  onChange={(e) =>
                    setContact({ ...contact, [key]: e.target.value })
                  }
                />
              </label>
            ))}
          </div>
        </>
      )}
      <div className="row-actions">
        <button
          className="primary"
          disabled={
            busy ||
            !anything ||
            (needsReview &&
              (chosen.length > 0 || !!newGroup.trim()) &&
              missing.length > 0)
          }
          onClick={() =>
            void run(
              {
                kind: "testflight",
                promotion: {
                  groupIds: chosen,
                  ...(newGroup.trim()
                    ? {
                        newGroup: {
                          name: newGroup.trim(),
                          publicLink: newLink,
                          ...(Number(limit) > 0
                            ? { publicLinkLimit: Number(limit) }
                            : {}),
                        },
                      }
                    : {}),
                  ...(linkChanges.length ? { publicLinks: linkChanges } : {}),
                  ...(options.missingContact.length
                    ? {
                        contact: {
                          contactFirstName: contact.contactFirstName,
                          contactLastName: contact.contactLastName,
                          contactEmail: contact.contactEmail,
                          contactPhone: contact.contactPhone,
                        },
                      }
                    : {}),
                },
              },
              `${chosen.length || newGroup.trim() ? "Send this build to external testers" : "Update public links"}${needsReview && (chosen.length || newGroup.trim()) ? "? It goes to Beta App Review first" : ""}?`,
            )
          }
        >
          {busy
            ? "Working…"
            : needsReview && (chosen.length || newGroup.trim())
              ? "Submit for beta review and add"
              : "Apply"}
        </button>
      </div>
    </>
  );
}

/** Android vitals for a staged rollout, and the guard that halts it. */
function RolloutGuardPanel({
  project,
  release,
}: {
  project: Project;
  release: StoreRelease;
}) {
  const [health, setHealth] = useState<RolloutHealth>();
  const [guard, setGuard] = useState<RolloutGuard>();
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void api.rolloutHealth(project.id, release.id).then(
      (h: RolloutHealth) => {
        setHealth(h);
        setGuard(h.guard);
      },
      (e: Error) => setError(e.message),
    );
  }, [project.id, release.id]);
  if (!health || !guard)
    return error ? (
      <p className="workflow-error">{error}</p>
    ) : (
      <p className="muted">Reading Android vitals…</p>
    );
  const v = health.vitals;
  const rate = (n?: number) =>
    n === undefined ? "no data" : `${Math.round(n * 100) / 100}%`;
  const number = (value: string, fallback: number) =>
    Number.isFinite(Number(value)) && value.trim() ? Number(value) : fallback;
  return (
    <div className="promote-guard">
      <h3>Rollout guard</h3>
      {v && (
        <p>
          Last 24 hours, {Math.round(v.users)} users: crashes{" "}
          {rate(v.crashRate)} (limit {guard.maxCrashRate}%), ANRs{" "}
          {rate(v.anrRate)} (limit {guard.maxAnrRate}%).{" "}
          {health.verdict ? (
            <strong className="workflow-error">
              Over the limit: {health.verdict}.
            </strong>
          ) : v.users < guard.minUsers ? (
            <span className="muted">
              Too few users to judge yet ({guard.minUsers} needed).
            </span>
          ) : (
            <span className="muted">Healthy.</span>
          )}
        </p>
      )}
      {health.error && (
        <p className="workflow-error">
          {health.error}{" "}
          {health.enableUrl && (
            <button
              className="text-button"
              onClick={() => void api.openExternal(health.enableUrl!)}
            >
              Enable it
            </button>
          )}
        </p>
      )}
      <label className="check-label">
        <input
          type="checkbox"
          checked={guard.enabled}
          onChange={(e) => setGuard({ ...guard, enabled: e.target.checked })}
        />
        Halt this app's staged rollouts automatically when a limit is crossed
        (checked hourly)
      </label>
      <div className="form-grid">
        <label className="field">
          <span>Crash limit, % of users</span>
          <input
            aria-label="Crash limit"
            defaultValue={guard.maxCrashRate}
            onChange={(e) =>
              setGuard({
                ...guard,
                maxCrashRate: number(e.target.value, guard.maxCrashRate),
              })
            }
          />
        </label>
        <label className="field">
          <span>ANR limit, % of users</span>
          <input
            aria-label="ANR limit"
            defaultValue={guard.maxAnrRate}
            onChange={(e) =>
              setGuard({
                ...guard,
                maxAnrRate: number(e.target.value, guard.maxAnrRate),
              })
            }
          />
        </label>
        <label className="field">
          <span>Users before judging</span>
          <input
            aria-label="Minimum users"
            defaultValue={guard.minUsers}
            onChange={(e) =>
              setGuard({
                ...guard,
                minUsers: Math.round(number(e.target.value, guard.minUsers)),
              })
            }
          />
        </label>
      </div>
      <div className="row-actions">
        <button
          className="button"
          disabled={JSON.stringify(guard) === JSON.stringify(health.guard)}
          onClick={() =>
            void api.saveRolloutGuard(project.id, guard).then(
              (g: RolloutGuard) => {
                setHealth({ ...health, guard: g });
                setSaved("Saved.");
              },
              (e: Error) => setError(e.message),
            )
          }
        >
          Save guard
        </button>
        {saved && (
          <span className="muted" role="status">
            {saved}
          </span>
        )}
        <span className="muted">
          Defaults are Google's bad-behavior thresholds.
        </span>
      </div>
      {health.history.length > 0 && (
        <ul className="monetization-log">
          {health.history.slice(0, 5).map((h) => (
            <li key={h.at}>
              {new Date(h.at).toLocaleString()}: halted{" "}
              {h.versionCodes.join(", ")} on {h.track} because the {h.reason}.
            </li>
          ))}
        </ul>
      )}
      {health.lastCheck && (
        <p className="muted">
          Last automatic check {new Date(health.lastCheck.at).toLocaleString()}
          {health.lastCheck.error ? `: ${health.lastCheck.error}` : "."}
        </p>
      )}
    </div>
  );
}

/** App Store phased release: 7 days from 1% to everyone, pausable. */
function AppStorePhased({
  project,
  release,
}: {
  project: Project;
  release: StoreRelease;
}) {
  const [health, setHealth] = useState<RolloutHealth>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = () =>
    api
      .rolloutHealth(project.id, release.id)
      .then(setHealth, (e: Error) => setError(e.message));
  useEffect(() => void load(), [project.id, release.id]);
  const phased = health?.phased;
  const set = (
    state: "INACTIVE" | "ACTIVE" | "PAUSED" | "COMPLETE",
    text: string,
  ) => {
    if (!window.confirm(text)) return;
    setBusy(true);
    setError("");
    void api
      .setPhasedRelease(project.id, release.id, state)
      .then(
        () => load(),
        (e: Error) => setError(e.message),
      )
      .finally(() => setBusy(false));
  };
  const live = ["READY_FOR_SALE", "READY_FOR_DISTRIBUTION"].includes(
    release.status,
  );
  const editable =
    !live &&
    ![
      "REMOVED_FROM_SALE",
      "DEVELOPER_REMOVED_FROM_SALE",
      "REPLACED_WITH_NEW_VERSION",
    ].includes(release.status);
  if (!health && !error) return null;
  return (
    <section className="promote-panel">
      <div className="promote-head">
        <h3>Phased release</h3>
      </div>
      <p className="muted">
        {!phased?.state
          ? "Off: everyone gets this version as soon as it's released."
          : phased.state === "INACTIVE"
            ? "On: starts when this version is released, reaching everyone over 7 days."
            : phased.state === "ACTIVE"
              ? `Day ${phased.day ?? "?"} of 7.`
              : phased.state === "PAUSED"
                ? `Paused on day ${phased.day ?? "?"}. Users can still update by hand.`
                : "Complete: everyone has this version."}
      </p>
      <div className="row-actions">
        {!phased?.state && editable && (
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              set(
                "INACTIVE",
                "Release this version in phases over 7 days once it's approved and released?",
              )
            }
          >
            Release in phases
          </button>
        )}
        {phased?.state === "ACTIVE" && (
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              set(
                "PAUSED",
                "Pause the phased release? Apple allows up to 30 days of pauses in total.",
              )
            }
          >
            <Pause size={14} /> Pause
          </button>
        )}
        {phased?.state === "PAUSED" && (
          <button
            className="button"
            disabled={busy}
            onClick={() => set("ACTIVE", "Resume the phased release?")}
          >
            <Play size={14} /> Resume
          </button>
        )}
        {(phased?.state === "ACTIVE" || phased?.state === "PAUSED") && (
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              set("COMPLETE", "Release this version to everyone now?")
            }
          >
            Release to everyone
          </button>
        )}
      </div>
      <p className="muted">
        Apple has no live crash API, so App Store phases are paused by hand;
        crashes show in Xcode Organizer.
      </p>
      {error && (
        <p role="alert" className="workflow-error">
          {error}
        </p>
      )}
    </section>
  );
}

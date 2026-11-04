import { useEffect, useState } from "react";
import { Users, RefreshCw, ArrowLeft } from "lucide-react";
import type { DesktopAPI, Project } from "../../core/types";
import type { TesterAction } from "../../core/testers";
import type { StoreActionPreview } from "../../core/store-actions";
import { StoreActionReview } from "./StoreActionReview";

const addresses = (s: string) => [
  ...new Set(
    s
      .split(/[\s,;\"]+/)
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  ),
];
export function Testers({ project }: { project: Project }) {
  const [provider, setProvider] = useState<"apple" | "google">(
    project.platforms?.includes("ios") === false
      ? "google"
      : project.settings.appleConnectionId ||
          project.platforms?.includes("android") === false
        ? "apple"
        : "google",
  );
  const [view, setView] =
    useState<Awaited<ReturnType<DesktopAPI["readTesters"]>>>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [preview, setPreview] = useState<StoreActionPreview>();
  const [mode, setMode] = useState<"list" | "invite" | "groups" | "builds">(
    "list",
  );
  const [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [page, setPage] = useState(0);
  const [group, setGroup] = useState(""),
    [emails, setEmails] = useState(""),
    [name, setName] = useState("");
  const [track, setTrack] = useState("internal"),
    [googleGroups, setGoogleGroups] = useState("");
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError("");
    setView(undefined);
    setSelected([]);
    window.desk
      .readTesters(project.id, provider)
      .then(
        (v) => {
          if (active) {
            setView(v);
            setGroup(v.apple?.groups.find((g) => !g.internal)?.id ?? "");
            setGoogleGroups(
              v.google?.tracks
                .find((t) => t.track === track)
                ?.googleGroups.join("\n") ?? "",
            );
          }
        },
        (e) => active && setError(e.message),
      )
      .finally(() => active && setBusy(false));
    return () => {
      active = false;
    };
  }, [project.id, provider]);
  const reload = async () => {
    setBusy(true);
    setError("");
    try {
      setView(await window.desk.readTesters(project.id, provider));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const prepare = async (action: TesterAction) => {
    setBusy(true);
    setError("");
    try {
      setPreview(await window.desk.prepareTesterAction(project.id, action));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const guide = (section: "testers" | "license") => {
    const list = addresses(emails);
    setBusy(true);
    setError("");
    void window.desk
      .openStoreConsole(project.id, section, list, track)
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const apple = view?.apple,
    google = view?.google;
  const filtered = (apple?.testers ?? []).filter(
    (t) =>
      (!status || t.state === status) &&
      `${t.name} ${t.email ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  const visible = filtered.slice(page * 50, page * 50 + 50);
  const groupPicker = (
    <label>
      External testing group
      <select
        aria-label="Tester group"
        value={group}
        onChange={(e) => setGroup(e.target.value)}
      >
        <option value="">Choose an external group</option>
        {apple?.groups
          .filter((g) => !g.internal)
          .map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
      </select>
    </label>
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">INVITE · DISTRIBUTE · VERIFY</div>
          <h1>Testers</h1>
          <p>
            Manage beta access for {project.name} and see who has installed a
            TestFlight build.
          </p>
        </div>
        <button
          className="button"
          disabled={busy}
          onClick={() => void reload()}
        >
          <RefreshCw size={14} />
          Refresh testers
        </button>
      </div>
      <div
        className="store-channel-tabs"
        role="tablist"
        aria-label="Tester platform"
      >
        {(["apple", "google"] as const)
          .filter(
            (p) =>
              !project.platforms ||
              project.platforms.includes(p === "apple" ? "ios" : "android"),
          )
          .map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={provider === p}
              onClick={() => {
                setProvider(p);
                setMode("list");
                setMessage("");
              }}
            >
              {p === "apple" ? "iOS · TestFlight" : "Android · Google Play"}
            </button>
          ))}
      </div>
      {busy && (
        <p role="status" className="muted">
          Reading tester access. This can take a minute…
        </p>
      )}
      {error && (
        <p role="alert" className="workflow-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {view?.operations
        .filter(
          (r) =>
            r.recovery?.kind === "testers" &&
            r.recovery?.provider === provider &&
            (["running", "uncertain"].includes(r.state) ||
              (r.state === "failed" &&
                !!r.completed &&
                r.completed < (r.total ?? 0))),
        )
        .map((r) => (
          <section className="section-card tester-editor" key={r.id}>
            <h2>
              {r.state === "failed"
                ? "Partially completed tester change"
                : "Check an uncertain tester change"}
            </h2>
            <p>
              {r.title}.{" "}
              {r.total
                ? `${r.completed ?? 0} of ${r.total} steps confirmed. `
                : ""}
              It will not be sent again automatically.
            </p>
            <div className="row-actions">
              {r.state === "failed" &&
              r.recovery?.actionKind === "appleReinvite" ? (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void prepare({
                      kind: "appleReinvite",
                      testerIds: (r.recovery!.testerIds as string[]).slice(
                        r.completed ?? 0,
                      ),
                    })
                  }
                >
                  Review remaining invitations
                </button>
              ) : null}
              <button
                className="button"
                disabled={busy || r.state === "failed"}
                onClick={() => {
                  setBusy(true);
                  void window.desk
                    .reconcileTesterAction(project.id, r.id)
                    .then(
                      (v) =>
                        setMessage(
                          v.state === "complete"
                            ? "The store confirmed this change."
                            : "The result is still uncertain. Check it in the store before allowing another preview.",
                        ),
                      (e) => setError(e.message),
                    )
                    .finally(() => void reload());
                }}
              >
                Reconcile tester change
              </button>
              <button
                className="button"
                disabled={busy || r.state === "failed"}
                onClick={() => {
                  if (
                    !window.confirm(
                      "Have you checked the outcome in the store? Closing this uncertain action permits a new reviewed attempt, which could resend an invitation. This does not claim the previous action succeeded.",
                    )
                  )
                    return;
                  void window.desk
                    .acknowledgeStoreAction(project.id, r.id, true)
                    .then(
                      () => reload(),
                      (e) => setError(e.message),
                    );
                }}
              >
                I checked the store; allow a new preview
              </button>
            </div>
          </section>
        ))}
      {apple && (
        <>
          {mode === "list" ? (
            <section className="section-card tester-editor">
              <div className="section-heading">
                <h2>
                  <Users size={18} /> {apple.testers.length} testers
                </h2>
                <div className="row-actions">
                  <button className="button" onClick={() => setMode("invite")}>
                    Invite testers
                  </button>
                  <button className="button" onClick={() => setMode("groups")}>
                    Manage groups
                  </button>
                  <button className="button" onClick={() => setMode("builds")}>
                    Build access & expiry
                  </button>
                </div>
              </div>
              <div className="form-grid">
                <label>
                  Find a tester
                  <input
                    aria-label="Search testers"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(0);
                    }}
                  />
                </label>
                <label>
                  Invitation status
                  <select
                    value={status}
                    onChange={(e) => {
                      setStatus(e.target.value);
                      setPage(0);
                    }}
                  >
                    <option value="">All statuses</option>
                    {[
                      "NOT_INVITED",
                      "INVITED",
                      "ACCEPTED",
                      "INSTALLED",
                      "REVOKED",
                    ].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                {groupPicker}
              </div>
              <div className="row-actions">
                <button
                  className="button"
                  disabled={busy || !selected.length}
                  onClick={() =>
                    void prepare({ kind: "appleReinvite", testerIds: selected })
                  }
                >
                  Review resend invitations
                </button>
                <button
                  className="button"
                  disabled={busy || !selected.length || !group}
                  onClick={() =>
                    void prepare({
                      kind: "appleMembership",
                      testerIds: selected,
                      groupId: group,
                      add: true,
                    })
                  }
                >
                  Review add to group
                </button>
                <button
                  className="button"
                  disabled={busy || !selected.length || !group}
                  onClick={() =>
                    void prepare({
                      kind: "appleMembership",
                      testerIds: selected,
                      groupId: group,
                      add: false,
                    })
                  }
                >
                  Review remove from group
                </button>
              </div>
              <table className="job-table tester-table">
                <thead>
                  <tr>
                    <th>Select</th>
                    <th>Tester</th>
                    <th>Status / devices</th>
                    <th>Groups</th>
                    <th>7-day activity</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${t.email ?? t.name}`}
                          checked={selected.includes(t.id)}
                          disabled={
                            !selected.includes(t.id) && selected.length >= 50
                          }
                          onChange={(e) =>
                            setSelected((v) =>
                              e.target.checked
                                ? [...v, t.id]
                                : v.filter((id) => id !== t.id),
                            )
                          }
                        />
                      </td>
                      <td>
                        <strong>{t.name}</strong>
                        {t.email && <p className="muted">{t.email}</p>}
                      </td>
                      <td>
                        {t.state}
                        {t.devices.map((d, i) => (
                          <p className="muted" key={i}>
                            {d.model} · {d.osVersion} · build{" "}
                            {d.appBuildVersion}
                          </p>
                        ))}
                      </td>
                      <td>
                        {t.groupIds
                          .map(
                            (id) => apple.groups.find((g) => g.id === id)?.name,
                          )
                          .filter(Boolean)
                          .join(", ") || "No group"}
                      </td>
                      <td>
                        {t.sessions === undefined
                          ? "Not available yet"
                          : `${t.sessions} sessions · ${t.crashes} crashes · ${t.feedback} feedback`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="row-actions">
                <button
                  className="button"
                  disabled={!page}
                  onClick={() => setPage(page - 1)}
                >
                  Previous testers
                </button>
                <span className="muted">
                  {filtered.length ? page * 50 + 1 : 0}–
                  {Math.min(filtered.length, (page + 1) * 50)} of{" "}
                  {filtered.length}
                </span>
                <button
                  className="button"
                  disabled={(page + 1) * 50 >= filtered.length}
                  onClick={() => setPage(page + 1)}
                >
                  Next testers
                </button>
              </div>
              <p className="muted">
                Anonymous public-link testers have no email address. Engagement
                metrics can arrive a day later; unavailable is different from
                zero.
              </p>
              {apple.metricsError && (
                <p className="muted">
                  Engagement metrics unavailable: {apple.metricsError}
                </p>
              )}
            </section>
          ) : (
            <section className="section-card tester-editor">
              <div className="detail-navigation">
                <button className="button" onClick={() => setMode("list")}>
                  <ArrowLeft size={14} />
                  Back to testers
                </button>
              </div>
              {mode === "invite" && (
                <>
                  <h2>Invite external testers</h2>
                  {groupPicker}
                  <label>
                    Email addresses
                    <textarea
                      aria-label="Invite tester emails"
                      rows={6}
                      value={emails}
                      onChange={(e) => setEmails(e.target.value)}
                      placeholder="One address per line, or comma separated"
                    />
                  </label>
                  <label>
                    Import an address list
                    <input
                      type="file"
                      accept=".csv,.txt"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        if (file.size > 1024 * 1024) {
                          setError("Choose a list smaller than 1 MB.");
                          return;
                        }
                        void file
                          .text()
                          .then((s) =>
                            setEmails(
                              (
                                s.match(
                                  /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
                                ) ?? []
                              ).join("\n"),
                            ),
                          );
                      }}
                    />
                  </label>
                  <p className="muted">
                    Up to 50 addresses per reviewed batch. Existing testers are
                    reused.
                  </p>
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !group ||
                      !addresses(emails).length ||
                      addresses(emails).length > 50
                    }
                    onClick={() =>
                      void prepare({
                        kind: "appleInvite",
                        groupId: group,
                        emails: addresses(emails),
                      })
                    }
                  >
                    Preview tester invitations
                  </button>
                </>
              )}
              {mode === "groups" && (
                <>
                  <h2>Testing groups</h2>
                  {apple.groups.map((g) => (
                    <div className="tester-group" key={g.id}>
                      <strong>{g.name}</strong>
                      <p className="muted">
                        {g.internal
                          ? "Internal teammates · manage eligible users in Guided setup"
                          : "External testing"}
                      </p>
                      {g.publicLinkEnabled && g.publicLink && (
                        <button
                          className="button"
                          onClick={() =>
                            void navigator.clipboard.writeText(g.publicLink!)
                          }
                        >
                          Copy {g.name} public link
                        </button>
                      )}
                    </div>
                  ))}
                  <label>
                    New external group name
                    <input
                      aria-label="New tester group"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <button
                    className="button"
                    disabled={busy || !name.trim()}
                    onClick={() => void prepare({ kind: "appleGroup", name })}
                  >
                    Preview new group
                  </button>
                </>
              )}
              {mode === "builds" && (
                <>
                  <h2>Build access & expiry</h2>
                  <p className="muted">
                    Build assignments and public-link settings are available in
                    App Store → Submitted releases → TestFlight.
                  </p>
                  {apple.builds.map((b) => (
                    <div className="tester-group" key={b.id}>
                      <strong>Build {b.number}</strong>
                      <p>
                        {b.expired
                          ? "Expired"
                          : b.expiresAt
                            ? `Expires ${new Date(b.expiresAt).toLocaleDateString()} (${Math.max(0, Math.ceil((Date.parse(b.expiresAt) - Date.now()) / 86400000))} days remaining)`
                            : "Expiry not reported"}
                      </p>
                      <p className="muted">
                        {b.groupIds
                          .map(
                            (id) => apple.groups.find((g) => g.id === id)?.name,
                          )
                          .filter(Boolean)
                          .join(", ") || "No groups reported"}
                      </p>
                      <button
                        className="button"
                        disabled={busy || b.expired}
                        onClick={() =>
                          void prepare({ kind: "appleExpire", buildId: b.id })
                        }
                      >
                        Review expiring build {b.number}
                      </button>
                    </div>
                  ))}
                </>
              )}
            </section>
          )}
        </>
      )}
      {google && (
        <section className="section-card tester-editor">
          <h2>Play testing access</h2>
          <p className="muted">{google.note}</p>
          <label>
            Testing track
            <select
              aria-label="Play tester track"
              value={track}
              onChange={(e) => {
                setTrack(e.target.value);
                setGoogleGroups(
                  google.tracks
                    .find((t) => t.track === e.target.value)
                    ?.googleGroups.join("\n") ?? "",
                );
              }}
            >
              {google.tracks.map((t) => (
                <option key={t.track} value={t.track}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {google.tracks.find((t) => t.track === track)?.error && (
            <p role="alert">
              {google.tracks.find((t) => t.track === track)?.error}
            </p>
          )}
          <label>
            Google Groups assigned to this track
            <textarea
              aria-label="Play testing Google Groups"
              rows={4}
              value={googleGroups}
              onChange={(e) => setGoogleGroups(e.target.value)}
              placeholder="qa-testers@googlegroups.com"
            />
          </label>
          <button
            className="primary"
            disabled={
              busy || !!google.tracks.find((t) => t.track === track)?.error
            }
            onClick={() =>
              void prepare({
                kind: "playGroups",
                track,
                googleGroups: addresses(googleGroups),
              })
            }
          >
            Preview Google Groups update
          </button>
          <div className="tester-group">
            <h3>Email lists & license-test accounts</h3>
            <label>
              Accounts for the Console guide
              <textarea
                aria-label="Play tester email addresses"
                rows={4}
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
              />
            </label>
            <p className="muted">
              The guide opens inside Local Build Desk, navigates to the relevant
              Console page and fills the editor when available. Review the final
              Save there. License testing is account-wide and separate from
              joining a test track.
            </p>
            <div className="row-actions">
              <button
                className="button"
                disabled={busy}
                onClick={() => guide("testers")}
              >
                Set up email-list testers
              </button>
              <button
                className="button"
                disabled={busy}
                onClick={() => guide("license")}
              >
                Set up license testers
              </button>
              <button
                className="button"
                onClick={() =>
                  void navigator.clipboard.writeText(google.optInUrl)
                }
              >
                Copy Play opt-in link
              </button>
            </div>
          </div>
        </section>
      )}
      {preview && (
        <StoreActionReview
          projectId={project.id}
          preview={preview}
          onClose={() => setPreview(undefined)}
          onDone={(m) => {
            setPreview(undefined);
            setMessage(m);
            setSelected([]);
            void reload();
          }}
        />
      )}
    </>
  );
}

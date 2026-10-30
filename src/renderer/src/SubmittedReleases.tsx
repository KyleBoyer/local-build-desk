import { useCallback, useEffect, useRef, useState } from "react";
import {
  RefreshCw,
  ExternalLink,
  Image as ImageIcon,
  X,
  ChevronRight,
  Clock3,
} from "lucide-react";
import type { Project } from "../../core/types";
import type {
  StoreChannel,
  StoreRelease,
  StoreReleaseDetail,
  StoreReleaseSnapshot,
  StoreImage,
} from "../../core/store-release-types";
const api = window.desk;
const labels: Record<StoreChannel, string> = {
  appstore: "App Store review",
  testflight: "TestFlight",
  play: "Google Play",
};
const human = (value: string) =>
  value
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
const date = (value?: string) =>
  value ? new Date(value).toLocaleString() : undefined;
const display = (value: string) =>
  ({
    APP_IPHONE_67: "iPhone 6.7″",
    APP_IPHONE_65: "iPhone 6.5″",
    APP_IPAD_PRO_3GEN_129: "iPad Pro 12.9″ / 13″",
    APP_IPAD_PRO_3GEN_11: "iPad Pro 11″",
    phoneScreenshots: "Phone screenshots",
    sevenInchScreenshots: "7-inch tablet",
    tenInchScreenshots: "10-inch tablet",
    icon: "App icon",
    featureGraphic: "Feature graphic",
  })[value] ?? human(value);
function Preview({
  url,
  name,
  onClose,
}: {
  url: string;
  name: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="store-image-dialog"
      aria-label={name}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="section-heading">
        <h3>{name}</h3>
        <button
          className="icon-button"
          aria-label="Close image preview"
          onClick={onClose}
          autoFocus
        >
          <X size={20} />
        </button>
      </div>
      <img src={url} alt={name} />
    </dialog>
  );
}
function Thumbnail({
  projectId,
  image,
}: {
  projectId: string;
  image: StoreImage;
}) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState(""),
    [open, setOpen] = useState(false);
  useEffect(() => {
    let active = true;
    setUrl("");
    setError("");
    if (image.available)
      api.storeImagePreview(projectId, image.id).then(
        (url) => {
          if (active) setUrl(url);
        },
        (error) => {
          if (active) setError(error.message);
        },
      );
    return () => {
      active = false;
    };
  }, [projectId, image.id, image.available]);
  return (
    <figure className="store-thumbnail">
      <button
        className="store-image-button"
        disabled={!url}
        onClick={() => setOpen(true)}
        aria-label={`Enlarge ${image.name}`}
      >
        {url ? (
          <img src={url} alt={image.name} loading="lazy" />
        ) : (
          <div className="store-image-placeholder">
            {image.available && !error ? (
              <RefreshCw size={20} className="spin" />
            ) : (
              <ImageIcon size={24} />
            )}
            <span>
              {error
                ? "Preview unavailable"
                : image.available
                  ? "Loading…"
                  : "Still processing / no preview"}
            </span>
          </div>
        )}
      </button>
      <figcaption>
        {image.name}
        <span>
          {image.width && image.height
            ? `${image.width} × ${image.height} · `
            : ""}
          {human(image.status ?? "store asset")}
        </span>
      </figcaption>
      {error && <p className="muted store-image-error">{error}</p>}
      {open && (
        <Preview url={url} name={image.name} onClose={() => setOpen(false)} />
      )}
    </figure>
  );
}
export function SubmittedReleases({ project }: { project: Project }) {
  const [snapshot, setSnapshot] = useState<StoreReleaseSnapshot>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [channel, setChannel] = useState<StoreChannel>(
    project.settings.appleConnectionId
      ? "appstore"
      : project.settings.googleConnectionId
        ? "play"
        : "appstore",
  );
  const [selected, setSelected] = useState<StoreRelease>(),
    [detail, setDetail] = useState<StoreReleaseDetail>(),
    [detailBusy, setDetailBusy] = useState(false),
    [detailError, setDetailError] = useState("");
  const [locale, setLocale] = useState("");
  const refreshRequest = useRef(0);
  const request = useRef(0),
    mounted = useRef(true);
  const refresh = useCallback(async () => {
    const sequence = ++refreshRequest.current;
    request.current++;
    setSelected(undefined);
    setDetail(undefined);
    setDetailBusy(false);
    setDetailError("");
    setBusy(true);
    setError("");
    try {
      const result = await api.storeReleases(project.id);
      if (!mounted.current || sequence !== refreshRequest.current) return;
      setSnapshot(result);
      setSelected((previous) =>
        result.releases.find((r) => r.id === previous?.id),
      );
      setDetail(undefined);
      setDetailError("");
      request.current++;
    } catch (error) {
      if (mounted.current && sequence === refreshRequest.current)
        setError((error as Error).message);
    } finally {
      if (mounted.current && sequence === refreshRequest.current)
        setBusy(false);
    }
  }, [project.id]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      refreshRequest.current++;
      request.current++;
    };
  }, [
    refresh,
    project.settings.appleConnectionId,
    project.settings.googleConnectionId,
  ]);
  const show = async (release: StoreRelease, language?: string) => {
    const current = ++request.current;
    setSelected(release);
    setDetailBusy(true);
    setDetail(undefined);
    setDetailError("");
    try {
      const result = await api.storeReleaseDetails(
        project.id,
        release.id,
        language,
      );
      if (mounted.current && current === request.current) {
        setDetail(result);
        setLocale(
          language && result.listings.some((l) => l.locale === language)
            ? language
            : (result.imageLocale ?? result.listings[0]?.locale ?? ""),
        );
      }
    } catch (error) {
      if (mounted.current && current === request.current)
        setDetailError((error as Error).message);
    } finally {
      if (mounted.current && current === request.current) setDetailBusy(false);
    }
  };
  const rows = snapshot?.releases.filter((r) => r.channel === channel) ?? [],
    source = snapshot?.channels[channel];
  const listing =
    detail?.listings.find((l) => l.locale === locale) ?? detail?.listings[0];
  const groups = new Map<string, StoreImage[]>();
  for (const image of detail?.images ?? []) {
    const key = `${image.origin === "local" ? "Local build captures" : "Store assets"} · ${display(image.displayType)} · ${image.locale}`;
    groups.set(key, [...(groups.get(key) ?? []), image]);
  }
  const changeChannel = (next: StoreChannel) => {
    request.current++;
    setChannel(next);
    setSelected(undefined);
    setDetail(undefined);
    setDetailBusy(false);
    setDetailError("");
  };
  return (
    <section
      className="section-card submitted-releases"
      aria-label="Submitted releases"
    >
      <div className="section-heading">
        <div>
          <h2>Submitted releases</h2>
          <p className="muted">
            What the stores currently know about this app, including uploads
            made elsewhere.
          </p>
        </div>
        <button
          className="button"
          onClick={() => void refresh()}
          disabled={busy}
        >
          <RefreshCw size={14} className={busy ? "spin" : ""} />
          {busy ? "Refreshing…" : "Refresh store status"}
        </button>
      </div>
      <div
        className="store-channel-tabs"
        role="tablist"
        aria-label="Store destination"
      >
        {(Object.keys(labels) as StoreChannel[]).map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={key === channel}
            onClick={() => changeChannel(key)}
          >
            {labels[key]}
            <span>
              {snapshot?.channels[key].error
                ? "!"
                : snapshot?.channels[key].connected
                  ? snapshot.releases.filter((r) => r.channel === key).length
                  : "—"}
            </span>
          </button>
        ))}
      </div>
      {busy && (
        <p role="status" className="muted">
          Reading store status. This can take a minute; releases and review
          submissions are not modified.
        </p>
      )}
      {error && (
        <p role="alert" className="inline-error">
          Could not refresh: {error}
        </p>
      )}
      {source?.error && (
        <p role="alert" className="inline-error">
          {source.error}
        </p>
      )}
      {source?.note && <p className="store-source-note muted">{source.note}</p>}
      <div
        className={`store-release-workspace ${selected ? "has-selection" : ""}`}
      >
        <div
          className="store-release-list"
          aria-label={`${labels[channel]} releases`}
        >
          {!rows.length && !busy && (
            <p className="muted">
              {source?.error
                ? "Store status is unavailable. Refresh after resolving the connection error."
                : source?.connected
                  ? "No releases were returned for this destination."
                  : "Connect this store in Guided setup to see its releases."}
            </p>
          )}
          {rows.map((release) => (
            <button
              className={`store-release-row ${selected?.id === release.id ? "selected" : ""}`}
              key={release.id}
              onClick={() => void show(release)}
              aria-pressed={selected?.id === release.id}
            >
              <span>
                <strong>{release.version ?? "Uploaded build"}</strong>
                <span className="mono">
                  {release.buildNumbers.length
                    ? `Build ${release.buildNumbers.join(", ")}`
                    : "No build attached"}
                  {release.track ? ` · ${release.track}` : ""}
                </span>
              </span>
              <span className="store-release-row-status">
                <span className="store-status-badge">
                  {human(release.status)}
                </span>
                {(release.uploadedAt || release.createdAt) && (
                  <small>
                    {release.uploadedAt ? "Uploaded" : "Version created"}{" "}
                    {date(release.uploadedAt ?? release.createdAt)}
                  </small>
                )}
                <ChevronRight size={14} />
              </span>
            </button>
          ))}
        </div>
        {selected && (
          <div className="store-release-detail">
            <div className="section-heading">
              <div>
                <div className="eyebrow">{labels[selected.channel]}</div>
                <h3>
                  {selected.version ?? "Build"}
                  {selected.channel !== "play" && selected.buildNumbers.length
                    ? ` (${selected.buildNumbers.join(", ")})`
                    : ""}
                </h3>
              </div>
              <button
                className="button"
                onClick={() => void api.openExternal(selected.consoleUrl)}
              >
                <ExternalLink size={13} />
                Open console
              </button>
            </div>
            <dl className="store-release-facts">
              {selected.channel === "play" && (
                <div>
                  <dt>Version codes</dt>
                  <dd>{selected.buildNumbers.join(", ") || "None"}</dd>
                </div>
              )}
              <div>
                <dt>Status</dt>
                <dd>{human(selected.status)}</dd>
              </div>
              {selected.track && (
                <div>
                  <dt>Track</dt>
                  <dd>{selected.track}</dd>
                </div>
              )}
              {selected.fraction !== undefined && (
                <div>
                  <dt>Rollout</dt>
                  <dd>{Math.round(selected.fraction * 100)}%</dd>
                </div>
              )}
              {selected.internalState && (
                <div>
                  <dt>Internal testing</dt>
                  <dd>{human(selected.internalState)}</dd>
                </div>
              )}
              {selected.externalState && (
                <div>
                  <dt>External testing</dt>
                  <dd>{human(selected.externalState)}</dd>
                </div>
              )}
              {selected.betaReviewState && (
                <div>
                  <dt>Beta App Review</dt>
                  <dd>{human(selected.betaReviewState)}</dd>
                </div>
              )}
              {selected.expiresAt && (
                <div>
                  <dt>Expires</dt>
                  <dd>{date(selected.expiresAt)}</dd>
                </div>
              )}
              {detail?.groups.length ? (
                <div>
                  <dt>Testing groups</dt>
                  <dd>{detail.groups.join(", ")}</dd>
                </div>
              ) : null}
            </dl>
            {detailBusy && (
              <p role="status" className="muted">
                Loading the listing and its attached assets…
              </p>
            )}
            {detailError && (
              <p role="alert" className="inline-error">
                {detailError}
              </p>
            )}
            {detail && (
              <>
                {detail.notes.map((note, i) => (
                  <p key={i} className="store-detail-note muted">
                    {note}
                  </p>
                ))}
                {detail.listings.length > 1 && (
                  <label className="store-locale">
                    Listing language
                    <select
                      value={locale}
                      onChange={(event) =>
                        void show(selected, event.target.value)
                      }
                    >
                      {detail.listings.map((l) => (
                        <option key={l.locale}>{l.locale}</option>
                      ))}
                    </select>
                  </label>
                )}
                {listing && (
                  <div className="store-listing-text">
                    {listing.title && <h4>{listing.title}</h4>}
                    {listing.whatsNew && (
                      <details open>
                        <summary>
                          {selected.channel === "testflight"
                            ? "What to Test"
                            : "What's New"}
                        </summary>
                        <p>{listing.whatsNew}</p>
                      </details>
                    )}
                    {listing.shortDescription && (
                      <p>{listing.shortDescription}</p>
                    )}
                    {listing.description && (
                      <details>
                        <summary>
                          Submitted description · {listing.locale}
                        </summary>
                        <p>{listing.description}</p>
                      </details>
                    )}
                    {listing.keywords && (
                      <p className="muted">Keywords: {listing.keywords}</p>
                    )}
                  </div>
                )}
                {[...groups].map(([title, images]) => (
                  <section className="store-image-group" key={title}>
                    <h4>
                      {title}
                      <span className="mono">{images.length}</span>
                    </h4>
                    <div className="store-image-grid">
                      {images.map((image) => (
                        <Thumbnail
                          projectId={project.id}
                          image={image}
                          key={image.id}
                        />
                      ))}
                    </div>
                  </section>
                ))}
                {!detail.images.length && (
                  <p className="muted">
                    No screenshot previews are available for this selection.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {snapshot && (
        <p className="store-checked-at mono subtle">
          <Clock3 size={12} />
          Last checked {date(snapshot.checkedAt)} ·{" "}
          {channel === "play" ? "Current track state" : "Latest 25 records"}
        </p>
      )}
    </section>
  );
}

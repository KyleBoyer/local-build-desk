import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  Download,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type { Project } from "../../core/types";
import type {
  AppleGroup,
  AppleIap,
  AppleOfferCode,
  AppleSubscription,
  GoogleProduct,
  GooglePromo,
  GoogleSubscription,
  Monetization as Config,
  StoreItem,
} from "../../core/monetization";
import type { MonetizationView } from "../../core/monetization-service";
const api = window.desk;

// Prices, in-app purchases, subscriptions, offer codes and promo codes on the
// App Store and Google Play. Every edit is saved to the project's monetization
// file; each save chooses whether the store gets it now or with the next
// release. The next release applies whatever the store still doesn't match.

type Store = "apple" | "google";
type When = "now" | "release";
type Editing =
  | { kind: "apple-app" }
  | { kind: "apple-iap"; index?: number }
  | { kind: "apple-group"; index?: number }
  | { kind: "apple-subscription"; group?: number; index?: number }
  | { kind: "apple-offer"; index?: number }
  | { kind: "google-price" }
  | { kind: "google-product"; index?: number }
  | { kind: "google-subscription"; index?: number }
  | { kind: "google-promo"; index?: number };

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const money = (v?: string) =>
  v === undefined ? "—" : Number(v) === 0 ? "Free" : `$${v}`;
const plural = (n: number, one: string, many = one + "s") =>
  `${n} ${n === 1 ? one : many}`;
const relativeTo = (fromDir: string, target: string) => {
  const from = fromDir.split("/").filter(Boolean),
    to = target.split("/").filter(Boolean);
  let i = 0;
  while (i < from.length && from[i] === to[i]) i++;
  return [...from.slice(i).map(() => ".."), ...to.slice(i)].join("/");
};

function Dialog({
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
    ref.current
      ?.querySelector<HTMLElement>("input,select,textarea,button")
      ?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [close]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        className="modal monetization-modal"
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

function Text({
  label,
  value,
  onChange,
  hint,
  disabled,
  placeholder,
  area,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  hint?: string;
  disabled?: boolean;
  placeholder?: string;
  area?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {area ? (
        <textarea
          aria-label={label}
          value={value ?? ""}
          disabled={disabled}
          placeholder={placeholder}
          rows={3}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          aria-label={label}
          value={value ?? ""}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T | undefined;
  options: [T, string][];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
function Check({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="check-label">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}
const num = (v: string, fallback = 1) =>
  Number.isFinite(Number(v)) && v.trim() ? Number(v) : fallback;

/** Locale → text rows, such as en-US: name + description. */
function Localized<T extends Record<string, unknown>>({
  value,
  fields,
  onChange,
  blank,
}: {
  value: Record<string, T>;
  fields: [keyof T & string, string, string?][];
  onChange: (v: Record<string, T>) => void;
  blank: T;
}) {
  const entries = Object.entries(value);
  const rename = (from: string, to: string) =>
    onChange(
      Object.fromEntries(entries.map(([k, v]) => [k === from ? to : k, v])),
    );
  return (
    <div className="monetization-locales">
      {entries.map(([locale, text]) => (
        <div className="monetization-locale" key={locale}>
          <Text
            label="Locale"
            value={locale}
            onChange={(v) => rename(locale, v)}
          />
          {fields.map(([key, label, hint]) => (
            <Text
              key={key}
              label={label}
              hint={hint}
              value={
                Array.isArray(text[key])
                  ? (text[key] as string[]).join(", ")
                  : (text[key] as string | undefined)
              }
              onChange={(v) =>
                onChange({
                  ...value,
                  [locale]: {
                    ...text,
                    [key]:
                      key === "benefits"
                        ? v
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean)
                        : v || undefined,
                  },
                })
              }
            />
          ))}
          {entries.length > 1 && (
            <button
              className="text-button"
              onClick={() =>
                onChange(
                  Object.fromEntries(entries.filter(([k]) => k !== locale)),
                )
              }
            >
              Remove {locale}
            </button>
          )}
        </div>
      ))}
      <button
        className="text-button"
        onClick={() =>
          onChange({ ...value, [`xx-${entries.length}`]: clone(blank) })
        }
      >
        <Plus size={12} /> Add a language
      </button>
    </div>
  );
}

function Territories({
  value,
  onChange,
}: {
  value: "ALL" | string[];
  onChange: (v: "ALL" | string[]) => void;
}) {
  return (
    <>
      <Choice
        label="Territories"
        value={value === "ALL" ? "ALL" : "SOME"}
        options={[
          ["ALL", "Every territory"],
          ["SOME", "Only these…"],
        ]}
        onChange={(v) => onChange(v === "ALL" ? "ALL" : ["USA"])}
      />
      {value !== "ALL" && (
        <Text
          label="Territory codes"
          placeholder="USA, CAN, GBR"
          value={value.join(", ")}
          onChange={(v) =>
            onChange(
              v
                .split(/[\s,]+/)
                .map((s) => s.trim().toUpperCase())
                .filter(Boolean),
            )
          }
        />
      )}
    </>
  );
}

function Status({ item }: { item?: StoreItem }) {
  if (!item || item.unknown)
    return <span className="badge queued">Not compared</span>;
  if (!item.exists)
    return <span className="badge needs-attention">Not in store yet</span>;
  if (item.changes.length)
    return (
      <span className="badge running">
        {plural(item.changes.length, "change")} pending
      </span>
    );
  return <span className="badge succeeded">In sync</span>;
}

function ItemRow({
  title,
  detail,
  item,
  price,
  onEdit,
  onRemove,
  onApply,
  busy,
}: {
  title: string;
  detail: string;
  item?: StoreItem;
  price?: string;
  onEdit: () => void;
  onRemove?: () => void;
  onApply?: () => void;
  busy: boolean;
}) {
  return (
    <div className="monetization-row">
      <div className="monetization-row-main">
        <strong>{title}</strong>
        <span className="mono">{detail}</span>
        {item?.state && (
          <span className="muted">
            {item.state.replaceAll("_", " ").toLowerCase()}
          </span>
        )}
      </div>
      <div className="monetization-row-price">
        <span>{money(price)}</span>
        {item?.price !== undefined && !item.changes.length
          ? null
          : item?.price !== undefined && (
              <small>store: {money(item.price)}</small>
            )}
      </div>
      <Status item={item} />
      <div className="row-actions">
        {onApply && item?.changes.length ? (
          <button className="button" disabled={busy} onClick={onApply}>
            Apply now
          </button>
        ) : null}
        <button
          className="icon-button"
          aria-label={`Edit ${title}`}
          disabled={busy}
          onClick={onEdit}
        >
          <Pencil size={15} />
        </button>
        {onRemove && (
          <button
            className="icon-button"
            aria-label={`Remove ${title} from the file`}
            disabled={busy}
            onClick={onRemove}
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>
      {!!item && (item.changes.length > 0 || item.warnings.length > 0) && (
        <ul className="monetization-changes">
          {item.changes.map((c) => (
            <li key={c}>{c}</li>
          ))}
          {item.warnings.map((w) => (
            <li key={w} className="warning">
              <AlertTriangle size={11} /> {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Monetization({ project }: { project: Project }) {
  const [view, setView] = useState<MonetizationView>();
  const [store, setStore] = useState<Store>(() =>
    project.platforms?.includes("ios") === false ? "google" : "apple",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [editing, setEditing] = useState<Editing>();
  const [when, setWhen] = useState<When>("release");

  const load = useCallback(() => {
    setBusy(true);
    setError("");
    return api
      .readMonetization(project.id)
      .then(setView)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }, [project.id]);
  useEffect(() => void load(), [load]);
  // The Play Console assist records promotions while this page is open.
  useEffect(() => {
    const focus = () =>
      void api.readMonetization(project.id).then(setView, () => undefined);
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [project.id]);

  const items = view?.items ?? [];
  const item = (key: string) => items.find((i) => i.key === key);
  const pending = items.filter(
    (i) =>
      i.managed &&
      i.changes.length &&
      !i.key.startsWith("google:promo:") &&
      i.key !== "google:appPrice",
  );

  const save = async (config: Config, apply: string[]) => {
    setBusy(true);
    setError("");
    try {
      const result = await api.saveMonetization(project.id, config, apply);
      setView(result);
      setLog(result.log);
      setEditing(undefined);
    } catch (e) {
      setError((e as Error).message);
      void api.readMonetization(project.id).then(setView, () => undefined);
    } finally {
      setBusy(false);
    }
  };
  const remove = (mutate: (c: Config) => void) => {
    if (!view) return;
    const next = clone(view.config);
    mutate(next);
    void save(next, []);
  };

  if (!view)
    return (
      <>
        <Heading project={project} file={undefined} />
        <section className="section-card">
          <p className="muted">
            {busy
              ? "Reading the monetization file and the stores…"
              : "Couldn't read monetization."}
          </p>
          {error && (
            <p role="alert" className="workflow-error">
              {error}
            </p>
          )}
        </section>
      </>
    );

  const config = view.config;
  const storeState = view.stores[store];
  const unmanaged = items.filter((i) => !i.managed && i.store === store);
  const editorProps = {
    config,
    busy,
    when,
    setWhen,
    close: () => setEditing(undefined),
    save,
    codesFile: view.file,
  };

  return (
    <>
      <Heading project={project} file={view.file} />
      <div className="monetization-toolbar">
        <div className="store-channel-tabs" role="tablist" aria-label="Store">
          {(["apple", "google"] as Store[]).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={s === store}
              onClick={() => setStore(s)}
            >
              {s === "apple" ? "App Store" : "Google Play"}
              <span>
                {view.stores[s].error
                  ? "!"
                  : !view.stores[s].connected
                    ? "—"
                    : items.filter(
                        (i) => i.store === s && i.managed && i.changes.length,
                      ).length || "✓"}
              </span>
            </button>
          ))}
        </div>
        <button className="button" disabled={busy} onClick={() => void load()}>
          <RefreshCw size={14} className={busy ? "spin" : ""} />{" "}
          {busy ? "Reading…" : "Compare with stores"}
        </button>
      </div>

      {!storeState.connected && (
        <p className="workflow-error">
          {store === "apple"
            ? "Connect App Store Connect to this project in Connections to compare with and apply to the App Store."
            : "Connect a Google Play service account to this project in Connections to compare with and apply to Google Play."}
        </p>
      )}
      {storeState.error && (
        <p role="alert" className="workflow-error">
          {storeState.error}
        </p>
      )}
      {view.problems.length > 0 && (
        <p role="alert" className="workflow-error">
          {view.problems.join(" ")}
        </p>
      )}

      {pending.filter((i) => i.store === store).length > 0 && (
        <section className="section-card monetization-pending">
          <div>
            <h2>
              {plural(pending.filter((i) => i.store === store).length, "item")}{" "}
              waiting for the next release
            </h2>
            <p className="muted">
              Saved in {view.file}. The next{" "}
              {store === "apple"
                ? "App Store Connect upload or listing submission"
                : "Play upload"}{" "}
              applies them, or apply them now.
            </p>
          </div>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void save(
                config,
                pending.filter((i) => i.store === store).map((i) => i.key),
              )
            }
          >
            Apply all now
          </button>
        </section>
      )}

      {store === "apple" ? (
        <>
          <section className="section-card">
            <div className="monetization-section-head">
              <h2>App price and availability</h2>
            </div>
            {config.apple.app ? (
              <ItemRow
                title="The app"
                detail={
                  config.apple.app.territories === "ALL"
                    ? "Every territory"
                    : config.apple.app.territories.join(", ")
                }
                price={config.apple.app.price}
                item={item("apple:app")}
                busy={busy}
                onEdit={() => setEditing({ kind: "apple-app" })}
                onApply={() => void save(config, ["apple:app"])}
                onRemove={() => remove((c) => (c.apple.app = undefined))}
              />
            ) : (
              <div className="row-actions">
                <span className="muted">
                  Not managed here{view.stores.apple.connected ? "" : ""}. Your
                  listing file's compliance answers set it otherwise.
                </span>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => setEditing({ kind: "apple-app" })}
                >
                  Set the price here
                </button>
              </div>
            )}
          </section>

          <section className="section-card">
            <div className="monetization-section-head">
              <h2>In-app purchases</h2>
              <button
                className="button"
                disabled={busy}
                onClick={() => setEditing({ kind: "apple-iap" })}
              >
                <Plus size={14} /> Add purchase
              </button>
            </div>
            {config.apple.inAppPurchases.length === 0 && (
              <p className="muted">
                No consumable, non-consumable or non-renewing purchases in the
                file.
              </p>
            )}
            {config.apple.inAppPurchases.map((p, index) => (
              <ItemRow
                key={p.productId}
                title={
                  Object.values(p.localizations)[0]?.name ?? p.referenceName
                }
                detail={`${p.productId} · ${p.type.toLowerCase().replaceAll("_", "-")}`}
                price={p.price}
                item={item(`apple:iap:${p.productId}`)}
                busy={busy}
                onEdit={() => setEditing({ kind: "apple-iap", index })}
                onApply={() => void save(config, [`apple:iap:${p.productId}`])}
                onRemove={() =>
                  remove((c) => c.apple.inAppPurchases.splice(index, 1))
                }
              />
            ))}
          </section>

          <section className="section-card">
            <div className="monetization-section-head">
              <h2>Subscriptions</h2>
              <div className="row-actions">
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => setEditing({ kind: "apple-group" })}
                >
                  <Plus size={14} /> Add group
                </button>
                <button
                  className="button"
                  disabled={busy || !config.apple.subscriptionGroups.length}
                  onClick={() => setEditing({ kind: "apple-subscription" })}
                >
                  <Plus size={14} /> Add subscription
                </button>
              </div>
            </div>
            {config.apple.subscriptionGroups.length === 0 && (
              <p className="muted">
                Add a subscription group first; a group's subscriptions are
                levels of the same service.
              </p>
            )}
            {config.apple.subscriptionGroups.map((g, gi) => (
              <div key={g.referenceName} className="monetization-group">
                <ItemRow
                  title={
                    Object.values(g.localizations)[0]?.name ?? g.referenceName
                  }
                  detail={`Group · ${g.referenceName}`}
                  item={item(`apple:group:${g.referenceName}`)}
                  busy={busy}
                  onEdit={() => setEditing({ kind: "apple-group", index: gi })}
                  onApply={() =>
                    void save(config, [`apple:group:${g.referenceName}`])
                  }
                  onRemove={
                    g.subscriptions.length
                      ? undefined
                      : () =>
                          remove((c) =>
                            c.apple.subscriptionGroups.splice(gi, 1),
                          )
                  }
                />
                {g.subscriptions.map((s, si) => (
                  <ItemRow
                    key={s.productId}
                    title={
                      Object.values(s.localizations)[0]?.name ?? s.referenceName
                    }
                    detail={`${s.productId} · ${s.period.toLowerCase().replaceAll("_", " ")}${s.introOffer ? ` · intro ${s.introOffer.mode.toLowerCase().replaceAll("_", " ")}` : ""}`}
                    price={s.price}
                    item={item(`apple:subscription:${s.productId}`)}
                    busy={busy}
                    onEdit={() =>
                      setEditing({
                        kind: "apple-subscription",
                        group: gi,
                        index: si,
                      })
                    }
                    onApply={() =>
                      void save(config, [
                        `apple:group:${g.referenceName}`,
                        `apple:subscription:${s.productId}`,
                      ])
                    }
                    onRemove={() =>
                      remove((c) =>
                        c.apple.subscriptionGroups[gi]!.subscriptions.splice(
                          si,
                          1,
                        ),
                      )
                    }
                  />
                ))}
              </div>
            ))}
          </section>

          <section className="section-card">
            <div className="monetization-section-head">
              <h2>Offer codes</h2>
              <button
                className="button"
                disabled={
                  busy ||
                  (!config.apple.inAppPurchases.length &&
                    !config.apple.subscriptionGroups.some(
                      (g) => g.subscriptions.length,
                    ))
                }
                onClick={() => setEditing({ kind: "apple-offer" })}
              >
                <Plus size={14} /> Add offer
              </button>
            </div>
            <p className="muted">
              Apple replaced promo codes with offer codes in 2026. Offers work
              for subscriptions and, now, consumable and non-consumable
              purchases: one-time codes to hand out, or a custom code anyone can
              type.
            </p>
            {config.apple.offerCodes.map((o, index) => (
              <ItemRow
                key={`${o.productId}/${o.name}`}
                title={o.name}
                detail={`${o.productId} · ${plural(o.batches.length, "batch", "batches")}${o.active ? "" : " · off"}`}
                price={
                  o.price ?? (o.mode === "FREE_TRIAL" ? "0.00" : undefined)
                }
                item={item(`apple:offer:${o.productId}:${o.name}`)}
                busy={busy}
                onEdit={() => setEditing({ kind: "apple-offer", index })}
                onApply={() =>
                  void save(config, [`apple:offer:${o.productId}:${o.name}`])
                }
                onRemove={
                  o.batches.some((b) => b.id)
                    ? undefined
                    : () => remove((c) => c.apple.offerCodes.splice(index, 1))
                }
              />
            ))}
          </section>
        </>
      ) : (
        <>
          <section className="section-card">
            <div className="monetization-section-head">
              <h2>Paid app price</h2>
            </div>
            {config.google.appPrice !== undefined ? (
              <ItemRow
                title="The app"
                detail="Set in Play Console"
                price={config.google.appPrice}
                item={item("google:appPrice")}
                busy={busy}
                onEdit={() => setEditing({ kind: "google-price" })}
                onRemove={() => remove((c) => (c.google.appPrice = undefined))}
              />
            ) : (
              <div className="row-actions">
                <span className="muted">Free, or not managed here.</span>
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => setEditing({ kind: "google-price" })}
                >
                  Set a price
                </button>
              </div>
            )}
            {config.google.appPrice !== undefined && (
              <div className="row-actions">
                <button
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void api
                      .openPlayMonetization(project.id, "google:appPrice")
                      .catch((e: Error) => setError(e.message))
                  }
                >
                  Open in Play Console
                </button>
              </div>
            )}
          </section>

          <section className="section-card">
            <div className="monetization-section-head">
              <h2>One-time products</h2>
              <button
                className="button"
                disabled={busy}
                onClick={() => setEditing({ kind: "google-product" })}
              >
                <Plus size={14} /> Add product
              </button>
            </div>
            {config.google.products.length === 0 && (
              <p className="muted">No in-app products in the file.</p>
            )}
            {config.google.products.map((p, index) => (
              <ItemRow
                key={p.productId}
                title={Object.values(p.listings)[0]?.title ?? p.productId}
                detail={`${p.productId}${p.active ? "" : " · inactive"}`}
                price={p.price}
                item={item(`google:product:${p.productId}`)}
                busy={busy}
                onEdit={() => setEditing({ kind: "google-product", index })}
                onApply={() =>
                  void save(config, [`google:product:${p.productId}`])
                }
                onRemove={() =>
                  remove((c) => c.google.products.splice(index, 1))
                }
              />
            ))}
          </section>

          <section className="section-card">
            <div className="monetization-section-head">
              <h2>Subscriptions</h2>
              <button
                className="button"
                disabled={busy}
                onClick={() => setEditing({ kind: "google-subscription" })}
              >
                <Plus size={14} /> Add subscription
              </button>
            </div>
            {config.google.subscriptions.map((s, index) => (
              <ItemRow
                key={s.productId}
                title={Object.values(s.listings)[0]?.title ?? s.productId}
                detail={`${s.productId} · ${s.basePlans.map((b) => `${b.basePlanId} ${b.period}`).join(", ")}`}
                price={s.basePlans[0]?.price}
                item={item(`google:subscription:${s.productId}`)}
                busy={busy}
                onEdit={() =>
                  setEditing({ kind: "google-subscription", index })
                }
                onApply={() =>
                  void save(config, [`google:subscription:${s.productId}`])
                }
                onRemove={() =>
                  remove((c) => c.google.subscriptions.splice(index, 1))
                }
              />
            ))}
          </section>

          <section className="section-card">
            <div className="monetization-section-head">
              <h2>Promo codes</h2>
              <button
                className="button"
                disabled={
                  busy ||
                  (!config.google.products.length &&
                    !config.google.subscriptions.length)
                }
                onClick={() => setEditing({ kind: "google-promo" })}
              >
                <Plus size={14} /> Add promotion
              </button>
            </div>
            <p className="muted">
              Google has no API for promo codes. Local Build Desk opens the
              promotion in its signed-in Play Console window and fills in what
              it can; you review it and choose Save. Downloaded codes are saved
              privately, never in your repository.
            </p>
            {config.google.promoCodes.map((p, index) => {
              const key = `google:promo:${p.name}`;
              return (
                <div key={p.name}>
                  <ItemRow
                    title={p.name}
                    detail={`${p.productId} · ${p.kind === "custom" ? `code ${p.code}` : plural(p.count, "code")} · ${p.start} → ${p.end}`}
                    item={item(key)}
                    busy={busy}
                    onEdit={() => setEditing({ kind: "google-promo", index })}
                    onRemove={
                      p.generatedAt
                        ? undefined
                        : () =>
                            remove((c) => c.google.promoCodes.splice(index, 1))
                    }
                  />
                  {!p.generatedAt && (
                    <div className="row-actions monetization-row-actions">
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() =>
                          void api
                            .openPlayMonetization(project.id, key)
                            .catch((e: Error) => setError(e.message))
                        }
                      >
                        Create in Play Console
                      </button>
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() =>
                          void api
                            .markMonetizationDone(project.id, key)
                            .then(load, (e: Error) => setError(e.message))
                        }
                      >
                        I created it
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        </>
      )}

      {unmanaged.length > 0 && (
        <section className="section-card">
          <div className="monetization-section-head">
            <h2>
              In {store === "apple" ? "App Store Connect" : "Play Console"}, not
              in your file
            </h2>
            <button
              className="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void api
                  .importMonetization(
                    project.id,
                    unmanaged.map((i) => i.key),
                  )
                  .then(setView, (e: Error) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              <Download size={14} /> Import all
            </button>
          </div>
          <p className="muted">
            Importing writes them to {view.file} exactly as the store has them,
            so you can manage them here. Nothing in the store changes.
          </p>
          {unmanaged.map((i) => (
            <div className="monetization-row" key={i.key}>
              <div className="monetization-row-main">
                <strong>{i.label}</strong>
                <span className="mono">
                  {i.key.split(":").slice(2).join(":")} · {i.kind}
                </span>
              </div>
              <div className="monetization-row-price">
                <span>{money(i.price)}</span>
              </div>
              <span className="badge queued">
                {i.state?.replaceAll("_", " ").toLowerCase() ?? "unmanaged"}
              </span>
              <div className="row-actions">
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void api
                      .importMonetization(project.id, [i.key])
                      .then(setView, (e: Error) => setError(e.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  Import
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {view.codes.length > 0 && (
        <section className="section-card">
          <h2>Generated codes</h2>
          <p className="muted">
            Saved on this Mac only. Share them however you hand out codes; they
            aren't in the repository.
          </p>
          {view.codes.map((c) => (
            <div className="monetization-row" key={c.file}>
              <div className="monetization-row-main">
                <strong>{c.key.split(":").slice(2).join(" · ")}</strong>
                <span className="mono">
                  {plural(c.count, "code")} ·{" "}
                  {new Date(c.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="row-actions">
                <button
                  className="button"
                  onClick={() => void api.reveal(c.file)}
                >
                  Show in Finder
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {log.length > 0 && (
        <section className="section-card">
          <h2>Last apply</h2>
          <ul className="monetization-log">
            {log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </section>
      )}
      {error && (
        <p role="alert" className="workflow-error">
          {error}
        </p>
      )}

      {editing?.kind === "apple-app" && <AppleAppEditor {...editorProps} />}
      {editing?.kind === "apple-iap" && (
        <AppleIapEditor
          {...editorProps}
          index={editing.index}
          project={project}
        />
      )}
      {editing?.kind === "apple-group" && (
        <AppleGroupEditor {...editorProps} index={editing.index} />
      )}
      {editing?.kind === "apple-subscription" && (
        <AppleSubscriptionEditor
          {...editorProps}
          group={editing.group}
          index={editing.index}
          project={project}
        />
      )}
      {editing?.kind === "apple-offer" && (
        <AppleOfferEditor {...editorProps} index={editing.index} />
      )}
      {editing?.kind === "google-price" && (
        <GooglePriceEditor {...editorProps} />
      )}
      {editing?.kind === "google-product" && (
        <GoogleProductEditor {...editorProps} index={editing.index} />
      )}
      {editing?.kind === "google-subscription" && (
        <GoogleSubscriptionEditor {...editorProps} index={editing.index} />
      )}
      {editing?.kind === "google-promo" && (
        <GooglePromoEditor {...editorProps} index={editing.index} />
      )}
    </>
  );
}

function Heading({ project, file }: { project: Project; file?: string }) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">PRICES · PURCHASES · CODES</div>
        <h1>Monetization</h1>
        <p>
          Prices, in-app purchases, subscriptions, offer codes and promo codes
          for {project.name}, on the App Store and Google Play. Every change is
          saved in{" "}
          <span className="mono">
            {file ?? "assets/store/monetization.json"}
          </span>{" "}
          so it's reviewed and committed with your code.
        </p>
      </div>
    </div>
  );
}

interface EditorProps {
  config: Config;
  busy: boolean;
  when: When;
  setWhen: (w: When) => void;
  close: () => void;
  save: (config: Config, apply: string[]) => Promise<void>;
  codesFile: string;
}

/** Save choice shared by every editor: the file always, the store now or later. */
function Footer({
  busy,
  when,
  setWhen,
  onSave,
  error,
  label = "Save",
}: {
  busy: boolean;
  when: When;
  setWhen: (w: When) => void;
  onSave: () => void;
  error?: string;
  label?: string;
}) {
  return (
    <>
      {error && (
        <p role="alert" className="workflow-error">
          {error}
        </p>
      )}
      <div
        className="monetization-when segmented"
        role="radiogroup"
        aria-label="When to apply"
      >
        <label className="check-label">
          <input
            type="radio"
            name="when"
            checked={when === "release"}
            onChange={() => setWhen("release")}
          />
          With the next release
        </label>
        <label className="check-label">
          <input
            type="radio"
            name="when"
            checked={when === "now"}
            onChange={() => setWhen("now")}
          />
          Apply to the store now
        </label>
      </div>
      <div className="modal-footer">
        <span className="muted">
          Saved to the monetization file either way.
        </span>
        <button
          className="primary"
          disabled={busy}
          onClick={onSave}
          style={{ marginLeft: "auto" }}
        >
          {busy ? "Saving…" : when === "now" ? `${label} and apply` : label}
        </button>
      </div>
    </>
  );
}
const priceHint =
  "US dollars, such as 0.99. Other territories follow the store's equalized price.";
const validPrice = (v?: string) => !!v && /^\d{1,5}\.\d\d$/.test(v);

function AppleAppEditor({
  config,
  busy,
  when,
  setWhen,
  close,
  save,
}: EditorProps) {
  const [app, setApp] = useState(
    config.apple.app ?? { price: "0.00", territories: "ALL" as const },
  );
  const [error, setError] = useState("");
  return (
    <Dialog
      title="App price and availability"
      subtitle="The app's own price on the App Store."
      close={close}
    >
      <div className="form-grid">
        <Text
          label="US price (0.00 is free)"
          value={app.price}
          hint={priceHint}
          onChange={(price) => setApp({ ...app, price })}
        />
        <Territories
          value={app.territories}
          onChange={(territories) => setApp({ ...app, territories })}
        />
      </div>
      <Footer
        busy={busy}
        when={when}
        setWhen={setWhen}
        error={error}
        onSave={() => {
          if (!validPrice(app.price))
            return setError("Enter a price such as 0.99, or 0.00 for free.");
          const next = clone(config);
          next.apple.app = app;
          void save(next, when === "now" ? ["apple:app"] : []);
        }}
      />
    </Dialog>
  );
}

function ScreenshotPicker({
  project,
  file,
  value,
  onChange,
}: {
  project: Project;
  file: string;
  value?: string;
  onChange: (v?: string) => void;
}) {
  const dir = `${project.path}/${file.split("/").slice(0, -1).join("/")}`;
  return (
    <label className="field">
      <span>Review screenshot</span>
      <div className="row-actions">
        <span className="mono">{value ?? "None"}</span>
        <button
          className="button"
          type="button"
          onClick={() =>
            void api
              .choose({ kind: "file", extensions: ["png", "jpg", "jpeg"] })
              .then((paths: string[]) => {
                if (paths[0]) onChange(relativeTo(dir, paths[0]));
              })
          }
        >
          Choose…
        </button>
      </div>
      <small>
        What App Review sees to find the purchase in your app. Required before
        review.
      </small>
    </label>
  );
}

function AppleIapEditor({
  config,
  busy,
  when,
  setWhen,
  close,
  save,
  index,
  project,
  codesFile,
}: EditorProps & { index?: number; project: Project }) {
  const existing =
    index === undefined ? undefined : config.apple.inAppPurchases[index];
  const [iap, setIap] = useState<AppleIap>(
    existing
      ? clone(existing)
      : {
          productId: `${project.bundleId ?? "com.example.app"}.`,
          type: "CONSUMABLE",
          referenceName: "",
          price: "0.99",
          territories: "ALL",
          localizations: { "en-US": { name: "" } },
        },
  );
  const [error, setError] = useState("");
  return (
    <Dialog
      title={existing ? `Edit ${existing.productId}` : "Add in-app purchase"}
      subtitle="Consumable, non-consumable or non-renewing subscription."
      close={close}
    >
      <div className="form-grid">
        <Text
          label="Product ID"
          value={iap.productId}
          disabled={!!existing}
          hint="Can't change after it's created."
          onChange={(productId) => setIap({ ...iap, productId })}
        />
        <Choice
          label="Type"
          value={iap.type}
          disabled={!!existing}
          options={[
            ["CONSUMABLE", "Consumable"],
            ["NON_CONSUMABLE", "Non-consumable"],
            ["NON_RENEWING_SUBSCRIPTION", "Non-renewing subscription"],
          ]}
          onChange={(type) => setIap({ ...iap, type })}
        />
        <Text
          label="Reference name"
          value={iap.referenceName}
          hint="Only you see this, in App Store Connect."
          onChange={(referenceName) => setIap({ ...iap, referenceName })}
        />
        <Text
          label="US price"
          value={iap.price}
          hint={priceHint}
          onChange={(price) => setIap({ ...iap, price })}
        />
        <Territories
          value={iap.territories}
          onChange={(territories) => setIap({ ...iap, territories })}
        />
      </div>
      <Localized
        value={iap.localizations}
        blank={{ name: "" }}
        fields={[
          ["name", "Display name"],
          ["description", "Description"],
        ]}
        onChange={(localizations) => setIap({ ...iap, localizations })}
      />
      <ScreenshotPicker
        project={project}
        file={codesFile}
        value={iap.reviewScreenshot}
        onChange={(reviewScreenshot) => setIap({ ...iap, reviewScreenshot })}
      />
      <Text
        label="Review notes"
        area
        value={iap.reviewNote}
        onChange={(reviewNote) =>
          setIap({ ...iap, reviewNote: reviewNote || undefined })
        }
      />
      <Check
        label="Family Sharing (can't be turned off later)"
        checked={!!iap.familySharable}
        onChange={(familySharable) => setIap({ ...iap, familySharable })}
      />
      <Footer
        busy={busy}
        when={when}
        setWhen={setWhen}
        error={error}
        onSave={() => {
          if (!iap.productId || iap.productId.endsWith("."))
            return setError("Enter a product ID.");
          if (!iap.referenceName) return setError("Enter a reference name.");
          if (!validPrice(iap.price))
            return setError("Enter a price such as 0.99.");
          if (
            Object.values(iap.localizations).some(
              (l) => (l.name ?? "").length < 2,
            )
          )
            return setError("Every language needs a display name.");
          const next = clone(config);
          if (index === undefined) next.apple.inAppPurchases.push(iap);
          else next.apple.inAppPurchases[index] = iap;
          void save(next, when === "now" ? [`apple:iap:${iap.productId}`] : []);
        }}
      />
    </Dialog>
  );
}

function AppleGroupEditor({
  config,
  busy,
  when,
  setWhen,
  close,
  save,
  index,
}: EditorProps & { index?: number }) {
  const existing =
    index === undefined ? undefined : config.apple.subscriptionGroups[index];
  const [group, setGroup] = useState<AppleGroup>(
    existing
      ? clone(existing)
      : {
          referenceName: "",
          localizations: { "en-US": { name: "" } },
          subscriptions: [],
        },
  );
  const [error, setError] = useState("");
  return (
    <Dialog
      title={
        existing ? `Edit ${existing.referenceName}` : "Add subscription group"
      }
      subtitle="Customers can only have one subscription in a group at a time."
      close={close}
    >
      <Text
        label="Reference name"
        value={group.referenceName}
        disabled={!!existing}
        onChange={(referenceName) => setGroup({ ...group, referenceName })}
      />
      <Localized
        value={group.localizations}
        blank={{ name: "" }}
        fields={[
          ["name", "Group display name"],
          ["customAppName", "App name in subscriptions", "Optional"],
        ]}
        onChange={(localizations) => setGroup({ ...group, localizations })}
      />
      <Footer
        busy={busy}
        when={when}
        setWhen={setWhen}
        error={error}
        onSave={() => {
          if (!group.referenceName) return setError("Enter a reference name.");
          const next = clone(config);
          if (index === undefined) next.apple.subscriptionGroups.push(group);
          else next.apple.subscriptionGroups[index] = group;
          void save(
            next,
            when === "now" ? [`apple:group:${group.referenceName}`] : [],
          );
        }}
      />
    </Dialog>
  );
}

const periods: [AppleSubscription["period"], string][] = [
  ["ONE_WEEK", "1 week"],
  ["ONE_MONTH", "1 month"],
  ["TWO_MONTHS", "2 months"],
  ["THREE_MONTHS", "3 months"],
  ["SIX_MONTHS", "6 months"],
  ["ONE_YEAR", "1 year"],
];
const durations: [NonNullable<AppleOfferCode["duration"]>, string][] = [
  ["THREE_DAYS", "3 days"],
  ["ONE_WEEK", "1 week"],
  ["TWO_WEEKS", "2 weeks"],
  ["ONE_MONTH", "1 month"],
  ["TWO_MONTHS", "2 months"],
  ["THREE_MONTHS", "3 months"],
  ["SIX_MONTHS", "6 months"],
  ["ONE_YEAR", "1 year"],
];
const modes: [NonNullable<AppleOfferCode["mode"]>, string][] = [
  ["FREE_TRIAL", "Free"],
  ["PAY_AS_YOU_GO", "Pay as you go"],
  ["PAY_UP_FRONT", "Pay up front"],
];

function AppleSubscriptionEditor({
  config,
  busy,
  when,
  setWhen,
  close,
  save,
  group,
  index,
  project,
  codesFile,
}: EditorProps & { group?: number; index?: number; project: Project }) {
  const existing =
    group === undefined || index === undefined
      ? undefined
      : config.apple.subscriptionGroups[group]!.subscriptions[index];
  const [groupIndex, setGroupIndex] = useState(group ?? 0);
  const [sub, setSub] = useState<AppleSubscription>(
    existing
      ? clone(existing)
      : {
          productId: `${project.bundleId ?? "com.example.app"}.`,
          referenceName: "",
          period: "ONE_MONTH",
          price: "4.99",
          territories: "ALL",
          localizations: { "en-US": { name: "" } },
        },
  );
  const [error, setError] = useState("");
  const intro = sub.introOffer;
  return (
    <Dialog
      title={existing ? `Edit ${existing.productId}` : "Add subscription"}
      subtitle="An auto-renewing subscription."
      close={close}
    >
      <div className="form-grid">
        <Choice
          label="Group"
          value={String(groupIndex)}
          disabled={!!existing}
          options={config.apple.subscriptionGroups.map((g, i) => [
            String(i),
            g.referenceName,
          ])}
          onChange={(v) => setGroupIndex(Number(v))}
        />
        <Text
          label="Product ID"
          value={sub.productId}
          disabled={!!existing}
          onChange={(productId) => setSub({ ...sub, productId })}
        />
        <Text
          label="Reference name"
          value={sub.referenceName}
          onChange={(referenceName) => setSub({ ...sub, referenceName })}
        />
        <Choice
          label="Renews every"
          value={sub.period}
          options={periods}
          onChange={(period) => setSub({ ...sub, period })}
        />
        <Text
          label="US price per period"
          value={sub.price}
          hint="New price applies to new subscribers; current subscribers keep theirs."
          onChange={(price) => setSub({ ...sub, price })}
        />
        <Text
          label="Level in group"
          value={sub.level === undefined ? "" : String(sub.level)}
          hint="1 is the highest tier."
          onChange={(v) => setSub({ ...sub, level: v ? num(v) : undefined })}
        />
        <Territories
          value={sub.territories}
          onChange={(territories) => setSub({ ...sub, territories })}
        />
      </div>
      <Localized
        value={sub.localizations}
        blank={{ name: "" }}
        fields={[
          ["name", "Display name"],
          ["description", "Description"],
        ]}
        onChange={(localizations) => setSub({ ...sub, localizations })}
      />
      <h3 className="monetization-subhead">Introductory offer</h3>
      <div className="form-grid">
        <Choice
          label="Offer"
          value={intro?.mode ?? "NONE"}
          options={[
            ["NONE", "None"],
            ...modes.map(
              ([v, l]) =>
                [v, v === "FREE_TRIAL" ? "Free trial" : l] as [string, string],
            ),
          ]}
          onChange={(v) =>
            setSub({
              ...sub,
              introOffer:
                v === "NONE"
                  ? undefined
                  : {
                      mode: v as any,
                      duration: intro?.duration ?? "ONE_WEEK",
                      periods: intro?.periods ?? 1,
                      price:
                        v === "FREE_TRIAL"
                          ? undefined
                          : (intro?.price ?? "0.99"),
                    },
            })
          }
        />
        {intro && (
          <Choice
            label="Duration"
            value={intro.duration}
            options={durations}
            onChange={(duration) =>
              setSub({ ...sub, introOffer: { ...intro, duration } })
            }
          />
        )}
        {intro && (
          <Text
            label="Periods"
            value={String(intro.periods)}
            onChange={(v) =>
              setSub({ ...sub, introOffer: { ...intro, periods: num(v) } })
            }
          />
        )}
        {intro && intro.mode !== "FREE_TRIAL" && (
          <Text
            label="US offer price"
            value={intro.price}
            onChange={(price) =>
              setSub({ ...sub, introOffer: { ...intro, price } })
            }
          />
        )}
      </div>
      <ScreenshotPicker
        project={project}
        file={codesFile}
        value={sub.reviewScreenshot}
        onChange={(reviewScreenshot) => setSub({ ...sub, reviewScreenshot })}
      />
      <Text
        label="Review notes"
        area
        value={sub.reviewNote}
        onChange={(reviewNote) =>
          setSub({ ...sub, reviewNote: reviewNote || undefined })
        }
      />
      <Check
        label="Family Sharing (can't be turned off later)"
        checked={!!sub.familySharable}
        onChange={(familySharable) => setSub({ ...sub, familySharable })}
      />
      <Footer
        busy={busy}
        when={when}
        setWhen={setWhen}
        error={error}
        onSave={() => {
          if (!sub.productId || sub.productId.endsWith("."))
            return setError("Enter a product ID.");
          if (!sub.referenceName) return setError("Enter a reference name.");
          if (
            !validPrice(sub.price) ||
            (intro && intro.mode !== "FREE_TRIAL" && !validPrice(intro.price))
          )
            return setError("Enter prices such as 4.99.");
          const next = clone(config);
          const target = next.apple.subscriptionGroups[groupIndex]!;
          if (existing) target.subscriptions[index!] = sub;
          else target.subscriptions.push(sub);
          void save(
            next,
            when === "now"
              ? [
                  `apple:group:${target.referenceName}`,
                  `apple:subscription:${sub.productId}`,
                ]
              : [],
          );
        }}
      />
    </Dialog>
  );
}

const futureDate = (days: number) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

function AppleOfferEditor({
  config,
  busy,
  when,
  setWhen,
  close,
  save,
  index,
}: EditorProps & { index?: number }) {
  const existing =
    index === undefined ? undefined : config.apple.offerCodes[index];
  const subscriptions = config.apple.subscriptionGroups.flatMap(
    (g) => g.subscriptions,
  );
  const products: [string, string][] = [
    ...config.apple.inAppPurchases.map(
      (p) => [p.productId, `${p.productId} (purchase)`] as [string, string],
    ),
    ...subscriptions.map(
      (s) => [s.productId, `${s.productId} (subscription)`] as [string, string],
    ),
  ];
  const [offer, setOffer] = useState<AppleOfferCode>(
    existing
      ? clone(existing)
      : {
          name: "",
          productId: products[0]![0],
          active: true,
          price: "0.00",
          batches: [],
        },
  );
  const [error, setError] = useState("");
  const isSub = subscriptions.some((s) => s.productId === offer.productId);
  const locked = !!existing;
  const eligibility = isSub
    ? [
        ["NEW", "New"],
        ["EXISTING", "Current"],
        ["EXPIRED", "Lapsed"],
      ]
    : [
        ["NON_SPENDER", "Never purchased"],
        ["ACTIVE_SPENDER", "Recent buyers"],
        ["CHURNED_SPENDER", "Past buyers"],
      ];
  const chosen = offer.eligibility ?? eligibility.map(([v]) => v);
  return (
    <Dialog
      title={existing ? `Edit offer ${existing.name}` : "Add offer code"}
      subtitle="Apple doesn't allow changing an offer's terms after it's created; you can turn it off and add code batches."
      close={close}
    >
      <div className="form-grid">
        <Text
          label="Offer name"
          value={offer.name}
          disabled={locked}
          onChange={(name) => setOffer({ ...offer, name })}
        />
        <Choice
          label="Product"
          value={offer.productId}
          disabled={locked}
          options={products}
          onChange={(productId) => {
            const sub = subscriptions.some((s) => s.productId === productId);
            setOffer({
              ...offer,
              productId,
              eligibility: undefined,
              ...(sub
                ? {
                    mode: "FREE_TRIAL",
                    duration: "ONE_MONTH",
                    periods: 1,
                    price: undefined,
                  }
                : {
                    mode: undefined,
                    duration: undefined,
                    periods: undefined,
                    price: "0.00",
                  }),
            });
          }}
        />
        {isSub && (
          <Choice
            label="Offer"
            value={offer.mode}
            disabled={locked}
            options={modes}
            onChange={(mode) =>
              setOffer({
                ...offer,
                mode,
                price:
                  mode === "FREE_TRIAL" ? undefined : (offer.price ?? "0.99"),
              })
            }
          />
        )}
        {isSub && (
          <Choice
            label="Duration"
            value={offer.duration}
            disabled={locked}
            options={durations}
            onChange={(duration) => setOffer({ ...offer, duration })}
          />
        )}
        {isSub && (
          <Text
            label="Periods"
            value={String(offer.periods ?? 1)}
            disabled={locked}
            onChange={(v) => setOffer({ ...offer, periods: num(v) })}
          />
        )}
        {(!isSub || offer.mode !== "FREE_TRIAL") && (
          <Text
            label={
              isSub ? "US price per period" : "US offer price (0.00 is free)"
            }
            value={offer.price}
            disabled={locked}
            onChange={(price) => setOffer({ ...offer, price })}
          />
        )}
      </div>
      <div className="field">
        <span>Who can redeem</span>
        <div className="segmented">
          {eligibility.map(([value, label]) => (
            <Check
              key={value}
              label={label!}
              disabled={locked}
              checked={chosen.includes(value!)}
              onChange={(on) =>
                setOffer({
                  ...offer,
                  eligibility: on
                    ? [...chosen, value!]
                    : chosen.filter((v) => v !== value),
                })
              }
            />
          ))}
        </div>
      </div>
      <Check
        label="Offer is on"
        checked={offer.active}
        onChange={(active) => setOffer({ ...offer, active })}
      />
      <h3 className="monetization-subhead">Code batches</h3>
      {offer.batches.map((b, i) => (
        <div className="monetization-batch" key={i}>
          {b.id ? (
            <span className="muted">
              {b.kind === "custom"
                ? `Custom code ${b.code}`
                : `${b.count} one-time codes`}{" "}
              · {b.expires ? `expires ${b.expires}` : "no expiry"} · created
            </span>
          ) : (
            <div className="form-grid">
              <Choice
                label="Kind"
                value={b.kind}
                options={[
                  ["oneTime", "One-time codes"],
                  ["custom", "Custom code"],
                ]}
                onChange={(kind) =>
                  setOffer({
                    ...offer,
                    batches: offer.batches.map((x, j) =>
                      j === i
                        ? {
                            ...x,
                            kind,
                            code:
                              kind === "custom" ? (x.code ?? "") : undefined,
                          }
                        : x,
                    ),
                  })
                }
              />
              {b.kind === "custom" && (
                <Text
                  label="Code"
                  value={b.code}
                  placeholder="LAUNCH50"
                  onChange={(code) =>
                    setOffer({
                      ...offer,
                      batches: offer.batches.map((x, j) =>
                        j === i ? { ...x, code: code.toUpperCase() } : x,
                      ),
                    })
                  }
                />
              )}
              <Text
                label={
                  b.kind === "custom" ? "Redemption limit" : "Number of codes"
                }
                value={String(b.count)}
                onChange={(v) =>
                  setOffer({
                    ...offer,
                    batches: offer.batches.map((x, j) =>
                      j === i ? { ...x, count: num(v) } : x,
                    ),
                  })
                }
              />
              <Text
                label="Expires (YYYY-MM-DD)"
                value={b.expires}
                onChange={(expires) =>
                  setOffer({
                    ...offer,
                    batches: offer.batches.map((x, j) =>
                      j === i ? { ...x, expires: expires || undefined } : x,
                    ),
                  })
                }
              />
              <Check
                label="Sandbox codes for testing"
                checked={!!b.sandbox}
                onChange={(sandbox) =>
                  setOffer({
                    ...offer,
                    batches: offer.batches.map((x, j) =>
                      j === i ? { ...x, sandbox } : x,
                    ),
                  })
                }
              />
              <button
                className="text-button"
                onClick={() =>
                  setOffer({
                    ...offer,
                    batches: offer.batches.filter((_, j) => j !== i),
                  })
                }
              >
                Remove batch
              </button>
            </div>
          )}
        </div>
      ))}
      <button
        className="text-button"
        onClick={() =>
          setOffer({
            ...offer,
            batches: [
              ...offer.batches,
              { kind: "oneTime", count: 100, expires: futureDate(90) },
            ],
          })
        }
      >
        <Plus size={12} /> Add a batch
      </button>
      <Footer
        busy={busy}
        when={when}
        setWhen={setWhen}
        error={error}
        label="Save offer"
        onSave={() => {
          if (!offer.name) return setError("Enter an offer name.");
          if (offer.batches.some((b) => b.kind === "custom" && !b.code))
            return setError("Custom batches need a code.");
          if (offer.batches.some((b) => b.kind === "oneTime" && !b.expires))
            return setError("One-time codes need an expiry date.");
          const next = clone(config);
          if (index === undefined) next.apple.offerCodes.push(offer);
          else next.apple.offerCodes[index] = offer;
          void save(
            next,
            when === "now"
              ? [`apple:offer:${offer.productId}:${offer.name}`]
              : [],
          );
        }}
      />
    </Dialog>
  );
}

function GooglePriceEditor({ config, busy, close, save }: EditorProps) {
  const [price, setPrice] = useState(config.google.appPrice ?? "0.99");
  const [error, setError] = useState("");
  return (
    <Dialog
      title="Paid app price"
      subtitle="Google has no API for this; Play Console sets it."
      close={close}
    >
      <Text
        label="US price"
        value={price}
        hint="Play converts it for other countries."
        onChange={setPrice}
      />
      {error && (
        <p role="alert" className="workflow-error">
          {error}
        </p>
      )}
      <div className="modal-footer">
        <span className="muted">
          Saved to the file; use Open in Play Console to set it there.
        </span>
        <button
          className="primary"
          style={{ marginLeft: "auto" }}
          disabled={busy}
          onClick={() => {
            if (!validPrice(price))
              return setError("Enter a price such as 2.99.");
            const next = clone(config);
            next.google.appPrice = price;
            void save(next, []);
          }}
        >
          Save
        </button>
      </div>
    </Dialog>
  );
}

const regionText = (r?: Record<string, string>) =>
  Object.entries(r ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
const parseRegions = (v: string) => {
  const entries = v
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split("=").map((x) => x.trim()) as [string, string]);
  return entries.length
    ? Object.fromEntries(entries.map(([k, val]) => [k.toUpperCase(), val]))
    : undefined;
};

function GoogleProductEditor({
  config,
  busy,
  when,
  setWhen,
  close,
  save,
  index,
}: EditorProps & { index?: number }) {
  const existing =
    index === undefined ? undefined : config.google.products[index];
  const [product, setProduct] = useState<GoogleProduct>(
    existing
      ? clone(existing)
      : {
          productId: "",
          price: "0.99",
          active: true,
          listings: { "en-US": { title: "" } },
        },
  );
  const [regions, setRegions] = useState(regionText(existing?.regionalPrices));
  const [error, setError] = useState("");
  return (
    <Dialog
      title={existing ? `Edit ${existing.productId}` : "Add one-time product"}
      subtitle="An in-app product on Google Play."
      close={close}
    >
      <div className="form-grid">
        <Text
          label="Product ID"
          value={product.productId}
          disabled={!!existing}
          hint="Lowercase letters, digits, dots and underscores."
          onChange={(productId) => setProduct({ ...product, productId })}
        />
        <Text
          label="US price"
          value={product.price}
          hint="Play converts it for every other country."
          onChange={(price) => setProduct({ ...product, price })}
        />
      </div>
      <Text
        label="Country price overrides"
        placeholder="JP=160, IN=79"
        value={regions}
        hint="Optional, in each country's currency."
        onChange={setRegions}
      />
      <Localized
        value={product.listings}
        blank={{ title: "" }}
        fields={[
          ["title", "Title"],
          ["description", "Description"],
        ]}
        onChange={(listings) => setProduct({ ...product, listings })}
      />
      <Check
        label="Active (customers can buy it)"
        checked={product.active}
        onChange={(active) => setProduct({ ...product, active })}
      />
      <Footer
        busy={busy}
        when={when}
        setWhen={setWhen}
        error={error}
        onSave={() => {
          if (!/^[a-z0-9][a-z0-9._]*$/.test(product.productId))
            return setError(
              "Enter a product ID with lowercase letters, digits, dots or underscores.",
            );
          if (!validPrice(product.price))
            return setError("Enter a price such as 0.99.");
          if (Object.values(product.listings).some((l) => !l.title))
            return setError("Every language needs a title.");
          const next = clone(config);
          const value = { ...product, regionalPrices: parseRegions(regions) };
          if (index === undefined) next.google.products.push(value);
          else next.google.products[index] = value;
          void save(
            next,
            when === "now" ? [`google:product:${product.productId}`] : [],
          );
        }}
      />
    </Dialog>
  );
}

const googlePeriods: [string, string][] = [
  ["P1W", "Weekly"],
  ["P1M", "Monthly"],
  ["P3M", "Every 3 months"],
  ["P6M", "Every 6 months"],
  ["P1Y", "Yearly"],
];
const phaseDurations: [string, string][] = [
  ["P3D", "3 days"],
  ["P1W", "1 week"],
  ["P2W", "2 weeks"],
  ["P1M", "1 month"],
  ["P3M", "3 months"],
  ["P6M", "6 months"],
  ["P1Y", "1 year"],
];

function GoogleSubscriptionEditor({
  config,
  busy,
  when,
  setWhen,
  close,
  save,
  index,
}: EditorProps & { index?: number }) {
  const existing =
    index === undefined ? undefined : config.google.subscriptions[index];
  const [sub, setSub] = useState<GoogleSubscription>(
    existing
      ? clone(existing)
      : {
          productId: "",
          listings: { "en-US": { title: "" } },
          basePlans: [
            {
              basePlanId: "monthly",
              period: "P1M",
              autoRenewing: true,
              price: "4.99",
              active: true,
              offers: [],
            },
          ],
        },
  );
  const [error, setError] = useState("");
  const plan = (
    i: number,
    patch: Partial<GoogleSubscription["basePlans"][number]>,
  ) =>
    setSub({
      ...sub,
      basePlans: sub.basePlans.map((b, j) =>
        j === i ? { ...b, ...patch } : b,
      ),
    });
  const existed = new Set(existing?.basePlans.map((b) => b.basePlanId));
  return (
    <Dialog
      title={existing ? `Edit ${existing.productId}` : "Add subscription"}
      subtitle="A Play subscription, its base plans and their offers."
      close={close}
    >
      <Text
        label="Product ID"
        value={sub.productId}
        disabled={!!existing}
        onChange={(productId) => setSub({ ...sub, productId })}
      />
      <Localized
        value={sub.listings}
        blank={{ title: "" }}
        fields={[
          ["title", "Title"],
          ["description", "Description"],
          ["benefits", "Benefits", "Comma-separated, up to 4"],
        ]}
        onChange={(listings) => setSub({ ...sub, listings })}
      />
      {sub.basePlans.map((b, i) => (
        <div className="monetization-group" key={i}>
          <h3 className="monetization-subhead">
            Base plan {b.basePlanId || i + 1}
          </h3>
          <div className="form-grid">
            <Text
              label="Base plan ID"
              value={b.basePlanId}
              disabled={existed.has(b.basePlanId)}
              onChange={(basePlanId) => plan(i, { basePlanId })}
            />
            <Choice
              label="Bills"
              value={b.period}
              disabled={existed.has(b.basePlanId)}
              options={googlePeriods}
              onChange={(period) => plan(i, { period })}
            />
            <Text
              label="US price"
              value={b.price}
              onChange={(price) => plan(i, { price })}
            />
            <Choice
              label="Renewal"
              value={b.autoRenewing ? "auto" : "prepaid"}
              disabled={existed.has(b.basePlanId)}
              options={[
                ["auto", "Auto-renewing"],
                ["prepaid", "Prepaid"],
              ]}
              onChange={(v) => plan(i, { autoRenewing: v === "auto" })}
            />
          </div>
          <Check
            label="Active"
            checked={b.active}
            onChange={(active) => plan(i, { active })}
          />
          {b.offers.map((o, oi) => (
            <div className="monetization-batch" key={oi}>
              <div className="form-grid">
                <Text
                  label="Offer ID"
                  value={o.offerId}
                  onChange={(offerId) =>
                    plan(i, {
                      offers: b.offers.map((x, j) =>
                        j === oi ? { ...x, offerId } : x,
                      ),
                    })
                  }
                />
                <Choice
                  label="Who sees it"
                  value={o.eligibility}
                  options={[
                    ["new", "New subscribers"],
                    ["developer", "Chosen by the app"],
                  ]}
                  onChange={(eligibility) =>
                    plan(i, {
                      offers: b.offers.map((x, j) =>
                        j === oi ? { ...x, eligibility } : x,
                      ),
                    })
                  }
                />
                <Choice
                  label="First phase"
                  value={o.phases[0]!.duration}
                  options={phaseDurations}
                  onChange={(duration) =>
                    plan(i, {
                      offers: b.offers.map((x, j) =>
                        j === oi
                          ? { ...x, phases: [{ ...x.phases[0]!, duration }] }
                          : x,
                      ),
                    })
                  }
                />
                <Text
                  label="Phase price (free or USD)"
                  value={o.phases[0]!.price}
                  onChange={(price) =>
                    plan(i, {
                      offers: b.offers.map((x, j) =>
                        j === oi
                          ? {
                              ...x,
                              phases: [
                                {
                                  ...x.phases[0]!,
                                  price: price === "free" ? "free" : price,
                                },
                              ],
                            }
                          : x,
                      ),
                    })
                  }
                />
              </div>
              <Check
                label="Offer active"
                checked={o.active}
                onChange={(active) =>
                  plan(i, {
                    offers: b.offers.map((x, j) =>
                      j === oi ? { ...x, active } : x,
                    ),
                  })
                }
              />
            </div>
          ))}
          <button
            className="text-button"
            onClick={() =>
              plan(i, {
                offers: [
                  ...b.offers,
                  {
                    offerId: "free-trial",
                    eligibility: "new",
                    active: true,
                    phases: [{ duration: "P1W", recurrence: 1, price: "free" }],
                  },
                ],
              })
            }
          >
            <Plus size={12} /> Add an offer, such as a free trial
          </button>
        </div>
      ))}
      <button
        className="text-button"
        onClick={() =>
          setSub({
            ...sub,
            basePlans: [
              ...sub.basePlans,
              {
                basePlanId: "yearly",
                period: "P1Y",
                autoRenewing: true,
                price: "39.99",
                active: true,
                offers: [],
              },
            ],
          })
        }
      >
        <Plus size={12} /> Add a base plan
      </button>
      <Footer
        busy={busy}
        when={when}
        setWhen={setWhen}
        error={error}
        onSave={() => {
          if (!/^[a-z0-9][a-z0-9._]*$/.test(sub.productId))
            return setError(
              "Enter a product ID with lowercase letters, digits, dots or underscores.",
            );
          if (
            sub.basePlans.some(
              (b) => !/^[a-z0-9][a-z0-9-]*$/.test(b.basePlanId),
            )
          )
            return setError(
              "Base plan IDs use lowercase letters, digits and dashes.",
            );
          if (sub.basePlans.some((b) => !validPrice(b.price)))
            return setError("Enter base plan prices such as 4.99.");
          if (
            sub.basePlans.some((b) =>
              b.offers.some((o) =>
                o.phases.some(
                  (p) => p.price !== "free" && !validPrice(p.price),
                ),
              ),
            )
          )
            return setError("Offer prices are free or USD such as 0.99.");
          const next = clone(config);
          if (index === undefined) next.google.subscriptions.push(sub);
          else next.google.subscriptions[index] = sub;
          void save(
            next,
            when === "now" ? [`google:subscription:${sub.productId}`] : [],
          );
        }}
      />
    </Dialog>
  );
}

function GooglePromoEditor({
  config,
  busy,
  close,
  save,
  index,
}: EditorProps & { index?: number }) {
  const existing =
    index === undefined ? undefined : config.google.promoCodes[index];
  const products: [string, string][] = [
    ...config.google.products.map(
      (p) => [p.productId, p.productId] as [string, string],
    ),
    ...config.google.subscriptions.map(
      (s) => [s.productId, `${s.productId} (subscription)`] as [string, string],
    ),
  ];
  const [promo, setPromo] = useState<GooglePromo>(
    existing
      ? clone(existing)
      : {
          name: "",
          productId: products[0]![0],
          kind: "oneTime",
          count: 50,
          start: futureDate(0),
          end: futureDate(30),
        },
  );
  const [error, setError] = useState("");
  const locked = !!existing?.generatedAt;
  return (
    <Dialog
      title={existing ? `Edit ${existing.name}` : "Add promotion"}
      subtitle="Play allows 500 one-time promo codes per quarter across the app's products."
      close={close}
    >
      <div className="form-grid">
        <Text
          label="Promotion name"
          value={promo.name}
          disabled={!!existing}
          onChange={(name) => setPromo({ ...promo, name })}
        />
        <Choice
          label="Product"
          value={promo.productId}
          disabled={locked}
          options={products}
          onChange={(productId) => setPromo({ ...promo, productId })}
        />
        <Choice
          label="Kind"
          value={promo.kind}
          disabled={locked}
          options={[
            ["oneTime", "One-time codes"],
            ["custom", "Custom code"],
          ]}
          onChange={(kind) =>
            setPromo({
              ...promo,
              kind,
              code: kind === "custom" ? (promo.code ?? "") : undefined,
            })
          }
        />
        {promo.kind === "custom" && (
          <Text
            label="Code"
            value={promo.code}
            disabled={locked}
            placeholder="SPRING2027"
            onChange={(code) =>
              setPromo({ ...promo, code: code.toUpperCase() })
            }
          />
        )}
        <Text
          label={
            promo.kind === "custom" ? "Redemption limit" : "Number of codes"
          }
          value={String(promo.count)}
          disabled={locked}
          onChange={(v) => setPromo({ ...promo, count: num(v) })}
        />
        <Text
          label="Starts (YYYY-MM-DD)"
          value={promo.start}
          disabled={locked}
          onChange={(start) => setPromo({ ...promo, start })}
        />
        <Text
          label="Ends (YYYY-MM-DD)"
          value={promo.end}
          disabled={locked}
          onChange={(end) => setPromo({ ...promo, end })}
        />
      </div>
      {error && (
        <p role="alert" className="workflow-error">
          {error}
        </p>
      )}
      <div className="modal-footer">
        <span className="muted">
          Saved to the file; create it in Play Console from the list.
        </span>
        <button
          className="primary"
          style={{ marginLeft: "auto" }}
          disabled={busy || locked}
          onClick={() => {
            if (!promo.name) return setError("Enter a promotion name.");
            if (
              promo.kind === "custom" &&
              !/^[A-Z0-9]{6,20}$/.test(promo.code ?? "")
            )
              return setError("Custom codes are 6–20 letters or digits.");
            if (promo.end < promo.start)
              return setError("The promotion ends before it starts.");
            const next = clone(config);
            if (index === undefined) next.google.promoCodes.push(promo);
            else next.google.promoCodes[index] = promo;
            void save(next, []);
          }}
        >
          Save
        </button>
      </div>
    </Dialog>
  );
}

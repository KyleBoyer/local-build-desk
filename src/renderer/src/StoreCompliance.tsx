import { useEffect, useState } from "react";
import type {
  AgeRating,
  AppPrivacy,
  Compliance,
  Pricing,
} from "../../core/app-store-compliance";
import {
  DATA_TYPES,
  LEVEL_QUESTIONS,
  PURPOSES,
  YES_NO_QUESTIONS,
} from "../../core/app-store-questions";
import type { ComplianceView, Project } from "../../core/types";
const api = window.desk;

// Apple's compliance questions for a project's App Store listing: age rating,
// App Privacy, and price and availability. Answers are saved into the
// project's listing file; attesting records who confirmed exactly these
// answers. `ios-submit listing --apply` sends only attested answers to Apple.

type Level = AgeRating["contests"];
type PrivacyItem = Extract<AppPrivacy, { collected: true }>["data"][number];
const levelKeys = Object.keys(
  LEVEL_QUESTIONS,
) as (keyof typeof LEVEL_QUESTIONS)[];
const yesNoKeys = Object.keys(
  YES_NO_QUESTIONS,
) as (keyof typeof YES_NO_QUESTIONS)[];
const purposeKeys = Object.keys(PURPOSES) as (keyof typeof PURPOSES)[];

export function StoreCompliance({ project }: { project: Project }) {
  const [view, setView] = useState<ComplianceView>();
  const [listing, setListing] = useState("");
  const [rating, setRating] = useState<Partial<AgeRating>>({});
  const [collected, setCollected] = useState<boolean>();
  const [data, setData] = useState<PrivacyItem[]>([]);
  const [pricing, setPricing] = useState<Pricing>({
    price: "0.00",
    territories: "ALL",
  });
  const [territories, setTerritories] = useState("");
  const [name, setName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = (v: ComplianceView) => {
    setView(v);
    setListing(v.listing ?? "");
    const c = v.compliance ?? {};
    setRating(c.ageRating ?? {});
    setCollected(c.appPrivacy?.collected);
    setData(c.appPrivacy?.collected ? c.appPrivacy.data : []);
    if (c.pricing) {
      setPricing(c.pricing);
      setTerritories(
        c.pricing.territories === "ALL" ? "" : c.pricing.territories.join(", "),
      );
    }
    if (c.attestation) setName(c.attestation.name);
    setConfirmed(false);
  };
  useEffect(() => {
    api.readCompliance(project.id).then(load, (e) => setError(e.message));
  }, [project.id]);

  const unanswered =
    levelKeys.filter((k) => !rating[k]).length +
    yesNoKeys.filter((k) => rating[k] === undefined).length;
  const privacyIncomplete =
    collected === undefined ||
    (collected && (!data.length || data.some((d) => !d.purposes.length)));
  const answers = (): Omit<Compliance, "attestation"> => ({
    ageRating: rating as AgeRating,
    appPrivacy: collected ? { collected: true, data } : { collected: false },
    pricing:
      pricing.territories === "ALL"
        ? pricing
        : {
            ...pricing,
            territories: territories
              .split(/[\s,]+/)
              .filter(Boolean)
              .map((t) => t.toUpperCase()),
          },
  });
  const complete = !!listing && !unanswered && !privacyIncomplete;
  // Attest only what was saved and shown as statements.
  const saved = view?.compliance;
  const dirty =
    listing !== (view?.listing ?? "") ||
    JSON.stringify(answers()) !==
      JSON.stringify({
        ageRating: saved?.ageRating,
        appPrivacy: saved?.appPrivacy,
        pricing: saved?.pricing,
      });

  const save = (attest: boolean) => {
    setBusy(true);
    setError("");
    setMessage("");
    api
      .saveCompliance(
        project.id,
        listing,
        answers(),
        attest ? name.trim() : undefined,
      )
      .then((v) => {
        load(v);
        setMessage(
          attest
            ? `Attested by ${name.trim()}. ios-submit listing --apply will send these answers to Apple.`
            : "Saved. Review the statements below and attest before they can be sent to Apple.",
        );
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };

  const item = (type: string) => data.find((d) => d.type === type);
  const setItem = (type: string, change: Partial<PrivacyItem> | null) =>
    setData((all) => {
      const rest = all.filter((d) => d.type !== type);
      if (change === null) return rest;
      const current = all.find((d) => d.type === type) ?? {
        type,
        purposes: [],
        linkedToUser: false,
        usedForTracking: false,
      };
      return [...rest, { ...current, ...change }].sort((a, b) =>
        a.type.localeCompare(b.type),
      );
    });

  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ANSWER · REVIEW · ATTEST</div>
          <h1>App Store compliance</h1>
          <p>
            Apple's age rating, App Privacy and pricing questions for{" "}
            {project.name}. Answers are saved in your listing file and are sent
            to Apple only after you attest to them.
          </p>
        </div>
      </div>
      <section className="section-card">
        <fieldset disabled={busy} className="workflow-fieldset">
          <h2>Listing file</h2>
          <div className="row-actions">
            <span className="mono">{listing || "No listing file chosen"}</span>
            <button
              className="button"
              onClick={() =>
                void api
                  .choose({ kind: "file", extensions: ["json"] })
                  .then((paths: string[]) => {
                    if (paths[0]) {
                      setBusy(true);
                      setError("");
                      void api
                        .readCompliance(project.id, paths[0])
                        .then(load)
                        .catch((e) => setError(e.message))
                        .finally(() => setBusy(false));
                    }
                  })
              }
            >
              Choose listing JSON…
            </button>
          </div>
          <p className="muted">
            The same file `ios-submit listing` reads (for example
            assets/store/en-US/apple-listing.json). Other fields in it are kept.
          </p>
        </fieldset>
      </section>

      <section className="section-card">
        <fieldset disabled={busy} className="workflow-fieldset">
          <h2>Age rating</h2>
          <p className="muted">
            How often does the app show each of these? Answer for everything in
            the app, including content from its servers.
          </p>
          <div className="compliance-grid">
            {levelKeys.map((k) => (
              <label key={k}>
                {LEVEL_QUESTIONS[k]}
                <select
                  aria-label={LEVEL_QUESTIONS[k]}
                  value={rating[k] ?? ""}
                  onChange={(e) =>
                    setRating({ ...rating, [k]: e.target.value as Level })
                  }
                >
                  <option value="">Choose…</option>
                  <option value="NONE">None</option>
                  <option value="INFREQUENT">Infrequent</option>
                  <option value="FREQUENT">Frequent</option>
                </select>
              </label>
            ))}
          </div>
          <p className="muted">Does the app have…</p>
          <div className="compliance-grid">
            {yesNoKeys.map((k) => (
              <label key={k}>
                {YES_NO_QUESTIONS[k]}
                <select
                  aria-label={YES_NO_QUESTIONS[k]}
                  value={
                    rating[k] === undefined ? "" : rating[k] ? "yes" : "no"
                  }
                  onChange={(e) =>
                    setRating({
                      ...rating,
                      [k]:
                        e.target.value === ""
                          ? undefined
                          : e.target.value === "yes",
                    })
                  }
                >
                  <option value="">Choose…</option>
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </select>
              </label>
            ))}
          </div>
          {unanswered > 0 && (
            <p className="muted">{unanswered} question(s) left.</p>
          )}
        </fieldset>
      </section>

      <section className="section-card">
        <fieldset disabled={busy} className="workflow-fieldset">
          <h2>App Privacy</h2>
          <p className="muted">
            Do you or your third-party partners (SDKs, analytics, ad networks)
            collect data from this app? "Collect" means sending it off the
            device where it's kept longer than needed to handle a request.
          </p>
          <div className="compliance-choices">
            <label className="check-label">
              <input
                type="radio"
                name="collected"
                checked={collected === false}
                onChange={() => setCollected(false)}
              />
              No, we don't collect data from this app
            </label>
            <label className="check-label">
              <input
                type="radio"
                name="collected"
                checked={collected === true}
                onChange={() => setCollected(true)}
              />
              Yes, we collect data
            </label>
          </div>
          {collected &&
            Object.entries(DATA_TYPES).map(([group, types]) => (
              <div key={group} className="compliance-group">
                <h3>{group}</h3>
                {Object.entries(types).map(([type, label]) => {
                  const d = item(type);
                  return (
                    <div key={type} className="compliance-type">
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={!!d}
                          onChange={(e) =>
                            setItem(type, e.target.checked ? {} : null)
                          }
                        />
                        {label}
                      </label>
                      {d && (
                        <div className="compliance-detail">
                          <span className="muted">Used for:</span>
                          {purposeKeys.map((p) => (
                            <label key={p} className="check-label">
                              <input
                                type="checkbox"
                                checked={d.purposes.includes(p)}
                                onChange={(e) =>
                                  setItem(type, {
                                    purposes: e.target.checked
                                      ? [...d.purposes, p].sort()
                                      : d.purposes.filter((x) => x !== p),
                                  })
                                }
                              />
                              {PURPOSES[p]}
                            </label>
                          ))}
                          <label className="check-label">
                            <input
                              type="checkbox"
                              checked={d.linkedToUser}
                              onChange={(e) =>
                                setItem(type, {
                                  linkedToUser: e.target.checked,
                                })
                              }
                            />
                            Linked to the user's identity
                          </label>
                          <label className="check-label">
                            <input
                              type="checkbox"
                              checked={d.usedForTracking}
                              onChange={(e) =>
                                setItem(type, {
                                  usedForTracking: e.target.checked,
                                })
                              }
                            />
                            Used to track the user across other companies' apps
                            or websites
                          </label>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          <p className="muted">
            Apple has no public API for App Privacy. Local Build Desk publishes
            these answers through App Store Connect's own web requests in your
            signed-in Apple session, and asks you to sign in if needed.
          </p>
        </fieldset>
      </section>

      <section className="section-card">
        <fieldset disabled={busy} className="workflow-fieldset">
          <h2>Price and availability</h2>
          <div className="form-grid">
            <label>
              US price (USD; 0.00 is free)
              <input
                aria-label="US price"
                value={pricing.price}
                onChange={(e) =>
                  setPricing({ ...pricing, price: e.target.value })
                }
              />
            </label>
            <label>
              Territories
              <select
                aria-label="Territories"
                value={pricing.territories === "ALL" ? "ALL" : "SOME"}
                onChange={(e) =>
                  setPricing({
                    ...pricing,
                    territories: e.target.value === "ALL" ? "ALL" : ["USA"],
                  })
                }
              >
                <option value="ALL">Every territory</option>
                <option value="SOME">Only these…</option>
              </select>
            </label>
            {pricing.territories !== "ALL" && (
              <label>
                Territory codes
                <input
                  aria-label="Territory codes"
                  placeholder="USA, CAN, GBR"
                  value={territories}
                  onChange={(e) => setTerritories(e.target.value)}
                />
              </label>
            )}
          </div>
        </fieldset>
      </section>

      <section className="section-card">
        <fieldset disabled={busy} className="workflow-fieldset">
          <h2>Review and attest</h2>
          {view?.statements?.length ? (
            <ul className="compliance-statements">
              {view.statements.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              Save your answers to see them as statements.
            </p>
          )}
          {view?.compliance?.attestation && (
            <p className={view.attested ? "" : "workflow-error"}>
              {view.attested
                ? `Attested by ${view.compliance.attestation.name} on ${view.compliance.attestation.date}.`
                : "The answers changed since the last attestation. Review and attest again."}
            </p>
          )}
          <div className="row-actions">
            <button
              className="button"
              disabled={!complete}
              onClick={() => save(false)}
            >
              Save answers
            </button>
          </div>
          <label>
            Your name
            <input
              aria-label="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I confirm these answers are accurate and complete for {project.name}
            , including any third-party code it uses, and I'm authorized to
            provide them to Apple.
          </label>
          <div className="row-actions">
            <button
              className="primary"
              disabled={
                !complete || dirty || !confirmed || name.trim().length < 2
              }
              onClick={() => save(true)}
            >
              Attest these answers
            </button>
          </div>
          {dirty && complete && (
            <p className="muted">
              Save your answers to review them before attesting.
            </p>
          )}
          <p className="muted">
            Attesting doesn't contact Apple. `ios-submit listing --apply` sends
            attested answers; it refuses if they were edited afterwards.
          </p>
        </fieldset>
        {error && (
          <p role="alert" className="workflow-error">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
      </section>
    </>
  );
}

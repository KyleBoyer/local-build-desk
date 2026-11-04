import { useEffect, useState } from "react";
import type { DesktopAPI, Job, Project } from "../../core/types";
import type { PurchaseTesting as Config } from "../../core/purchase-test-schema";
const scenarios: Config["scenarios"] = [
  "purchase",
  "restore",
  "refund",
  "failedPayment",
  "renewal",
  "cancellation",
  "expiration",
];
export function PurchaseTesting({
  project,
  onJob,
}: {
  project: Project;
  onJob: (job: Job) => void;
}) {
  const [data, setData] =
    useState<Awaited<ReturnType<DesktopAPI["readPurchaseTesting"]>>>();
  const [platform, setPlatform] = useState<"ios" | "android">(
    project.platforms?.includes("ios") === false ? "android" : "ios",
  );
  const [config, setConfig] = useState<Config>({
    productId: "",
    scenarios: ["purchase"],
    buyIdentifier: "",
    unlockedIdentifier: "",
    lockedIdentifier: "",
    launchArguments: [],
  });
  const [device, setDevice] = useState(""),
    [runtime, setRuntime] = useState("");
  const [targets, setTargets] =
    useState<Awaited<ReturnType<DesktopAPI["checkTargets"]>>>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [command, setCommand] = useState("[]"),
    [args, setArgs] = useState("[]"),
    [profile, setProfile] = useState(
      project.profiles.includes("production")
        ? "production"
        : project.profiles[0],
    );
  useEffect(() => {
    let active = true;
    window.desk.readPurchaseTesting(project.id).then(
      (v) => {
        if (!active) return;
        setData(v);
        if (v.config) {
          setConfig(v.config);
          setArgs(JSON.stringify(v.config.launchArguments));
        } else setConfig((c) => ({ ...c, productId: v.products[0]?.id ?? "" }));
        setCommand(
          JSON.stringify(
            v.policy?.androidBillingCommand ?? v.config?.androidCommand ?? [],
          ),
        );
        setDevice(v.policy?.destinations[0]?.deviceType ?? "");
        setRuntime(v.policy?.destinations[0]?.runtime ?? "");
      },
      (e) => active && setError(e.message),
    );
    return () => {
      active = false;
    };
  }, [project.id]);
  const perform = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (platform === "android")
      await window.desk.saveAndroidPurchaseTesting(
        project.id,
        JSON.parse(command),
      );
    else
      await window.desk.savePurchaseTesting(
        project.id,
        { ...config, launchArguments: JSON.parse(args) },
        { deviceType: device, runtime: runtime || undefined },
      );
    setMessage(
      "Purchase assertions are required before store uploads. Your source project stays unchanged.",
    );
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">VERIFY THE ENTITLEMENT · THEN SHIP</div>
          <h1>Purchase testing</h1>
          <p>
            Exercise the app’s actual purchase and entitlement behavior before
            upload.
          </p>
        </div>
      </div>
      <div
        className="store-channel-tabs"
        role="tablist"
        aria-label="Purchase test platform"
      >
        {(["ios", "android"] as const)
          .filter((p) => !project.platforms || project.platforms.includes(p))
          .map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={platform === p}
              onClick={() => setPlatform(p)}
            >
              {p === "ios" ? "iOS · StoreKit" : "Android · Play Billing"}
            </button>
          ))}
      </div>
      <section className="section-card">
        <fieldset className="workflow-fieldset" disabled={busy}>
          <label>
            Build profile
            <select
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
            >
              {project.profiles.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          {platform === "ios" ? (
            <>
              <h2>App assertions in a disposable StoreKit environment</h2>
              <p className="muted">
                Local products/prices come from the monetization file. Regional
                pricing, offers and receipt servers still need sandbox/device
                checks. Missing UI assertions fail the run; a simulated
                transaction alone never counts as app coverage.
              </p>
              {data && !data.products.length && (
                <p className="store-source-note">
                  Import or add an Apple product in Monetization first.
                </p>
              )}
              <label>
                Product
                <select
                  aria-label="Purchase test product"
                  value={config.productId}
                  onChange={(e) =>
                    setConfig({ ...config, productId: e.target.value })
                  }
                >
                  {data?.products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.id}
                    </option>
                  ))}
                </select>
              </label>
              <div className="form-grid">
                {(
                  [
                    "buyIdentifier",
                    "unlockedIdentifier",
                    "lockedIdentifier",
                    "restoreIdentifier",
                    "failureIdentifier",
                  ] as const
                ).map((key) => (
                  <label key={key}>
                    {
                      {
                        buyIdentifier: "Purchase button identifier",
                        unlockedIdentifier: "Unlocked UI identifier",
                        lockedIdentifier: "Locked UI identifier",
                        restoreIdentifier: "Restore button identifier",
                        failureIdentifier: "Payment error identifier",
                      }[key]
                    }
                    <input
                      aria-label={key}
                      value={config[key] ?? ""}
                      onChange={(e) =>
                        setConfig({ ...config, [key]: e.target.value })
                      }
                    />
                  </label>
                ))}
              </div>
              <div className="purchase-scenarios">
                {scenarios.map((s) => (
                  <label className="check-label" key={s}>
                    <input
                      type="checkbox"
                      checked={config.scenarios.includes(s)}
                      disabled={
                        ["renewal", "cancellation", "expiration"].includes(s) &&
                        !data?.products.find((p) => p.id === config.productId)
                          ?.subscription
                      }
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          scenarios: e.target.checked
                            ? [...config.scenarios, s]
                            : config.scenarios.filter((v) => v !== s),
                        })
                      }
                    />
                    {s.replace(/([a-z])([A-Z])/g, "$1 $2")}
                  </label>
                ))}
              </div>
              <label>
                App launch arguments (JSON array)
                <input
                  aria-label="Purchase launch arguments"
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                />
              </label>
              <button
                className="button"
                onClick={() =>
                  void perform(async () =>
                    setTargets(await window.desk.checkTargets(project.id)),
                  )
                }
              >
                Discover purchase-test simulators
              </button>
              <div className="form-grid">
                <label>
                  Simulator device
                  <input
                    aria-label="Purchase simulator"
                    list="purchase-devices"
                    value={device}
                    onChange={(e) => setDevice(e.target.value)}
                  />
                  <datalist id="purchase-devices">
                    {targets?.devices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </datalist>
                </label>
                <label>
                  Runtime (optional)
                  <input
                    list="purchase-runtimes"
                    value={runtime}
                    onChange={(e) => setRuntime(e.target.value)}
                  />
                  <datalist id="purchase-runtimes">
                    {targets?.runtimes.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </datalist>
                </label>
              </div>
              <button
                className="button"
                disabled={!config.productId}
                onClick={() =>
                  void perform(async () =>
                    window.desk.reveal(
                      await window.desk.exportPurchaseConfiguration(project.id),
                    ),
                  )
                }
              >
                Export StoreKit configuration
              </button>
            </>
          ) : (
            <>
              <h2>Project-owned Android billing suite</h2>
              <p className="muted">
                Runs in the isolated snapshot and uses your app’s real billing
                assertions. Configure license testers and a Play-enabled test
                device first. Test-track membership alone does not provide test
                payment methods.
              </p>
              <p className="mono">
                Catalog:{" "}
                {data?.googleProducts.join(", ") ||
                  "Import Play products in Monetization"}
              </p>
              <label>
                Billing test command (JSON array)
                <textarea
                  aria-label="Android billing test command"
                  rows={4}
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder={'["npm", "run", "test:billing"]'}
                />
              </label>
              <div className="row-actions">
                <button
                  className="button"
                  onClick={() =>
                    void window.desk.openStoreConsole(project.id, "license")
                  }
                >
                  Set up license testers
                </button>
                <button
                  className="button"
                  onClick={() =>
                    void window.desk.openExternal(
                      "https://developer.android.com/google/play/billing/test",
                    )
                  }
                >
                  Play Billing Lab & test scenarios
                </button>
              </div>
            </>
          )}
          <div className="row-actions">
            <button className="primary" onClick={() => void perform(save)}>
              Save required purchase checks
            </button>
            <button
              className="button"
              onClick={() =>
                void perform(async () => {
                  await save();
                  const [job] = await window.desk.runChecks(
                    project.id,
                    profile,
                    "tests",
                    platform,
                  );
                  onJob(job);
                })
              }
            >
              Run {platform === "ios" ? "iOS purchase" : "Android billing"}{" "}
              checks
            </button>
          </div>
        </fieldset>
        {busy && (
          <p role="status">
            Preparing the purchase workflow. Simulator discovery can take a
            minute…
          </p>
        )}
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

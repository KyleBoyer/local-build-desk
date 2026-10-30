import { useEffect, useState } from "react";
import {
  Smartphone,
  QrCode,
  Copy,
  RefreshCw,
  LockKeyhole,
  Radio,
  Trash2,
} from "lucide-react";
import type {
  MonitorConfig,
  MonitorStatus,
  MonitorPairing,
} from "../../mobile/types";
const api = window.desk;
export function MobilePreferences() {
  const [status, setStatus] = useState<MonitorStatus>(),
    [config, setConfig] = useState<MonitorConfig>(),
    [pair, setPair] = useState<MonitorPairing>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [cert, setCert] = useState(""),
    [key, setKey] = useState(""),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api
        .mobileStatus()
        .then((value) => {
          if (!alive) return;
          setStatus(value);
          setConfig(
            (previous) =>
              previous ?? {
                ...value.config,
                host:
                  !value.config.enabled &&
                  value.config.host === "127.0.0.1" &&
                  !value.config.publicOrigin
                    ? (value.interfaces.find((i) => i.address !== "127.0.0.1")
                        ?.address ?? value.config.host)
                    : value.config.host,
              },
          );
        })
        .catch((error) => {
          if (alive) setError(error.message);
        });
    void refresh();
    const remove = api.onEvent((event) => {
      if (event.type === "monitor") void refresh();
    });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      remove();
      clearInterval(timer);
    };
  }, []);
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const apply = async (enabled: boolean) => {
    if (!config) return;
    if (enabled && config.tls === "custom" && !!cert !== !!key)
      throw new Error(
        "Select both the PEM certificate and its matching private key.",
      );
    setPair(undefined);
    const result = await api.configureMobileMonitor(
      { ...config, enabled },
      config.tls === "custom" && cert && key
        ? { certificatePath: cert, keyPath: key }
        : undefined,
    );
    setStatus(result);
    setConfig(result.config);
    if (result.running && enabled) setPair(await api.mobilePairing());
  };
  const remaining = pair
    ? Math.max(0, Math.ceil((Date.parse(pair.expiresAt) - now) / 1000))
    : 0;
  return (
    <section
      className="section-card mobile-preferences"
      aria-label="Mobile monitoring"
    >
      <div className="section-heading">
        <div>
          <Smartphone size={18} />
          <h2>Mobile monitoring</h2>
        </div>
        <span
          className={`monitor-desktop-status ${status?.running ? "online" : ""}`}
        >
          <Radio size={13} />
          {status?.running ? `${status.clients} connected` : "Stopped"}
        </span>
      </div>
      <p className="muted">
        Watch builds, logs, test results and store submissions from your phone.
        The dashboard keeps running in the menu bar when you close this window,
        including for CLI builds.
      </p>
      <div className="mobile-settings-layout">
        <fieldset className="workflow-fieldset" disabled={busy || !config}>
          <div className="form-grid">
            <label>
              Listen address
              <select
                value={config?.host ?? "127.0.0.1"}
                onChange={(event) =>
                  setConfig(
                    (previous) =>
                      previous && {
                        ...previous,
                        host: event.target.value,
                        publicOrigin:
                          event.target.value === "127.0.0.1"
                            ? previous.publicOrigin
                            : undefined,
                      },
                  )
                }
              >
                {config &&
                  !status?.interfaces.some(
                    (i) => i.address === config.host,
                  ) && (
                    <option value={config.host}>
                      {config.host} · unavailable
                    </option>
                  )}
                {status?.interfaces.map((i) => (
                  <option key={i.address} value={i.address}>
                    {i.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Port
              <input
                type="number"
                min={1024}
                max={65535}
                value={config?.port ?? 43178}
                onChange={(event) =>
                  setConfig(
                    (previous) =>
                      previous && {
                        ...previous,
                        port: Number(event.target.value),
                      },
                  )
                }
              />
            </label>
          </div>
          <label>
            Connection security
            <select
              value={config?.tls ?? "self-signed"}
              onChange={(event) =>
                setConfig(
                  (previous) =>
                    previous && {
                      ...previous,
                      tls: event.target.value as MonitorConfig["tls"],
                    },
                )
              }
            >
              <option value="self-signed">
                HTTPS · self-signed on this Mac (default)
              </option>
              <option value="custom">HTTPS · your certificate</option>
              <option value="off">
                HTTP · trusted network / HTTPS reverse proxy
              </option>
            </select>
          </label>
          {config?.tls === "custom" && (
            <div className="monitor-certificate-files">
              <button
                className="button"
                onClick={() =>
                  void perform(async () => {
                    const files = await api.choose({
                      kind: "file",
                      extensions: ["pem", "crt", "cer"],
                    });
                    if (files[0]) setCert(files[0]);
                  })
                }
              >
                {cert ? "Certificate selected" : "Choose PEM certificate"}
              </button>
              <button
                className="button"
                onClick={() =>
                  void perform(async () => {
                    const files = await api.choose({
                      kind: "file",
                      extensions: ["pem", "key"],
                    });
                    if (files[0]) setKey(files[0]);
                  })
                }
              >
                {key ? "Private key selected" : "Choose PEM private key"}
              </button>
              <small className="muted">
                Imported keys are encrypted with macOS Keychain. The certificate
                must cover the selected IP address.
              </small>
            </div>
          )}
          {config?.host === "127.0.0.1" && (
            <label>
              HTTPS reverse-proxy origin (optional)
              <input
                placeholder="https://your-mac.your-tailnet.ts.net"
                value={config.publicOrigin ?? ""}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    publicOrigin: event.target.value || undefined,
                  })
                }
              />
              <span className="muted">
                For a proxy such as Tailscale Serve. Leave blank for direct
                local access.
              </span>
            </label>
          )}
          <div className="row-actions">
            <button
              className="primary"
              onClick={() => void perform(() => apply(true))}
            >
              <Radio size={14} />
              {status?.running ? "Apply & restart" : "Start mobile monitor"}
            </button>
            <button
              className="button"
              disabled={!status?.config.enabled}
              onClick={() => void perform(() => apply(false))}
            >
              Stop monitor
            </button>
          </div>
        </fieldset>
        <div className="monitor-pairing-panel">
          {status?.running ? (
            <>
              <div className="monitor-url">
                <LockKeyhole size={15} />
                <span className="mono">{status.url}</span>
                <button
                  className="icon-button"
                  aria-label="Copy dashboard address"
                  onClick={() => void perform(() => api.copyMobileLink())}
                >
                  <Copy size={15} />
                </button>
              </div>
              {pair && remaining > 0 ? (
                <>
                  <img
                    className="monitor-qr"
                    src={pair.qrDataUrl}
                    alt="Scan to pair this phone with Local Build Desk"
                  />
                  <div
                    className="monitor-pair-code"
                    aria-label="Phone pairing code"
                  >
                    {pair.code}
                  </div>
                  <p className="muted">
                    Scan with your phone's camera, or open the address and enter
                    this code. One use · expires in {Math.floor(remaining / 60)}
                    :{String(remaining % 60).padStart(2, "0")}.
                  </p>
                </>
              ) : (
                <div className="monitor-qr-empty">
                  <QrCode size={42} />
                  <p>
                    {pair
                      ? "This pairing code expired."
                      : "Pair a phone to open the dashboard."}
                  </p>
                </div>
              )}
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  void perform(async () => setPair(await api.mobilePairing()))
                }
              >
                <RefreshCw size={14} />
                New pairing code
              </button>
            </>
          ) : (
            <div className="monitor-qr-empty">
              <Smartphone size={44} />
              <p>Start the monitor, then scan its pairing QR code.</p>
            </div>
          )}
        </div>
      </div>
      {busy && (
        <p role="status" className="muted">
          Preparing the monitor. Generating a new HTTPS certificate can take a
          few seconds…
        </p>
      )}
      {(error || status?.error) && (
        <p role="alert" className="inline-error">
          {error || status?.error}
        </p>
      )}
      {status?.certificate && (
        <details className="workflow-details">
          <summary>
            <LockKeyhole size={13} />
            HTTPS certificate ·{" "}
            {status.certificate.selfSigned ? "self-signed" : "custom"}
          </summary>
          <p className="muted">
            On your phone's first visit, verify this SHA-256 fingerprint before
            trusting the certificate. A self-signed certificate is local to this
            Mac; it is not issued by Apple.
          </p>
          <code className="monitor-fingerprint">
            {status.certificate.fingerprint}
          </code>
          <p className="muted">
            Expires{" "}
            {new Date(status.certificate.expiresAt).toLocaleDateString()} ·
            private key encrypted in Keychain.
          </p>
        </details>
      )}
      <div className="section-heading monitor-devices-heading">
        <h3>Paired devices</h3>
        <span className="mono subtle">{status?.devices.length ?? 0} / 20</span>
      </div>
      {!status?.devices.length ? (
        <p className="muted">
          No devices paired yet. Pairing gives access to this Mac's monitoring
          data; build and signing controls stay in the desktop app.
        </p>
      ) : (
        <div className="monitor-device-list">
          {status.devices.map((device) => (
            <div key={device.id}>
              <div>
                <strong>{device.name}</strong>
                <span>
                  Last seen {new Date(device.lastSeenAt).toLocaleString()}
                </span>
              </div>
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  void perform(async () =>
                    setStatus(await api.revokeMobileDevice(device.id)),
                  )
                }
              >
                <Trash2 size={13} />
                Forget
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

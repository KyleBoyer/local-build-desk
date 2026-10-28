import { WorkProgress } from "./WorkProgress";
import { useState, useEffect } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileKey2,
  FolderOpen,
  KeyRound,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Undo2,
} from "lucide-react";
import type { AccountSetupState } from "../../core/types";
const api = window.desk;
export function AccountSetup() {
  const [state, setState] = useState<AccountSetupState>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const refresh = () =>
      api
        .accountState()
        .then(setState)
        .catch((e) => setError(e.message));
    void refresh();
    return api.onEvent(() => void refresh());
  }, []);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      setState(await api.accountState());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const update = (
    key: "label" | "issuerId" | "teamId" | "keyId",
    value: string,
  ) => {
    if (!state) return;
    setState({ ...state, [key]: value });
    void api.updateAccountSetup({ [key]: value });
  };
  const choose = () =>
    action(async () => {
      const paths = await api.choose({
        kind: "file",
        extensions: state?.provider === "apple" ? ["p8"] : ["json"],
      });
      if (paths[0]) {
        const keyId = paths[0].match(/AuthKey_([A-Za-z0-9]+)\.p8$/)?.[1];
        await api.updateAccountSetup({
          downloadedFile: paths[0],
          ...(keyId ? { keyId } : {}),
        });
      }
    });
  if (!state)
    return (
      <div className="account-loading">
        <LoaderCircle className="spin" />
        Opening account setup…{error}
      </div>
    );
  return (
    <div className="account-shell">
      <header className="account-toolbar">
        <div>
          <Layers3 size={19} />
          <strong>Local Build Desk</strong>
          <span>
            {state.provider === "apple" ? "Apple" : "Google"} account setup
          </span>
        </div>
        <div>
          <button
            aria-label="Go back"
            onClick={() => void action(() => api.accountNavigate("back"))}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            aria-label="Reload account page"
            onClick={() => void action(() => api.accountNavigate("reload"))}
          >
            <RefreshCw size={15} />
          </button>
          <span className="account-origin">
            <LockKeyhole size={11} />
            {new URL(state.url).hostname || "Local toolchain"}
          </span>
          <button
            className="account-return"
            onClick={() => void api.closeAccountSetup()}
          >
            Return to Guided setup
            <ChevronRight size={14} />
          </button>
        </div>
      </header>
      <aside className="account-guide">
        <span className="eyebrow">
          {state.purpose === "xcode"
            ? `AUTOMATIC XCODE · iOS ${state.requiredSdk}`
            : state.purpose === "store"
              ? "AUTOMATIC STORE SETUP"
              : "AUTOMATIC ACCOUNT SETUP"}
        </span>
        <h1>
          {state.status === "complete"
            ? state.purpose === "xcode"
              ? "Your toolchain is ready."
              : state.purpose === "store"
                ? "Store setup ready."
                : "You’re connected."
            : state.status === "needs-input"
              ? "Your turn for a moment."
              : "We’ll take it from here."}
        </h1>
        <div className={`account-status ${state.status}`}>
          {state.status === "working" ? (
            <LoaderCircle className="spin" size={18} />
          ) : state.status === "complete" ? (
            <CheckCircle2 size={18} />
          ) : (
            <CircleAlert size={18} />
          )}
          <p>{state.message}</p>
        </div>
        {state.status === "working" && (
          <WorkProgress
            progress={state.progress}
            startedAt={state.progress?.startedAt ?? state.activityStartedAt}
            label={
              state.purpose === "xcode"
                ? "Preparing Xcode"
                : "Working with your account"
            }
            note="This step can take a few minutes. We’ll show the window if your input is needed."
          />
        )}
        <label className="account-hide">
          <input
            type="checkbox"
            checked={state.hideWhenWorking}
            onChange={(e) =>
              void api.updateAccountSetup({ hideWhenWorking: e.target.checked })
            }
          />
          Hide this window while automation works
        </label>
        <p className="account-privacy">
          We show this window whenever your input is needed or automation times
          out. Passwords and MFA codes stay in the provider’s page.
        </p>
        {state.storeSetup && (
          <div className="google-account-controls">
            <strong>{state.storeSetup.appName}</strong>
            <code>{state.storeSetup.identity}</code>
            <p>
              {state.storeSetup.mode === "bootstrap"
                ? "Internal testing · draft only"
                : state.storeSetup.mode === "capabilities"
                  ? "Apple capability assignments"
                  : "Store app record"}
            </p>
            {state.storeSetup.artifact && (
              <p>
                {state.storeSetup.artifact.name} · version{" "}
                {state.storeSetup.artifact.buildNumber}
                <small>SHA-256: {state.storeSetup.artifact.sha256}</small>
              </p>
            )}
            {state.storeSetup.identifiers?.map((id) => (
              <code key={id}>{id}</code>
            ))}
            {state.storeSetup.rejection && (
              <StoreNameRetry
                key={state.storeSetup.rejection}
                current={state.storeSetup.appName}
                provider={state.provider}
                rejection={state.storeSetup.rejection}
                busy={busy}
                retry={(name) =>
                  void action(() =>
                    api.updateAccountSetup({ storeAppName: name }),
                  )
                }
              />
            )}
            {state.storeSetup.approval && (
              <div className="account-approval">
                <strong>{state.storeSetup.approval.title}</strong>
                <p>{state.storeSetup.approval.detail}</p>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void action(() => api.approveStoreSetup())}
                >
                  Approve {state.storeSetup.approval.title.toLowerCase()}
                </button>
              </div>
            )}
          </div>
        )}
        {state.provider === "google" && state.google && (
          <GoogleSetupControls state={state} busy={busy} action={action} />
        )}
        {state.approvalRequired && (
          <div className="account-approval">
            <strong>Approve new security access</strong>
            <p>
              This creates a persistent Apple team API key with Admin access,
              including certificates and provisioning. It is stored encrypted on
              your Mac.
            </p>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void action(() => api.approveAccountKey())}
            >
              <ShieldCheck size={14} />
              Generate this Admin API key
            </button>
          </div>
        )}
        {state.xcodeLicenseRequired && (
          <div className="account-approval">
            <strong>Xcode and Apple SDKs Agreement</strong>
            <details>
              <summary>Review the license</summary>
              <pre
                style={{
                  maxHeight: 260,
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  fontSize: 11,
                }}
              >
                {state.xcodeLicenseText}
              </pre>
            </details>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void action(() => api.approveXcodeLicense())}
            >
              Accept license & finish Xcode setup
            </button>
          </div>
        )}
        {state.purpose !== "xcode" && state.purpose !== "store" && (
          <div className="account-shortcuts">
            {state.provider === "apple" ? (
              <>
                <button
                  onClick={() =>
                    void action(() => api.accountNavigate("apple-api"))
                  }
                >
                  API access & team keys
                  <ArrowUpRight size={12} />
                </button>
                <button
                  onClick={() =>
                    void action(() => api.accountNavigate("apple-team"))
                  }
                >
                  Developer membership & Team ID
                  <ArrowUpRight size={12} />
                </button>
                <button
                  onClick={() =>
                    void action(() => api.accountNavigate("apple-enroll"))
                  }
                >
                  Apple Developer enrollment
                  <ArrowUpRight size={12} />
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() =>
                    void action(() => api.accountNavigate("google-cloud"))
                  }
                >
                  Google Cloud service accounts
                  <ArrowUpRight size={12} />
                </button>
                <button
                  onClick={() =>
                    void action(() => api.accountNavigate("google-play"))
                  }
                >
                  Play Console app permissions
                  <ArrowUpRight size={12} />
                </button>
              </>
            )}
          </div>
        )}
        {state.purpose !== "xcode" &&
          state.purpose !== "store" &&
          state.status !== "complete" && (
            <details
              className="account-key-details"
              open={!!state.downloadedFile}
            >
              <summary>
                <FileKey2 size={14} />
                Key details & manual fallback
              </summary>
              <label className="field">
                <span>Connection name</span>
                <input
                  value={state.label}
                  onChange={(e) => update("label", e.target.value)}
                />
              </label>
              {state.provider === "apple" && (
                <>
                  <label className="field">
                    <span>Key ID</span>
                    <input
                      value={state.keyId}
                      onChange={(e) => update("keyId", e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Issuer ID</span>
                    <input
                      value={state.issuerId}
                      onChange={(e) => update("issuerId", e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Developer Team ID</span>
                    <input
                      value={state.teamId}
                      onChange={(e) => update("teamId", e.target.value)}
                    />
                  </label>
                </>
              )}
              <button className="file-picker" onClick={() => void choose()}>
                <FolderOpen size={14} />
                <span>
                  {state.downloadedFile?.split("/").at(-1) ??
                    "Choose an existing private key…"}
                </span>
              </button>
              <button
                className="primary account-save"
                disabled={busy || !state.downloadedFile}
                onClick={() => void action(() => api.completeAccountSetup())}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <KeyRound size={14} />
                )}
                Connect & verify
              </button>
            </details>
          )}
        {!!error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="account-diagnostics">
          <button
            className="text-button"
            onClick={() => void action(() => api.revealAccountDiagnostics())}
          >
            <FolderOpen size={13} />
            Open redacted diagnostics
          </button>
          <button
            className="text-button"
            onClick={() => void action(() => api.retryAccountAutomation())}
          >
            <RefreshCw size={13} />
            Retry automation
          </button>
          <p>
            Navigation, network status, JS failures, and sanitized page fixtures
            are captured locally. Authentication secrets are excluded.
          </p>
        </div>
        <div className="account-activity">
          <strong>SETUP ACTIVITY</strong>
          {state.events.map((event, i) => (
            <p key={i}>{event}</p>
          ))}
        </div>
      </aside>
    </div>
  );
}

function GoogleSetupControls({
  state,
  busy,
  action,
}: {
  state: AccountSetupState;
  busy: boolean;
  action: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const google = state.google!;
  const [cloudProject, setCloudProject] = useState(google.cloudProject),
    [createProject, setCreateProject] = useState(!!google.createProject),
    [developerId, setDeveloperId] = useState(google.developerId ?? "");
  useEffect(() => setCloudProject(google.cloudProject), [google.cloudProject]);
  useEffect(
    () => setDeveloperId(google.developerId ?? ""),
    [google.developerId],
  );
  return (
    <div className="google-account-controls">
      <ol className="google-setup-stages" aria-label="Google setup stages">
        <li
          data-done={
            google.createProject
              ? (google.apiIndex ?? 0) > 0
              : !!google.cloudProject
          }
        >
          Cloud project
        </li>
        <li
          data-done={
            (google.apiIndex ?? 0) >= 2 || !!google.pendingCredentialId
          }
        >
          Publisher & IAM APIs
        </li>
        <li data-done={!!google.pendingCredentialId}>
          Encrypted service-account key
        </li>
        <li data-done={state.status === "complete"}>
          App access in Google Play
        </li>
      </ol>
      {google.email && (
        <p className="google-service-email">
          <strong>Service account</strong>
          <code>{google.email}</code>
        </p>
      )}
      {google.approval && (
        <div className="account-approval">
          <strong>
            {google.approval === "cloud"
              ? "Approve Cloud credentials"
              : "Approve Play app access"}
          </strong>
          <p>
            {google.approval === "cloud"
              ? `${google.createProject ? "Create the Cloud project, enable" : "Enable"} the Publisher and IAM APIs, create or reuse the service account in ${google.cloudProject}, and generate one JSON key for encrypted storage on this Mac.`
              : "Grant the displayed service account read access and testing-release access for this app. Account-wide, production, financial, and user-management access remain unselected."}
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void action(() => api.approveGoogleSetup())}
          >
            <ShieldCheck size={14} />
            {google.approval === "cloud"
              ? "Approve service account & key"
              : "Approve this app’s testing access"}
          </button>
        </div>
      )}
      <details className="account-key-details" open={!google.cloudProject}>
        <summary>Cloud project & setup options</summary>
        <label className="field">
          <span>Google Cloud project ID</span>
          <input
            value={cloudProject}
            onChange={(event) => setCloudProject(event.target.value)}
            placeholder="my-app-builds"
          />
        </label>
        <label className="account-hide">
          <input
            type="checkbox"
            checked={createProject}
            onChange={(event) => setCreateProject(event.target.checked)}
          />
          Create a new Cloud project
        </label>
        <button
          className="button"
          disabled={
            busy ||
            !cloudProject ||
            !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(cloudProject)
          }
          onClick={() =>
            void action(() =>
              api.updateAccountSetup({
                googleCloudProject: cloudProject,
                googleCreateProject: createProject,
                googleStartSetup: true,
              }),
            )
          }
        >
          Start guided Google setup
        </button>
        <p className="subtle">
          The saved connection stays selected until this one verifies. Existing
          keys are preserved.
        </p>
        <label className="field">
          <span>Play developer account ID (optional)</span>
          <input
            value={developerId}
            inputMode="numeric"
            onChange={(event) =>
              setDeveloperId(event.target.value.replace(/\D/g, ""))
            }
          />
        </label>
        <button
          className="text-button"
          disabled={busy || !developerId}
          onClick={() =>
            void action(() =>
              api.updateAccountSetup({ googleDeveloperId: developerId }),
            )
          }
        >
          Use this Play account
        </button>
        <button
          className="text-button"
          disabled={busy || !google.pendingCredentialId}
          onClick={() =>
            void action(async () => {
              await api.updateAccountSetup({ googleRequestNewPlayApp: true });
              await api.accountNavigate("google-play");
            })
          }
        >
          Prepare a new Play app record
        </button>
      </details>
    </div>
  );
}

function StoreNameRetry(props: {
  current: string;
  provider: AccountSetupState["provider"];
  rejection: string;
  busy: boolean;
  retry: (name: string) => void;
}) {
  const [name, setName] = useState(props.current);
  const limit = props.provider === "apple" ? 30 : 50,
    trimmed = name.trim();
  return (
    <div className="account-approval">
      <strong>Choose another store app name</strong>
      <p>{props.rejection}</p>
      <label className="field">
        <span>Store app name</span>
        <input
          value={name}
          maxLength={limit}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <button
        className="primary"
        disabled={props.busy || !trimmed || trimmed === props.current}
        onClick={() => props.retry(trimmed)}
      >
        Retry with this name
      </button>
    </div>
  );
}

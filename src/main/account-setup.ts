import {
  inspectStorePage,
  performStoreAction,
  type StoreAction,
  type StoreProbe,
} from "./store-automation";
import { storeScope } from "../core/store-scope";
import type { StoreSetupRequest, StoreSetupState } from "../core/types";
import {
  BrowserWindow,
  WebContentsView,
  session,
  type WebContents,
} from "electron";
import { join, basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { chmod } from "node:fs/promises";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { AccountDiagnostics } from "./account-diagnostics";
import { Engine } from "../core/engine";
import { invariant, messageOf } from "../core/errors";
import type {
  AccountSetupState,
  AccountProvider,
  Project,
  DeskEvent,
} from "../core/types";
import {
  inspectApplePage,
  performAppleAction,
  type AccountProbe,
} from "./account-automation";
import {
  inspectGooglePage,
  matchesGoogleServiceRoute,
  performGoogleAction,
  type GoogleTarget,
  type GoogleProbe,
  type GoogleActionType,
  type GoogleActionResult,
} from "./google-automation";
import { startXcodeDownload } from "./xcode-automation";
import { shouldRetryGoogleKeyActivation } from "./google-key-activation";
import { sdkAtLeast } from "../core/xcode-toolchain";
import { toolProgress } from "../core/progress";
interface AccountSession {
  host: BrowserWindow;
  view: WebContentsView;
  state: AccountSetupState;
  timer: NodeJS.Timeout;
  lastPhase?: string;
  phaseSince: number;
  busy: boolean;
  approvedKey: boolean;
  attempts: Record<string, number>;
  lastConnectFingerprint?: string;
  downloadInProgress?: boolean;
  diagnostics: AccountDiagnostics;
  progressPath: string;
  lastProbe?: string;
  pendingAction?: { type: string; started: number; expected: string[] };
  xcodeFailed?: boolean;
  googleLastVerify?: number;
  googleLastError?: string;
  googleBlocked?: boolean;
  storeApprovalScope?: string;
  storeVerifyAt?: number;
  storeVerifyFailures?: number;
  storeVerificationPaused?: boolean;
  storeWaitForPermissions?: boolean;
  storeLastAction?: { fingerprint: string; time: number };
  googleTokenVerified?: string;
  googleSelectedAppScope?: string;
  googlePreparedAppScope?: string;
  googleLastTokenCheck?: number;
}
export class AccountSetupManager {
  private accounts = new Map<number, AccountSession>();
  constructor(
    private engine: Engine,
    private parent: () => BrowserWindow | undefined,
    private options: { hidden?: boolean } = {},
  ) {}
  owns(sender: WebContents) {
    return this.accounts.has(sender.id);
  }
  async open(
    projectId: string,
    provider: AccountProvider,
    purpose: "connection" | "xcode" | "store" = "connection",
    pendingGoogleConnectionId?: string,
    storeSetup?: StoreSetupState,
  ) {
    if (pendingGoogleConnectionId) {
      invariant(
        provider === "google",
        "GOOGLE_CONNECTION",
        "Pending Google credentials require Google setup.",
      );
      await this.engine.googleCredentialDetails(
        pendingGoogleConnectionId,
        false,
      );
    }
    for (const account of this.accounts.values())
      if (
        account.state.projectId === projectId &&
        account.state.provider === provider &&
        (account.state.purpose ?? "connection") === purpose
      ) {
        if (pendingGoogleConnectionId) {
          invariant(
            provider === "google",
            "GOOGLE_CONNECTION",
            "Pending Google credentials require Google setup.",
          );
          const details = await this.engine.googleCredentialDetails(
            pendingGoogleConnectionId,
            false,
          );
          account.state.google = {
            cloudProject: details.cloudProject,
            email: details.email,
            pendingCredentialId: pendingGoogleConnectionId,
            stage: "play",
            submitted: {},
            developerId: account.state.google?.developerId,
          };
          account.state.connectedCredentialId = undefined;
          account.state.status = "working";
          account.googleLastVerify = 0;
          account.googleBlocked = false;
          this.persist(account);
          await this.googleNavigate(
            account,
            "https://play.google.com/console/developers",
          );
        }
        if (!this.options.hidden) account.host.show();
        return;
      }
    const project = this.engine.store.get<Project>("projects", projectId);
    invariant(
      purpose !== "xcode" || project.settings.minimumIosSdk,
      "XCODE_SDK_REQUIRED",
      "Choose the minimum iOS SDK in Toolchain before starting an automatic Xcode download.",
    );
    const host = new BrowserWindow({
      show: !this.options.hidden,
      width: 1380,
      height: 950,
      minWidth: 1100,
      minHeight: 760,
      title:
        provider === "apple"
          ? "Apple setup · Local Build Desk"
          : "Google setup · Local Build Desk",
      backgroundColor: "#101a23",
      parent: this.parent(),
      webPreferences: {
        preload: join(__dirname, "../preload/index.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const partition = session.fromPartition(`persist:desk-account-${provider}`);
    const view = new WebContentsView({
      webPreferences: {
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    host.contentView.addChildView(view);
    const url =
      purpose === "store"
        ? this.storeStartUrl(storeSetup!)
        : purpose === "xcode"
          ? "https://developer.apple.com/download/applications/"
          : provider === "apple"
            ? "https://appstoreconnect.apple.com/access/integrations/api"
            : "https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com";
    const progressRoot = join(this.engine.store.root, "accounts");
    mkdirSync(progressRoot, { recursive: true, mode: 0o700 });
    const progressPath = join(
      progressRoot,
      `${projectId}-${provider}${purpose === "store" ? "-store-" + storeSetup!.mode : purpose === "xcode" ? "-xcode" : ""}.json`,
    );
    let restored: Partial<AccountSetupState> = {};
    try {
      restored = JSON.parse(readFileSync(progressPath, "utf8"));
    } catch {}
    if (
      purpose === "xcode" &&
      restored.requiredSdk !== project.settings.minimumIosSdk
    )
      restored = { hideWhenWorking: restored.hideWhenWorking };
    const diagnostics = new AccountDiagnostics(
      this.engine.store.root,
      provider,
      projectId,
    );
    const account: AccountSession = {
      host,
      view,
      state: {
        projectId,
        provider,
        purpose,
        requiredSdk: project.settings.minimumIosSdk,
        url,
        status: "working",
        message: "Opening your account setup…",
        issuerId: "",
        teamId: "",
        keyId: "",
        label:
          provider === "apple"
            ? "Local Build Desk · Apple"
            : "Local Build Desk · Google",
        events: [],
        hideWhenWorking: false,
      },
      diagnostics,
      progressPath,
      timer: undefined as any,
      phaseSince: Date.now(),
      busy: false,
      approvedKey: false,
      attempts: {},
    };
    for (const key of [
      "issuerId",
      "teamId",
      "keyId",
      "label",
      "downloadedFile",
      "hideWhenWorking",
      "keyGenerationSubmitted",
      "connectedCredentialId",
      "xcodeApp",
      "xcodeLicenseApproved",
    ] as const)
      if (restored[key] !== undefined)
        (account.state as any)[key] = restored[key];
    if (purpose === "store") {
      const saved = restored.storeSetup;
      invariant(
        !(
          saved?.submitted.upload &&
          !["verifying", "complete"].includes(saved.stage)
        ) || storeScope(saved, "resume") === storeScope(storeSetup!, "resume"),
        "STORE_PENDING_UPLOAD",
        "Resume the selected pending AAB before changing this first-upload workflow.",
      );
      account.state.storeSetup =
        saved &&
        storeScope(saved, "resume") === storeScope(storeSetup!, "resume")
          ? { ...saved, approval: undefined }
          : storeSetup;
      if (
        storeSetup!.mode === "bootstrap" &&
        account.state.storeSetup!.stage !== "complete"
      )
        account.state.storeSetup!.consoleEditActive = true;
      if (account.state.storeSetup!.stage === "complete") {
        account.state.status = "complete";
        account.state.message =
          "This app's store setup is verified. Return to Guided setup to continue.";
      }
    }
    if (provider === "google" && purpose === "connection") {
      account.state.google = restored.google ?? {
        cloudProject: "",
        stage: "cloud",
        submitted: {},
      };
      if (pendingGoogleConnectionId) {
        const details = await this.engine.googleCredentialDetails(
          pendingGoogleConnectionId,
          false,
        );
        account.state.google = {
          cloudProject: details.cloudProject,
          email: details.email,
          pendingCredentialId: pendingGoogleConnectionId,
          stage: "play",
          submitted: {},
          developerId: account.state.google?.developerId,
        };
        account.state.connectedCredentialId = undefined;
      }
      delete account.state.google.approval;
      delete account.state.google.approvedCloudScope;
      delete account.state.google.approvedPlayScope;
      const resumingCloudSetup =
        restored.google?.stage === "cloud" &&
        !!restored.google.cloudProject &&
        !restored.connectedCredentialId;
      if (
        !account.state.google.pendingCredentialId &&
        project.settings.googleConnectionId &&
        !resumingCloudSetup
      ) {
        try {
          const details = await this.engine.googleCredentialDetails(
            project.settings.googleConnectionId,
            false,
          );
          Object.assign(account.state.google, {
            cloudProject: details.cloudProject ?? "",
            email: details.email,
            pendingCredentialId: project.settings.googleConnectionId,
            stage: "play",
          });
        } catch {}
      }
    }
    if (
      account.state.downloadedFile &&
      !existsSync(account.state.downloadedFile)
    )
      account.state.downloadedFile = undefined;
    if (
      purpose === "xcode" &&
      !account.state.xcodeApp &&
      project.settings.xcodePath &&
      project.settings.iosSdk &&
      sdkAtLeast(project.settings.iosSdk, account.state.requiredSdk!)
    )
      account.state.xcodeApp = project.settings.xcodePath.replace(
        /\/Contents\/Developer\/?$/,
        "",
      );
    account.state.diagnosticPath = diagnostics.directory;
    diagnostics.record("session.restored", {
      hasIssuer: !!restored.issuerId,
      hasTeam: !!restored.teamId,
      hasDownloadedFile: !!account.state.downloadedFile,
    });
    void diagnostics.attach(view.webContents);
    const hostId = host.webContents.id;
    this.accounts.set(hostId, account);
    if (account.state.storeSetup) this.persist(account);
    const toolchainProgress = (event: DeskEvent) => {
      if (
        purpose !== "xcode" ||
        !account.busy ||
        event.type !== "log" ||
        !event.entry ||
        event.jobId !== `setup:${projectId}`
      )
        return;
      const text = event.entry.text.slice(-1500);
      account.state.progress =
        toolProgress(text, account.state.progress) ?? account.state.progress;
      this.note(account, text);
      if (/administrator authentication is required/i.test(text))
        this.prompt(account, text);
      else this.working(account, text);
    };
    this.engine.on("event", toolchainProgress);
    const layout = () => {
      const [width, height] = host.getContentSize();
      view.setBounds({
        x: 328,
        y: 58,
        width: Math.max(1, width - 328),
        height: Math.max(1, height - 58),
      });
    };
    host.on("resize", layout);
    layout();
    const allowed = (target: string) => {
      try {
        const u = new URL(target);
        return (
          u.protocol === "https:" &&
          (provider === "apple"
            ? u.hostname === "apple.com" || u.hostname.endsWith(".apple.com")
            : u.hostname === "google.com" || u.hostname.endsWith(".google.com"))
        );
      } catch {
        return false;
      }
    };
    view.webContents.on("will-navigate", (event, target) => {
      if (!allowed(target)) {
        event.preventDefault();
        diagnostics.record("navigation.blocked", { url: target });
      }
    });
    view.webContents.setWindowOpenHandler(({ url }) => {
      diagnostics.record("navigation.popup", { url, allowed: allowed(url) });
      if (
        provider === "google" &&
        url.startsWith("blob:https://console.cloud.google.com/") &&
        account.state.google?.submitted.key
      ) {
        view.webContents.downloadURL(url);
        return { action: "deny" };
      }
      if (allowed(url)) void view.webContents.loadURL(url);
      return { action: "deny" };
    });
    host.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    host.webContents.on("will-navigate", (event) => event.preventDefault());
    const agent = view.webContents
      .getUserAgent()
      .replace(/ Electron\/[^ ]+/g, "")
      .replace(/ LocalBuildDesk\/[^ ]+/g, "");
    view.webContents.setUserAgent(agent);
    view.webContents.on("did-navigate", (_event, target) => {
      account.state.url = target;
      if (account.state.storeSetup) {
        account.state.storeSetup.lastUrl = target;
        this.persist(account);
      }
      this.changed(account);
    });
    view.webContents.on(
      "did-navigate-in-page",
      (_event, target, isMainFrame) => {
        if (!isMainFrame) return;
        account.state.url = target;
        if (account.state.storeSetup) {
          account.state.storeSetup.lastUrl = target;
          this.persist(account);
        }
        this.changed(account);
      },
    );
    view.webContents.on("did-fail-load", (_event, code, description) => {
      if (code !== -3)
        this.prompt(
          account,
          `The account page could not load: ${description}. You can reload or complete this step manually.`,
        );
    });
    const downloadListener = (
      _event: Electron.Event,
      item: Electron.DownloadItem,
      contents: WebContents,
    ) => {
      if (contents.id !== view.webContents.id) return;
      const filename = basename(item.getFilename());
      if (account.state.purpose === "xcode") {
        if (!filename.toLowerCase().endsWith(".xip")) return;
        const storage = this.engine.store.get<Project>("projects", projectId)
          .settings.buildDirectory;
        if (!storage) {
          item.cancel();
          this.prompt(
            account,
            "Choose a build storage folder in Toolchain before downloading Xcode.",
          );
          return;
        }
        const downloads = join(storage, "toolchains", "downloads");
        mkdirSync(downloads, { recursive: true, mode: 0o700 });
        const path = join(downloads, filename);
        item.setSavePath(path);
        diagnostics.record("xcode.download.started", { filename });
        account.downloadInProgress = true;
        const startedAt = new Date().toISOString();
        account.state.progress = {
          kind: "download",
          label: "Downloading Xcode",
          startedAt,
          updatedAt: startedAt,
          completedBytes: 0,
          totalBytes: item.getTotalBytes() || undefined,
          detail:
            "Apple’s Xcode archive is several gigabytes. This can take a few minutes.",
        };
        let lastPercent = -1;
        let lastProgressUpdate = 0;
        item.on("updated", () => {
          const percent =
            item.getTotalBytes() > 0
              ? Math.floor(
                  (item.getReceivedBytes() / item.getTotalBytes()) * 100,
                )
              : 0;
          if (
            percent !== lastPercent ||
            Date.now() - lastProgressUpdate >= 250
          ) {
            lastPercent = percent;
            lastProgressUpdate = Date.now();
            account.state.progress = {
              ...account.state.progress!,
              updatedAt: new Date().toISOString(),
              completedBytes: item.getReceivedBytes(),
              totalBytes: item.getTotalBytes() || undefined,
            };
            this.working(
              account,
              `Downloading Xcode for iOS ${account.state.requiredSdk}: ${percent}% (${(item.getReceivedBytes() / 1024 ** 3).toFixed(1)} GB)…`,
            );
          }
        });
        item.once("done", async (_event, state) => {
          diagnostics.record("xcode.download.finished", {
            state,
            receivedBytes: item.getReceivedBytes(),
            totalBytes: item.getTotalBytes(),
          });
          account.downloadInProgress = false;
          account.pendingAction = undefined;
          if (state === "completed") {
            await chmod(path, 0o600);
            account.state.downloadedFile = path;
            this.persist(account);
            void this.advance(account);
          } else
            this.prompt(
              account,
              "The Xcode download did not finish. Retry automation to resume the acquisition.",
            );
        });
        this.working(account, "Downloading Xcode from Apple…");
        return;
      }
      if (!/\.(p8|json)$/i.test(filename)) return;
      const downloadRoot = join(progressRoot, "private-downloads");
      mkdirSync(downloadRoot, { recursive: true, mode: 0o700 });
      const downloadDirectory = mkdtempSync(join(downloadRoot, "key-"));
      const path = join(downloadDirectory, filename);
      account.downloadInProgress = true;
      this.working(
        account,
        "Saving the private key in protected local storage…",
      );
      item.setSavePath(path);
      diagnostics.record("download.started", {
        extension: filename.split(".").at(-1),
      });
      item.once("done", async (_event, state) => {
        diagnostics.record("download.finished", { state });
        account.downloadInProgress = false;
        if (item.getSavePath() !== path || state !== "completed")
          rmSync(downloadDirectory, { recursive: true, force: true });
        if (state === "completed") {
          const file = item.getSavePath();
          try {
            await chmod(file, 0o600);
          } catch {
            this.prompt(
              account,
              "The downloaded key could not be protected. Check local file permissions before retrying.",
            );
            return;
          }
          account.state.downloadedFile = file;
          account.pendingAction = undefined;
          account.diagnostics.record("automation.download.verified", {
            extension: filename.split(".").at(-1),
          });
          this.persist(account);
          const keyId = filename.match(/AuthKey_([A-Za-z0-9]+)\.p8$/)?.[1];
          if (keyId) account.state.keyId = keyId;
          this.note(
            account,
            "Private key downloaded. It will be imported into the encrypted local vault.",
          );
          void this.advance(account);
        } else
          this.prompt(
            account,
            "The key download did not finish. Retry the download on the account page.",
          );
      });
    };
    const cookieListener = (
      _event: Electron.Event,
      cookie: Electron.Cookie,
      cause: string,
      removed: boolean,
    ) =>
      diagnostics.record("session.cookie-metadata", {
        domain: cookie.domain,
        name: cookie.name,
        session: cookie.session,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expires: cookie.expirationDate,
        cause,
        removed,
      });
    partition.cookies.on("changed", cookieListener);
    partition.on("will-download", downloadListener);
    host.on("close", () => {
      if (
        account.state.storeSetup?.mode === "bootstrap" &&
        !account.state.storeSetup.submitted.upload
      )
        account.state.storeSetup.consoleEditActive = false;
      this.persist(account);
      partition.flushStorageData();
      void partition.cookies
        .flushStore()
        .then(() => diagnostics.record("session.cookies-flushed"))
        .catch((error) =>
          diagnostics.record("session.flush-error", { error: String(error) }),
        );
    });
    host.on("closed", () => {
      this.engine.off("event", toolchainProgress);
      clearInterval(account.timer);
      diagnostics.close();
      partition.removeListener("will-download", downloadListener);
      partition.cookies.removeListener("changed", cookieListener);
      if (!view.webContents.isDestroyed()) view.webContents.close();
      this.accounts.delete(hostId);
    });
    if (process.env.ELECTRON_RENDERER_URL)
      await host.loadURL(
        `${process.env.ELECTRON_RENDERER_URL}?account=${provider}`,
      );
    else
      await host.loadFile(join(__dirname, "../renderer/index.html"), {
        query: { account: provider },
      });
    const connectionId = account.state.connectedCredentialId;
    if (
      purpose === "connection" &&
      provider !== "google" &&
      connectionId &&
      connectionId ===
        project.settings[
          provider === "apple" ? "appleConnectionId" : "googleConnectionId"
        ]
    ) {
      try {
        await this.engine.validateConnection(connectionId);
        account.state.status = "complete";
        account.state.message =
          "Your saved account connection is verified and ready.";
        this.changed(account);
        return;
      } catch (error) {
        diagnostics.record("connection.restore-failed", {
          error: messageOf(error),
        });
        account.state.connectedCredentialId = undefined;
      }
    }
    const localXcode =
      purpose === "xcode" &&
      (account.state.xcodeApp ||
        account.state.downloadedFile ||
        project.settings.pendingXcodePath);
    await view.webContents
      .loadURL(
        localXcode
          ? "about:blank"
          : purpose === "store" && account.state.storeSetup?.lastUrl
            ? this.checkedStoreUrl(account.state.storeSetup.lastUrl, provider)
            : url,
      )
      .catch(() => {});
    account.timer = setInterval(() => void this.advance(account), 1600);
    void this.advance(account);
  }
  get(sender: WebContents) {
    const account = this.accounts.get(sender.id);
    invariant(account, "ACCOUNT_WINDOW", "Account setup window was not found.");
    return account;
  }
  state(sender: WebContents) {
    return this.get(sender).state;
  }
  private persist(account: AccountSession) {
    const {
      issuerId,
      teamId,
      keyId,
      label,
      downloadedFile,
      hideWhenWorking,
      keyGenerationSubmitted,
      connectedCredentialId,
      xcodeApp,
      xcodeLicenseApproved,
      requiredSdk,
      google,
      storeSetup,
    } = account.state;
    writeFileSync(
      account.progressPath,
      JSON.stringify({
        issuerId,
        teamId,
        keyId,
        label,
        downloadedFile,
        hideWhenWorking,
        keyGenerationSubmitted,
        connectedCredentialId,
        xcodeApp,
        xcodeLicenseApproved,
        requiredSdk,
        storeSetup: storeSetup
          ? { ...storeSetup, approval: undefined }
          : undefined,
        google: google
          ? {
              ...google,
              approval: undefined,
              approvedCloudScope: undefined,
              approvedPlayScope: undefined,
            }
          : undefined,
      }) + "\n",
      { mode: 0o600 },
    );
  }
  private changed(account: AccountSession) {
    if (!account.host.isDestroyed())
      account.host.webContents.send("desk:event", { type: "state" });
  }
  private note(account: AccountSession, text: string) {
    if (account.state.events.at(-1) !== text) {
      account.state.events.push(text);
      account.diagnostics.record("automation.note", { text });
    }
    account.state.events = account.state.events.slice(-40);
    this.changed(account);
  }
  private prompt(account: AccountSession, message: string) {
    if (
      account.state.status !== "needs-input" ||
      account.state.message !== message
    ) {
      account.diagnostics.record("automation.handoff", { message });
      void account.diagnostics.snapshot(account.view.webContents, "handoff");
    }
    account.state.status = "needs-input";
    account.state.message = message;
    if (!this.options.hidden && !account.host.isVisible()) account.host.show();
    this.changed(account);
  }
  private working(account: AccountSession, message: string) {
    if (account.state.status !== "working" || !account.state.activityStartedAt)
      account.state.activityStartedAt = new Date().toISOString();
    account.state.status = "working";
    account.state.message = message;
    if (account.state.hideWhenWorking) account.host.hide();
    this.changed(account);
  }
  async navigate(sender: WebContents, action: string) {
    const account = this.get(sender);
    account.diagnostics.record("automation.navigate", { action });
    const contents = account.view.webContents;
    const urls: Record<string, string> = {
      "apple-api": "https://appstoreconnect.apple.com/access/integrations/api",
      "apple-team": "https://developer.apple.com/account/#/membership",
      "apple-enroll": "https://developer.apple.com/programs/enroll/",
      "google-cloud":
        "https://console.cloud.google.com/iam-admin/serviceaccounts",
      "google-play": "https://play.google.com/console/developers",
    };
    if (action === "back") {
      if (contents.navigationHistory.canGoBack())
        contents.navigationHistory.goBack();
    } else if (action === "reload") contents.reload();
    else {
      invariant(
        urls[action] &&
          action.startsWith(
            account.state.provider === "apple" ? "apple" : "google",
          ),
        "ACCOUNT_NAV",
        "Invalid account destination.",
      );
      await contents.loadURL(urls[action]);
    }
    if (account.state.provider === "google" && account.state.google) {
      account.state.status = "working";
      account.state.google.stage = action === "google-play" ? "play" : "cloud";
      account.googleLastVerify = Date.now();
    }
    account.lastPhase = undefined;
    account.pendingAction = undefined;
    account.phaseSince = Date.now();
    this.changed(account);
  }
  update(
    sender: WebContents,
    values: Partial<AccountSetupState> & {
      storeAppName?: string;
      googleCloudProject?: string;
      googleCreateProject?: boolean;
      googleDeveloperId?: string;
      googleRequestNewPlayApp?: boolean;
      googleStartSetup?: boolean;
    },
  ) {
    const account = this.get(sender);
    const store = account.state.storeSetup;
    if (values.storeAppName !== undefined && store) {
      const name = values.storeAppName.trim();
      invariant(
        store.mode === "record" && !store.submitted.create && !account.busy,
        "STORE_NAME_LOCKED",
        "The app name can only change before the app record is submitted.",
      );
      invariant(
        store.provider !== "apple" || name.length <= 30,
        "STORE_APP_NAME",
        "Apple app names are limited to 30 characters.",
      );
      store.appName = name;
      store.staleError = store.rejection;
      store.rejection = undefined;
      store.approval = undefined;
      account.storeApprovalScope = undefined;
      account.lastProbe = undefined;
      account.state.status = "working";
      this.persist(account);
      this.note(account, `Retrying the app record as ${name}.`);
    }
    for (const key of [
      "issuerId",
      "teamId",
      "keyId",
      "label",
      "downloadedFile",
      "hideWhenWorking",
    ] as const)
      if (values[key] !== undefined) (account.state as any)[key] = values[key];
    if (account.state.provider === "google" && account.state.google) {
      const google = account.state.google;
      if (
        values.googleCloudProject !== undefined &&
        values.googleCloudProject !== google.cloudProject
      ) {
        invariant(
          !account.busy && !account.downloadInProgress,
          "GOOGLE_BUSY",
          "Wait for the current Google step before changing projects.",
        );
        google.cloudProject = values.googleCloudProject;
        google.email = undefined;
        google.pendingCredentialId = undefined;
        google.serviceUrl = undefined;
        google.apiIndex = 0;
        google.stage = "cloud";
        google.approvedCloudScope = undefined;
        google.approval = undefined;
        account.state.connectedCredentialId = undefined;
        account.state.status = "needs-input";
        account.pendingAction = undefined;
        account.lastProbe = undefined;
      }
      if (values.googleStartSetup) {
        invariant(
          !account.busy && !account.downloadInProgress,
          "GOOGLE_BUSY",
          "Wait for the current Google setup step.",
        );
        google.pendingCredentialId = undefined;
        google.email = undefined;
        account.googleBlocked = false;
        google.stage = "cloud";
        google.apiIndex = 0;
        google.approval = undefined;
        google.approvedCloudScope = undefined;
        account.state.connectedCredentialId = undefined;
        account.state.status = "working";
        account.pendingAction = undefined;
        account.lastProbe = undefined;
        account.attempts = {};
      }
      if (values.downloadedFile) {
        google.pendingCredentialId = undefined;
        google.email = undefined;
        account.googleBlocked = false;
        account.googleLastVerify = 0;
        account.state.connectedCredentialId = undefined;
        account.state.status = "working";
      }
      if (values.googleCreateProject !== undefined)
        google.createProject = values.googleCreateProject;
      if (values.googleDeveloperId !== undefined) {
        google.developerId = values.googleDeveloperId;
        google.approvedPlayScope = undefined;
      }
      if (values.googleRequestNewPlayApp !== undefined)
        google.requestNewPlayApp = values.googleRequestNewPlayApp;
    }
    this.persist(account);
    this.changed(account);
  }
  async approveKey(sender: WebContents) {
    const account = this.get(sender);
    invariant(
      account.state.provider === "apple" &&
        account.state.approvalRequired &&
        !account.state.keyGenerationSubmitted,
      "KEY_APPROVAL",
      "No key-generation approval is pending.",
    );
    account.approvedKey = true;
    account.state.approvalRequired = false;
    this.working(account, "Generating the team API key you approved…");
    const result = await this.action(account, { type: "generate-key" });
    if (!result.done)
      this.prompt(
        account,
        "The key-generation button is not ready yet. We will recheck the form automatically.",
      );
  }
  async approveXcodeLicense(sender: WebContents) {
    const account = this.get(sender);
    invariant(
      account.state.purpose === "xcode" && account.state.xcodeLicenseRequired,
      "XCODE_LICENSE",
      "No Xcode license approval is pending.",
    );
    account.state.xcodeLicenseApproved = true;
    account.state.xcodeLicenseRequired = false;
    this.persist(account);
    await this.advance(account);
  }
  private async advanceXcode(account: AccountSession) {
    const state = account.state;
    const pending = this.engine.store.get<Project>("projects", state.projectId)
      .settings.pendingXcodePath;
    if (!state.xcodeApp && pending)
      state.xcodeApp = pending.replace(/\/Contents\/Developer\/?$/, "");
    if (state.xcodeLicenseRequired && !state.xcodeLicenseApproved) return;
    if (state.xcodeApp || state.downloadedFile) {
      const time = new Date().toISOString();
      state.progress = {
        kind: "work",
        label: "Preparing Xcode",
        startedAt: time,
        updatedAt: time,
        detail:
          "Expansion, signature verification and component installation can take a few minutes.",
      };
      this.working(
        account,
        "Expanding and verifying the Apple Xcode archive, then installing matching platform components…",
      );
      const result = await this.engine.installXcode(
        state.projectId,
        state.xcodeApp ?? state.downloadedFile!,
        state.xcodeLicenseApproved === true,
      );
      state.xcodeApp = result.installation.developerDirectory.replace(
        /\/Contents\/Developer\/?$/,
        "",
      );
      this.persist(account);
      if (result.requiresLicense) {
        state.xcodeLicenseRequired = true;
        state.xcodeLicenseText = result.licenseText;
        this.prompt(
          account,
          "Xcode is verified and installed. Review the Xcode and Apple SDKs Agreement, then approve completing first launch.",
        );
        return;
      }
      state.status = "complete";
      state.message = `Xcode ${result.installation.version} and its iOS platform are installed and selected for this project. SDKs: ${result.installation.iosSdks.join(", ")}.`;
      this.note(account, state.message);
      this.changed(account);
      return;
    }
    if (
      account.pendingAction &&
      Date.now() - account.pendingAction.started < 45000
    )
      return;
    if (!account.attempts.xcodeDownloadSnapshot) {
      account.attempts.xcodeDownloadSnapshot = 1;
      await account.diagnostics.snapshot(
        account.view.webContents,
        "before-xcode-download",
      );
    }
    const result = await account.view.webContents.executeJavaScript(
      `(${startXcodeDownload.toString()})(${JSON.stringify(state.requiredSdk)})`,
      true,
    );
    account.diagnostics.record("xcode.download.action", result);
    if (result.done) {
      account.pendingAction = {
        type: "download-xcode",
        started: Date.now(),
        expected: [],
      };
      this.working(
        account,
        "Apple’s Xcode download was selected. Waiting for the download to begin…",
      );
    } else if (result.phase === "login")
      this.prompt(
        account,
        "Sign in to Apple in the page on the right. Xcode acquisition resumes automatically after sign-in and MFA.",
      );
    else if (result.phase === "terms")
      this.prompt(
        account,
        "Review and accept Apple’s displayed download agreement to continue.",
      );
    else if (Date.now() - account.phaseSince > 15000) {
      await account.diagnostics.snapshot(
        account.view.webContents,
        "xcode-download-missing",
      );
      this.prompt(
        account,
        `The iOS ${state.requiredSdk} Xcode download was not found yet. Retry automation after the page finishes loading.`,
      );
    }
  }
  private async action(
    account: AccountSession,
    action: Parameters<typeof performAppleAction>[0],
  ) {
    account.diagnostics.record("automation.action.start", { action });
    await account.diagnostics.snapshot(
      account.view.webContents,
      `before-${action.type}`,
    );
    // Write ahead of the browser click: a crash or lost response must never
    // turn an uncertain creation into a second persistent API key.
    if (action.type === "generate-key") {
      account.state.keyGenerationSubmitted = true;
      this.persist(account);
    }
    const result = await account.view.webContents.executeJavaScript(
      `(${performAppleAction.toString()})(${JSON.stringify(action)})`,
      true,
    );
    account.diagnostics.record("automation.action.result", { action, result });
    if (action.type === "generate-key" && !result.done) {
      account.state.keyGenerationSubmitted = false;
      this.persist(account);
    }
    if (result.done) {
      const expected: Record<string, string[]> = {
        "open-key-dialog": ["key-dialog"],
        "generate-key": ["keys", "download-confirm", "download"],
        "download-key": ["download-confirm", "download"],
        membership: ["team"],
      };
      if (expected[action.type])
        account.pendingAction = {
          type: action.type,
          started: Date.now(),
          expected: expected[action.type],
        };
    }
    await account.diagnostics.snapshot(
      account.view.webContents,
      `after-${action.type}`,
    );
    return result;
  }
  async complete(sender: WebContents) {
    const account = this.get(sender);
    const state = account.state;
    if (state.provider === "google") {
      await this.advance(account);
      return;
    }
    invariant(
      state.downloadedFile,
      "KEY_FILE",
      "Download or choose the private key first.",
    );
    this.working(
      account,
      "Encrypting the key and checking account permissions…",
    );
    try {
      const saved = await this.engine.saveCredential(
        state.provider === "apple"
          ? {
              kind: "apple",
              label: state.label,
              keyPath: state.downloadedFile,
              keyId: state.keyId,
              issuerId: state.issuerId,
              teamId: state.teamId,
            }
          : {
              kind: "google",
              label: state.label,
              keyPath: state.downloadedFile,
            },
      );
      try {
        await this.engine.validateConnection(saved.id);
      } catch (error) {
        this.engine.vault.remove(saved.id);
        throw error;
      }
      const project = this.engine.store.get<Project>(
        "projects",
        state.projectId,
      );
      this.engine.saveSettings(project.id, {
        ...project.settings,
        [state.provider === "apple"
          ? "appleConnectionId"
          : "googleConnectionId"]: saved.id,
      });
      account.diagnostics.record("connection.verified", {
        provider: state.provider,
      });
      state.connectedCredentialId = saved.id;
      // Only remove downloads created by this window. User-imported originals
      // remain under their control.
      const managedRoot = join(
        this.engine.store.root,
        "accounts",
        "private-downloads",
      );
      const downloadedDirectory = dirname(resolve(state.downloadedFile));
      if (
        dirname(downloadedDirectory) === resolve(managedRoot) &&
        basename(downloadedDirectory).startsWith("key-")
      ) {
        rmSync(downloadedDirectory, { recursive: true, force: true });
        state.downloadedFile = undefined;
      }
      this.persist(account);
      state.status = "complete";
      state.message =
        "Connected and verified. Return to Guided setup to create signing credentials and build.";
      this.note(account, "Account connected to this project.");
      if (!this.options.hidden) account.host.show();
    } catch (error) {
      account.diagnostics.record("connection.failed", {
        error: messageOf(error),
      });
      this.prompt(account, messageOf(error));
      throw error;
    }
  }
  diagnosticsPath(sender: WebContents) {
    return this.get(sender).diagnostics.directory;
  }
  retry(sender: WebContents) {
    const account = this.get(sender);
    const retryDownload =
      account.xcodeFailed &&
      account.state.purpose === "xcode" &&
      !account.state.xcodeApp &&
      !this.engine.store.get<Project>("projects", account.state.projectId)
        .settings.pendingXcodePath;
    account.attempts = {};
    account.storeLastAction = undefined;
    account.storeVerificationPaused = false;
    account.storeVerifyAt = undefined;
    account.storeVerifyFailures = 0;
    account.googleBlocked = false;
    account.googleLastVerify = 0;
    account.googleLastError = undefined;
    account.googleLastTokenCheck = undefined;
    account.xcodeFailed = false;
    account.pendingAction = undefined;
    account.phaseSince = Date.now();
    account.lastConnectFingerprint = undefined;
    account.diagnostics.record("automation.retry");
    if (retryDownload) {
      account.state.downloadedFile = undefined;
      this.persist(account);
      this.working(account, "Retrying the Xcode download from Apple…");
      void account.view.webContents
        .loadURL("https://developer.apple.com/download/applications/")
        .then(() => this.advance(account))
        .catch((error) => this.prompt(account, messageOf(error)));
      return;
    }
    void this.advance(account);
  }
  private googleTarget(account: AccountSession): GoogleTarget {
    const project = this.engine.store.get<Project>(
      "projects",
      account.state.projectId,
    );
    const google = account.state.google!;
    return {
      cloudProject: google.cloudProject,
      email:
        google.email ||
        `local-build-desk@${google.cloudProject}.iam.gserviceaccount.com`,
      packageName: project.packageName || "",
      appName: project.name,
    };
  }
  async approveGoogle(sender: WebContents) {
    const account = this.get(sender),
      google = account.state.google;
    invariant(
      account.state.provider === "google" && google?.approval,
      "GOOGLE_APPROVAL",
      "No Google setup approval is pending.",
    );
    const target = this.googleTarget(account);
    if (google.approval === "cloud")
      google.approvedCloudScope = `${target.cloudProject}:${target.email}`;
    else
      google.approvedPlayScope = `${google.developerId}:${target.email}:${target.packageName}`;
    google.approval = undefined;
    this.working(account, "Continuing the Google setup you approved…");
    await this.advance(account);
  }
  private async googleAction(
    account: AccountSession,
    type: GoogleActionType,
    mutation?: string,
  ) {
    const google = account.state.google!,
      target = this.googleTarget(account),
      scope = `${target.cloudProject}:${target.email}`;
    const scopeKey =
      mutation === "invite" || mutation === "invite-confirm"
        ? `${google.developerId}:${target.email}:${target.packageName}`
        : scope;
    if (mutation && google.submitted[mutation] === scopeKey) {
      this.prompt(
        account,
        `Google has not confirmed the submitted ${mutation} request. Inspect or reload this page; it will not be submitted again automatically.`,
      );
      return false;
    }
    if (mutation) {
      google.submitted[mutation] = scopeKey;
      this.persist(account);
    }
    account.diagnostics.record("google.action", { type, mutation });
    const result = (await account.view.webContents.executeJavaScript(
      `(${performGoogleAction.toString()})(${JSON.stringify({ type, target })})`,
      true,
    )) as GoogleActionResult;
    account.diagnostics.record("google.action.result", { type, result });
    if (!result.done) {
      if (mutation) {
        delete google.submitted[mutation];
        this.persist(account);
      }
      this.prompt(
        account,
        result.detail ||
          `Google’s ${type.replaceAll("-", " ")} control is not ready. Complete this step on the page or retry automation.`,
      );
    } else {
      this.working(account, `Google setup: ${type.replaceAll("-", " ")}…`);
      account.pendingAction = {
        type: "google:" + type,
        started: Date.now(),
        expected: [],
      };
    }
    await account.diagnostics.snapshot(
      account.view.webContents,
      "google-" + type,
    );
    return result.done;
  }
  private async googleNavigate(account: AccountSession, url: string) {
    const parsed = new URL(url);
    invariant(
      parsed.protocol === "https:" &&
        ["console.cloud.google.com", "play.google.com"].includes(
          parsed.hostname,
        ),
      "GOOGLE_DESTINATION",
      "Unexpected Google setup destination.",
    );
    account.pendingAction = undefined;
    this.working(account, "Opening the next Google setup step…");
    await account.view.webContents.loadURL(url);
  }
  private async importGoogleDownload(account: AccountSession) {
    const state = account.state,
      google = state.google!,
      file = state.downloadedFile!;
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw Error(
        "The downloaded Google key is not valid JSON. Its contents were excluded from diagnostics.",
      );
    }
    invariant(
      input.type === "service_account" &&
        typeof input.client_email === "string" &&
        typeof input.project_id === "string",
      "GOOGLE_KEY",
      "Choose a Google service-account JSON key.",
    );
    const target = this.googleTarget(account);
    invariant(
      !google.cloudProject || input.project_id === google.cloudProject,
      "GOOGLE_KEY_PROJECT",
      "This key belongs to a different Cloud project. Select its project explicitly before importing.",
    );
    invariant(
      !google.email || input.client_email === google.email,
      "GOOGLE_KEY_ACCOUNT",
      "This key belongs to a different service account than the selected setup.",
    );
    const saved = await this.engine.saveCredential({
      kind: "google",
      label: state.label,
      keyPath: file,
    });
    google.pendingCredentialId = saved.id;
    google.keyImportedAt = Date.now();
    account.googleTokenVerified = undefined;
    account.googleLastTokenCheck = undefined;
    google.cloudProject = input.project_id;
    google.email = input.client_email;
    google.stage = "play";
    // The key is encrypted now, even if Play permissions still need setup.
    const managedRoot = join(
      this.engine.store.root,
      "accounts",
      "private-downloads",
    );
    const directory = dirname(resolve(file));
    if (
      dirname(directory) === resolve(managedRoot) &&
      basename(directory).startsWith("key-")
    ) {
      rmSync(directory, { recursive: true, force: true });
      state.downloadedFile = undefined;
    }
    this.persist(account);
    this.note(
      account,
      "Google key encrypted. Checking this app’s Play Console access…",
    );
  }
  private async verifyGoogleKey(account: AccountSession) {
    const google = account.state.google!;
    const id = google.pendingCredentialId!;
    if (account.googleTokenVerified === id) return true;
    if (Date.now() - (account.googleLastTokenCheck ?? 0) < 12000) return false;
    account.googleLastTokenCheck = Date.now();
    try {
      await this.engine.googleCredentialDetails(id);
      account.googleTokenVerified = id;
      this.note(
        account,
        "Google key activated. Checking this app’s Play access…",
      );
      return true;
    } catch (error) {
      if (shouldRetryGoogleKeyActivation(error, google.keyImportedAt)) {
        this.working(
          account,
          "Google is activating the new key. This can take a minute or more; retrying the same encrypted key automatically…",
        );
        return false;
      }
      account.googleBlocked = true;
      this.prompt(
        account,
        "The encrypted Google key could not authenticate: " +
          messageOf(error) +
          ". Retry after checking this key in Google Cloud; another key will not be generated.",
      );
      return false;
    }
  }
  private async verifyGooglePlay(account: AccountSession) {
    const google = account.state.google!;
    if (!google.pendingCredentialId) return false;
    if (Date.now() - (account.googleLastVerify ?? 0) < 12000) return false;
    account.googleLastVerify = Date.now();
    try {
      await this.engine.validateConnection(
        google.pendingCredentialId,
        account.state.projectId,
      );
      const project = this.engine.store.get<Project>(
        "projects",
        account.state.projectId,
      );
      this.engine.saveSettings(project.id, {
        ...project.settings,
        googleConnectionId: google.pendingCredentialId,
      });
      account.state.connectedCredentialId = google.pendingCredentialId;
      google.approval = undefined;
      this.persist(account);
      account.state.status = "complete";
      account.state.message =
        "Google Play access verified. Your existing upload key is preserved; return to Guided setup to build and upload using your selected Google Play track and rollout setting.";
      this.note(account, "Google Play connection verified for this app.");
      if (!this.options.hidden) account.host.show();
      return true;
    } catch (error) {
      const detail = messageOf(error);
      if (account.googleLastError !== detail) {
        account.googleLastError = detail;
        this.note(account, "Play access is not ready yet: " + detail);
      }
      return false;
    }
  }
  private async advanceGoogle(account: AccountSession) {
    const state = account.state,
      google = state.google!;
    if (account.googleBlocked) return;
    invariant(
      this.googleTarget(account).packageName,
      "ANDROID_PACKAGE",
      "Set android.package in the Expo project before starting app-scoped Google setup.",
    );
    if (state.downloadedFile && !google.pendingCredentialId) {
      this.working(
        account,
        "Encrypting and validating the downloaded Google key…",
      );
      await this.importGoogleDownload(account);
    }
    if (google.stage === "play" && google.pendingCredentialId) {
      if (!(await this.verifyGoogleKey(account))) return;
      if (await this.verifyGooglePlay(account)) return;
    }
    const target = this.googleTarget(account);
    const probe = (await account.view.webContents.executeJavaScript(
      `(${inspectGooglePage.toString()})(${JSON.stringify(target)})`,
    )) as GoogleProbe;
    const fingerprint = JSON.stringify(probe);
    if (account.lastProbe !== fingerprint) {
      account.lastProbe = fingerprint;
      account.phaseSince = Date.now();
      account.pendingAction = undefined;
      account.attempts = {};
      account.diagnostics.record("google.probe", probe);
    }
    if (
      probe.cloudProject &&
      !google.cloudProject &&
      /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(probe.cloudProject)
    ) {
      google.cloudProject = probe.cloudProject;
      this.persist(account);
      return;
    }
    if (probe.developerId && google.developerId !== probe.developerId) {
      google.developerId = probe.developerId;
      google.approvedPlayScope = undefined;
      this.persist(account);
    }
    if (probe.phase === "signed-out") {
      await this.googleAction(account, "sign-in");
      return;
    }
    if (probe.phase === "login") {
      this.prompt(
        account,
        "Sign in to Google and complete any MFA on this page. Setup resumes automatically afterward.",
      );
      return;
    }
    if (probe.phase === "blocked-login") {
      this.prompt(
        account,
        "Google declined sign-in in this embedded browser. Use the Google Cloud CLI sign-in fallback in Guided setup; do not bypass Google’s browser security checks. Existing JSON keys can also be imported here.",
      );
      return;
    }
    if (probe.phase === "terms") {
      this.prompt(
        account,
        "Review and accept Google’s agreement on the page yourself. Automation resumes after you finish.",
      );
      return;
    }
    if (probe.phase === "policy") {
      this.prompt(
        account,
        "Your organization blocks service-account key creation. Ask its administrator for an approved credential method; Local Build Desk will not weaken that policy.",
      );
      return;
    }
    if (probe.phase === "unknown") {
      if (Date.now() - account.phaseSince < 15000)
        this.working(account, "Waiting for Google’s page to finish loading…");
      else
        this.prompt(
          account,
          "This Google page is not recognized yet. Complete the visible step or retry; redacted diagnostics include its controls and loading failures.",
        );
      return;
    }
    if (account.pendingAction?.type.startsWith("google:")) {
      if (Date.now() - account.pendingAction.started < 15000) {
        this.working(
          account,
          "Waiting for Google to finish the previous setup step…",
        );
        return;
      }
      account.pendingAction = undefined;
    }
    if (google.stage === "cloud" && !google.pendingCredentialId) {
      if (!google.cloudProject) {
        this.prompt(
          account,
          "Choose a Cloud project on the page, or enter its project ID here. Select “Create a new project” to prepare one automatically.",
        );
        return;
      }
      const scope = `${target.cloudProject}:${target.email}`;
      const approve = () => {
        google.approval = "cloud";
        this.prompt(
          account,
          `Approve ${google.createProject ? "creating Cloud project " : "setup in "}${google.cloudProject}: enable Android Publisher and IAM, create or reuse ${target.email}, and generate one JSON key. No project-wide IAM roles or billing changes are made.`,
        );
      };
      if (
        !google.serviceUrl &&
        probe.phase === "service-details" &&
        probe.servicePresent &&
        probe.cloudProject === google.cloudProject
      ) {
        google.serviceUrl = account.view.webContents.getURL();
        this.persist(account);
      }
      const selectedService = google.serviceUrl
        ? matchesGoogleServiceRoute(
            account.view.webContents.getURL(),
            google.serviceUrl,
            google.cloudProject,
          )
        : !!probe.servicePresent;
      const cloud = `https://console.cloud.google.com`,
        query = `?project=${encodeURIComponent(google.cloudProject)}`;
      if (google.createProject && google.submitted.project !== scope) {
        if (probe.phase !== "project-create") {
          await this.googleNavigate(account, cloud + "/projectcreate");
          return;
        }
        if (!probe.formReady) {
          await this.googleAction(account, "fill-project");
          return;
        }
        if (google.approvedCloudScope !== scope) {
          approve();
          return;
        }
        await this.googleAction(account, "create-project", "project");
        return;
      }
      const apis = ["androidpublisher.googleapis.com", "iam.googleapis.com"];
      const apiIndex = google.apiIndex ?? 0;
      if (apiIndex < apis.length) {
        const url = cloud + "/apis/library/" + apis[apiIndex] + query;
        if (
          !(
            new URL(account.view.webContents.getURL()).pathname ===
              "/apis/library/" + apis[apiIndex] ||
            new URL(account.view.webContents.getURL()).pathname.startsWith(
              "/apis/api/" + apis[apiIndex] + "/",
            )
          ) ||
          probe.cloudProject !== google.cloudProject
        ) {
          await this.googleNavigate(account, url);
          return;
        }
        if (probe.phase !== "api") {
          this.prompt(
            account,
            "Waiting for Google’s API page. Reload if this page does not finish loading.",
          );
          return;
        }
        if (probe.apiEnabled) {
          google.apiIndex = apiIndex + 1;
          this.persist(account);
          return;
        }
        if (google.approvedCloudScope !== scope) {
          approve();
          return;
        }
        await this.googleAction(account, "enable-api", "api" + apiIndex);
        return;
      }
      if (
        probe.phase.startsWith("service-") &&
        probe.cloudProject !== google.cloudProject
      ) {
        await this.googleNavigate(
          account,
          cloud + "/iam-admin/serviceaccounts" + query,
        );
        return;
      }
      if (probe.phase === "service-create") {
        if (!probe.formReady) {
          await this.googleAction(account, "fill-service");
          return;
        }
        if (google.approvedCloudScope !== scope) {
          approve();
          return;
        }
        await this.googleAction(account, "create-service", "service");
        return;
      }
      if (probe.phase === "service-grants") {
        if (probe.unsafePermissions) {
          this.prompt(
            account,
            "Remove project-wide IAM roles before continuing. This upload account only needs app-scoped access in Google Play.",
          );
          return;
        }
        await this.googleAction(account, "finish-service");
        return;
      }
      if (probe.phase === "service-list") {
        if (probe.serviceUrl) {
          google.serviceUrl = probe.serviceUrl;
          this.persist(account);
          await this.googleNavigate(account, probe.serviceUrl);
          return;
        }
        if (probe.servicePresent) {
          this.prompt(
            account,
            "Open the selected service account’s details on this page. The account will be reused.",
          );
          return;
        }
        if (google.submitted.service === scope) {
          this.prompt(
            account,
            "The service-account creation result is not confirmed. Reload the list; a duplicate account will not be created.",
          );
          return;
        }
        await this.googleAction(account, "open-service-create");
        return;
      }
      if (probe.phase === "key-dialog") {
        if (!selectedService || probe.cloudProject !== google.cloudProject) {
          this.prompt(
            account,
            "Verify the selected Cloud project and service account on the key dialog before continuing.",
          );
          return;
        }
        if (!probe.formReady) {
          await this.googleAction(account, "select-json");
          return;
        }
        if (google.submitted.key === scope) {
          this.prompt(
            account,
            "Google has not delivered the submitted key download. A second key will not be created automatically. Check downloads or import the JSON file.",
          );
          return;
        }
        if (google.approvedCloudScope !== scope) {
          approve();
          return;
        }
        await this.googleAction(account, "create-key", "key");
        return;
      }
      if (probe.phase === "service-details") {
        if (!selectedService) {
          this.prompt(
            account,
            "Waiting for the selected service account details. Open the matching account if this page shows a different email.",
          );
          return;
        }
        if (!/\/keys(?:\?|$)/.test(account.view.webContents.getURL())) {
          await this.googleAction(account, "open-keys");
          return;
        }
        if (google.submitted.key === scope) {
          this.prompt(
            account,
            "A key was already requested. Import its JSON file if the download was interrupted; creating another key requires a new explicit setup.",
          );
          return;
        }
        await this.googleAction(
          account,
          probe.keyMenuOpen ? "new-key" : "add-key",
        );
        return;
      }
      await this.googleNavigate(
        account,
        cloud + "/iam-admin/serviceaccounts" + query,
      );
      return;
    }
    google.stage = "play";
    if (!google.pendingCredentialId) {
      this.prompt(
        account,
        "Import or generate a Google service-account JSON key first.",
      );
      return;
    }
    if (probe.phase === "play-accounts") {
      if (probe.singleAccountOption) {
        await this.googleAction(account, "select-developer");
        return;
      }
      if (probe.accountUrl) {
        await this.googleNavigate(account, probe.accountUrl);
        return;
      }
      this.prompt(
        account,
        "Choose your Google Play developer account on this page. Enrollment, payments, and identity checks require your input.",
      );
      return;
    }
    if (!google.developerId) {
      await this.googleNavigate(
        account,
        "https://play.google.com/console/developers",
      );
      return;
    }
    const play = `https://play.google.com/console/developers/${google.developerId}`;
    if (
      google.requestNewPlayApp &&
      probe.phase === "play-apps" &&
      !probe.targetAppPresent
    ) {
      await this.googleAction(account, "open-play-create");
      return;
    }
    if (probe.phase === "play-create") {
      if (!account.attempts["play-form"]) {
        account.attempts["play-form"] = 1;
        await this.googleAction(account, "fill-play-create");
      }
      account.pendingAction = undefined;
      this.prompt(
        account,
        "The app name is prepared. Choose language, App/Game, and Free/Paid, review Google’s declarations, then create the app on this page. Automation will resume.",
      );
      return;
    }
    if (probe.phase === "play-users") {
      if (
        probe.targetUserPresent ||
        google.submitted.invite ===
          `${google.developerId}:${target.email}:${target.packageName}`
      ) {
        this.prompt(
          account,
          "The service account is listed or its invitation was submitted. Waiting for app access to propagate. If Google requires a first console upload, complete it in this app’s Play Console page; the API is checked automatically.",
        );
        return;
      }
      await this.googleAction(account, "open-invite");
      return;
    }
    if (probe.phase === "play-app-select") {
      if (probe.unsafePermissions) {
        this.prompt(
          account,
          "Another app is selected. Clear it and select only the intended package before continuing.",
        );
        return;
      }
      const scope = `${google.developerId}:${target.email}:${target.packageName}`;
      if (
        await this.googleAction(
          account,
          probe.targetAppPresent ? "apply-app" : "select-app",
        )
      )
        account.googleSelectedAppScope = scope;
      return;
    }
    if (probe.phase === "play-permissions") {
      const scope = `${google.developerId}:${target.email}:${target.packageName}`;
      if (account.googleSelectedAppScope !== scope) {
        this.note(
          account,
          "Reopening app selection to verify the exact package before preparing permissions.",
        );
        await this.googleNavigate(account, account.view.webContents.getURL());
        return;
      }
      if (probe.unsafePermissions) {
        this.prompt(
          account,
          "Remove broader permissions from this app before continuing. Only read access and testing releases are needed.",
        );
        return;
      }
      if (!probe.permissionsReady) {
        await this.googleAction(account, "select-permissions");
        return;
      }
      if (await this.googleAction(account, "apply-permissions"))
        account.googlePreparedAppScope = scope;
      return;
    }
    if (probe.phase === "play-invite-confirm") {
      const scope = `${google.developerId}:${target.email}:${target.packageName}`;
      if (
        !probe.appScoped ||
        probe.unsafePermissions ||
        google.submitted.invite !== scope
      ) {
        this.prompt(
          account,
          "The invitation confirmation does not match the prepared app-only access. Review the invitation before sending.",
        );
        return;
      }
      if (google.approvedPlayScope !== scope) {
        google.approval = "play";
        this.prompt(
          account,
          `Approve sending the prepared invitation to ${target.email} for ${target.packageName} read and testing access only.`,
        );
        return;
      }
      await this.googleAction(account, "confirm-invite", "invite-confirm");
      return;
    }
    if (probe.phase === "play-invite") {
      if (!probe.formReady) {
        await this.googleAction(account, "fill-invite");
        return;
      }
      if (probe.unsafePermissions) {
        this.prompt(
          account,
          "Google’s form includes broader permissions. Remove account-wide, production, financial, or user-management access. Only this app’s read and testing-release permissions are needed.",
        );
        return;
      }
      if (!probe.appScoped) {
        await this.googleAction(account, "open-apps");
        return;
      }
      const scope = `${google.developerId}:${target.email}:${target.packageName}`;
      if (!probe.permissionsReady && account.googlePreparedAppScope !== scope) {
        const action = probe.permissionsEditorAvailable
          ? "open-permissions"
          : "select-permissions";
        if (await this.googleAction(account, action))
          account.googleSelectedAppScope = scope;
        return;
      }
      if (google.approvedPlayScope !== scope) {
        google.approval = "play";
        this.prompt(
          account,
          `Approve granting ${target.email} read access and testing-release access for ${target.packageName} only. No production, financial, user-management, or account-wide permissions will be granted.`,
        );
        return;
      }
      await this.googleAction(account, "invite", "invite");
      return;
    }
    if (probe.phase === "play-apps") {
      const result = await this.googleAction(account, "open-users");
      if (!result)
        await this.googleNavigate(account, play + "/users-and-permissions");
      return;
    }
    await this.googleNavigate(account, play + "/users-and-permissions");
  }

  async openStore(projectId: string, request: StoreSetupRequest) {
    const state = await this.engine.storeSetupContext(projectId, request);
    for (const account of this.accounts.values())
      if (
        account.state.projectId === projectId &&
        account.state.provider === request.provider &&
        account.state.purpose === "store"
      ) {
        if (
          account.state.storeSetup?.submitted.upload &&
          !["verifying", "complete"].includes(account.state.storeSetup.stage) &&
          storeScope(account.state.storeSetup, "resume") !==
            storeScope(state, "resume")
        )
          throw Error(
            "Resume the pending console upload before choosing another artifact or workflow.",
          );
        account.host.close();
      }
    await this.open(projectId, request.provider, "store", undefined, state);
  }
  private checkedStoreUrl(url: string, provider: "apple" | "google") {
    const parsed = new URL(url);
    invariant(
      parsed.protocol === "https:" &&
        (provider === "apple"
          ? ["developer.apple.com", "appstoreconnect.apple.com"].includes(
              parsed.hostname,
            )
          : parsed.hostname === "play.google.com"),
      "STORE_DESTINATION",
      "Unexpected store setup destination.",
    );
    return parsed.href;
  }
  private storeStartUrl(state: StoreSetupState) {
    if (state.provider === "apple")
      return state.mode === "capabilities"
        ? `https://developer.apple.com/account/resources/identifiers/bundleId/edit/${encodeURIComponent(state.appId!)}`
        : "https://appstoreconnect.apple.com/apps";
    return `https://play.google.com/console/developers${state.developerId ? "/" + state.developerId + (state.appId ? "/app/" + state.appId + "/app-dashboard" : "/apps") : ""}`;
  }
  async approveStore(sender: WebContents) {
    const account = this.get(sender),
      state = account.state.storeSetup;
    invariant(
      state?.approval,
      "STORE_APPROVAL",
      "No store setup action is awaiting approval.",
    );
    invariant(
      state.approval.scope === storeScope(state, state.approval.action),
      "STORE_APPROVAL_CHANGED",
      "The app, artifact or selected account changed. Review the prepared action again.",
    );
    account.storeApprovalScope = state.approval.scope;
    state.approval = undefined;
    this.working(account, "Continuing the store action you approved…");
    await this.advance(account);
  }
  private async storeAction(
    account: AccountSession,
    action: StoreAction,
    mutation?: string,
  ) {
    const state = account.state.storeSetup!,
      fingerprint = JSON.stringify([
        action,
        state.capabilityIndex,
        state.appId,
      ]);
    if (
      account.storeLastAction?.fingerprint === fingerprint &&
      Date.now() - account.storeLastAction.time < 8000
    )
      return false;
    if (mutation && state.submitted[mutation]) {
      this.prompt(
        account,
        "The submitted action has not been confirmed. Review the provider page; it will not be sent again automatically.",
      );
      return false;
    }
    if (mutation) {
      state.submitted[mutation] = storeScope(state, mutation);
      if (mutation === "create") state.createSubmittedAt = Date.now();
      this.persist(account);
    }
    const result = await account.view.webContents.executeJavaScript(
      `(${performStoreAction.toString()})(${JSON.stringify(action)},${JSON.stringify(state)})`,
      true,
    );
    account.diagnostics.record("store.action", {
      action,
      done: result.done,
      detail: result.detail,
    });
    await account.diagnostics.snapshot(
      account.view.webContents,
      "store-" + action,
    );
    if (!result.done) {
      if (mutation) {
        delete state.submitted[mutation];
        this.persist(account);
      }
      this.prompt(
        account,
        result.detail ||
          "The next store control is not ready. Complete the highlighted provider step or retry.",
      );
      return false;
    }
    account.storeLastAction = { fingerprint, time: Date.now() };
    this.working(
      account,
      "Preparing store setup: " + action.replaceAll("-", " ") + "…",
    );
    return true;
  }
  private storeApproval(
    account: AccountSession,
    action: string,
    title: string,
    detail: string,
  ) {
    const state = account.state.storeSetup!,
      scope = storeScope(state, action);
    if (account.storeApprovalScope === scope) return true;
    state.approval = { action, scope, title, detail };
    this.prompt(account, detail);
    return false;
  }
  private async advanceStore(account: AccountSession) {
    const state = account.state.storeSetup!;
    if (state.stage === "verifying") {
      if (
        account.storeVerificationPaused &&
        account.storeWaitForPermissions &&
        [...this.accounts.values()].some(
          (item) =>
            item !== account &&
            item.state.provider === "google" &&
            item.state.status === "complete" &&
            item.state.connectedCredentialId === state.connectionId,
        )
      ) {
        account.storeVerificationPaused = false;
        account.storeWaitForPermissions = false;
        account.storeVerifyAt = undefined;
        account.storeVerifyFailures = 0;
      }
      if (
        account.storeVerificationPaused ||
        Date.now() - (account.storeVerifyAt ?? 0) < 12000
      )
        return;
      if (state.mode === "capabilities") {
        const probe = (await account.view.webContents.executeJavaScript(
          `(${inspectStorePage.toString()})(${JSON.stringify(state)})`,
        )) as StoreProbe;
        if (probe.confirmCapabilities) {
          if (
            !this.storeApproval(
              account,
              "capabilities",
              "Apply capability assignments",
              `Confirm the configured capability assignments for ${state.identity} and regenerate matching profiles?`,
            )
          )
            return;
          await this.storeAction(
            account,
            "confirm-capabilities",
            "capabilities-confirm",
          );
          return;
        }
      }
      account.storeVerifyAt = Date.now();
      try {
        const message = await this.engine.finishStoreSetup(
          account.state.projectId,
          state,
        );
        state.stage = "complete";
        state.approval = undefined;
        this.persist(account);
        account.state.status = "complete";
        account.state.message = message;
        this.note(account, message);
      } catch (error) {
        account.storeVerifyFailures = (account.storeVerifyFailures ?? 0) + 1;
        account.storeVerificationPaused =
          state.mode === "capabilities" || account.storeVerifyFailures >= 6;
        if (
          state.mode === "bootstrap" &&
          /Google Play 403|caller does not have permission/i.test(
            messageOf(error),
          ) &&
          !account.storeWaitForPermissions
        ) {
          account.storeWaitForPermissions = true;
          account.storeVerificationPaused = true;
          this.note(
            account,
            "The AAB is saved. Opening app-specific Google permissions setup; verification resumes after access is approved.",
          );
          await this.open(account.state.projectId, "google");
        }
        this.prompt(
          account,
          "Verification is pending: " +
            messageOf(error) +
            " Retry checks the same app/artifact; it will not upload or create another.",
        );
      }
      return;
    }
    const probe = (await account.view.webContents.executeJavaScript(
      `(${inspectStorePage.toString()})(${JSON.stringify(state)})`,
    )) as StoreProbe;
    const fingerprint = JSON.stringify(probe);
    if (account.lastProbe !== fingerprint) {
      account.lastProbe = fingerprint;
      account.storeLastAction = undefined;
      account.diagnostics.record("store.probe", probe);
    }
    if (probe.phase === "login") {
      this.prompt(
        account,
        "Sign in and complete MFA on the provider page. Store setup resumes automatically afterward.",
      );
      return;
    }
    if (probe.phase === "terms") {
      this.prompt(
        account,
        "Review and accept the provider agreement yourself on this page. The app will resume when you finish.",
      );
      return;
    }
    if (probe.phase === "blocked") {
      this.prompt(
        account,
        "The provider declined embedded sign-in. Use its supported external-browser sign-in fallback; do not bypass browser security checks.",
      );
      return;
    }
    const onCreateForm =
      state.mode === "record" &&
      (probe.phase === "apple-form" || probe.phase === "google-form");
    if (probe.error && onCreateForm && state.submitted.create) {
      // Give the provider a moment to replace any earlier message after submit.
      if (Date.now() - (state.createSubmittedAt ?? 0) < 4000) return;
      // The provider kept its form open with an error, so nothing was created.
      // Allow a corrected name and a fresh approval instead of waiting to verify.
      delete state.submitted.create;
      state.createSubmittedAt = undefined;
      state.staleError = undefined;
      state.rejection = probe.error;
      state.approval = undefined;
      account.storeApprovalScope = undefined;
      this.persist(account);
      this.prompt(
        account,
        `${state.provider === "apple" ? "Apple" : "Google"} did not create the app: ${probe.error} Enter a different store app name and retry.`,
      );
      return;
    }
    if (
      probe.error &&
      !(onCreateForm && !state.rejection && probe.error === state.staleError)
    ) {
      this.prompt(
        account,
        state.rejection && state.mode === "record"
          ? `${state.provider === "apple" ? "Apple" : "Google"} did not create the app: ${state.rejection} Enter a different store app name and retry.`
          : "The provider needs attention: " + probe.error,
      );
      return;
    }
    if (probe.developerId) {
      if (state.developerId && state.developerId !== probe.developerId) {
        this.prompt(
          account,
          "This is a different Play developer account. Return to the selected account before continuing.",
        );
        return;
      }
      state.developerId = probe.developerId;
    }
    if (probe.appId && state.appId && probe.appId !== state.appId) {
      this.prompt(
        account,
        "This page belongs to a different app. Return to the selected app before continuing.",
      );
      return;
    }
    if (probe.phase === "google-accounts") {
      await this.storeAction(account, "select-account");
      return;
    }
    if (state.mode === "capabilities") {
      if (probe.phase === "identifier-register") {
        if (!probe.ready) {
          await this.storeAction(account, "fill-identifier");
          return;
        }
        const identifier = state.identifiers![state.capabilityIndex ?? 0];
        if (
          !this.storeApproval(
            account,
            "register:" + identifier,
            "Register identifier",
            `Register ${identifier} on this Apple team for ${state.identity}? Existing identifiers and assignments are preserved.`,
          )
        )
          return;
        await this.storeAction(
          account,
          "register-identifier",
          "register:" + identifier,
        );
        return;
      }
      if (probe.phase === "identifier-picker") {
        if (!probe.capabilityReady) {
          if (probe.canCreateIdentifier) {
            await this.storeAction(account, "new-identifier");
            return;
          }
          this.prompt(
            account,
            "The configured identifier is not registered yet. Use Add/Register on this page; the exact identifier will be filled automatically. Existing identifiers will be preserved.",
          );
          return;
        }
        const applied = probe.existingAssignment;
        if (await this.storeAction(account, "apply-identifier")) {
          if (applied) {
            state.capabilityIndex = (state.capabilityIndex ?? 0) + 1;
            this.persist(account);
          }
        }
        return;
      }
      if (probe.phase === "capabilities" && probe.ready) {
        if ((state.capabilityIndex ?? 0) < state.identifiers!.length) {
          await this.storeAction(account, "configure-capability");
          return;
        }
        if (
          !this.storeApproval(
            account,
            "capabilities",
            "Apply capability assignments",
            `Save ${state.identifiers!.join(", ")} for ${state.identity}, then regenerate and verify its provisioning profiles? Existing assignments and certificates are preserved.`,
          )
        )
          return;
        if (
          await this.storeAction(account, "save-capabilities", "capabilities")
        ) {
          state.stage = "verifying";
          this.persist(account);
        }
        return;
      }
      if (
        Object.keys(state.submitted).some((key) =>
          key.startsWith("register:"),
        ) &&
        !state.submitted.capabilities
      ) {
        await account.view.webContents.loadURL(this.storeStartUrl(state));
        return;
      }
      this.prompt(
        account,
        "Open this exact bundle ID's capability settings. The configured container and group identifiers are shown on the left.",
      );
      return;
    }
    if (state.mode === "record") {
      if (
        (probe.phase === "app" || probe.created) &&
        probe.appId &&
        (state.submitted.create ||
          state.appId === probe.appId ||
          probe.identityMatches)
      ) {
        state.appId = probe.appId;
        state.stage = "verifying";
        this.persist(account);
        return;
      }
      if (probe.phase === "google-list" && probe.appUrl) {
        state.appId = new URL(probe.appUrl).pathname.match(/\/app\/(\d+)/)?.[1];
        this.persist(account);
        await account.view.webContents.loadURL(
          this.checkedStoreUrl(probe.appUrl, state.provider),
        );
        return;
      }
      if (probe.phase === "apple-list" || probe.phase === "google-list") {
        await this.storeAction(account, "new-app");
        return;
      }
      if (probe.phase === "apple-form" || probe.phase === "google-form") {
        if (state.submitted.create) {
          // Apple leaves the form up while it responds; only fall back to API
          // verification once the form has stayed open without an error.
          state.createSubmittedAt ??= Date.now();
          if (Date.now() - state.createSubmittedAt < 20000) return;
          if (state.provider === "apple") {
            state.stage = "verifying";
            this.persist(account);
          } else
            this.prompt(
              account,
              "App creation was submitted. Inspect the result or reload the app list; another record will not be created automatically.",
            );
          return;
        }
        if (!probe.ready) {
          await this.storeAction(account, "fill-app");
          return;
        }
        if (
          !this.storeApproval(
            account,
            "create",
            "Create app record",
            `Create ${state.appName} for ${state.identity} in ${state.provider === "apple" ? "App Store Connect" : "the selected Play developer account"}, language ${state.language}${state.provider === "google" ? `, ${state.appType}, ${state.pricing}` : ""}? Review any required declarations on the provider page before approving.`,
          )
        )
          return;
        await this.storeAction(account, "create-app", "create");
        return;
      }
    } else if (state.mode === "bootstrap") {
      if (!state.appId) {
        this.prompt(
          account,
          "Create or associate this new Play app using Store app record first, then reopen the bootstrap with the exact selected app.",
        );
        return;
      }
      if (probe.appId !== state.appId) {
        this.prompt(
          account,
          "Open the selected new app before uploading its AAB.",
        );
        return;
      }
      if (probe.internalUrl) {
        state.internalUrl = this.checkedStoreUrl(probe.internalUrl, "google");
        this.persist(account);
      }
      const onInternal =
        !!state.internalUrl &&
        new URL(account.state.url).pathname.startsWith(
          new URL(state.internalUrl).pathname,
        );
      if (!onInternal) {
        if (probe.internalUrl) {
          await this.storeAction(account, "open-internal");
        } else await this.storeAction(account, "open-testing");
        return;
      }
      if (probe.phase === "uploading") {
        this.working(
          account,
          "Uploading or processing the selected AAB. This can take several minutes. Keep this window open; the same file will not be uploaded again.",
        );
        return;
      }
      if (state.submitted.upload && probe.draftSaved) {
        state.stage = "verifying";
        this.persist(account);
        return;
      }
      if (state.submitted.upload && probe.uploaded) {
        await this.storeAction(account, "save-draft", "draft");
        return;
      }
      if (!state.submitted.upload && probe.fileInputs === 1) {
        if (
          !this.storeApproval(
            account,
            "upload",
            "Upload first AAB",
            `Upload ${state.artifact!.name} (version ${state.artifact!.buildNumber}, SHA-256 ${state.artifact!.sha256}) to app ${state.appId}, developer ${state.developerId}, internal testing, and save as a draft? This does not start a rollout.`,
          )
        )
          return;
        const path = await this.engine.bootstrapFile(
          account.state.projectId,
          state.artifactId!,
        );
        const debug = account.view.webContents.debugger;
        if (!debug.isAttached()) debug.attach("1.3");
        const root = await debug.sendCommand("DOM.getDocument");
        const nodes = await debug.sendCommand("DOM.querySelectorAll", {
          nodeId: root.root.nodeId,
          selector: 'input[type="file"]',
        });
        invariant(
          nodes.nodeIds.length === 1,
          "STORE_FILE_INPUT",
          "The upload field changed. No second file attachment will be attempted; inspect the console.",
        );
        state.submitted.upload = storeScope(state, "upload");
        state.stage = "uploading";
        this.persist(account);
        account.diagnostics.record("store.upload.started", {
          artifactId: state.artifactId,
          version: state.artifact!.buildNumber,
          size: state.artifact!.size,
        });
        await debug.sendCommand("DOM.setFileInputFiles", {
          nodeId: nodes.nodeIds[0],
          files: [path],
        });
        this.working(
          account,
          "Uploading the approved AAB. This can take several minutes; elapsed time is shown below.",
        );
        return;
      }
      if (state.submitted.upload) {
        this.prompt(
          account,
          "The upload result is not confirmed yet. Keep or reopen this console draft and inspect its version. No second upload or API edit will be attempted until the exact version is saved as an internal draft.",
        );
        return;
      }
      if (probe.phase === "release") {
        await this.storeAction(account, "new-release");
        return;
      }
    }
    if (probe.phase !== "loading")
      this.prompt(
        account,
        "Waiting for a recognized store page. Navigate to the intended app; setup resumes when the page is ready. Use Retry after correcting a provider error.",
      );
  }
  private async advance(account: AccountSession) {
    if (
      account.busy ||
      account.xcodeFailed ||
      account.host.isDestroyed() ||
      account.state.status === "complete"
    )
      return;
    if (account.downloadInProgress) return;
    account.busy = true;
    try {
      if (account.state.purpose === "store") {
        await this.advanceStore(account);
        return;
      }
      if (account.state.purpose === "xcode") {
        await this.advanceXcode(account);
        return;
      }
      if (account.state.provider === "google") {
        await this.advanceGoogle(account);
        return;
      }
      const probe = (await account.view.webContents.executeJavaScript(
        `(${inspectApplePage.toString()})()`,
      )) as AccountProbe;
      const probeKey = JSON.stringify(probe);
      if (account.lastProbe !== probeKey) {
        account.diagnostics.record("automation.probe", probe);
        account.lastProbe = probeKey;
      }
      if (probe.issuerId) account.state.issuerId = probe.issuerId;
      if (probe.teamId) account.state.teamId = probe.teamId;
      const managed = probe.keys?.find((key) =>
        /^Local Build Desk(?:\b|\s|·)/i.test(key.name),
      );
      if (managed && !account.state.keyId) {
        account.state.keyId = managed.id;
        this.note(
          account,
          "Detected the existing Local Build Desk API key; it will not be created twice.",
        );
      }
      if (account.state.keyId && !account.state.downloadedFile) {
        const existing = join(
          homedir(),
          "Downloads",
          `AuthKey_${account.state.keyId}.p8`,
        );
        if (existsSync(existing)) {
          account.state.downloadedFile = existing;
          this.note(
            account,
            "Found the matching downloaded private key and resumed setup.",
          );
        }
      }

      if (probe.phase !== account.lastPhase) {
        account.lastPhase = probe.phase;
        account.phaseSince = Date.now();
        this.note(account, `Apple setup: ${probe.phase.replace("-", " ")}.`);
        await account.diagnostics.snapshot(
          account.view.webContents,
          `phase-${probe.phase}`,
        );
      }
      this.persist(account);
      if (account.pendingAction) {
        const pending = account.pendingAction;
        if (
          pending.expected.includes(probe.phase) &&
          !(pending.type === "download-key" && probe.phase === "download")
        ) {
          account.diagnostics.record("automation.action.verified", {
            action: pending.type,
            observed: probe.phase,
          });
          account.pendingAction = undefined;
        } else if (Date.now() - pending.started < 12000) {
          this.working(
            account,
            `Waiting for Apple to finish ${pending.type.replaceAll("-", " ")}…`,
          );
          return;
        } else {
          account.diagnostics.record("automation.action.timeout", {
            action: pending.type,
            observed: probe.phase,
          });
          await account.diagnostics.snapshot(
            account.view.webContents,
            `timeout-${pending.type}`,
          );
          account.pendingAction = undefined;
        }
      }
      if (probe.phase === "login") {
        if (Date.now() - account.phaseSince < 12000) {
          this.working(account, "Restoring your Apple sign-in session…");
          return;
        }
        this.prompt(
          account,
          "Sign in to Apple and complete any MFA prompts in the page on the right. We never read your password or verification code.",
        );
        return;
      }
      if (probe.phase === "terms") {
        this.prompt(
          account,
          "Apple requires your agreement to API access. Review the terms, check the agreement box, and click Submit. Setup will resume automatically.",
        );
        return;
      }
      if (
        account.state.downloadedFile &&
        account.state.issuerId &&
        account.state.teamId &&
        account.state.keyId
      ) {
        const fingerprint = [
          account.state.downloadedFile,
          account.state.issuerId,
          account.state.teamId,
          account.state.keyId,
        ].join("|");
        if (account.lastConnectFingerprint !== fingerprint) {
          account.lastConnectFingerprint = fingerprint;
          await this.complete(account.host.webContents);
        }
        return;
      }
      if (
        account.state.downloadedFile &&
        account.state.issuerId &&
        !account.state.teamId
      ) {
        if (!account.state.url.includes("developer.apple.com")) {
          this.working(account, "Finding your Apple Developer Team ID…");
          await this.navigate(account.host.webContents, "apple-team");
          return;
        }
        await this.action(account, { type: "membership" });
        if (Date.now() - account.phaseSince > 15000)
          this.prompt(
            account,
            "Find Team ID under Apple Developer membership details, or paste it in the field on the left.",
          );
        return;
      }
      if (probe.phase === "apps") {
        this.working(
          account,
          "Apple restored your login. Returning to API access…",
        );
        await this.navigate(account.host.webContents, "apple-api");
        return;
      }
      if (probe.phase === "keys") {
        if (probe.detail === "access-required") {
          this.working(account, "Opening Apple’s API-access agreement…");
          const result = await this.action(account, { type: "request-access" });
          if (!result.done)
            this.prompt(account, "Click Request Access on the Apple page.");
          return;
        }
        const existingKey = probe.keys?.find(
          (key) => key.id === account.state.keyId,
        );
        if (existingKey) {
          if (account.state.downloadedFile) {
            this.note(
              account,
              "API key and downloaded file are ready. Continuing account verification.",
            );
            return;
          }
          if (existingKey.downloadable) {
            this.working(
              account,
              "Downloading the API key that was just generated…",
            );
            await this.action(account, {
              type: "download-key",
              keyId: existingKey.id,
            });
            return;
          }
          this.prompt(
            account,
            "This Local Build Desk key already exists and Apple no longer offers its one-time download. Choose its existing .p8 in Key details; we will not generate a duplicate key.",
          );
          return;
        }
        if (account.state.keyGenerationSubmitted) {
          if (Date.now() - account.phaseSince < 30000)
            this.working(
              account,
              "Waiting for the newly generated key to appear in Apple’s table…",
            );
          else
            this.prompt(
              account,
              "A key-generation request was already sent. The new key is not visible yet; check the diagnostics or reload this page. Another key will not be generated automatically.",
            );
          return;
        }
        this.working(account, "Opening a new team API key…");
        const result = await this.action(account, { type: "open-key-dialog" });
        if (!result.done && Date.now() - account.phaseSince > 10000)
          this.prompt(
            account,
            "Click the + or Generate API Key button beside Team Keys. Apple’s control could not be identified automatically.",
          );
        return;
      }
      if (probe.phase === "key-dialog") {
        if (account.state.keyGenerationSubmitted) {
          account.state.approvalRequired = false;
          this.prompt(
            account,
            "Apple has not confirmed the submitted key-generation request. Review any form validation error; a second key will not be generated automatically.",
          );
          return;
        }
        const ready =
          probe.form?.nameReady &&
          probe.form.adminSelected &&
          probe.form.generateEnabled;
        if (!ready) {
          account.state.approvalRequired = false;
          if ((account.attempts["fill-key-dialog"] ?? 0) < 12) {
            this.working(
              account,
              "Preparing and verifying the API key name and Admin access…",
            );
            await this.action(account, {
              type: "fill-key-dialog",
              name: "Local Build Desk",
            });
            account.attempts["fill-key-dialog"] =
              (account.attempts["fill-key-dialog"] ?? 0) + 1;
            return;
          }
          this.prompt(
            account,
            "Apple’s key form did not reach the expected state. The exact controls and failing actions are saved in diagnostics; check the highlighted Name and Access fields.",
          );
          return;
        }
        account.state.approvalRequired = !account.approvedKey;
        if (!account.approvedKey) {
          this.prompt(
            account,
            "The key form is ready and verified. Approve creating this Admin team key once; generation, download, and verification then continue automatically.",
          );
          return;
        }
        if ((account.attempts.generate ?? 0) < 3) {
          account.attempts.generate = (account.attempts.generate ?? 0) + 1;
          this.working(account, "Generating the API key you approved…");
          await this.action(account, { type: "generate-key" });
          return;
        }
        this.prompt(
          account,
          "Apple did not complete the approved key-generation request. Check the form’s validation message; its page and network failures are in diagnostics.",
        );
        return;
      }
      if (probe.phase === "download" || probe.phase === "download-confirm") {
        if ((account.attempts.download ?? 0) >= 3) {
          this.prompt(
            account,
            "Finish the key download on Apple’s page, or choose the downloaded .p8 using Key details on the left.",
          );
          return;
        }
        account.attempts.download = (account.attempts.download ?? 0) + 1;
        this.working(account, "Downloading the new API key…");
        await this.action(account, { type: "download-key" });
        return;
      }
      if (
        probe.phase === "team" &&
        account.state.downloadedFile &&
        !account.state.issuerId
      ) {
        await this.navigate(account.host.webContents, "apple-api");
        return;
      }
      if (Date.now() - account.phaseSince > 15000)
        this.prompt(
          account,
          "The next control could not be identified automatically. Complete the visible account step, or fill the key details on the left. We will resume when the page is recognized.",
        );
      this.changed(account);
    } catch (error) {
      if (account.state.purpose === "xcode") account.xcodeFailed = true;
      account.diagnostics.record("automation.error", {
        error: messageOf(error),
      });
      await account.diagnostics.snapshot(
        account.view.webContents,
        "automation-error",
      );
      this.prompt(account, `Setup needs a hand: ${messageOf(error)}`);
    } finally {
      account.busy = false;
    }
  }
}

import { app, autoUpdater as nativeUpdater } from "electron";
import electronUpdater from "electron-updater";
import type { UpdateStatus } from "../core/types";
import { invariant, messageOf } from "../core/errors";
const { autoUpdater } = electronUpdater;
const checkInterval = 4 * 60 * 60 * 1000;
const initialDelay = 15 * 1000;
// Updates come from the GitHub releases baked into app-update.yml at package
// time. Squirrel.Mac only accepts an update signed by the same Developer ID,
// so unpackaged and test builds never check.
export class Updater {
  private current: UpdateStatus;
  private timer?: NodeJS.Timeout;
  private initialTimer?: NodeJS.Timeout;
  private checking?: Promise<UpdateStatus>;
  private installing = false;
  // electron-updater reports "ready" before Squirrel.Mac has fetched the
  // update from its local proxy; only then does quitting install it.
  private staged = process.platform !== "darwin";
  private readonly waiters = new Set<() => void>();
  get isInstalling() {
    return this.installing;
  }
  constructor(
    private readonly emit: (status: UpdateStatus) => void,
    private readonly busy: () => boolean,
    enabled: boolean,
    // The desktop downloads found updates in the background. A CLI owner
    // only reports them unless `update` asks for the download.
    private readonly autoDownload = true,
  ) {
    this.current = {
      state: enabled ? "idle" : "disabled",
      currentVersion: app.getVersion(),
    };
    if (!enabled) return;
    autoUpdater.autoDownload = autoDownload;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = {
      info: (message) => console.info("[updater]", message),
      warn: (message) => console.warn("[updater]", message),
      error: (message) => console.error("[updater]", message),
    };
    autoUpdater.on("checking-for-update", () =>
      this.set({ state: "checking" }),
    );
    autoUpdater.on("update-not-available", () =>
      this.set({ state: "current" }),
    );
    autoUpdater.on("update-available", (info) =>
      this.set(
        autoUpdater.autoDownload
          ? { state: "downloading", version: info.version, percent: 0 }
          : { state: "available", version: info.version },
      ),
    );
    autoUpdater.on("download-progress", (progress) =>
      this.set({
        state: "downloading",
        version: this.current.version,
        percent: Math.floor(progress.percent),
      }),
    );
    autoUpdater.on("update-downloaded", (info) =>
      this.set({ state: "ready", version: info.version }),
    );
    autoUpdater.on("error", (error) =>
      this.set({ state: "error", error: messageOf(error) }),
    );
    nativeUpdater?.on("update-downloaded", () => {
      this.staged = true;
      this.notify();
    });
  }
  status() {
    return this.current;
  }
  start() {
    if (this.current.state === "disabled" || this.timer) return;
    this.initialTimer = setTimeout(() => void this.check(), initialDelay);
    this.initialTimer.unref();
    this.timer = setInterval(() => void this.check(), checkInterval);
    this.timer.unref();
  }
  stop() {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.timer) clearInterval(this.timer);
    this.initialTimer = undefined;
    this.timer = undefined;
  }
  // Resolves once the check settles; a found update keeps downloading in the
  // background and reports progress through emitted status changes.
  check(): Promise<UpdateStatus> {
    invariant(
      this.current.state !== "disabled",
      "UPDATES_DISABLED",
      "Updates are only available in signed release builds.",
    );
    if (["downloading", "ready"].includes(this.current.state))
      return Promise.resolve(this.current);
    this.checking ??= autoUpdater
      .checkForUpdates()
      .then((result) => {
        // A successful check can start a download that fails later. The
        // updater emits an error but also rejects this separate promise.
        // Observe it without making the check wait for the entire transfer.
        void result?.downloadPromise?.catch((error) => {
          this.set({ state: "error", error: messageOf(error) });
        });
        return this.current;
      })
      .catch((error) => {
        this.set({ state: "error", error: messageOf(error) });
        return this.current;
      })
      .finally(() => (this.checking = undefined));
    return this.checking;
  }
  install() {
    invariant(
      this.current.state === "ready",
      "UPDATE_NOT_READY",
      "No downloaded update is ready to install.",
    );
    invariant(
      !this.busy(),
      "UPDATE_BUSY",
      "Finish or cancel running builds and setup/device operations before restarting to update.",
    );
    // The app's before-quit handler shuts the engine down first; Squirrel
    // replaces the bundle once the process exits and relaunches it.
    if (this.installing) return;
    this.installing = true;
    autoUpdater.quitAndInstall(false, true);
  }
  private set(next: Omit<UpdateStatus, "currentVersion">) {
    this.current = { ...next, currentVersion: this.current.currentVersion };
    this.emit(this.current);
    this.notify();
  }
  private notify() {
    for (const wake of this.waiters) wake();
  }
  /** Checks, downloads any newer release, and resolves once it is staged so
   * that quitting this process installs it. */
  async prepare(timeoutMs: number): Promise<UpdateStatus> {
    let status = await this.check();
    if (status.state === "available") {
      this.set({ state: "downloading", version: status.version, percent: 0 });
      void autoUpdater.downloadUpdate().catch((error) => {
        this.set({ state: "error", error: messageOf(error) });
      });
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      status = this.current;
      if (status.state === "ready" && this.staged) return status;
      if (!["downloading", "ready"].includes(status.state)) return status;
      invariant(
        Date.now() < deadline,
        "UPDATE_TIMEOUT",
        `Downloading ${status.version ?? "the update"} did not finish in time. Run update again to resume.`,
      );
      await new Promise<void>((wake) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          wake();
        };
        const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
        this.waiters.add(done);
      });
    }
  }
}

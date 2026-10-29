import { app } from "electron";
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
  get isInstalling() {
    return this.installing;
  }
  constructor(
    private readonly emit: (status: UpdateStatus) => void,
    private readonly busy: () => boolean,
    enabled: boolean,
  ) {
    this.current = {
      state: enabled ? "idle" : "disabled",
      currentVersion: app.getVersion(),
    };
    if (!enabled) return;
    autoUpdater.autoDownload = true;
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
      this.set({ state: "downloading", version: info.version, percent: 0 }),
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
  }
}

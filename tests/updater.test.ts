import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
const autoUpdater = Object.assign(new EventEmitter(), {
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  autoDownload: true,
});
const nativeUpdater = new EventEmitter();
vi.mock("electron", () => ({
  app: { getVersion: () => "0.1.0" },
  autoUpdater: nativeUpdater,
}));
vi.mock("electron-updater", () => ({ default: { autoUpdater } }));
const { Updater } = await import("../src/main/updater");
beforeEach(() => {
  autoUpdater.removeAllListeners();
  nativeUpdater.removeAllListeners();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());
it("stays disabled outside signed release builds", async () => {
  const updater = new Updater(vi.fn(), () => false, false);
  expect(updater.status()).toEqual({
    state: "disabled",
    currentVersion: "0.1.0",
  });
  updater.start();
  expect(() => updater.check()).toThrow(/signed release builds/);
  expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
});
it("reports download progress and installs only once ready and idle", async () => {
  const emit = vi.fn();
  let busy = true;
  const updater = new Updater(emit, () => busy, true);
  autoUpdater.checkForUpdates.mockImplementation(async () => {
    autoUpdater.emit("checking-for-update");
    autoUpdater.emit("update-available", { version: "0.2.0" });
  });
  expect(() => updater.install()).toThrow(/No downloaded update/);
  const [first, second] = [updater.check(), updater.check()];
  expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  expect(await first).toBe(await second);
  autoUpdater.emit("download-progress", { percent: 41.7 });
  expect(updater.status()).toMatchObject({
    state: "downloading",
    version: "0.2.0",
    percent: 41,
  });
  autoUpdater.emit("update-downloaded", { version: "0.2.0" });
  expect(emit).toHaveBeenLastCalledWith({
    state: "ready",
    version: "0.2.0",
    currentVersion: "0.1.0",
  });
  expect(() => updater.install()).toThrow(/running builds/);
  busy = false;
  updater.install();
  expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
});
it("turns a failed check into a reportable status", async () => {
  const updater = new Updater(vi.fn(), () => false, true);
  autoUpdater.checkForUpdates.mockRejectedValue(new Error("offline"));
  expect(await updater.check()).toMatchObject({
    state: "error",
    error: "offline",
  });
});
it("handles a background transfer failure after the check has completed", async () => {
  let rejectDownload!: (error: Error) => void;
  const downloadPromise = new Promise<string[]>((_, reject) => {
    rejectDownload = reject;
  });
  autoUpdater.checkForUpdates.mockResolvedValue({ downloadPromise });
  const updater = new Updater(vi.fn(), () => false, true);
  await updater.check();
  rejectDownload(new Error("Connection lost during download"));
  await Promise.resolve();
  expect(updater.status()).toMatchObject({
    state: "error",
    error: "Connection lost during download",
  });
});
it("stops the startup check as well as periodic checks during shutdown", async () => {
  vi.useFakeTimers();
  autoUpdater.checkForUpdates.mockResolvedValue(null);
  const updater = new Updater(vi.fn(), () => false, true);
  updater.start();
  updater.start();
  await vi.advanceTimersByTimeAsync(15000);
  expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  updater.stop();
  updater.start();
  updater.stop();
  await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
  expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
});
it("lets a CLI owner report an update, then download and stage it on request", async () => {
  const updater = new Updater(vi.fn(), () => false, true, false);
  expect(autoUpdater.autoDownload).toBe(false);
  autoUpdater.checkForUpdates.mockImplementation(async () => {
    autoUpdater.emit("update-available", { version: "0.2.0" });
  });
  expect(await updater.check()).toMatchObject({
    state: "available",
    version: "0.2.0",
  });
  expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  autoUpdater.downloadUpdate.mockImplementation(async () => {
    autoUpdater.emit("download-progress", { percent: 50 });
    autoUpdater.emit("update-downloaded", { version: "0.2.0" });
  });
  let settled = false;
  const prepared = updater.prepare(60000).finally(() => (settled = true));
  await new Promise((wake) => setTimeout(wake, 10));
  expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  expect(updater.status().state).toBe("ready");
  // Squirrel.Mac has not fetched it from the local proxy yet, so quitting
  // now would not install it.
  if (process.platform === "darwin") {
    expect(settled).toBe(false);
    nativeUpdater.emit("update-downloaded");
  }
  expect(await prepared).toMatchObject({ state: "ready", version: "0.2.0" });
});
it("reports an up-to-date app without downloading", async () => {
  const updater = new Updater(vi.fn(), () => false, true, false);
  autoUpdater.checkForUpdates.mockImplementation(async () => {
    autoUpdater.emit("update-not-available");
  });
  expect(await updater.prepare(60000)).toMatchObject({ state: "current" });
  expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
});
it("stops waiting for a stalled download at the timeout", async () => {
  const updater = new Updater(vi.fn(), () => false, true, false);
  autoUpdater.checkForUpdates.mockImplementation(async () => {
    autoUpdater.emit("update-available", { version: "0.2.0" });
  });
  autoUpdater.downloadUpdate.mockReturnValue(new Promise(() => {}));
  await expect(updater.prepare(20)).rejects.toThrow(/did not finish in time/);
});

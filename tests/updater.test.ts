import { it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
const autoUpdater = Object.assign(new EventEmitter(), {
  checkForUpdates: vi.fn(),
  quitAndInstall: vi.fn(),
});
vi.mock("electron", () => ({ app: { getVersion: () => "0.1.0" } }));
vi.mock("electron-updater", () => ({ default: { autoUpdater } }));
const { Updater } = await import("../src/main/updater");
beforeEach(() => {
  autoUpdater.removeAllListeners();
  vi.clearAllMocks();
});
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

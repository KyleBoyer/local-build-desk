import { app, BrowserWindow } from "electron";
import { BuildTray } from "../../src/main/build-tray";
// Observe real native trays in the CLI lifecycle tests, without production IPC
// or a test-only environment switch in the application.
const refresh = BuildTray.prototype.refresh;
let lastTray = "";
BuildTray.prototype.refresh = function () {
  refresh.call(this);
  (globalThis as any).__deskTray = this;
  const tray = (this as any).tray;
  const value = tray
    ? JSON.stringify({
        count: Number(tray.getTitle()),
        visible: tray.getBounds().width > 0,
        windows: app.isReady() ? BrowserWindow.getAllWindows().length : 0,
      })
    : "idle";
  if (value !== lastTray) {
    lastTray = value;
    console.log("fixture-tray " + value);
  }
};
const dispose = BuildTray.prototype.dispose;
BuildTray.prototype.dispose = function () {
  dispose.call(this);
  console.log("fixture-tray-disposed");
};
// Test startup failures belong in captured stderr, never a modal on the user's Mac.
const fail = (error: unknown) => {
  console.error(error);
  app.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
void import("../../src/main/index").catch(fail);

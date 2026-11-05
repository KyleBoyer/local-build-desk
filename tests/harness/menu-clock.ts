// Manual native-menu acceptance fixture: no accounts, jobs or app data.
import { app, BrowserWindow, Menu } from "electron";
import { EventEmitter } from "node:events";
import { BuildTray } from "../../src/main/build-tray";
import type { Job } from "../../src/core/types";

void app.whenReady().then(() => {
  app.setActivationPolicy("accessory");
  Menu.setApplicationMenu(null);
  let fixtureWindow: BrowserWindow | undefined;
  if (process.argv.includes("--window")) {
    app.setActivationPolicy("regular");
    const window = new BrowserWindow({
      width: 560,
      height: 180,
      title: "Menu Clock Fixture",
      webPreferences: { sandbox: true },
    });
    fixtureWindow = window;
    void window.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          "<title>Menu Clock Fixture</title><body style='background:#141a20;color:#dbe2e8;font:16px system-ui;padding:24px'><a style='color:#e9b669' href='https://fixture.invalid/open-menu'>Open native build menu</a><p>Close this temporary window to finish.</p></body>",
        ),
    );
    window.on("closed", () => app.quit());
  }
  const now = Date.now();
  const job = {
    id: "menu-clock-fixture",
    projectId: "fixture",
    projectName: "Menu clock fixture",
    kind: "build",
    platform: "ios",
    profile: "production",
    stage: "upload",
    status: "running",
    createdAt: new Date(now - 3601000).toISOString(),
    startedAt: new Date(now - 3601000).toISOString(),
    stageStartedAt: new Date(now - 65000).toISOString(),
    autoSubmit: false,
    clean: false,
    progress: {
      kind: "upload",
      label: "Fixture upload",
      startedAt: new Date(now - 65000).toISOString(),
      updatedAt: new Date(now).toISOString(),
      completedBytes: 25,
      totalBytes: 100,
    },
  } as Job;
  const tray = new BuildTray(new EventEmitter(), () => [job], {
    showLogs: () => {},
    openBuild: () => app.quit(),
  });
  fixtureWindow?.webContents.on("will-navigate", (event) => {
    event.preventDefault();
    console.log("fixture-menu-requested");
    (tray as any).tray.popUpContextMenu();
    console.log("fixture-menu-returned");
  });
  app.once("before-quit", () => tray.dispose());
  setTimeout(() => app.quit(), 180000).unref();
  console.log(`Native tray fixture ready: ${process.pid}`);
});

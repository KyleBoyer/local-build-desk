import type { Job } from "../core/types";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
} from "electron";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import {
  mkdirSync,
  chmodSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, createConnection } from "node:net";
import { Engine } from "../core/engine";
import { Store } from "../core/database";
import { Vault, cleanupStaleSecrets } from "../core/vault";
import { AccountSetupManager } from "./account-setup";
import { Updater } from "./updater";
import { JobNotifications } from "./notifications";
import { BuildTray } from "./build-tray";
import { methods, type Method } from "./validation";
import { captureInvocationEnvironment } from "../cli/invocation";
import { runCLI } from "../cli/commands";
import { appleWebSession } from "./apple-web";
import { ACCOUNT_PARTITIONS, keepSessions } from "./session-keeper";
import { invariant, messageOf } from "../core/errors";
const dataRoot =
  process.env.LOCAL_BUILD_DESK_DATA_DIR ??
  join(homedir(), "Library/Application Support/Local Build Desk");
mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
app.setPath("userData", dataRoot);
const socketPath = join(dataRoot, "desk.sock");
const ownerLockPath = join(dataRoot, "owner.lock");
const cliIndex = process.argv.indexOf("--desk-cli");
const cliArgs = cliIndex >= 0 ? process.argv.slice(cliIndex + 1) : undefined;
// Preserve the caller's invocation once, then prevent its credentials from
// leaking into native processes belonging to a different forwarded client.
const cliEnvironment = cliArgs ? { ...process.env } : undefined;
let forwardedEnvironment: Record<string, string> = {};
if (cliArgs) {
  try {
    forwardedEnvironment = captureInvocationEnvironment(
      cliArgs,
      cliEnvironment!,
    );
  } catch {
    console.error(
      "Invalid invocation configuration; secret contents are excluded.",
    );
    app.exit(1);
  }
  const system = new Set([
    "HOME",
    "PATH",
    "TMPDIR",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "JAVA_HOME",
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
    "DEVELOPER_DIR",
  ]);
  for (const name of Object.keys(forwardedEnvironment))
    if (!system.has(name)) delete process.env[name];
}
const hideTestUI =
  !!process.env.LOCAL_BUILD_DESK_DATA_DIR &&
  process.env.LOCAL_BUILD_DESK_TEST_UI === "hidden";
if ((cliArgs || hideTestUI) && process.platform === "darwin")
  app.setActivationPolicy("accessory");
let engine: Engine;
let accountSetup: AccountSetupManager;
let updater: Updater;
let notifications: JobNotifications;
let buildTray: BuildTray | undefined;
let window: BrowserWindow | undefined;
/** App Store Connect's web API for App Privacy, in the desk's Apple sign-in. */
const appleWeb = appleWebSession(
  () => window,
  () => engine?.savedLogin("apple") ?? Promise.resolve(undefined),
);
// Electron's single-instance lock can admit two processes that launch at the
// same instant (parallel CI jobs), so an atomically created lock file holding
// the owner's PID decides ownership. A dead owner's lock is reclaimed.
function acquireOwnerLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(ownerLockPath, String(process.pid), {
        flag: "wx",
        mode: 0o600,
      });
      process.once("exit", releaseOwnerLock);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let pid = 0;
    try {
      pid = Number(readFileSync(ownerLockPath, "utf8"));
    } catch {
      continue;
    }
    // An empty file is a lock another process is still writing.
    if (!pid || processAlive(pid)) return false;
    try {
      if (Number(readFileSync(ownerLockPath, "utf8")) === pid)
        unlinkSync(ownerLockPath);
    } catch {}
  }
  return false;
}
function releaseOwnerLock() {
  try {
    if (readFileSync(ownerLockPath, "utf8") === String(process.pid))
      unlinkSync(ownerLockPath);
  } catch {}
}
function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
if (acquireOwnerLock()) {
  // Lets a second desktop launch focus this window.
  if (!cliArgs) app.requestSingleInstanceLock();
  startOwner();
} else if (cliArgs) {
  // The owner may still be starting, so keep trying its socket. If it exits
  // before accepting this request, take ownership instead. The owner
  // acknowledges a request before running it, so an unacknowledged request
  // never ran and is safe to send again.
  const deadline = Date.now() + 30000;
  const retry = () => {
    if (acquireOwnerLock()) startOwner();
    else setTimeout(forward, 250);
  };
  const forward = () => {
    const socket = createConnection(socketPath);
    let connected = false,
      accepted = false,
      completed = false;
    socket.on("connect", () => {
      connected = true;
      socket.write(
        JSON.stringify({
          argv: cliArgs,
          environment: forwardedEnvironment,
          cwd: process.cwd(),
        }) + "\n",
      );
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let n;
      while ((n = buffer.indexOf("\n")) >= 0) {
        const line = JSON.parse(buffer.slice(0, n));
        buffer = buffer.slice(n + 1);
        if (line.accepted) accepted = true;
        if (line.text) process.stdout.write(line.text);
        if (line.exit !== undefined) {
          completed = true;
          socket.end();
          app.exit(line.exit);
        }
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (completed) return;
      completed = true;
      if (
        !accepted &&
        (connected || ["ENOENT", "ECONNREFUSED"].includes(error.code ?? "")) &&
        Date.now() < deadline
      ) {
        retry();
        return;
      }
      console.error(
        connected
          ? "Local Build Desk stopped before returning a result. Check status before retrying a build or upload."
          : "Local Build Desk is starting. Try again in a moment.",
      );
      app.exit(1);
    });
    socket.on("end", () => {
      if (completed) return;
      completed = true;
      if (!accepted && Date.now() < deadline) {
        retry();
        return;
      }
      console.error(
        "Local Build Desk stopped before returning a result. Check status before retrying a build or upload.",
      );
      app.exit(1);
    });
  };
  forward();
} else {
  app.requestSingleInstanceLock();
  app.quit();
}
function startOwner() {
  app.on("second-instance", (_event, argv) => {
    if (!argv.includes("--desk-cli")) {
      window?.show();
      window?.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      await cleanupStaleSecrets();
      const store = new Store(dataRoot);
      const vault = new Vault(store, {
        async encrypt(value) {
          invariant(
            safeStorage.isEncryptionAvailable(),
            "KEYCHAIN_LOCKED",
            "macOS Keychain encryption is unavailable. Unlock your login keychain.",
          );
          return safeStorage.encryptString(value);
        },
        async decrypt(value) {
          invariant(
            safeStorage.isEncryptionAvailable(),
            "KEYCHAIN_LOCKED",
            "Unlock your macOS login keychain.",
          );
          return safeStorage.decryptString(value);
        },
      });
      engine = new Engine(store, vault);
      // Apple and Google sign-ins survive restarts while they're still valid.
      for (const partition of ACCOUNT_PARTITIONS) keepSessions(partition);
      buildTray = new BuildTray(
        engine,
        () => store.list<Job>("jobs"),
        {
          openBuild: cliArgs ? undefined : (jobId) => void openBuild(jobId),
          showLogs: (jobId) =>
            shell.showItemInFolder(join(dataRoot, "jobs", jobId, "logs.jsonl")),
        },
        hideTestUI || process.platform !== "darwin",
      );
      app.once("will-quit", () => buildTray?.dispose());
      if (!cliArgs) {
        notifications = new JobNotifications(
          store,
          (jobId) => void openBuild(jobId),
          hideTestUI,
        );
        engine.on("event", (event) => {
          if (event.type === "state") notifications.scan();
        });
      }
      engine.start();
      notifications?.scan();
      if (!cliArgs) void notifications.restoreHistory();
      try {
        unlinkSync(socketPath);
      } catch {}
      const clients = new Set<import("node:net").Socket>();
      const drained = new Set<() => void>();
      let activeRequests = 0;
      const server = createServer((socket) => {
        socket.on("error", () => socket.destroy());
        clients.add(socket);
        socket.on("close", () => {
          clients.delete(socket);
          if (!clients.size && !activeRequests)
            for (const ready of drained) ready();
        });
        socket.setTimeout(10000, () => socket.destroy());
        let buffer = "";
        socket.on("data", async (chunk) => {
          buffer += chunk.toString();
          if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) {
            socket.destroy();
            return;
          }
          const n = buffer.indexOf("\n");
          if (n < 0) return;
          socket.setTimeout(0);
          socket.removeAllListeners("data");
          socket.write(JSON.stringify({ accepted: true }) + "\n");
          activeRequests++;
          try {
            const request = JSON.parse(buffer.slice(0, n));
            const args = Array.isArray(request) ? request : request.argv;
            const environment = Array.isArray(request)
              ? {}
              : (request.environment ?? {});
            invariant(
              environment &&
                typeof environment === "object" &&
                !Array.isArray(environment) &&
                Object.values(environment).every(
                  (value) => typeof value === "string",
                ),
              "CLI_ENV",
              "Invalid invocation environment.",
            );
            invariant(
              Array.isArray(args) && args.every((a) => typeof a === "string"),
              "CLI_ARGS",
              "Invalid CLI request.",
            );
            const cwd = Array.isArray(request) ? process.cwd() : request.cwd;
            invariant(
              cwd === undefined || typeof cwd === "string",
              "CLI_CWD",
              "Invalid invocation working directory.",
            );
            const code = await runCLI(
              engine,
              args,
              (text) => {
                if (!socket.destroyed)
                  socket.write(JSON.stringify({ text }) + "\n");
              },
              { environment, cwd, appleWeb },
            );
            socket.end(JSON.stringify({ exit: code }) + "\n");
          } catch (error) {
            socket.end(
              JSON.stringify({ text: messageOf(error) + "\n", exit: 1 }) + "\n",
            );
          } finally {
            activeRequests--;
            if (!clients.size && !activeRequests)
              for (const ready of drained) ready();
          }
        });
      });
      server.listen(socketPath, () => chmodSync(socketPath, 0o600));
      server.on("error", (error) =>
        console.error("CLI socket:", error.message),
      );
      if (cliArgs) {
        app.dock?.hide();
        let exitPromise: Promise<void> | undefined;
        const finish = (code: number): Promise<void> => {
          if (exitPromise) return exitPromise;
          exitPromise = (async () => {
            buildTray?.dispose();
            await engine.shutdown();
            server.close();
            try {
              unlinkSync(socketPath);
            } catch {}
            store.close();
            releaseOwnerLock();
            app.exit(code);
          })();
          return exitPromise;
        };
        const owningJobs = new Set<string>();
        let interruptedCode: number | undefined;
        process.once("SIGINT", () => {
          interruptedCode = 130;
          for (const jobId of owningJobs) engine.cancel(jobId);
        });
        process.once("SIGTERM", () => void finish(143));
        const code = await runCLI(
          engine,
          cliArgs,
          (text) => process.stdout.write(text),
          {
            environment: cliEnvironment,
            appleWeb,
            onJobs: (ids) => {
              for (const id of ids) {
                owningJobs.add(id);
                if (interruptedCode) engine.cancel(id);
              }
            },
          },
        );
        if (exitPromise) {
          await exitPromise;
          return;
        }
        // Forwarded builds can outlive the request that originally launched
        // this headless owner. Never shut their native processes down early.
        if (clients.size || activeRequests)
          await new Promise<void>((ready) => drained.add(ready));
        if (exitPromise) {
          await exitPromise;
          return;
        }
        await engine.idle();
        // Stop accepting requests, then serve any that arrived meanwhile.
        // Clients that are refused from here on retry and take ownership.
        server.close();
        if (clients.size || activeRequests)
          await new Promise<void>((ready) => drained.add(ready));
        await engine.idle();
        await finish(interruptedCode ?? code);
        return;
      }
      accountSetup = new AccountSetupManager(engine, () => window, {
        hidden: hideTestUI,
      });
      updater = new Updater(
        (update) => {
          if (window && !window.isDestroyed())
            window.webContents.send("desk:event", { type: "update", update });
        },
        () => engine.isBusy(),
        app.isPackaged &&
          !hideTestUI &&
          !process.env.LOCAL_BUILD_DESK_DISABLE_UPDATES,
      );
      registerIPC();
      await createWindow();
      updater.start();
      app.on("activate", () => {
        if (!BrowserWindow.getAllWindows().length) void createWindow();
      });
      let quitReady = false;
      app.on("before-quit", (event) => {
        if (quitReady) return;
        event.preventDefault();
        updater.stop();
        buildTray?.dispose();
        void engine.shutdown().finally(() => {
          server.close();
          try {
            unlinkSync(socketPath);
          } catch {}
          store.close();
          releaseOwnerLock();
          quitReady = true;
          app.quit();
        });
      });
    })
    .catch((error) => {
      console.error(error);
      buildTray?.dispose();
      releaseOwnerLock();
      app.exit(1);
    });
  app.on("window-all-closed", () => {
    app.quit();
  });
}
async function openBuild(jobId: string) {
  if (!window || window.isDestroyed()) await createWindow();
  if (window!.isMinimized()) window!.restore();
  window!.show();
  window!.focus();
  window!.webContents.send("desk:event", { type: "focus-job", jobId });
}
async function createWindow() {
  window = new BrowserWindow({
    show: !hideTestUI,
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 740,
    backgroundColor: "#0c1014",
    title: "Local Build Desk",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 20 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  engine.on("event", (event) => {
    if (window && !window.isDestroyed())
      window.webContents.send("desk:event", event);
  });
  if (process.env.ELECTRON_RENDERER_URL)
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await window.loadFile(join(__dirname, "../renderer/index.html"));
}
function registerIPC() {
  ipcMain.handle(
    "desk:invoke",
    async (event, method: Method, args: unknown[]) => {
      try {
        const isMain =
          window &&
          event.sender === window.webContents &&
          event.senderFrame === window.webContents.mainFrame;
        const isAccount =
          accountSetup?.owns(event.sender) &&
          event.senderFrame === event.sender.mainFrame;
        const accountMethods = [
          "accountState",
          "revealAccountDiagnostics",
          "retryAccountAutomation",
          "accountNavigate",
          "updateAccountSetup",
          "approveAccountKey",
          "approveGoogleSetup",
          "approveStoreSetup",
          "approveXcodeLicense",
          "completeAccountSetup",
          "closeAccountSetup",
          "choose",
        ];
        invariant(
          isMain || (isAccount && accountMethods.includes(method)),
          "IPC_SENDER",
          "Unexpected caller.",
        );
        invariant(
          Object.prototype.hasOwnProperty.call(methods, method),
          "IPC_METHOD",
          "Unknown method.",
        );
        const values = methods[method].parse(args) as any[];
        if (method === "openAccountSetup") {
          await accountSetup.open(
            values[0],
            values[1],
            "connection",
            values[2],
          );
          return { ok: true };
        }
        if (method === "openStoreSetup") {
          await accountSetup.openStore(values[0], values[1]);
          return { ok: true };
        }
        if (method === "approveStoreSetup") {
          await accountSetup.approveStore(event.sender);
          return { ok: true };
        }
        if (method === "openXcodeDownload") {
          await accountSetup.open(values[0], "apple", "xcode");
          return { ok: true };
        }
        if (method === "approveXcodeLicense") {
          await accountSetup.approveXcodeLicense(event.sender);
          return { ok: true };
        }
        if (method === "revealAccountDiagnostics") {
          shell.showItemInFolder(accountSetup.diagnosticsPath(event.sender));
          return { ok: true };
        }
        if (method === "retryAccountAutomation") {
          accountSetup.retry(event.sender);
          return { ok: true };
        }
        if (method === "accountState")
          return { ok: true, value: accountSetup.state(event.sender) };
        if (method === "accountNavigate") {
          await accountSetup.navigate(event.sender, values[0]);
          return { ok: true };
        }
        if (method === "updateAccountSetup") {
          accountSetup.update(event.sender, values[0]);
          return { ok: true };
        }
        if (method === "approveGoogleSetup") {
          await accountSetup.approveGoogle(event.sender);
          return { ok: true };
        }
        if (method === "approveAccountKey") {
          await accountSetup.approveKey(event.sender);
          return { ok: true };
        }
        if (method === "completeAccountSetup") {
          await accountSetup.complete(event.sender);
          return { ok: true };
        }
        if (method === "closeAccountSetup") {
          accountSetup.get(event.sender).host.close();
          return { ok: true };
        }
        if (method === "choose") {
          const options = values[0];
          const result = await dialog.showOpenDialog(
            BrowserWindow.fromWebContents(event.sender)!,
            {
              properties:
                options.kind === "directory"
                  ? ["openDirectory"]
                  : options.kind === "files"
                    ? ["openFile", "multiSelections"]
                    : ["openFile"],
              filters: options.extensions?.length
                ? [{ name: "Supported files", extensions: options.extensions }]
                : undefined,
            },
          );
          return { ok: true, value: result.filePaths };
        }
        if (method === "reveal") {
          const path = resolve(values[0]);
          const allowed = [
            dataRoot,
            ...engine.state().artifacts.map((a) => a.path),
            ...engine.state().projects.map((p) => p.path),
            ...engine
              .state()
              .projects.flatMap((p) =>
                p.settings.buildDirectory
                  ? [resolve(p.settings.buildDirectory)]
                  : [],
              ),
          ];
          invariant(
            allowed.some(
              (root) => path === root || path.startsWith(root + sep),
            ),
            "REVEAL_PATH",
            "Path is outside imported projects and build storage.",
          );
          shell.showItemInFolder(path);
          return { ok: true };
        }
        if (method === "updateStatus")
          return { ok: true, value: updater.status() };
        if (method === "notificationSettings")
          return { ok: true, value: notifications.settings(values[0]) };
        if (method === "exportBuildSettings") {
          const selected = await dialog.showSaveDialog(window!, {
            title: "Export portable build settings",
            defaultPath: "ios-submit.json",
            filters: [{ name: "Build settings", extensions: ["json"] }],
          });
          if (selected.canceled || !selected.filePath)
            return { ok: true, value: false };
          await (
            await import("node:fs/promises")
          ).writeFile(
            selected.filePath,
            engine.portableBuildSettings(values[0]),
            { mode: 0o600 },
          );
          return { ok: true, value: true };
        }
        if (method === "importBuildSettings") {
          const selected = await dialog.showOpenDialog(window!, {
            title: "Import build settings",
            properties: ["openFile"],
            filters: [{ name: "Build settings", extensions: ["json"] }],
          });
          if (selected.filePaths[0])
            engine.loadBuildSettings(
              values[0],
              await (
                await import("node:fs/promises")
              ).readFile(selected.filePaths[0], "utf8"),
            );
          return { ok: true };
        }
        if (method === "exportBackup") {
          const selected = await dialog.showSaveDialog(window!, {
            title: "Create encrypted Local Build Desk backup",
            defaultPath: "Local-Build-Desk.lbdbackup",
            filters: [
              { name: "Encrypted desk backup", extensions: ["lbdbackup"] },
            ],
          });
          if (selected.canceled || !selected.filePath) return { ok: true };
          const path = selected.filePath.endsWith(".lbdbackup")
            ? selected.filePath
            : selected.filePath + ".lbdbackup";
          return {
            ok: true,
            value: await engine.exportBackupFile(path, values[0]),
          };
        }
        if (method === "previewBackup") {
          const selected = await dialog.showOpenDialog(window!, {
            title: "Restore encrypted Local Build Desk backup",
            properties: ["openFile"],
            filters: [
              { name: "Encrypted desk backup", extensions: ["lbdbackup"] },
            ],
          });
          return {
            ok: true,
            value: selected.filePaths[0]
              ? await engine.previewBackupFile(selected.filePaths[0], values[0])
              : undefined,
          };
        }
        if (method === "testNotification") {
          const latest = engine.store
            .list<Job>("jobs")
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
          notifications.show(
            "Local Build Desk notifications",
            latest
              ? "Click to open your most recent build."
              : "Build and upload results will appear here.",
            latest?.id,
          );
          return { ok: true };
        }
        if (method === "checkForUpdates")
          return { ok: true, value: await updater.check() };
        if (method === "installUpdate") {
          updater.install();
          return { ok: true };
        }
        if (method === "openExternal") {
          const url = new URL(values[0]);
          invariant(
            url.protocol === "https:" &&
              [
                "developer.apple.com",
                "appstoreconnect.apple.com",
                "play.google.com",
                "console.cloud.google.com",
                "docs.expo.dev",
                "developer.android.com",
                "www.oracle.com",
                "adoptium.net",
                "apps.apple.com",
                "brew.sh",
                "cloud.google.com",
                "docs.cloud.google.com",
              ].includes(url.hostname),
            "EXTERNAL_URL",
            "This external link is not allowed.",
          );
          await shell.openExternal(url.href);
          return { ok: true };
        }
        const callable = (engine as any)[method];
        invariant(
          typeof callable === "function",
          "IPC_METHOD",
          "Method is not implemented.",
        );
        return { ok: true, value: await callable.apply(engine, values) };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
  );
}

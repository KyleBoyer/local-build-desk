import { test, expect, _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  rm,
  readFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { Store } from "../../src/core/database";
import type { Job } from "../../src/core/types";
/** A solid-colour PNG for capture fixtures. */
function png(width: number, height: number, rgb: [number, number, number]) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: width }, () => rgb).flat()),
  ]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port as number;
}
test("pairs a phone viewport with the real desktop, streams progress/logs and shows store assets without desktop privileges", async () => {
  await build({
    entryPoints: ["tests/harness/mobile-monitor.ts"],
    outfile: "out/tests/mobile-monitor.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    packages: "external",
  });
  const root = await mkdtemp(join(tmpdir(), "desk-mobile-ui-")),
    state = join(root, "data"),
    source = join(root, "source");
  await mkdir(source, { recursive: true });
  const store = new Store(state),
    now = new Date().toISOString();
  store.putProject({
    id: "project",
    name: "Crease",
    path: source,
    bundleId: "com.example.fixture",
    packageName: "com.example.fixture",
    version: "1.0",
    profiles: ["production"],
    createdAt: now,
    platforms: ["ios", "android"],
    settings: {
      appleConnectionId: "apple-fixture",
      googleConnectionId: "google-fixture",
      releaseChecks: {
        enabled: true,
        required: false,
        runner: "command",
        command: ["npm", "run", "verify"],
        onlyTesting: [],
        timeoutSeconds: 1800,
        destinations: [{ deviceType: "iPhone 18 Pro Max", runtime: "27.2" }],
        androidDevices: [{ device: "pixel_9_pro" }],
        androidCaptureTask: ":app:assembleDebug",
        screenshotPlanFile: "assets/store/screenshots.json",
      },
    },
  });
  // A finished check run with framed store images and their raw captures.
  const captures = join(root, "captures");
  await mkdir(captures, { recursive: true });
  const shot = async (
    name: string,
    rgb: [number, number, number],
    framed: [number, number, number],
  ) => {
    const raw = png(66, 143, rgb),
      store = png(66, 143, framed);
    await writeFile(join(captures, `${name}.png`), raw);
    await writeFile(join(captures, `${name}-framed.png`), store);
    return {
      name,
      path: join(captures, `${name}.png`),
      sha256: createHash("sha256").update(raw).digest("hex"),
      size: raw.length,
      width: 66,
      height: 143,
      device: "iPhone 18 Pro Max",
      runtime: "27.2",
      framed: {
        path: join(captures, `${name}-framed.png`),
        sha256: createHash("sha256").update(store).digest("hex"),
        size: store.length,
      },
    };
  };
  store.putJob({
    id: "checks",
    projectId: "project",
    projectName: "Crease",
    platform: "ios",
    profile: "production",
    kind: "test",
    status: "succeeded",
    stage: "complete",
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    checkpoints: [],
    validation: {
      configuration: "Release",
      state: "passed",
      mode: "all",
      fingerprint: "f".repeat(64),
      sourceHash: "c".repeat(64),
      policyDigest: "d".repeat(64),
      startedAt: now,
      finishedAt: new Date(Date.parse(now) + 245000).toISOString(),
      runs: [
        { device: "Project command", status: "passed" },
        {
          device: "iPhone 18 Pro Max",
          runtime: "27.2",
          status: "passed",
          attachments: captures,
        },
      ],
      screenshots: [
        await shot("title", [40, 30, 60], [200, 60, 60]),
        await shot("win", [40, 60, 30], [60, 60, 200]),
      ],
    },
  } as unknown as Job);
  store.putJob({
    id: "job",
    projectId: "project",
    projectName: "Crease",
    platform: "ios",
    profile: "production",
    kind: "build",
    status: "succeeded",
    stage: "complete",
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    version: "1.0",
    buildNumber: "8",
    checkpoints: [],
    validation: {
      configuration: "Release",
      state: "passed",
      mode: "screenshots",
      runs: [
        {
          device: "iPhone 17",
          runtime: "27.2",
          status: "passed",
          passed: 3,
          failed: 0,
        },
      ],
      screenshots: [],
    },
  } as unknown as Job);
  store.close();
  await mkdir(join(state, "jobs/job"), { recursive: true });
  const logfile = join(state, "jobs/job/logs.jsonl");
  const lines = (start: number, count: number) =>
    Array.from({ length: count }, (_, i) =>
      JSON.stringify({
        time: now,
        stage: "compile",
        text: `Build line ${start + i} apiKey=private-test-secret ${source}`,
      }),
    ).join("\n") + "\n";
  await writeFile(logfile, lines(0, 100));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOCAL_BUILD_DESK_DATA_DIR: state,
    LOCAL_BUILD_DESK_TEST_UI: "hidden",
    LOCAL_BUILD_DESK_DISABLE_UPDATES: "true",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [resolve("out/tests/mobile-monitor.cjs")],
    env: env as Record<string, string>,
  });
  try {
    const desktop = await app.firstWindow();
    await desktop
      .getByRole("button", { name: "Preferences", exact: true })
      .click();
    const prefs = desktop.getByRole("region", { name: "Mobile monitoring" });
    await expect(
      prefs.getByRole("heading", { name: "Mobile monitoring" }),
    ).toBeVisible();
    await prefs.getByLabel("Listen address").selectOption("127.0.0.1");
    await prefs.getByLabel("Connection security").selectOption("off");
    await prefs
      .getByLabel("Port", { exact: true })
      .fill(String(await freePort()));
    await prefs.getByRole("button", { name: "Start mobile monitor" }).click();
    await expect(
      prefs.getByAltText("Scan to pair this phone with Local Build Desk"),
    ).toBeVisible();
    const pairing = await desktop.evaluate(() => window.desk.mobilePairing());
    const before = app.windows().length;
    await app.evaluate(({ BrowserWindow }, url) => {
      const window = new BrowserWindow({
        width: 390,
        height: 844,
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      void window.loadURL(url);
    }, pairing.url);
    await expect.poll(() => app.windows().length).toBe(before + 1);
    const phone = app.windows().find((p) => p !== desktop)!;
    await phone.setViewportSize({ width: 390, height: 844 });
    const errors: string[] = [];
    phone.on("pageerror", (e) => errors.push(e.message));
    await expect(
      phone.getByRole("navigation", { name: "Mobile navigation" }),
    ).toBeVisible();
    await expect(phone.getByText("Live", { exact: true })).toBeVisible();
    expect(await phone.evaluate(() => typeof (window as any).desk)).toBe(
      "undefined",
    );
    await expect(
      phone.getByRole("heading", { name: "Crease", exact: true }).first(),
    ).toBeVisible();
    expect(
      await phone.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
    await app.evaluate(() => {
      const engine = (globalThis as any).__mobileEngine,
        job = engine.store.get("jobs", "job");
      engine.store.putJob({
        ...job,
        status: "running",
        stage: "upload",
        finishedAt: undefined,
        progress: {
          kind: "upload",
          label: "Uploading IPA",
          percent: 45,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      engine.emit("event", { type: "state" });
    });
    await expect(phone.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "45",
    );
    await expect(phone.getByText("45%", { exact: true })).toBeVisible();
    await phone.screenshot({
      path: "test-results/mobile-now.png",
      fullPage: true,
    });
    await app.evaluate(() => {
      const e = (globalThis as any).__mobileEngine,
        j = e.store.get("jobs", "job");
      e.store.putJob({
        ...j,
        status: "needs-attention",
        submission: {
          state: "accepted",
          destination: "TestFlight",
          message: "Tester distribution needs attention",
        },
      });
      e.emit("event", { type: "state" });
    });
    await expect(
      phone.getByRole("heading", { name: "Needs a look" }),
    ).toBeVisible();
    await expect(
      phone
        .locator(".m-badge.danger")
        .filter({ hasText: "Needs attention" })
        .first(),
    ).toBeVisible();
    await app.evaluate(() => {
      const e = (globalThis as any).__mobileEngine,
        j = e.store.get("jobs", "job");
      e.store.putJob({
        ...j,
        status: "succeeded",
        stage: "complete",
        progress: undefined,
        submission: undefined,
      });
      e.emit("event", { type: "state" });
    });
    await phone.getByRole("button", { name: "History", exact: true }).click();
    await phone.getByLabel("Search build history").fill("8");
    await expect(phone.locator(".m-job")).toHaveCount(1);
    await phone.locator(".m-job").click();
    await phone.getByRole("button", { name: "logs", exact: true }).click();
    await expect(phone.getByLabel("Build logs")).toContainText("Build line 99");
    await expect(phone.getByLabel("Build logs")).not.toContainText(
      "private-test-secret",
    );
    await phone.getByLabel("Search loaded logs").fill("line 99");
    await expect(phone.locator(".m-log-line")).toHaveCount(1);
    await phone.getByLabel("Search loaded logs").fill("");
    await phone.evaluate(() => window.scrollTo(0, 0));
    const scroll = await phone.evaluate(() => window.scrollY);
    await appendFile(logfile, lines(100, 5));
    await expect(phone.getByLabel("Build logs")).toContainText(
      "Build line 104",
    );
    expect(await phone.evaluate(() => window.scrollY)).toBe(scroll);
    await phone.getByRole("button", { name: "Checks", exact: true }).click();
    await expect(phone.getByText("3 passed · 0 failed · passed")).toBeVisible();
    await phone.getByRole("button", { name: "Back", exact: true }).click();
    await phone.getByRole("button", { name: "Releases", exact: true }).click();
    await phone
      .locator(".m-store-list>button")
      .filter({ hasText: "Build 3" })
      .click();
    const shot = phone.getByAltText("review-home.png", { exact: true });
    await expect(shot).toBeVisible();
    await expect
      .poll(() => shot.evaluate((i: HTMLImageElement) => i.naturalWidth))
      .toBe(1);
    await shot.click();
    await expect(
      phone.getByRole("dialog", { name: "review-home.png" }),
    ).toBeVisible();
    await phone.keyboard.press("Escape");
    await expect(phone.getByRole("dialog")).toHaveCount(0);
    await phone.screenshot({
      path: "test-results/mobile-store-review.png",
      fullPage: true,
    });
    const warm = await app.evaluate(() => ({
      reads: (globalThis as any).__storeHistoryReads.length,
      images: (globalThis as any).__storeHistoryImageFetches,
    }));
    // Checks: one card per project, then the run's results on a tap.
    await phone.getByRole("button", { name: "Checks", exact: true }).click();
    await expect(phone.getByRole("heading", { name: "Crease" })).toBeVisible();
    const ios = phone.getByRole("button", {
      name: "Crease iOS checks: passed, tests passed · 2 screenshots",
    });
    await expect(ios).toBeVisible();
    await expect(phone.locator(".m-check-platform.empty")).toContainText(
      "Android",
    );
    await phone.getByText("What runs", { exact: true }).click();
    await expect(
      phone.getByText("npm run verify", { exact: true }),
    ).toBeVisible();
    await expect(
      phone.getByText("assets/store/screenshots.json", { exact: true }),
    ).toBeVisible();
    await phone.screenshot({
      path: "test-results/mobile-checks.png",
      fullPage: true,
    });
    await ios.click();
    await expect(
      phone.getByRole("button", { name: "Checks", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      phone.getByText("tests passed · 2 screenshots · 4m 05s"),
    ).toBeVisible();
    const pixel = (alt: string) =>
      phone
        .getByAltText(alt, { exact: true })
        .evaluate(async (img: HTMLImageElement) => {
          await img.decode();
          const c = document.createElement("canvas");
          c.width = c.height = 1;
          const g = c.getContext("2d")!;
          g.drawImage(img, 5, 5, 1, 1, 0, 0, 1, 1);
          return [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)];
        });
    // Store images by default, raw captures on request.
    await expect.poll(() => pixel("title")).toEqual([200, 60, 60]);
    const command = phone.locator(".m-check-run").first();
    await expect(command.locator("strong")).toHaveText("Test command");
    await expect(command.locator("span")).toHaveText("tests passed");
    await phone.getByRole("button", { name: "Raw", exact: true }).click();
    await expect.poll(() => pixel("title")).toEqual([40, 30, 60]);
    await phone.screenshot({
      path: "test-results/mobile-check-run.png",
      fullPage: true,
    });
    await phone.getByRole("button", { name: "Back", exact: true }).click();
    await expect(phone.getByRole("heading", { name: "Checks." })).toBeVisible();
    await phone.getByRole("button", { name: "Projects", exact: true }).click();
    await phone.screenshot({
      path: "test-results/mobile-projects.png",
      fullPage: true,
    });
    await phone.getByRole("button", { name: "Releases", exact: true }).click();
    await expect(phone.getByText(/Saved copy/)).toBeVisible();
    await phone
      .locator(".m-store-list>button")
      .filter({ hasText: "Build 3" })
      .click();
    const cachedShot = phone.getByAltText("review-home.png", { exact: true });
    await expect(cachedShot).toBeVisible();
    await expect
      .poll(() => cachedShot.evaluate((i: HTMLImageElement) => i.naturalWidth))
      .toBe(1);
    expect(
      await app.evaluate(() => (globalThis as any).__storeHistoryReads.length),
    ).toBe(warm.reads);
    expect(
      await app.evaluate(() => (globalThis as any).__storeHistoryImageFetches),
    ).toBe(warm.images);
    await app.evaluate(() => {
      (globalThis as any).__storeHistoryDelay = 150;
      (globalThis as any).__storeHistoryState = "IN_REVIEW";
      for (const entry of (
        globalThis as any
      ).__mobileEngine._storeReads.memory.values())
        entry.fetchedAt -= 16 * 60 * 1000;
    });
    await phone.getByRole("button", { name: "Projects", exact: true }).click();
    await phone.getByRole("button", { name: "Releases", exact: true }).click();
    await expect(phone.getByText(/Checking for updates/)).toBeVisible();
    await expect(
      phone.locator(".m-store-list>button").filter({ hasText: "Build 3" }),
    ).toContainText(/in review/i, { timeout: 15000 });
    await app.evaluate(() => {
      (globalThis as any).__storeHistoryDelay = 0;
    });
    await phone
      .getByRole("button", { name: "TestFlight", exact: true })
      .click();
    await phone
      .locator(".m-store-list>button")
      .filter({ hasText: "Build 4" })
      .click();
    await expect(
      phone.getByText("Try the new TestFlight action."),
    ).toBeVisible();
    await phone
      .getByRole("button", { name: "Google Play", exact: true })
      .click();
    await phone
      .locator(".m-store-list>button")
      .filter({ hasText: "Build 4" })
      .click();
    await expect(phone.getByAltText("phoneScreenshots 1")).toBeVisible();
    const config = await desktop.evaluate(
      async () => (await window.desk.mobileStatus()).config,
    );
    await desktop.evaluate(
      (config) =>
        window.desk.configureMobileMonitor({ ...config, enabled: false }),
      config,
    );
    await expect(
      phone.getByText("Reconnecting", { exact: true }),
    ).toBeVisible();
    await desktop.evaluate(
      (config) => window.desk.configureMobileMonitor(config),
      config,
    );
    await expect(phone.getByText("Live", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await desktop.evaluate(() => window.desk.revokeMobileDevice());
    await expect(
      phone.getByRole("button", { name: "Connect to my Mac" }),
    ).toBeVisible();
    expect(errors).toEqual([]);
    await prefs.getByRole("button", { name: "Stop monitor" }).click();
    await expect(prefs.getByText("Stopped", { exact: true })).toBeVisible();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a background monitor opens the desktop on a second launch and survives closing its last window", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-monitor-daemon-ui-")),
    state = join(root, "data");
  const { writeMonitorConfig, defaultMonitorConfig } =
    await import("../../src/mobile/config");
  const port = await freePort();
  writeMonitorConfig(state, {
    ...defaultMonitorConfig,
    enabled: true,
    tls: "off",
    port,
  });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOCAL_BUILD_DESK_DATA_DIR: state,
    LOCAL_BUILD_DESK_TEST_UI: "hidden",
    LOCAL_BUILD_DESK_DISABLE_UPDATES: "true",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [resolve("out/main/index.js"), "--desk-monitor-daemon"],
    env: env as Record<string, string>,
  });
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
    expect(app.windows()).toHaveLength(0);
    const { spawn } = await import("node:child_process");
    const child = spawn(
      resolve(
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
      [resolve("out/main/index.js")],
      { env, stdio: "ignore" },
    );
    expect(await new Promise<number | null>((r) => child.on("close", r))).toBe(
      0,
    );
    const page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: "Preferences", exact: true }),
    ).toBeVisible();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await expect.poll(() => app.windows().length).toBe(0);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

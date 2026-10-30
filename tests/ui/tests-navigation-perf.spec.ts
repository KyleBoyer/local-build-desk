import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../src/core/database";
import { LOG_PAGE_ENTRIES, type Job } from "../../src/core/types";

test("Tests navigation keeps its form mounted and preserves unsaved edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-tests-navigation-"));
  const source = join(root, "source"),
    state = join(root, "state");
  await mkdir(join(source, "node_modules/expo/bin"), { recursive: true });
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { expo: "58.0.0" } }),
  );
  await writeFile(
    join(source, "node_modules/expo/bin/cli"),
    `console.log(JSON.stringify({name:'Fixture',slug:'fixture',version:'1.0',ios:{bundleIdentifier:'com.example.fixture'}}))`,
  );
  await writeFile(
    join(source, "eas.json"),
    JSON.stringify({ build: { production: {} } }),
  );
  const store = new Store(state);
  store.putProject({
    id: "project",
    name: "Fixture",
    path: source,
    version: "1.0",
    bundleId: "com.example.fixture",
    profiles: ["production"],
    createdAt: "now",
    settings: {
      releaseChecks: {
        enabled: true,
        required: true,
        runner: "xcode",
        onlyTesting: [],
        timeoutSeconds: 1800,
        destinations: ["phone", "tablet"].map((device) => ({
          deviceType: device,
          runtime: "27.2",
        })),
        screenshots: {
          appearance: "light",
          language: "en",
          locale: "en_US",
          captures: [
            {
              name: "home",
              launchArguments: ["--demo"],
              launchEnvironment: {},
              steps: [],
            },
          ],
        },
      },
    },
  });
  store.close();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOCAL_BUILD_DESK_DATA_DIR: state,
    LOCAL_BUILD_DESK_TEST_UI: "hidden",
    LOCAL_BUILD_DESK_DISABLE_UPDATES: "true",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [resolve("."), "--force-renderer-accessibility"],
    env: env as Record<string, string>,
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Fixture, ready when you are." }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Tests", exact: true }).click();
    const configuration = page.getByRole("textbox", {
      name: "Configuration",
      exact: true,
    });
    await configuration.fill("Debug draft");
    const originalControl = await configuration.elementHandle();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const timings = [];
    for (let i = 0; i < 4; i++) {
      await page.getByRole("button", { name: "Project", exact: true }).click();
      await expect(configuration).toBeHidden();
      expect(
        await originalControl!.evaluate((element) => element.isConnected),
      ).toBe(true);
      const before = (await cdp.send("Performance.getMetrics")).metrics;
      const started = Date.now();
      await page.getByRole("button", { name: "Tests", exact: true }).click();
      await expect(configuration).toHaveValue("Debug draft");
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const after = (await cdp.send("Performance.getMetrics")).metrics;
      const value = (items: { name: string; value: number }[], name: string) =>
        items.find((item) => item.name === name)?.value ?? 0;
      timings.push({
        navigationMs: Date.now() - started,
        ...Object.fromEntries(
          [
            "LayoutDuration",
            "RecalcStyleDuration",
            "ScriptDuration",
            "TaskDuration",
          ].map((name) => [
            name,
            Math.round((value(after, name) - value(before, name)) * 1000),
          ]),
        ),
      });
    }
    expect(
      await originalControl!.evaluate((element) => element.isConnected),
    ).toBe(true);
    expect((await page.evaluate(() => window.desk.state())).jobs).toHaveLength(
      0,
    );
    await test.info().attach("tests-navigation-timing.json", {
      body: JSON.stringify(timings, null, 2),
      contentType: "application/json",
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Builds → Tests stays responsive with a 50,608-entry native build log", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-large-log-navigation-"));
  const source = join(root, "source"),
    state = join(root, "state");
  await mkdir(join(source, "node_modules/expo/bin"), { recursive: true });
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { expo: "58.0.0" } }),
  );
  await writeFile(
    join(source, "node_modules/expo/bin/cli"),
    `console.log(JSON.stringify({name:'Fixture',slug:'fixture',version:'1.0',ios:{bundleIdentifier:'com.example.fixture'}}))`,
  );
  await writeFile(
    join(source, "eas.json"),
    JSON.stringify({ build: { production: {} } }),
  );
  const store = new Store(state);
  store.putProject({
    id: "project",
    name: "Fixture",
    path: source,
    version: "1.0",
    profiles: ["production"],
    createdAt: "now",
    settings: {},
  });
  store.putJob({
    id: "large-log",
    projectId: "project",
    projectName: "Fixture",
    platform: "ios",
    profile: "production",
    kind: "build",
    status: "succeeded",
    stage: "verify",
    createdAt: "2026-10-30T12:00:00.000Z",
    finishedAt: "2026-10-30T12:10:00.000Z",
    buildNumber: "80",
  } as Job);
  store.close();
  await mkdir(join(state, "jobs/large-log"), { recursive: true });
  await writeFile(
    join(state, "jobs/large-log/logs.jsonl"),
    Array.from(
      { length: 50608 },
      (_, i) =>
        JSON.stringify({
          time: "2026-10-30T12:00:00.000Z",
          stage: "compile",
          text: `native compile ${i} ${i === 0 ? "early-only-diagnostic" : "x".repeat(270)}`,
        }) + "\n",
    ).join(""),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOCAL_BUILD_DESK_DATA_DIR: state,
    LOCAL_BUILD_DESK_TEST_UI: "hidden",
    LOCAL_BUILD_DESK_DISABLE_UPDATES: "true",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [resolve("."), "--force-renderer-accessibility"],
    env: env as Record<string, string>,
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("heading", { name: "Fixture, ready when you are." }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Builds", exact: true }).click();
    await expect(page.getByRole("log")).toContainText("native compile 50607");
    await expect(page.locator(".logs > div")).toHaveCount(LOG_PAGE_ENTRIES);
    // Page history and full-history search still reach output outside the tail.
    await page
      .getByRole("button", { name: "Older output", exact: true })
      .click();
    await expect(page.getByRole("log")).toContainText("native compile 50307");
    await expect(page.getByRole("log")).not.toContainText(
      "native compile 50607",
    );
    await page
      .getByRole("button", { name: "Newer output", exact: true })
      .click();
    await expect(page.getByRole("log")).toContainText("native compile 50607");
    await page.getByLabel("Search build logs").fill("early-only-diagnostic");
    await expect(page.getByRole("log")).toContainText(
      "native compile 0 early-only-diagnostic",
    );
    await expect(page.locator(".logs > div")).toHaveCount(1);
    await page.getByLabel("Search build logs").fill("");
    await expect(page.locator(".logs > div")).toHaveCount(LOG_PAGE_ENTRIES);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const timings: number[] = [];
    for (let i = 0; i < 4; i++) {
      const started = Date.now();
      await page.getByRole("button", { name: "Tests", exact: true }).click();
      await expect(
        page.getByRole("textbox", { name: "Configuration", exact: true }),
      ).toBeVisible();
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      timings.push(Date.now() - started);
      await page.getByRole("button", { name: "Builds", exact: true }).click();
      await expect(page.locator(".logs > div")).toHaveCount(LOG_PAGE_ENTRIES);
    }
    // Bursts also have a bounded DOM, even while the page is already full.
    await app.evaluate(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows()[0];
      for (let i = 0; i < 5000; i++)
        host.webContents.send("desk:event", {
          type: "log",
          jobId: "large-log",
          logOffset: 100000000 + i,
          entry: {
            time: "2026-10-30T12:00:00.000Z",
            stage: "compile",
            text: `live burst ${i}`,
          },
        });
    });
    await expect(page.getByRole("log")).toContainText("live burst 4999");
    await expect(page.locator(".logs > div")).toHaveCount(LOG_PAGE_ENTRIES);
    await page.screenshot({ path: "test-results/large-log-builds.png" });
    await test
      .info()
      .attach("builds-to-tests-timing.json", {
        body: JSON.stringify(
          {
            entries: 50608,
            visibleLimit: LOG_PAGE_ENTRIES,
            navigationMs: timings,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../src/core/database";

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
    await test
      .info()
      .attach("tests-navigation-timing.json", {
        body: JSON.stringify(timings, null, 2),
        contentType: "application/json",
      });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

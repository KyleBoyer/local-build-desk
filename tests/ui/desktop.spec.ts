import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const fixtureConfig = {
  name: "Fixture App",
  slug: "fixture-app",
  version: "1.2.3",
  ios: { bundleIdentifier: "com.example.fixture" },
  android: { package: "com.example.fixture" },
  plugins: [],
};
async function fixture(root: string) {
  const path = join(root, "fixture");
  await mkdir(join(path, "node_modules/expo/bin"), { recursive: true });
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({ name: "fixture-app", dependencies: { expo: "58.0.0" } }),
  );
  await writeFile(
    join(path, "node_modules/expo/bin/cli"),
    `console.log(${JSON.stringify(JSON.stringify(fixtureConfig))});`,
  );
  await writeFile(
    join(path, "eas.json"),
    JSON.stringify({
      cli: { appVersionSource: "remote" },
      build: {
        development: { developmentClient: true, distribution: "internal" },
        preview: { distribution: "internal" },
        production: { autoIncrement: true },
      },
    }),
  );
  return path;
}
test("desktop import, profile selection, toolchain, migration, queue, and keyboard dialog flow", async () => {
  // This real-toolchain smoke test has independent 30s doctor and 45s native
  // failure budgets. A cold CI Mac needs room for both plus UI interactions.
  test.setTimeout(120000);
  const root = await mkdtemp(join(tmpdir(), "desk-ui-test-"));
  const projectPath = await fixture(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOCAL_BUILD_DESK_DATA_DIR: join(root, "state"),
    LOCAL_BUILD_DESK_TEST_UI: "hidden",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [resolve(".")],
    env: Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await expect(
      page.getByRole("heading", { name: "Your next build starts here." }),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/desktop-welcome.png" });
    await page.evaluate(async (path) => {
      await window.desk.importProject(path);
    }, projectPath);
    await expect(
      page.getByRole("heading", { name: "Fixture App, ready when you are." }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Android", exact: true }).click();
    await expect(
      page.getByText("Google Play · internal · rolled out to testers", {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "iOS", exact: true }).click();
    await page.getByRole("button", { name: "Migration", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByLabel("Last used iOS build number").fill("12");
    await page.getByLabel("Last used Android version code").fill("20");
    await page.getByRole("button", { name: "Import & migrate" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page.screenshot({ path: "test-results/desktop-project.png" });
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await page.getByRole("button", { name: "Connect account" }).first().click();
    await expect(
      page.getByRole("dialog", { name: "Connect App Store Connect" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Guided setup", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Let’s get you to TestFlight." }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Set up signing automatically" }),
    ).toBeDisabled();
    await page.screenshot({ path: "test-results/desktop-setup.png" });
    await page.getByRole("button", { name: "Android / Play" }).click();
    await expect(
      page.getByRole("heading", { name: "Let’s get you to Google Play." }),
    ).toBeVisible();
    // The install button only shows while the Android SDK or Java looks
    // missing, and runners that have both hide it once the checks finish.
    // Either way it must never be enabled before the SDK license is accepted.
    expect(
      await page
        .getByRole("button", { name: "Install Android tools & JDK" })
        .isEnabled({ timeout: 1000 })
        .catch(() => false),
    ).toBe(false);
    await page
      .getByRole("button", { name: "Set up signing automatically" })
      .click();
    await expect(page.getByRole("alert")).toContainText("existing app");
    await page.getByRole("button", { name: "Signing", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Signing & provisioning" }),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/desktop-signing.png" });
    await page.getByRole("button", { name: "Toolchain", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "The local toolchain" }),
    ).toBeVisible();
    // A fresh Mac runner can take the doctor's full 15s subprocess timeout
    // while CoreSimulator starts. Wait for the real checks, not a UI placeholder.
    await expect(page.getByText("Xcode", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await page.screenshot({ path: "test-results/desktop-toolchain.png" });
    await page.getByRole("button", { name: "Project", exact: true }).click();
    await page.getByRole("button", { name: "Build", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Build history" }),
    ).toBeVisible();
    await expect(page.getByRole("log")).toBeVisible();
    await expect(page.locator(".job-error")).toBeVisible({ timeout: 45000 });
    await page.getByLabel("Search build logs").fill("ERROR");
    await expect(page.getByRole("log")).toContainText("ERROR");
    await page.screenshot({ path: "test-results/desktop-build-error.png" });
    const cli = await promisify(execFile)(
      process.execPath,
      [resolve("bin/ios-submit.mjs"), "status"],
      { env },
    );
    expect(JSON.parse(cli.stdout).projects[0].name).toBe("Fixture App");
    // The real renderer must never scroll the workspace to follow a hidden log.
    await page.getByLabel("Search build logs").fill("");
    const jobId = await page.evaluate(
      async () => (await window.desk.state()).jobs[0].id,
    );
    const appendLogs = async (start: number, count: number) =>
      app.evaluate(
        ({ BrowserWindow }, value) => {
          const host = BrowserWindow.getAllWindows().find(
            (window) => !window.webContents.getURL().includes("account="),
          )!;
          for (let i = value.start; i < value.start + value.count; i++)
            host.webContents.send("desk:event", {
              type: "log",
              jobId: value.jobId,
              entry: {
                time: new Date().toISOString(),
                stage: "compile",
                text: `scroll regression line ${i}`,
              },
            });
        },
        { jobId, start, count },
      );
    await page.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.style.height = "1200px";
      document.querySelector(".log-toolbar")!.before(spacer);
      window.scrollTo(0, 0);
    });
    await appendLogs(0, 80);
    await expect(page.getByRole("log")).toContainText(
      "scroll regression line 79",
    );
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.getByRole("log").scrollIntoViewIfNeeded();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.getByRole("log").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const before = await page
      .getByRole("log")
      .evaluate((element) => element.scrollTop);
    const workspaceY = await page.evaluate(() => window.scrollY);
    await appendLogs(80, 20);
    await expect
      .poll(() =>
        page.getByRole("log").evaluate((element) => element.scrollTop),
      )
      .toBeGreaterThan(before);
    expect(await page.evaluate(() => window.scrollY)).toBe(workspaceY);
    await page.getByRole("log").evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve)),
    );
    await appendLogs(100, 1);
    await expect(page.getByRole("log")).toContainText(
      "scroll regression line 100",
    );
    expect(
      await page.getByRole("log").evaluate((element) => element.scrollTop),
    ).toBe(0);
    await page.evaluate(() => {
      const rect = document.querySelector(".logs")!.getBoundingClientRect();
      window.scrollTo(0, window.scrollY + rect.top - window.innerHeight + 10);
    });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const sliverY = await page.evaluate(() => window.scrollY);
    await appendLogs(101, 1);
    await expect(page.getByRole("log")).toContainText(
      "scroll regression line 101",
    );
    expect(await page.evaluate(() => window.scrollY)).toBe(sliverY);
    // Exercise the production sender allowlist, not just a replay-only IPC handler.
    await app.evaluate(({ session }) =>
      session.fromPartition("persist:desk-account-google").protocol.handle(
        "https",
        () =>
          new Response('<h1>Google sign-in</h1><input type="password">', {
            headers: { "Content-Type": "text/html" },
          }),
      ),
    );
    await page.evaluate(async () => {
      const project = (await window.desk.state()).projects[0];
      await window.desk.openAccountSetup(project.id, "google");
    });
    const googleHost = app
      .windows()
      .find((window) => window.url().includes("account=google"))!;
    await expect(
      googleHost.getByText(/Sign in to Google and complete any MFA/),
    ).toBeVisible();
    const approvalError = await googleHost.evaluate(() =>
      window.desk.approveGoogleSetup().then(
        () => "unexpected success",
        (error) => String(error),
      ),
    );
    expect(approvalError).toContain("No Google setup approval is pending");
    expect(
      await app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter((window) => window.isVisible())
            .length,
      ),
    ).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

import { test, expect, _electron as electron } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../src/core/database";
import type { Project, Job } from "../../src/core/types";

test("build comparison, notification navigation, release notes and portable backup through the desktop API", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-workflow-ui-"));
  const source = join(root, "source"),
    state = join(root, "state"),
    backup = join(root, "desk.lbdbackup");
  await mkdir(join(source, "node_modules/expo/bin"), { recursive: true });
  const config = {
    name: "Workflow Fixture",
    slug: "workflow-fixture",
    version: "1.2.3",
    ios: { bundleIdentifier: "com.example.workflow" },
    android: { package: "com.example.workflow" },
  };
  const packageText = JSON.stringify({
    name: "workflow-fixture",
    dependencies: { expo: "58.0.0" },
  });
  await writeFile(join(source, "package.json"), packageText);
  await writeFile(
    join(source, "node_modules/expo/bin/cli"),
    `console.log(${JSON.stringify(JSON.stringify(config))});`,
  );
  await writeFile(
    join(source, "eas.json"),
    JSON.stringify({ build: { production: {} } }),
  );
  const store = new Store(state);
  const project: Project = {
    id: "project",
    path: source,
    name: config.name,
    bundleId: config.ios.bundleIdentifier,
    packageName: config.android.package,
    profiles: ["production"],
    version: "1.2.3",
    createdAt: "2026-10-01T00:00:00Z",
    settings: {},
  };
  store.putProject(project);
  for (const [id, sdk, build, date] of [
    ["before", "26.5", "20", "01"],
    ["after", "27.2", "21", "02"],
  ]) {
    const job: Job = {
      id,
      kind: "build",
      projectId: project.id,
      projectName: project.name,
      platform: "ios",
      profile: "production",
      stage: "complete",
      status: "succeeded",
      createdAt: `2026-10-${date}T00:00:00Z`,
      autoSubmit: false,
      clean: false,
      bundleId: project.bundleId,
      version: "1.2.3",
      buildNumber: build,
      artifactId: `${id}-ipa`,
      storeEligible: true,
      facts: {
        sourceHash: (id === "before" ? "a" : "b").repeat(64),
        configuration: "Release",
        distribution: "store",
        developmentClient: false,
        simulator: false,
        destination: "App Store Connect",
        entitlements: { "aps-environment": "production" },
      },
      toolchain: {
        developerDirectory: "/fixture/Xcode.app/Contents/Developer",
        xcodeVersion: sdk,
        iosSdk: sdk,
      },
    };
    store.putJob(job);
    store.putArtifact({
      id: `${id}-ipa`,
      jobId: id,
      path: join(root, `${id}.ipa`),
      kind: "ipa",
      platform: "ios",
      sha256: "a".repeat(64),
      size: 10,
      bundleId: project.bundleId!,
      version: "1.2.3",
      buildNumber: build,
    });
  }
  store.seed("ios:com.example.workflow", 21);
  store.close();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOCAL_BUILD_DESK_DATA_DIR: state,
    LOCAL_BUILD_DESK_TEST_UI: "hidden",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [resolve(".")],
    env: Object.fromEntries(
      Object.entries(env).filter(
        (v): v is [string, string] => v[1] !== undefined,
      ),
    ),
  });
  const page = await app.firstWindow(),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.getByRole("button", { name: "Builds", exact: true }).click();
    await page.getByText("What changed?", { exact: false }).click();
    const sdkRow = page.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: "iOS SDK", exact: true }),
    });
    await expect(sdkRow).toContainText("26.5");
    await expect(sdkRow).toContainText("27.2");
    await page.screenshot({ path: "test-results/workflow-comparison.png" });
    await page
      .getByRole("button", { name: "Preferences", exact: true })
      .click();
    const notifications = page.getByLabel(
      "Notify me when a build or upload needs attention",
    );
    await notifications.uncheck();
    expect(
      await page.evaluate(() => window.desk.notificationSettings()),
    ).toMatchObject({ enabled: false });
    await notifications.check();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send("desk:event", {
        type: "focus-job",
        jobId: "before",
      }),
    );
    await expect(
      page.getByRole("heading", { name: "Build history" }),
    ).toBeVisible();
    await expect(page.locator(".job-detail")).toContainText("20");
    await page.getByRole("button", { name: "Release", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Release assistant" }),
    ).toBeVisible();
    await page.getByLabel("What to Test").fill("Test the new workflow");
    await page.getByRole("button", { name: "Preview Apple changes" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "connect its Apple team",
    );
    await page.getByLabel("Destination", { exact: true }).selectOption("play");
    await page
      .getByLabel("What's New", { exact: true })
      .fill("Improved local releases");
    await page
      .getByRole("button", { name: "Save for next Play upload" })
      .click();
    await expect(page.getByRole("status")).toContainText("saved locally");
    expect(
      await page.evaluate(
        async () =>
          (await window.desk.state()).projects[0].settings.playReleaseNotes,
      ),
    ).toBe("Improved local releases");
    await page.screenshot({ path: "test-results/workflow-release.png" });
    await page
      .getByRole("button", { name: "Preferences", exact: true })
      .click();
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, backup);
    await page
      .getByLabel("Backup passphrase", { exact: true })
      .fill("a portable test passphrase");
    await page
      .getByLabel("Confirm passphrase", { exact: true })
      .fill("a portable test passphrase");
    await page
      .getByRole("button", { name: "Choose backup destination" })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Encrypted backup saved",
    );
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
    expect(await readFile(backup, "utf8")).not.toContain(
      "Improved local releases",
    );
    await page.getByLabel("Action", { exact: true }).selectOption("restore");
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, backup);
    await page
      .getByLabel("Backup passphrase", { exact: true })
      .fill("a portable test passphrase");
    await page
      .getByRole("button", { name: "Choose and preview backup" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Review restore" }),
    ).toBeVisible();
    await expect(
      page.getByText("2 historical jobs", { exact: false }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Restore this backup" }).click();
    await expect(page.getByRole("status")).toContainText("Restored 1 projects");
    expect(
      await page.evaluate(async () => (await window.desk.state()).jobs.length),
    ).toBe(2);
    expect(await readFile(join(source, "package.json"), "utf8")).toBe(
      packageText,
    );
    expect(errors).toEqual([]);
    await page.screenshot({ path: "test-results/workflow-preferences.png" });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

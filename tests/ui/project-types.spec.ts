import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createNativeFixture } from "../fixtures/native/create";
test("selects a native app inside a repository, edits profiles, exports portable settings", async () => {
  test.setTimeout(120000);
  const root = await mkdtemp(join(tmpdir(), "desk-project-types-ui-")),
    repository = join(root, "repository"),
    native = join(repository, "apps/native"),
    cap = join(repository, "apps/web");
  await mkdir(native, { recursive: true });
  await createNativeFixture(native);
  await mkdir(cap, { recursive: true });
  await writeFile(
    join(cap, "package.json"),
    JSON.stringify({
      name: "capacitor-fixture",
      dependencies: { "@capacitor/core": "8.6.0" },
    }),
  );
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
          (v): v is [string, string] => v[1] !== undefined,
        ),
      ),
    }),
    page = await app.firstWindow(),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, repository);
    await page
      .getByRole("button", { name: "Choose project", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Choose an app in this repository" }),
    ).toBeVisible();
    await page
      .getByLabel("App directory", { exact: true })
      .selectOption("apps/native");
    await page
      .getByRole("button", { name: "Import selected app", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Let’s get you to TestFlight." }),
    ).toBeVisible({ timeout: 60000 });
    await expect(
      page.getByRole("button", { name: "Android / Play", exact: true }),
    ).not.toBeVisible();
    await page.getByRole("button", { name: "Project", exact: true }).click();
    await expect(page.getByText("Native iOS", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Android", exact: true }),
    ).not.toBeVisible();
    await expect(page.locator(".target-list")).toContainText("DeskWidget", {
      timeout: 30000,
    });
    await page
      .getByLabel("Xcode app container", { exact: true })
      .selectOption("apps/native/DeskApp.xcodeproj");
    await page
      .getByLabel("Application scheme", { exact: true })
      .fill("DeskFixture");
    await page.getByText("Local build profiles", { exact: true }).click();
    const profiles = {
      development: {
        configuration: "Debug",
        distribution: "internal",
        simulator: true,
        debug: true,
        autoIncrement: true,
      },
      production: {
        configuration: "Release",
        distribution: "store",
        autoIncrement: true,
      },
    };
    await page
      .getByLabel("Profiles JSON", { exact: true })
      .fill(JSON.stringify(profiles, null, 2));
    await page
      .getByRole("button", { name: "Save build settings", exact: true })
      .click();
    await expect(
      page.getByText("Build settings saved.", { exact: true }),
    ).toBeVisible({ timeout: 30000 });
    const project = await page.evaluate(
      async () => (await window.desk.state()).projects[0],
    );
    expect(project).toMatchObject({
      type: "native-ios",
      platforms: ["ios"],
      settings: {
        appDirectory: "apps/native",
        iosTarget: "apps/native/DeskApp.xcodeproj",
        localProfiles: profiles,
      },
    });
    const portable = join(root, "ios-submit.json");
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, portable);
    await page
      .getByRole("button", { name: "Export portable settings", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(portable, "utf8")).settings.projectType,
      )
      .toBe("native-ios");
    const exported = JSON.parse(await readFile(portable, "utf8"));
    expect(exported.settings.appDirectory).toBe("apps/native");
    expect(exported.settings.appleConnectionId).toBeUndefined();
    expect(exported.settings.xcodePath).toBeUndefined();
    await page.screenshot({ path: "test-results/native-project-settings.png" });
    await page.getByRole("button", { name: "Toolchain", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "The local toolchain" }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Node executable", { exact: true }),
    ).not.toBeVisible();
    await expect
      .poll(async () =>
        (await page.evaluate((id) => window.desk.doctor(id), project.id)).map(
          (c) => c.name,
        ),
      )
      .not.toContain("Node.js");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

import { test, expect, _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../src/core/database";

test("shows remote review/TestFlight/Play releases and their correct assets in both store sections", async () => {
  await build({
    entryPoints: ["tests/harness/store-releases.ts"],
    outfile: "out/tests/store-releases.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    packages: "external",
  });
  const root = await mkdtemp(join(tmpdir(), "desk-submitted-releases-"));
  const source = join(root, "source"),
    state = join(root, "state");
  await mkdir(join(source, "node_modules/expo/bin"), { recursive: true });
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { expo: "58.0.0" } }),
  );
  await writeFile(
    join(source, "node_modules/expo/bin/cli"),
    `console.log(JSON.stringify({name:'Fixture',slug:'fixture',version:'1.0',ios:{bundleIdentifier:'com.example.fixture'},android:{package:'com.example.fixture'}}));`,
  );
  await writeFile(
    join(source, "eas.json"),
    JSON.stringify({ build: { production: {} } }),
  );
  const store = new Store(state);
  store.putProject({
    id: "project",
    path: source,
    name: "Fixture",
    bundleId: "com.example.fixture",
    packageName: "com.example.fixture",
    version: "1.0",
    profiles: ["production"],
    createdAt: "now",
    settings: {
      appleConnectionId: "apple-fixture",
      googleConnectionId: "google-fixture",
    },
  });
  store.close();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOCAL_BUILD_DESK_DATA_DIR: state,
    LOCAL_BUILD_DESK_TEST_UI: "hidden",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [resolve("out/tests/store-releases.cjs")],
    env: Object.fromEntries(
      Object.entries(env).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    ),
  });
  const page = await app.firstWindow(),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.getByRole("button", { name: "Release", exact: true }).click();
    const history = page.getByRole("region", {
      name: "Submitted releases",
      exact: true,
    });
    await expect(
      history.getByRole("tab", { name: /App Store review/ }),
    ).toBeVisible();
    await history
      .locator(".store-release-row")
      .filter({ hasText: "Build 3" })
      .click();
    await expect(
      history.getByText("waiting for review", { exact: true }),
    ).toHaveCount(2);
    const image = history.getByAltText("review-home.png", { exact: true });
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(1);
    await history
      .getByRole("button", { name: "Enlarge review-home.png" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "review-home.png" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await history
      .getByText("Submitted description · en-US", { exact: true })
      .click();
    await expect(
      history.getByText("The submitted review description."),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/submitted-app-review.png",
      fullPage: true,
    });
    await history.getByRole("tab", { name: /TestFlight/ }).click();
    await history
      .locator(".store-release-row")
      .filter({ hasText: "Build 4" })
      .click();
    await expect(
      history.getByText("Internal testers (internal)", { exact: true }),
    ).toBeVisible();
    await expect(
      history.getByText("Try the new TestFlight action."),
    ).toBeVisible();
    await expect(
      history.getByText("Beta App Review", { exact: true }),
    ).toBeVisible();
    await expect(
      history.getByText(/TestFlight builds have no store screenshots attached/),
    ).toBeVisible();
    await expect(history.getByAltText("review-home.png")).toHaveCount(0);
    await history.getByRole("tab", { name: /Google Play/ }).click();
    await history
      .locator(".store-release-row")
      .filter({ hasText: "Build 4" })
      .click();
    await expect(
      history.getByText(/Google review state is not exposed/),
    ).toBeVisible();
    await expect(
      history.getByText(/current Google Play listing assets/),
    ).toBeVisible();
    await expect(history.getByAltText("phoneScreenshots 1")).toBeVisible();
    await expect(history.getByText("New folding levels.")).toBeVisible();
    await page.screenshot({
      path: "test-results/submitted-google-play.png",
      fullPage: true,
    });
    await app.evaluate(() => {
      (globalThis as any).__storeHistoryState = "IN_REVIEW";
      (globalThis as any).__storeHistoryGoogleError = true;
    });
    await history.getByRole("button", { name: "Refresh store status" }).click();
    await expect(
      history.getByText("Google Play 403: permission needs attention"),
    ).toBeVisible();
    await history.getByRole("tab", { name: /App Store review/ }).click();
    await expect(
      history
        .locator(".store-release-row")
        .getByText("in review", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "App Store", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "App Store compliance" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Submitted releases" }),
    ).toBeVisible();
    const writes = await app.evaluate(
      () => (globalThis as any).__storeHistoryWrites,
    );
    expect(
      writes.every(
        (w: any) =>
          (w.method === "POST" && w.path.endsWith("/edits")) ||
          w.method === "DELETE",
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

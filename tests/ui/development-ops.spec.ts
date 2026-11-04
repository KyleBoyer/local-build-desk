import { test, expect, _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../src/core/database";

test("reviews publishing changes, manages both tester providers, and saves purchase gates without changing source", async () => {
  await build({
    entryPoints: ["tests/harness/development-ops.ts"],
    outfile: "out/tests/development-ops.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    packages: "external",
  });
  const root = await mkdtemp(join(tmpdir(), "lbd-development-ui-")),
    source = join(root, "source"),
    state = join(root, "state");
  await mkdir(join(source, "node_modules/expo/bin"), { recursive: true });
  await mkdir(join(source, "assets/store"), { recursive: true });
  const original = JSON.stringify({
    apple: {
      inAppPurchases: [
        {
          productId: "com.example.unlock",
          type: "NON_CONSUMABLE",
          referenceName: "Unlock",
          price: "4.99",
          localizations: { "en-US": { name: "Unlock" } },
        },
      ],
    },
  });
  await writeFile(join(source, "assets/store/monetization.json"), original);
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ dependencies: { expo: "58.0.0" } }),
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
    name: "Fixture",
    path: source,
    createdAt: "now",
    profiles: ["production"],
    bundleId: "com.example.fixture",
    packageName: "com.example.fixture",
    settings: {
      appleConnectionId: "apple-fixture",
      googleConnectionId: "google-fixture",
    },
  });
  store.close();
  await mkdir(join(state, "inbox"), { recursive: true });
  await writeFile(
    join(state, "inbox/project.json"),
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      primed: true,
      items: [
        {
          id: "apple-crash:crash",
          sourceId: "crash",
          kind: "crash",
          store: "apple",
          title: "Fixture crash",
          body: "Opening the app",
          createdAt: new Date().toISOString(),
          seenAt: new Date().toISOString(),
          read: false,
          buildNumber: "3",
        },
      ],
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOCAL_BUILD_DESK_DATA_DIR: state,
    LOCAL_BUILD_DESK_TEST_UI: "hidden",
    LOCAL_BUILD_DESK_DISABLE_UPDATES: "true",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: [resolve("out/tests/development-ops.cjs")],
    env: env as Record<string, string>,
  });
  try {
    const page = await app.firstWindow(),
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByRole("button", { name: "Release", exact: true }).click();
    await page
      .locator(".store-release-row")
      .filter({ hasText: "Build 3" })
      .click();
    await page
      .getByRole("button", { name: "Review release to App Store", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Review store change" });
    await expect(dialog).toContainText("com.example.fixture");
    await expect(dialog).toContainText("build 3");
    expect(
      await app.evaluate(() => (globalThis as any).__developmentWrites.length),
    ).toBe(0);
    await dialog
      .getByRole("button", { name: "Confirm release approved version" })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Publishing controls" }),
    ).toContainText("PENDING_APPLE_RELEASE");
    await page.getByRole("button", { name: "Tests", exact: true }).click();
    await page.getByRole("button", { name: "Testers", exact: true }).click();
    await expect(
      page.getByText("alice@example.com", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("checkbox", { name: "Select alice@example.com" })
      .check();
    await page
      .getByRole("button", { name: "Review resend invitations" })
      .click();
    await expect(dialog).toContainText("alice@example.com");
    await page.keyboard.press("Escape");
    expect(
      await app.evaluate(
        () =>
          (globalThis as any).__developmentWrites.filter(
            (w: any) => w.path === "/betaTesterInvitations",
          ).length,
      ),
    ).toBe(0);
    await page
      .getByRole("button", { name: "Review resend invitations" })
      .click();
    await dialog
      .getByRole("button", {
        name: "Confirm resend TestFlight invitations",
        exact: false,
      })
      .click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("tab", { name: "Android · Google Play" }).click();
    await expect(page.getByLabel("Play testing Google Groups")).toHaveValue(
      "old@googlegroups.com",
    );
    await page
      .getByLabel("Play testing Google Groups")
      .fill("new@googlegroups.com");
    await page
      .getByRole("button", { name: "Preview Google Groups update" })
      .click();
    await expect(dialog).toContainText("Internal testing");
    await dialog
      .getByRole("button", { name: "Confirm update play testing groups" })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("Play testing Google Groups")).toHaveValue(
      "new@googlegroups.com",
    );
    await page.screenshot({ path: "test-results/tester-management.png" });
    await page
      .getByRole("button", { name: "Purchase tests", exact: true })
      .click();
    await expect(page.getByLabel("Purchase test product")).toHaveValue(
      "com.example.unlock",
    );
    for (const key of [
      "buyIdentifier",
      "unlockedIdentifier",
      "lockedIdentifier",
    ])
      await page.getByLabel(key, { exact: true }).fill(key);
    await page
      .getByLabel("Purchase simulator", { exact: true })
      .fill("com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro");
    await page
      .getByRole("button", { name: "Save required purchase checks" })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "required before store uploads",
    );
    const policy = await page.evaluate(
      async () =>
        (await window.desk.state()).projects[0].settings.releaseChecks,
    );
    expect(policy).toMatchObject({
      required: true,
      enabled: true,
      runner: "purchase",
      purchaseTesting: { productId: "com.example.unlock" },
    });
    const configuration = await page.evaluate(() =>
      window.desk.exportPurchaseConfiguration("project"),
    );
    expect(
      JSON.parse(await readFile(configuration, "utf8")).products[0].productID,
    ).toBe("com.example.unlock");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.screenshot({ path: "test-results/purchase-testing.png" });
    await page.getByRole("button", { name: "Feedback", exact: true }).click();
    await page.getByRole("button", { name: "Crash log", exact: true }).click();
    const crash = page.getByRole("dialog", { name: "Crash log", exact: true });
    await expect(crash.locator("pre")).toContainText("fixtureCrash()");
    await page.screenshot({ path: "test-results/readable-crash.png" });
    await crash.getByLabel("Show original report").check();
    await expect(crash.locator("pre")).toContainText('"usedImages"');
    await page.keyboard.press("Escape");
    await expect(crash).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(
      await readFile(join(source, "assets/store/monetization.json"), "utf8"),
    ).toBe(original);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

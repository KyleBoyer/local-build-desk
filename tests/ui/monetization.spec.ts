import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Monetization without store connections: purchases, subscriptions and
// promotions are edited on the page and land in the committed file.
test("edits purchases, subscriptions and promotions into the monetization file", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-monetization-test-"));
  const project = join(root, "fixture");
  await mkdir(join(project, "node_modules/expo/bin"), { recursive: true });
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ name: "fixture-app", dependencies: { expo: "58.0.0" } }),
  );
  await writeFile(
    join(project, "node_modules/expo/bin/cli"),
    `console.log(${JSON.stringify(
      JSON.stringify({
        name: "Fixture App",
        slug: "fixture-app",
        version: "1.0.0",
        ios: { bundleIdentifier: "com.example.fixture" },
        android: { package: "com.example.fixture" },
        plugins: [],
      }),
    )});`,
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
        (e): e is [string, string] => e[1] !== undefined,
      ),
    ),
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const file = join(project, "assets/store/monetization.json");
  try {
    await page.evaluate((path) => window.desk.importProject(path), project);
    await page
      .getByRole("button", { name: "Monetization", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Monetization" }),
    ).toBeVisible();
    await expect(
      page.getByText(/Connect App Store Connect to this project/),
    ).toBeVisible();

    await page.getByRole("button", { name: "Add purchase" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Product ID").fill("com.example.fixture.coins");
    await dialog.getByLabel("Reference name").fill("Coin pack");
    await dialog.getByLabel("US price").fill("1.99");
    await dialog.getByLabel("Display name").fill("100 coins");
    await page.screenshot({ path: "test-results/monetization-editor.png" });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByText("com.example.fixture.coins · consumable"),
    ).toBeVisible();

    await page.getByRole("button", { name: "Add group" }).click();
    await dialog.getByLabel("Reference name").fill("Pro");
    await dialog.getByLabel("Group display name").fill("Fixture Pro");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Add subscription" }).click();
    await dialog.getByLabel("Product ID").fill("com.example.fixture.pro");
    await dialog.getByLabel("Reference name").fill("Pro monthly");
    await dialog.getByLabel("Display name").fill("Pro");
    await dialog
      .getByLabel("Offer", { exact: true })
      .selectOption("FREE_TRIAL");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.screenshot({
      path: "test-results/monetization-apple.png",
      fullPage: true,
    });

    await page.getByRole("tab", { name: /Google Play/ }).click();
    await page.getByRole("button", { name: "Add product" }).click();
    await dialog.getByLabel("Product ID").fill("coins");
    await dialog.getByLabel("Title").fill("Coins");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Add promotion" }).click();
    await dialog.getByLabel("Promotion name").fill("Launch week");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Create in Play Console" }),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/monetization-google.png",
      fullPage: true,
    });

    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.apple.inAppPurchases[0]).toMatchObject({
      productId: "com.example.fixture.coins",
      type: "CONSUMABLE",
      price: "1.99",
      territories: "ALL",
      localizations: { "en-US": { name: "100 coins" } },
    });
    expect(saved.apple.subscriptionGroups[0].subscriptions[0]).toMatchObject({
      productId: "com.example.fixture.pro",
      period: "ONE_MONTH",
      introOffer: { mode: "FREE_TRIAL", duration: "ONE_WEEK", periods: 1 },
    });
    expect(saved.google.products[0]).toMatchObject({
      productId: "coins",
      price: "0.99",
      active: true,
    });
    expect(saved.google.promoCodes[0]).toMatchObject({
      name: "Launch week",
      productId: "coins",
      kind: "oneTime",
    });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The App Store compliance questionnaire: answer every question, review the
// statements, attest, and find the attested answers in the listing file.
test("answers, reviews and attests App Store compliance questions", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-compliance-test-"));
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
        plugins: [],
      }),
    )});`,
  );
  await mkdir(join(project, "store"));
  const listing = join(project, "store/listing.json");
  await writeFile(
    listing,
    JSON.stringify({ name: "Fixture App", keywords: "fixture" }),
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
  try {
    await page.evaluate(
      async ([path, file]) => {
        const project = await window.desk.importProject(path);
        // Stands in for the native file picker.
        await window.desk.saveCompliance(project.id, file, {});
      },
      [project, listing] as const,
    );
    await page.getByRole("button", { name: "App Store", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "App Store compliance" }),
    ).toBeVisible();
    await expect(page.getByText("store/listing.json")).toBeVisible();
    const attestButton = page.getByRole("button", {
      name: "Attest these answers",
    });
    await expect(attestButton).toBeDisabled();

    for (const select of await page.locator(".compliance-grid select").all()) {
      const options = await select.locator("option").allTextContents();
      await select.selectOption({
        label: options.includes("None") ? "None" : "No",
      });
    }
    await page.getByLabel("No, we don't collect data from this app").check();
    await page.getByRole("button", { name: "Save answers" }).click();
    await expect(
      page.getByText(
        "Neither Fixture App nor any third-party code in it collects data",
      ),
    ).toBeVisible();
    await expect(
      page.getByText("Free, available in every territory."),
    ).toBeVisible();

    await page.getByLabel("Your name").fill("Pat Example");
    await page.getByLabel(/I confirm these answers are accurate/).check();
    await attestButton.click();
    await expect(
      page.getByText(/Attested by Pat Example on \d{4}-\d{2}-\d{2}\./),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/desktop-compliance.png",
      fullPage: true,
    });

    const saved = JSON.parse(await readFile(listing, "utf8"));
    expect(saved).toMatchObject({
      name: "Fixture App",
      keywords: "fixture",
      appPrivacy: { collected: false },
      pricing: { price: "0.00", territories: "ALL" },
      ageRating: { contests: "NONE", gambling: false, ageAssurance: false },
      attestation: { name: "Pat Example" },
    });

    // An edit after attesting needs a fresh attestation.
    await page.getByLabel("US price").fill("0.99");
    await expect(attestButton).toBeDisabled();
    await page.getByRole("button", { name: "Save answers" }).click();
    await expect(
      page.getByText("US price $0.99, available in every territory."),
    ).toBeVisible();
    expect(
      JSON.parse(await readFile(listing, "utf8")).attestation,
    ).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

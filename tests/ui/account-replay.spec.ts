import { test, expect, _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp, readFile, rm, readdir, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
test("an ambiguous creation is never repeated, including after restart", async () => {
  await build({
    entryPoints: ["tests/harness/account.ts"],
    outfile: "out/tests/account-harness.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
  });
  const root = await mkdtemp(join(tmpdir(), "desk-account-ambiguous-"));
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      LOCAL_BUILD_DESK_DATA_DIR: root,
      DESK_REPLAY_SCENARIO: "ambiguous",
    }).filter(
      ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
    ),
  ) as Record<string, string>;
  const launch = () =>
    electron.launch({ args: [resolve("out/tests/account-harness.cjs")], env });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Generate this Admin API key" })
      .click();
    await expect(
      page.getByText(
        /Apple has not confirmed the submitted key-generation request/,
      ),
    ).toBeVisible({ timeout: 25000 });
    await page.getByRole("button", { name: "Retry automation" }).click();
    await expect(
      page.getByRole("button", { name: "Generate this Admin API key" }),
    ).toHaveCount(0);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(
      page.getByText(
        /Apple has not confirmed the submitted key-generation request/,
      ),
    ).toBeVisible({ timeout: 25000 });
    await expect(
      page.getByRole("button", { name: "Generate this Admin API key" }),
    ).toHaveCount(0);
    const error = await page.evaluate(() =>
      window.desk.approveAccountKey().then(
        () => "unexpected success",
        (error) => String(error),
      ),
    );
    expect(error).toContain("No key-generation approval is pending");
    expect(
      JSON.parse(await readFile(join(root, "outcomes.json"), "utf8")),
    ).toEqual({ generated: 1, credentials: 0, validated: 0 });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("app-owned setup replays login redirect, live Add control, searchable roles, key download, Team ID, and automatic verification", async ({}, testInfo) => {
  await build({
    entryPoints: ["tests/harness/account.ts"],
    outfile: "out/tests/account-harness.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
  });
  const root = await mkdtemp(join(tmpdir(), "desk-account-replay-"));
  const env = Object.fromEntries(
    Object.entries({ ...process.env, LOCAL_BUILD_DESK_DATA_DIR: root }).filter(
      ([k, v]) => k !== "ELECTRON_RUN_AS_NODE" && v !== undefined,
    ),
  ) as Record<string, string>;
  let app = await electron.launch({
    args: [resolve("out/tests/account-harness.cjs")],
    env,
  });
  const page = await app.firstWindow();
  try {
    const approve = page.getByRole("button", {
      name: "Generate this Admin API key",
    });
    await expect(approve).toBeVisible({ timeout: 30000 });
    expect(
      JSON.parse(
        await readFile(join(root, "outcomes.json"), "utf8").catch(
          () => '{"generated":0}',
        ),
      ).generated,
    ).toBe(0);
    await approve.click();
    await expect(
      page.getByRole("heading", { name: "You’re connected." }),
    ).toBeVisible({ timeout: 30000 });
    const outcomes = JSON.parse(
      await readFile(join(root, "outcomes.json"), "utf8"),
    );
    expect(outcomes).toEqual({ generated: 1, credentials: 1, validated: 1 });
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((window) => window.isVisible()),
      ),
    ).toBe(false);
    const state = await page.evaluate(() => window.desk.accountState());
    expect(state.teamId).toBe("TEAM123456");
    expect(state.keyId).toBe("TESTKEY123");
    expect(state.issuerId).toBe("11111111-2222-4333-8444-555555555555");
    expect(state.downloadedFile).toBeUndefined();
    expect(await readdir(join(root, "accounts", "private-downloads"))).toEqual(
      [],
    );
    const logs = await readFile(
      join(state.diagnosticPath!, "events.jsonl"),
      "utf8",
    );
    expect(logs).toContain("automation.action.verified");
    expect(logs).toContain("automation.download.verified");
    expect(logs).not.toContain("TEST_PRIVATE_KEY_BYTES");
    expect(logs).not.toContain("automation.action.timeout");
    await page.screenshot({ path: "test-results/account-replay-complete.png" });
    await app.close();
    app = await electron.launch({
      args: [resolve("out/tests/account-harness.cjs")],
      env,
    });
    const restored = await app.firstWindow();
    await expect(
      restored.getByRole("heading", { name: "You’re connected." }),
    ).toBeVisible();
    expect(
      JSON.parse(await readFile(join(root, "outcomes.json"), "utf8")),
    ).toEqual({ generated: 1, credentials: 1, validated: 2 });
  } catch (error) {
    await cp(join(root, "diagnostics"), testInfo.outputPath("diagnostics"), {
      recursive: true,
    }).catch(() => {});
    await page
      .screenshot({ path: testInfo.outputPath("failure.png") })
      .catch(() => {});
    throw error;
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

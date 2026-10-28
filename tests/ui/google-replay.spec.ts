import { test, expect, _electron as electron } from "@playwright/test";
test.describe.configure({ timeout: 120000 });
import { build } from "esbuild";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
async function harness(scenario = "success") {
  await build({
    entryPoints: ["tests/harness/google.ts"],
    outfile: "out/tests/google-harness.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    packages: "external",
  });
  const root = await mkdtemp(join(tmpdir(), "desk-google-"));
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      LOCAL_BUILD_DESK_DATA_DIR: root,
      DESK_GOOGLE_SCENARIO: scenario,
    }).filter(
      ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
    ),
  ) as Record<string, string>;
  const launch = () =>
    electron.launch({ args: [resolve("out/tests/google-harness.cjs")], env });
  return {
    root,
    launch,
    outcome: async () =>
      JSON.parse(await readFile(join(root, "outcome.json"), "utf8")),
  };
}
test("Google account automation enables APIs, reuses scoped forms, encrypts a key, and grants only approved app access", async () => {
  const h = await harness();
  let app = await h.launch();
  let page = await app.firstWindow();
  try {
    await page.evaluate(() =>
      window.desk.updateAccountSetup({
        googleCloudProject: "fixture-builds",
        googleStartSetup: true,
      }),
    );
    await page
      .getByRole("button", { name: "Approve service account & key" })
      .click();
    await expect(
      page.getByRole("button", { name: "Approve this app’s testing access" }),
    ).toBeVisible({ timeout: 60000 });
    expect(
      await page.evaluate(
        async () => new URL((await window.desk.accountState()).url).hostname,
      ),
    ).toBe("play.google.com");
    expect((await h.outcome()).invites).toBe(0);
    expect((await h.outcome()).keys).toBe(1);
    expect((await h.outcome()).imports).toBe(1);
    await expect(
      readFile(join(h.root, "settings.json"), "utf8"),
    ).rejects.toThrow();
    // The encrypted pending key survives restart; form scope is checked again.
    await app.close();
    app = await h.launch();
    page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: "Approve this app’s testing access" }),
    ).toBeVisible({ timeout: 35000 });
    expect(await h.outcome()).toMatchObject({
      keys: 1,
      imports: 1,
      invites: 0,
    });
    await page
      .getByRole("button", { name: "Approve this app’s testing access" })
      .click();
    await expect(
      page.getByText("Google Play connection verified for this app."),
    ).toBeVisible({ timeout: 20000 });
    const outcome = await h.outcome();
    expect(outcome).toEqual({
      projects: 0,
      apis: ["androidpublisher.googleapis.com", "iam.googleapis.com"],
      services: 1,
      keys: 1,
      imports: 1,
      invites: 1,
    });
    expect(
      JSON.parse(await readFile(join(h.root, "settings.json"), "utf8"))
        .googleConnectionId,
    ).toBe("new-connection");
    expect(
      await app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().filter((window) => window.isVisible())
            .length,
      ),
    ).toBe(0);
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      return (
        await Promise.all(
          entries.map((entry) =>
            entry.isDirectory()
              ? walk(join(dir, entry.name))
              : Promise.resolve([join(dir, entry.name)]),
          ),
        )
      ).flat();
    };
    for (const file of await walk(join(h.root, "diagnostics")))
      expect(await readFile(file, "utf8")).not.toContain(
        "GOOGLE_FIXTURE_PRIVATE_BYTES_NEVER_LOG",
      );
  } finally {
    await app.close();
    await rm(h.root, { recursive: true, force: true });
  }
});
test("an uncertain Google key request is not repeated on retry or restart", async () => {
  const h = await harness("ambiguous");
  let app = await h.launch();
  try {
    let page = await app.firstWindow();
    await page.evaluate(() =>
      window.desk.updateAccountSetup({
        googleCloudProject: "fixture-builds",
        googleStartSetup: true,
      }),
    );
    await page
      .getByRole("button", { name: "Approve service account & key" })
      .click();
    await expect(
      page.getByText(/Google has not delivered the submitted key download/),
    ).toBeVisible({ timeout: 60000 });
    await page.getByRole("button", { name: "Retry automation" }).click();
    expect((await h.outcome()).keys).toBe(1);
    await app.close();
    app = await h.launch();
    page = await app.firstWindow();
    await expect(page.getByText(/A key was already requested/)).toBeVisible({
      timeout: 25000,
    });
    expect((await h.outcome()).keys).toBe(1);
    expect((await h.outcome()).invites).toBe(0);
  } finally {
    await app.close();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("prepares and creates a new Cloud project only after the scoped approval", async () => {
  const h = await harness("new-project");
  const app = await h.launch();
  try {
    const page = await app.firstWindow();
    await page.evaluate(() =>
      window.desk.updateAccountSetup({
        googleCloudProject: "fixture-builds",
        googleCreateProject: true,
        googleStartSetup: true,
      }),
    );
    await expect(
      page.getByRole("button", { name: "Approve service account & key" }),
    ).toBeVisible({ timeout: 20000 });
    let outcome;
    try {
      outcome = await h.outcome();
    } catch {
      outcome = { projects: 0, keys: 0 };
    }
    expect(outcome.projects).toBe(0);
    expect(outcome.keys).toBe(0);
    await page
      .getByRole("button", { name: "Approve service account & key" })
      .click();
    await expect(
      page.getByRole("button", { name: "Approve this app’s testing access" }),
    ).toBeVisible({ timeout: 60000 });
    expect((await h.outcome()).projects).toBe(1);
    expect((await h.outcome()).keys).toBe(1);
    expect((await h.outcome()).invites).toBe(0);
  } finally {
    await app.close();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("CLI-created credentials continue through guided Play permissions without generating another key", async () => {
  const h = await harness("cli-fallback");
  const app = await h.launch();
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: "Approve this app’s testing access" }),
    ).toBeVisible({ timeout: 35000 });
    await expect(
      page.getByRole("button", { name: "Approve service account & key" }),
    ).toHaveCount(0);
    await expect(
      readFile(join(h.root, "settings.json"), "utf8"),
    ).rejects.toThrow();
    await page
      .getByRole("button", { name: "Approve this app’s testing access" })
      .click();
    await expect(
      page.getByText("Google Play connection verified for this app."),
    ).toBeVisible({ timeout: 20000 });
    expect(await h.outcome()).toEqual({
      projects: 0,
      apis: [],
      services: 0,
      keys: 0,
      imports: 0,
      invites: 1,
    });
  } finally {
    await app.close();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("resumes an unfinished new connection without reverting to an older valid saved key", async () => {
  const h = await harness("resume-existing");
  let app = await h.launch();
  try {
    let page = await app.firstWindow();
    await expect(
      page.getByText("Google Play connection verified for this app."),
    ).toBeVisible();
    await page.evaluate(() =>
      window.desk.updateAccountSetup({
        googleCloudProject: "fixture-builds",
        googleStartSetup: true,
      }),
    );
    await page
      .getByRole("button", { name: "Approve service account & key" })
      .click();
    await expect(
      page.getByText(/Google has not delivered the submitted key download/),
    ).toBeVisible({ timeout: 60000 });
    await app.close();
    app = await h.launch();
    page = await app.firstWindow();
    await expect(page.getByText(/A key was already requested/)).toBeVisible({
      timeout: 25000,
    });
    const state = await page.evaluate(() => window.desk.accountState());
    expect(state.status).toBe("needs-input");
    expect(state.google?.pendingCredentialId).toBeUndefined();
    expect((await h.outcome()).keys).toBe(1);
  } finally {
    await app.close();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("new Google keys activate automatically without reimporting or regenerating", async () => {
  const h = await harness("activation");
  const app = await h.launch();
  const page = await app.firstWindow();
  try {
    await page.evaluate(() =>
      window.desk.updateAccountSetup({
        googleCloudProject: "fixture-builds",
        googleStartSetup: true,
      }),
    );
    await page
      .getByRole("button", { name: "Approve service account & key" })
      .click();
    await expect(
      page.getByText(/Google is activating the new key/),
    ).toBeVisible({ timeout: 60000 });
    await expect(
      page.getByRole("button", { name: "Approve this app’s testing access" }),
    ).toBeVisible({ timeout: 60000 });
    expect(await h.outcome()).toMatchObject({
      keys: 1,
      imports: 1,
      invites: 0,
    });
    await expect(
      readFile(join(h.root, "settings.json"), "utf8"),
    ).rejects.toThrow();
  } finally {
    await app.close();
    await rm(h.root, { recursive: true, force: true });
  }
});

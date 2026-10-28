import { test, expect, _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
test.describe.configure({ timeout: 90000 });
async function harness(scenario: string) {
  await build({
    entryPoints: ["tests/harness/store.ts"],
    outfile: "out/tests/store-harness.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    packages: "external",
  });
  const root = await mkdtemp(join(tmpdir(), "desk-store-"));
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      LOCAL_BUILD_DESK_DATA_DIR: root,
      DESK_STORE_SCENARIO: scenario,
    }).filter(([k, v]) => k !== "ELECTRON_RUN_AS_NODE" && v !== undefined),
  ) as Record<string, string>;
  const launch = () =>
    electron.launch({ args: [resolve("out/tests/store-harness.cjs")], env });
  return {
    root,
    launch,
    outcome: async () =>
      JSON.parse(await readFile(join(root, "outcome.json"), "utf8")),
  };
}
test("apple-taken: a taken name is reported, renamed, and created only after a new approval", async () => {
  const h = await harness("apple-taken"),
    app = await h.launch(),
    page = await app.firstWindow();
  try {
    // User Access is the person's choice; approval waits until it is made.
    await expect(page.getByText(/Choose User Access/).first()).toBeVisible({
      timeout: 25000,
    });
    await expect(
      page.getByRole("button", { name: "Approve create app record" }),
    ).toHaveCount(0);
    const provider = await app.evaluate(
      ({ webContents }) =>
        webContents
          .getAllWebContents()
          .find((c) => c.getURL().endsWith("/apps"))?.id,
    );
    await app.evaluate(async ({ webContents }, id) => {
      await webContents
        .fromId(id!)!
        .executeJavaScript(
          "document.querySelectorAll('[name=userAccess]')[1].click()",
          true,
        );
    }, provider);
    await page
      .getByRole("button", { name: "Approve create app record" })
      .click({ timeout: 25000 });
    await expect(
      page.getByText("The app name you entered is already being used.").first(),
    ).toBeVisible({ timeout: 20000 });
    expect(await h.outcome()).toMatchObject({ creates: 0, rejected: 1 });
    await page
      .getByLabel("Store app name", { exact: true })
      .fill("Fixture Two");
    await page.getByRole("button", { name: "Retry with this name" }).click();
    const approve = page.getByRole("button", {
      name: "Approve create app record",
    });
    await expect(approve).toBeVisible({ timeout: 20000 });
    await expect(
      page.getByText(/Create Fixture Two for/).first(),
    ).toBeVisible();
    expect((await h.outcome()).creates).toBe(0);
    await approve.click();
    await expect(
      page
        .getByText("Store setup verified for com.example.fixture.", {
          exact: true,
        })
        .first(),
    ).toBeVisible({ timeout: 30000 });
    expect(await h.outcome()).toMatchObject({ creates: 1, rejected: 1 });
  } finally {
    await app.close();
    await rm(h.root, { recursive: true, force: true });
  }
});
test("apple-stuck: a resumed create that never reached Apple is offered again behind a new approval", async () => {
  test.setTimeout(120000);
  const h = await harness("apple-stuck"),
    app = await h.launch(),
    page = await app.firstWindow();
  try {
    const approve = page.getByRole("button", {
      name: "Approve create app record",
    });
    await expect(approve).toBeVisible({ timeout: 80000 });
    await expect(
      page.getByText(/has no app record for this bundle ID/).first(),
    ).toBeVisible();
    expect((await h.outcome()).creates).toBe(0);
    await approve.click();
    await expect(
      page
        .getByText("Store setup verified for com.example.fixture.", {
          exact: true,
        })
        .first(),
    ).toBeVisible({ timeout: 30000 });
    expect(await h.outcome()).toMatchObject({ creates: 1, verified: 1 });
  } finally {
    await app.close();
    await rm(h.root, { recursive: true, force: true });
  }
});
for (const scenario of ["apple", "google"])
  test(`${scenario}: prepares a store record and creates only after approval`, async () => {
    const h = await harness(scenario),
      app = await h.launch(),
      page = await app.firstWindow();
    try {
      const approve = page.getByRole("button", {
        name: "Approve create app record",
      });
      await expect(approve).toBeVisible({ timeout: 25000 });
      expect((await h.outcome()).creates).toBe(0);
      if (scenario === "google") {
        const remote = await app.evaluate(
          ({ webContents }) =>
            webContents
              .getAllWebContents()
              .find((c) => c.getURL().includes("/create-app"))?.id,
        );
        await app.evaluate(async ({ webContents }, id) => {
          await webContents
            .fromId(id!)!
            .executeJavaScript(
              "document.querySelector('#terms').click()",
              true,
            );
        }, remote);
      }
      await approve.click();
      await expect(
        page
          .getByText("Store setup verified for com.example.fixture.", {
            exact: true,
          })
          .first(),
      ).toBeVisible({ timeout: 20000 });
      expect(await h.outcome()).toMatchObject({ creates: 1, verified: 1 });
    } finally {
      await app.close();
      await rm(h.root, { recursive: true, force: true });
    }
  });
test("capabilities: preserves other assignments, confirms changes, and verifies profiles once", async () => {
  const h = await harness("capabilities"),
    app = await h.launch(),
    page = await app.firstWindow();
  try {
    await expect(
      page.getByRole("button", {
        name: "Approve apply capability assignments",
      }),
    ).toBeVisible({ timeout: 30000 });
    expect((await h.outcome()).profiles).toBe(0);
    await page
      .getByRole("button", { name: "Approve apply capability assignments" })
      .click();
    await expect(
      page
        .getByText("Store setup verified for com.example.fixture.", {
          exact: true,
        })
        .first(),
    ).toBeVisible({ timeout: 20000 });
    expect((await h.outcome()).profiles).toBe(1);
  } finally {
    await app.close();
    await rm(h.root, { recursive: true, force: true });
  }
});
test("bootstrap: attaches the exact approved AAB, saves internal draft, and verifies once", async () => {
  const h = await harness("bootstrap"),
    app = await h.launch(),
    page = await app.firstWindow();
  try {
    await expect(
      page.getByRole("button", { name: "Approve upload first aab" }),
    ).toBeVisible({ timeout: 20000 });
    expect((await h.outcome()).uploads).toBe(0);
    await page
      .getByRole("button", { name: "Approve upload first aab" })
      .click();
    await expect(
      page
        .getByText("Store setup verified for com.example.fixture.", {
          exact: true,
        })
        .first(),
    ).toBeVisible({ timeout: 25000 });
    expect(await h.outcome()).toMatchObject({
      uploads: 1,
      drafts: 1,
      verified: 1,
    });
  } finally {
    await app.close();
    await rm(h.root, { recursive: true, force: true });
  }
});
test("bootstrap: ambiguous upload is never reattached after retry or restart", async () => {
  const h = await harness("bootstrap-uncertain");
  let app = await h.launch();
  let page = await app.firstWindow();
  try {
    await expect(
      page.getByRole("button", { name: "Approve upload first aab" }),
    ).toBeVisible({ timeout: 20000 });
    await page
      .getByRole("button", { name: "Approve upload first aab" })
      .click();
    await expect.poll(async () => (await h.outcome()).uploads).toBe(1);
    await page.getByRole("button", { name: "Retry automation" }).click();
    await app.close();
    app = await h.launch();
    page = await app.firstWindow();
    await expect(page.getByText(/No second upload or API edit/)).toBeVisible({
      timeout: 12000,
    });
    expect(await h.outcome()).toMatchObject({
      uploads: 1,
      drafts: 0,
      verified: 0,
    });
  } finally {
    await app.close();
    await rm(h.root, { recursive: true, force: true });
  }
});

test("existing Play dashboard redirects are associated without opening a new app form", async () => {
  const h = await harness("google-existing"),
    app = await h.launch(),
    page = await app.firstWindow();
  try {
    await expect(
      page
        .getByText("Store setup verified for com.example.fixture.", {
          exact: true,
        })
        .first(),
    ).toBeVisible({ timeout: 15000 });
    expect(await h.outcome()).toMatchObject({ creates: 0, verified: 1 });
    await expect(
      page.getByRole("button", { name: "Approve create app record" }),
    ).toHaveCount(0);
  } finally {
    await app.close();
    await rm(h.root, { recursive: true, force: true });
  }
});

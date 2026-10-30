import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../src/core/database";
import type { Project, Job } from "../../src/core/types";

// The Tests and Readiness screens against a recorded check run: evidence,
// a capture preview, policy validation, and readiness blocking upload.
test("shows release-check evidence, previews captures and reports readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-checks-ui-"));
  const source = join(root, "source"),
    state = join(root, "state");
  await mkdir(join(source, "node_modules/expo/bin"), { recursive: true });
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "checks-fixture",
      dependencies: { expo: "58.0.0" },
    }),
  );
  await writeFile(
    join(source, "node_modules/expo/bin/cli"),
    `console.log(${JSON.stringify(
      JSON.stringify({
        name: "Checks Fixture",
        slug: "checks-fixture",
        version: "1.0.0",
        ios: { bundleIdentifier: "com.example.checks" },
      }),
    )});`,
  );
  await writeFile(
    join(source, "eas.json"),
    JSON.stringify({ build: { production: {} } }),
  );
  const shot = join(root, "home.png");
  // A real, decodable PNG so the preview renders: 1320×2868 grey RGB.
  const crc = (b: Buffer) => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1320, 0);
  header.writeUInt32BE(2868, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(1320 * 3, 0x55)]);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(2868).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  await writeFile(shot, png);
  await writeFile(shot.replace(/\.png$/, "-framed.png"), png);
  const store = new Store(state);
  const project: Project = {
    id: "project",
    path: source,
    name: "Checks Fixture",
    bundleId: "com.example.checks",
    profiles: ["production"],
    version: "1.0.0",
    createdAt: "2026-10-01T00:00:00Z",
    settings: {
      releaseChecks: {
        enabled: true,
        required: true,
        runner: "xcode",
        onlyTesting: [],
        timeoutSeconds: 1800,
        androidDevices: [],
        androidCaptureTask: ":app:assembleRelease",
        destinations: [{ deviceType: "iPhone 18 Pro Max", runtime: "27.2" }],
      },
    },
  };
  store.putProject(project);
  const source64 = "c".repeat(64);
  store.putJob({
    id: "checks",
    kind: "test",
    projectId: project.id,
    projectName: project.name,
    platform: "ios",
    profile: "production",
    stage: "complete",
    status: "succeeded",
    createdAt: "2026-10-29T00:00:00Z",
    autoSubmit: false,
    clean: false,
    bundleId: project.bundleId,
    version: "1.0.0",
    buildNumber: "1",
    facts: { sourceHash: source64 },
    checkpoints: [
      {
        stage: "testing",
        state: "complete",
        startedAt: "2026-10-29T00:00:00Z",
        finishedAt: "2026-10-29T00:01:00Z",
      },
      {
        stage: "screenshots",
        state: "complete",
        startedAt: "2026-10-29T00:01:00Z",
        finishedAt: "2026-10-29T00:02:00Z",
      },
    ],
    validation: {
      state: "passed",
      mode: "all",
      fingerprint: "f".repeat(64),
      sourceHash: source64,
      policyDigest: "d".repeat(64),
      configuration: "Release",
      startedAt: "2026-10-29T00:00:00Z",
      finishedAt: "2026-10-29T00:02:00Z",
      runs: [
        {
          device: "iPhone 18 Pro Max",
          runtime: "27.2",
          status: "passed",
          passed: 25,
          failed: 0,
          total: 25,
        },
      ],
      screenshots: [
        {
          name: "home",
          path: shot,
          sha256: createHash("sha256").update(png).digest("hex"),
          size: png.length,
          width: 1320,
          height: 2868,
          displayType: "APP_IPHONE_67",
          framed: {
            path: shot.replace(/\.png$/, "-framed.png"),
            sha256: createHash("sha256").update(png).digest("hex"),
            size: png.length,
          },
          device: "iPhone 18 Pro Max",
          runtime: "27.2",
        },
      ],
    },
  } as unknown as Job);
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
    await page.getByRole("button", { name: "Tests", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Tests & screenshots" }),
    ).toBeVisible();
    const row = page.getByRole("row", {
      name: /Tests \+ screenshots passed run/,
    });
    await expect(row).toContainText("25 passed · 0 failed · 1 screenshot");
    await expect(row).toContainText("iPhone 18 Pro Max");
    await row.click();
    await expect(
      page.getByRole("heading", { name: "Tests + screenshots", level: 2 }),
    ).toBeFocused();
    await expect(page.getByText("25 passed · 0 failed · passed")).toBeVisible();
    // Framed store images show first; the raw capture is a toggle away.
    await expect(
      page.getByText("1320 × 2868 · APP_IPHONE_67 · framed"),
    ).toBeVisible();
    await page
      .getByRole("checkbox", {
        name: "Show raw captures instead of framed store images",
      })
      .check();
    await expect(
      page.getByText("1320 × 2868 · APP_IPHONE_67", { exact: true }),
    ).toBeVisible();
    const image = page.getByAltText("home on iPhone 18 Pro Max");
    await expect(image).toBeVisible();
    expect(await image.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(
      1320,
    );
    // A test-only run is evidence, not a store build to take screenshots from.
    await expect(
      page.getByRole("button", { name: "Use screenshots in listing" }),
    ).toHaveCount(0);
    await page.screenshot({ path: "test-results/release-check-run.png" });
    await page.getByRole("button", { name: "Back to test runs" }).click();
    await expect(row).toBeFocused();
    await page.getByRole("button", { name: "Check settings" }).click();
    // A checked-in plan file must stay inside the project.
    await page
      .getByRole("checkbox", { name: "Capture store screenshots after tests" })
      .check();
    await page.getByRole("radio", { name: "Plan file in the project" }).check();
    await page.getByRole("textbox", { name: "Plan file" }).fill("../plan.json");
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect(page.locator(".inline-error")).toContainText(
      "screenshotPlanFile: Use a .json path inside the project.",
    );
    await page.getByRole("radio", { name: "Edit here" }).check();
    // Removing the only simulator is rejected when saving an Xcode policy.
    await page.getByRole("button", { name: "Remove simulator 1" }).click();
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect(page.locator(".inline-error")).toHaveText(
      "destinations: Choose at least one simulator device and runtime.",
    );
    await page.screenshot({ path: "test-results/release-checks.png" });

    await page.getByRole("button", { name: "Readiness", exact: true }).click();
    await page.getByRole("button", { name: "Check readiness" }).click();
    await expect(
      page.getByRole("heading", { name: "Work remains before release" }),
    ).toBeVisible({ timeout: 60000 });
    await expect(
      page
        .locator(".readiness-list article.blocked")
        .filter({ hasText: "Apple connection" }),
    ).toBeVisible();
    await expect(
      page.locator(".readiness-list").getByText("Physical-device check"),
    ).toBeVisible();
    await page.screenshot({ path: "test-results/release-readiness.png" });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

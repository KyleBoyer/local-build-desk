import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The Feedback page without store connections: it explains what to connect
// and renders no errors.
test("shows the feedback inbox and asks to connect stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-feedback-test-"));
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
  try {
    await page.evaluate((path) => window.desk.importProject(path), project);
    await page.getByRole("button", { name: "Feedback", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Feedback" })).toBeVisible();
    await expect(
      page.getByText(/Connect App Store Connect or Google Play/),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: /Unread/ })).toBeVisible();
    await page.getByRole("tab", { name: "1–2 ★" }).click();
    await expect(page.getByText("Nothing matches this filter.")).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

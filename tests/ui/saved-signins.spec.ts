import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Saving needs the Keychain (covered by unit tests against the vault); this
// checks the Preferences section and its form rules in the real app.
test("offers saved Apple and Google sign-ins in Preferences", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-signins-test-"));
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
  try {
    await page
      .getByRole("button", { name: "Preferences", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Saved sign-ins" }),
    ).toBeVisible();
    const save = page.getByRole("button", { name: "Save sign-in" });
    await expect(save).toBeDisabled();
    await page.getByLabel("Email").fill("dev@example.com");
    await expect(save).toBeDisabled();
    await page.getByLabel("Password").fill("secret");
    await expect(save).toBeEnabled();
    await expect(page.getByLabel("Password")).toHaveAttribute(
      "type",
      "password",
    );
    await page.getByLabel("Account").selectOption("google");
    await expect(
      page.getByRole("option", { name: /Google account/ }),
    ).toBeAttached();
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

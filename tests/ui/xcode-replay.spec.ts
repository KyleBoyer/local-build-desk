import { test, expect, _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

for (const scenario of ["xcode-success", "xcode-failure"]) {
  test(`${scenario}: download, explicit license approval, components, and retained recovery`, async () => {
    await build({
      entryPoints: ["tests/harness/account.ts"],
      outfile: "out/tests/xcode-harness.cjs",
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      external: ["electron"],
    });
    const root = await mkdtemp(join(tmpdir(), "desk-xcode-replay-"));
    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        LOCAL_BUILD_DESK_DATA_DIR: root,
        DESK_REPLAY_SCENARIO: scenario,
      }).filter(
        ([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined,
      ),
    ) as Record<string, string>;
    const launch = () =>
      electron.launch({
        args: [resolve("out/tests/xcode-harness.cjs")],
        env,
      });
    const calls = async () =>
      JSON.parse(await readFile(join(root, "xcode-calls.json"), "utf8"));
    let app = await launch();
    try {
      let page = await app.firstWindow();
      if (scenario === "xcode-failure") {
        await expect(
          page.getByText(/Fixture Xcode download validation failed/),
        ).toBeVisible();
        // The periodic automation must not continually expand/retry a failed archive.
        await expect.poll(async () => (await calls()).length).toBe(1);
        await page.waitForTimeout(3000);
        expect((await calls()).length).toBe(1);
        await page.getByRole("button", { name: "Retry automation" }).click();
      }
      const approve = page.getByRole("button", {
        name: "Accept license & finish Xcode setup",
      });
      await expect(approve).toBeVisible();
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((window) => window.isVisible()),
        ),
      ).toBe(false);
      expect((await calls()).every((call: any) => !call.acceptLicense)).toBe(
        true,
      );
      const state = await page.evaluate(() => window.desk.accountState());
      expect(state.downloadedFile).toMatch(
        /Xcode_27\.2_Release_Candidate\.xip$/,
      );
      await approve.click();
      await expect(
        page
          .getByText(
            /Xcode 27.2 and its iOS platform are installed and selected/,
          )
          .first(),
      ).toBeVisible();
      expect(
        (await page.evaluate(() => window.desk.accountState())).events.some(
          (entry) => entry.includes("Fixture iOS component progress: 50%"),
        ),
      ).toBe(true);
      expect(
        (await calls()).filter((call: any) => call.acceptLicense),
      ).toHaveLength(1);
      const diagnostics = await readFile(
        join(state.diagnosticPath!, "events.jsonl"),
        "utf8",
      );
      expect(diagnostics).toContain("xcode.download.finished");
      expect(diagnostics).toContain("before-xcode-download");
      await app.close();
      app = await launch();
      page = await app.firstWindow();
      await expect(
        page
          .getByText(
            /Xcode 27.2 and its iOS platform are installed and selected/,
          )
          .first(),
      ).toBeVisible();
      expect((await page.evaluate(() => window.desk.accountState())).url).toBe(
        "about:blank",
      );
      // A restart reuses the extracted app and approved license, never starts another download.
      const restoredCalls = await calls();
      expect(restoredCalls.at(-1).acceptLicense).toBe(true);
      expect(restoredCalls.at(-1).path).toMatch(/Xcode-27\.2\.app$/);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

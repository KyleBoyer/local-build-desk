import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../src/core/process";

test("native tray clocks tick throughout one open menu, including its submenu and hour boundary", async () => {
  test.skip(
    process.platform !== "darwin",
    "The menu bar uses AppKit on macOS.",
  );
  const root = await mkdtemp(join(tmpdir(), "desk-menu-clock-"));
  try {
    const executable = join(root, "menu-clock");
    await run(
      "xcrun",
      [
        "clang++",
        "-std=c++17",
        "-fobjc-arc",
        "-framework",
        "Cocoa",
        resolve("native/menu-clock.mm"),
        resolve("tests/fixtures/menu-clock.mm"),
        "-o",
        executable,
      ],
      { timeout: 30000 },
    );
    const result = JSON.parse(
      (await run(executable, [], { timeout: 10000 })).stdout,
    );
    expect(result).toMatchObject({
      tracked: true,
      stopped: true,
      sameItem: true,
      sameSubmenu: true,
      waiting: "Waiting: 0s",
    });
    expect(result.titles.length).toBeGreaterThanOrEqual(4);
    expect(result.elapsed.length).toBeGreaterThanOrEqual(3);
    expect(result.progress).toMatch(/^Upload · 25% · [3-5]s$/);
    expect(
      result.elapsed.every((v: string) => /^Elapsed: 1h 0m \d{2}s$/.test(v)),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

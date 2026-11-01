import { it, expect, vi, beforeEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/core/database";
import { Vault } from "../src/core/vault";
import { Engine } from "../src/core/engine";
import { inspectProject } from "../src/core/config";

vi.mock("../src/core/config", async (original) => ({
  ...(await original<typeof import("../src/core/config")>()),
  inspectProject: vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 20));
    return {
      type: "native",
      platforms: ["ios"],
      name: "Fixture",
      version: "1.0",
      profiles: ["production"],
      eas: {},
      native: {},
      issues: [],
    };
  }),
}));

let engine: Engine;
beforeEach(async () => {
  vi.mocked(inspectProject).mockClear();
  const root = await mkdtemp(join(tmpdir(), "desk-inspect-cache-"));
  const store = new Store(root);
  engine = new Engine(
    store,
    new Vault(store, {
      async encrypt(v) {
        return Buffer.from(v);
      },
      async decrypt(v) {
        return v.toString();
      },
    }),
  );
  store.putProject({
    id: "project",
    name: "Fixture",
    path: root,
    settings: {},
    profiles: [],
    createdAt: "2026-01-01",
  });
});

it("shares one inspection between identical requests, and Refresh reads again", async () => {
  // Views mounting together ask for the same inspection at once.
  await Promise.all([
    engine.inspect("project"),
    engine.inspect("project"),
    engine.inspect("project"),
  ]);
  expect(inspectProject).toHaveBeenCalledTimes(1);
  // A moment later the result is reused.
  await engine.inspect("project");
  expect(inspectProject).toHaveBeenCalledTimes(1);
  // Refresh, and the CLI, always read the project again.
  await engine.inspect("project", undefined, "ios", true);
  expect(inspectProject).toHaveBeenCalledTimes(2);
});

it("doesn't keep a failed inspection", async () => {
  vi.mocked(inspectProject).mockRejectedValueOnce(
    new Error("xcodebuild failed"),
  );
  await expect(engine.inspect("project")).rejects.toThrow(/xcodebuild failed/);
  await engine.inspect("project");
  expect(inspectProject).toHaveBeenCalledTimes(2);
});

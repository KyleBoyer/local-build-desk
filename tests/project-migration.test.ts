import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/core/database";
import { resolveInvocation } from "../src/cli/invocation";
import type { Project } from "../src/core/types";
import type { Engine } from "../src/core/engine";
it("migrates the legacy unique-path table without losing project IDs, history or counters", () => {
  const root = mkdtempSync(join(tmpdir(), "desk-project-migration-"));
  try {
    const db = new DatabaseSync(join(root, "desk.sqlite"));
    db.exec(
      "CREATE TABLE projects(id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,data TEXT NOT NULL); CREATE TABLE counters(identity TEXT PRIMARY KEY,last_used INTEGER NOT NULL);",
    );
    const legacy: Project = {
      id: "legacy",
      path: join(root, "repository"),
      name: "Legacy",
      createdAt: "now",
      profiles: ["production"],
      settings: {},
    };
    db.prepare("INSERT INTO projects VALUES(?,?,?)").run(
      legacy.id,
      legacy.path,
      JSON.stringify(legacy),
    );
    db.prepare("INSERT INTO counters VALUES(?,?)").run(
      "ios:com.example.app",
      70,
    );
    db.close();
    const store = new Store(root);
    try {
      expect(store.get("projects", "legacy")).toEqual(legacy);
      expect(store.counter("ios:com.example.app")).toBe(70);
      store.putProject({
        ...legacy,
        id: "native",
        name: "Native",
        type: "native-ios",
        platforms: ["ios"],
        settings: { appDirectory: "apps/native" },
      });
      expect(store.list("projects")).toHaveLength(2);
      expect(store.claimNumber("ios:com.example.app", "native-job")).toBe("71");
    } finally {
      store.close();
    }
    const reopened = new Store(root);
    expect(reopened.list("projects")).toHaveLength(2);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("requires an explicit app when a repository has multiple stored signing configurations", async () => {
  const root = mkdtempSync(join(tmpdir(), "desk-app-selection-"));
  try {
    const projects: Project[] = ["a", "b"].map((name) => ({
      id: name,
      path: root,
      name,
      createdAt: "now",
      profiles: ["production"],
      settings: {
        projectType: "native-ios",
        appDirectory: "apps/" + name,
        iosSigningId: "key-" + name,
      },
    }));
    const engine = { state: () => ({ projects }) } as Engine;
    await expect(
      resolveInvocation(engine, { project: root }, {}),
    ).rejects.toThrow(/More than one app/);
    const selected = await resolveInvocation(
      engine,
      { project: root, "app-directory": "apps/b" },
      {},
    );
    expect(selected.project.id).toBe("b");
    expect(selected.project.settings.iosSigningId).toBe("key-b");
    writeFileSync(
      join(root, "ios-submit.json"),
      JSON.stringify({ settings: { appDirectory: "apps/a" } }),
    );
    const configured = await resolveInvocation(engine, { project: root }, {});
    expect(configured.project.id).toBe("a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

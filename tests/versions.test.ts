import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/database";
import { transferVersionCounter } from "../src/core/versions";
import { run, type CommandOptions } from "../src/core/process";
import type { Project, Job } from "../src/core/types";

it("hands counters to EAS without reusing failed local reservations, blocks other checkouts, and resumes above EAS", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-versions-"));
  const store = new Store(join(root, "data"));
  try {
    const path = join(root, "project");
    await mkdir(join(path, "node_modules"), { recursive: true });
    await writeFile(join(path, "package.json"), "{}");
    const project = {
      id: "project",
      path,
      settings: {},
      name: "fixture",
    } as Project;
    const key = "ios:com.example";
    store.seed(key, 70);
    let remote = 63,
      sets = 0;
    const execute = async (
      command: string,
      _args: string[],
      options?: CommandOptions,
    ) => {
      if (command === "eas")
        return {
          stdout: JSON.stringify({ buildNumber: String(remote) }),
          stderr: "",
          code: 0,
        };
      if (command === "/usr/bin/python3") {
        sets++;
        remote = Number(options!.input!.trim());
        expect(options!.inputAfter).toBeInstanceOf(RegExp);
      }
      return { stdout: "", stderr: "", code: 0 };
    };
    const handoff = await transferVersionCounter(
      store,
      project,
      "ios",
      "production",
      "com.example",
      true,
      "handoff",
      execute,
    );
    expect(handoff).toMatchObject({
      authority: "eas",
      easCounter: 70,
      nextEasBuild: 71,
    });
    expect(sets).toBe(1);
    const other = new Store(join(root, "data"));
    try {
      expect(() => other.reserve(key)).toThrow(/handed to EAS/);
    } finally {
      other.close();
    }
    remote = 72;
    await transferVersionCounter(
      store,
      project,
      "ios",
      "production",
      "com.example",
      true,
      "resume",
      execute,
    );
    expect(store.reserve(key)).toBe("73");
    remote = 80;
    sets = 0;
    await transferVersionCounter(
      store,
      project,
      "ios",
      "production",
      "com.example",
      true,
      "handoff",
      execute,
    );
    expect(sets).toBe(0);
    expect(store.counter(key)).toBe(80);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("does not hand off counters while the native queue is active", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-versions-busy-"));
  const store = new Store(root);
  try {
    store.seed("ios:app", 70);
    store.putJob({ id: "active", status: "queued" } as Job);
    expect(() => store.handoff("ios:app")).toThrow(/queue to finish/);
    expect(store.authority("ios:app")).toBe("local");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("keeps EAS ownership and gives a recovery instruction after an uncertain remote update", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-versions-uncertain-"));
  const store = new Store(join(root, "data"));
  try {
    const path = join(root, "project");
    await mkdir(join(path, "node_modules"), { recursive: true });
    await writeFile(join(path, "package.json"), "{}");
    store.seed("ios:app", 70);
    const execute = async (command: string) => {
      if (command === "eas")
        return { code: 0, stderr: "", stdout: '{"buildNumber":"63"}' };
      if (command === "/usr/bin/python3")
        throw new Error("connection lost after submission");
      return { code: 0, stderr: "", stdout: "" };
    };
    await expect(
      transferVersionCounter(
        store,
        { id: "project", path, settings: {} } as Project,
        "ios",
        "production",
        "app",
        true,
        "handoff",
        execute,
      ),
    ).rejects.toThrow(/remain paused.*--resume-local/);
    expect(store.authority("ios:app")).toBe("eas");
    expect(() => store.reserve("ios:app")).toThrow(/handed to EAS/);
    expect(store.counter("ios:app")).toBe(70);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("sends interactive tool input only after the expected prompt appears", async () => {
  const result = await run(
    process.execPath,
    [
      "-e",
      "setTimeout(()=>{process.stdout.write('What version? ');process.stdin.once('data',d=>{process.stdout.write('received:'+d.toString().trim());process.exit(0);});},30)",
    ],
    { input: "70\n", inputAfter: /What version\?/, timeout: 3000 },
  );
  expect(result.stdout).toContain("received:70");
});

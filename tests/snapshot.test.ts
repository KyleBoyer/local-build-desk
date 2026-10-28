import { it, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { snapshot, eligible } from "../src/core/snapshot";
import { run, Redactor } from "../src/core/process";
it("snapshots tracked and untracked source while excluding secrets and generated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-snapshot-"));
  const source = join(root, "app"),
    dest = join(root, "build");
  await mkdir(source);
  try {
    await run("git", ["init"], { cwd: source });
    await writeFile(join(source, ".gitignore"), "node_modules/\nios/\n");
    await writeFile(join(source, "tracked.ts"), "original");
    await run("git", ["add", "."], { cwd: source });
    await writeFile(join(source, "tracked.ts"), "uncommitted change");
    await mkdir(join(source, "modules"));
    await writeFile(join(source, "modules", "untracked.ts"), "native module");
    await writeFile(join(source, ".env"), "TOKEN=secret");
    await writeFile(join(source, "credentials.json"), "secret");
    await mkdir(join(source, "node_modules"));
    await writeFile(join(source, "node_modules", "skip"), "dependency");
    await mkdir(join(source, "ios"));
    await writeFile(join(source, "ios", "skip"), "generated");
    const before = await readFile(join(source, "tracked.ts"), "utf8");
    const hash = await snapshot(source, dest, { ios: false, android: false });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(dest, "tracked.ts"), "utf8")).toBe(
      "uncommitted change",
    );
    expect(await readFile(join(dest, "modules/untracked.ts"), "utf8")).toBe(
      "native module",
    );
    for (const p of [
      ".env",
      "credentials.json",
      "node_modules/skip",
      "ios/skip",
    ])
      await expect(readFile(join(dest, p))).rejects.toThrow();
    expect(await readFile(join(source, "tracked.ts"), "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("rejects symlinks escaping the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-symlink-"));
  try {
    await mkdir(join(root, "app"));
    await symlink("../outside", join(root, "app", "link"));
    await writeFile(join(root, "outside"), "secret");
    await expect(
      snapshot(join(root, "app"), join(root, "build"), {
        ios: false,
        android: false,
      }),
    ).rejects.toThrow(/outside/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("excludes signing files and environment files at every depth", () => {
  for (const file of [
    ".env.production",
    "cert.p12",
    "a/upload.jks",
    "a/key.p8",
    "a/.env.local",
    "credentials.json",
  ])
    expect(eligible(file, { ios: true, android: true })).toBe(false);
  expect(
    eligible("modules/vault/ios/Module.swift", { ios: false, android: false }),
  ).toBe(true);
});
it("redacts split private-key lines and literal secrets in tool output", () => {
  const r = new Redactor();
  r.add(
    "super-secret-token",
    "-----BEGIN PRIVATE KEY-----\nvery-long-private-line\n-----END PRIVATE KEY-----",
  );
  expect(r.redact("token=super-secret-token")).not.toContain(
    "super-secret-token",
  );
  expect(r.redact("very-long-private-line")).toBe("[REDACTED]");
  expect(r.redact("Authorization: Bearer abc.def.ghi")).not.toContain(
    "abc.def.ghi",
  );
});
it("cancels a subprocess and its process group", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const promise = run(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  await expect(promise).rejects.toThrow(/cancelled/);
  expect(Date.now() - started).toBeLessThan(5000);
});

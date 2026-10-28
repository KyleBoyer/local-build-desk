import { it, expect, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, cp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/core/database";
import { Vault } from "../src/core/vault";
import {
  buildNonExpo,
  validateCapacitorSync,
} from "../src/core/build-adapters";
import * as commands from "../src/core/process";
import * as toolchain from "../src/core/doctor";
import type { Job, Project } from "../src/core/types";
afterEach(() => vi.restoreAllMocks());
async function fixture(server = false) {
  const root = await mkdtemp(join(tmpdir(), "desk-cap-build-unit-")),
    source = join(root, "source");
  await mkdir(join(source, "node_modules/@capacitor/cli/bin"), {
    recursive: true,
  });
  await mkdir(join(source, "dist"));
  await writeFile(join(source, "dist/index.html"), "stale assets");
  const pkg = {
    name: "fixture",
    version: "1.2.3",
    scripts: { build: "node build.js" },
    dependencies: { "@capacitor/core": "8.6.0", "@capacitor/ios": "8.6.0" },
    devDependencies: { "@capacitor/cli": "8.6.0" },
  };
  await writeFile(join(source, "package.json"), JSON.stringify(pkg));
  await writeFile(join(source, "package-lock.json"), "{}");
  await writeFile(
    join(source, "capacitor.config.json"),
    JSON.stringify({ appId: "com.example.fixture" }),
  );
  await writeFile(
    join(source, "node_modules/@capacitor/cli/bin/capacitor"),
    `const path=require('path'),cwd=process.cwd();console.log(JSON.stringify({app:{package:${JSON.stringify(pkg)},extConfig:{appId:'com.example.fixture',appName:'Fixture',webDir:'dist'${server ? ",server:{url:'http://localhost:5173'}" : ""}}},cli:{package:{version:'8.6.0'}},ios:{platformDirAbs:path.join(cwd,'ios'),packageManager:'SPM'},android:{platformDirAbs:path.join(cwd,'android')}}));`,
  );
  const store = new Store(join(root, "state")),
    vault = new Vault(store, {
      encrypt: async (s) => Buffer.from(s),
      decrypt: async (b) => b.toString(),
    });
  const project: Project = {
    id: "project",
    type: "capacitor",
    platforms: ["ios"],
    path: source,
    name: "Fixture",
    profiles: ["production"],
    createdAt: "now",
    settings: { projectType: "capacitor" },
  };
  const job: Job = {
    id: "job",
    projectId: "project",
    projectName: "Fixture",
    platform: "ios",
    profile: "production",
    kind: "build",
    status: "running",
    stage: "preflight",
    createdAt: "now",
    autoSubmit: false,
    clean: false,
  };
  store.putProject(project);
  store.putJob(job);
  return {
    root,
    source,
    store,
    ctx: {
      job,
      project,
      store,
      vault,
      signal: new AbortController().signal,
      log: () => {},
      stage: () => {},
      save: () => {},
    },
  };
}
it("blocks a production development-server URL before reserving versions or running native tools", async () => {
  const f = await fixture(true);
  try {
    await expect(buildNonExpo(f.ctx)).rejects.toThrow(/server.url/);
    expect(f.store.counter("ios:com.example.fixture")).toBeUndefined();
    expect(f.ctx.job.buildNumber).toBeUndefined();
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
it("requires freshly generated web assets instead of shipping an old ignored dist directory", async () => {
  const f = await fixture();
  try {
    vi.spyOn(toolchain, "doctor").mockResolvedValue(
      ["Node.js", "Xcode", "iOS SDK", "Build storage"].map((name) => ({
        name,
        status: "ok" as const,
        detail: "fixture",
      })),
    );
    const run = commands.run;
    const calls: string[][] = [];
    vi.spyOn(commands, "run").mockImplementation(
      async (command, args, options) => {
        if (command === "npm") {
          calls.push(args);
          if (args[0] === "ci")
            await cp(
              join(f.source, "node_modules"),
              join(options!.cwd!, "node_modules"),
              { recursive: true },
            );
          return { code: 0, stdout: "", stderr: "" };
        }
        return run(command, args, options);
      },
    );
    await expect(buildNonExpo(f.ctx)).rejects.toThrow(/index.html/);
    expect(calls).toContainEqual(["ci", "--no-audit", "--no-fund"]);
    expect(calls).toContainEqual(["run", "build"]);
    expect(await readFile(join(f.source, "dist/index.html"), "utf8")).toBe(
      "stale assets",
    );
    expect(f.store.counter("ios:com.example.fixture")).toBeUndefined();
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
it("does not silently omit plugins that Capacitor reports as incompatible with Swift Package Manager", () => {
  expect(() =>
    validateCapacitorSync(
      "[warn] Some installed Capacitor plugins are not compatible with SPM",
    ),
  ).toThrow(/compatible plugins/);
  expect(() =>
    validateCapacitorSync(
      "[info] All Capacitor plugins have a Package.swift file and will be included in Package.swift",
    ),
  ).not.toThrow();
});

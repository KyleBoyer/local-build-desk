import { test, expect, _electron as electron } from "@playwright/test";
import { build } from "esbuild";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Store } from "../../src/core/database";
import type { Job } from "../../src/core/types";
async function harness() {
  await build({
    entryPoints: ["tests/harness/cli-owner.ts"],
    outfile: "out/tests/cli-owner.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    packages: "external",
    plugins: [
      {
        name: "fixture-build",
        setup(api) {
          api.onResolve({ filter: /^\.\/build$/ }, (args) =>
            args.importer.endsWith("/src/core/engine.ts")
              ? { path: resolve("tests/harness/cli-build.ts") }
              : undefined,
          );
        },
      },
    ],
  });
  const root = await mkdtemp(join(tmpdir(), "desk-cli-owner-"));
  for (const name of ["first", "second"]) {
    const path = join(root, name);
    await mkdir(join(path, "node_modules/expo/bin"), { recursive: true });
    await writeFile(
      join(path, "package.json"),
      JSON.stringify({ dependencies: { expo: "58.0.0" } }),
    );
    await writeFile(
      join(path, "node_modules/expo/bin/cli"),
      `console.log(JSON.stringify({name:'Fixture',slug:'fixture',version:'1.0.0',ios:{bundleIdentifier:'com.example.fixture'}}));`,
    );
    await writeFile(
      join(path, "eas.json"),
      JSON.stringify({ build: { production: {} } }),
    );
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOCAL_BUILD_DESK_DATA_DIR: join(root, "data"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const children: ChildProcess[] = [];
  const launch = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
    const child = spawn(
      resolve(
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
      [resolve("out/tests/cli-owner.cjs"), "--desk-cli", ...args],
      { env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    let output = "";
    child.stdout!.on("data", (data) => (output += data.toString()));
    child.stderr!.on("data", (data) => (output += data.toString()));
    const exit = new Promise<number | null>((resolve) =>
      child.on("close", resolve),
    );
    return { child, exit, output: () => output };
  };
  return {
    root,
    env,
    launch,
    async cleanup() {
      for (const child of children)
        if (child.exitCode === null) child.kill("SIGTERM");
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("a headless CLI owner waits for a forwarded build before closing the shared engine", async () => {
  const h = await harness();
  try {
    const owner = h.launch(
      ["build", "--project", join(h.root, "first"), "--platform", "ios"],
      {
        IOS_SUBMIT_ENVIRONMENT_JSON: JSON.stringify({
          FIXTURE_WAIT_FOR_QUEUED: "true",
        }),
      },
    );
    await expect
      .poll(() => owner.output(), { timeout: 20000 })
      .toContain("fixture-active");
    expect(owner.output()).toContain(
      'fixture-tray {"count":1,"visible":true,"windows":0}',
    );
    const client = h.launch([
      "build",
      "--project",
      join(h.root, "second"),
      "--platform",
      "ios",
    ]);
    expect(await client.exit).toBe(0);
    expect(await owner.exit).toBe(0);
    expect(owner.output()).toContain(
      'fixture-tray {"count":2,"visible":true,"windows":0}',
    );
    expect(owner.output()).toContain("fixture-tray idle");
    expect(owner.output()).toContain("fixture-tray-disposed");
    const store = new Store(join(h.root, "data"));
    try {
      expect(store.list<Job>("jobs").map((job) => job.status)).toEqual([
        "succeeded",
        "succeeded",
      ]);
    } finally {
      store.close();
    }
  } finally {
    await h.cleanup();
  }
});

test("the desktop tray opens the selected build and restores a hidden window", async () => {
  const h = await harness();
  const app = await electron.launch({
    args: [resolve("out/tests/cli-owner.cjs")],
    env: Object.fromEntries(
      Object.entries({
        ...h.env,
        LOCAL_BUILD_DESK_DISABLE_UPDATES: "true",
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ app, BrowserWindow }) => {
      app.setActivationPolicy("accessory");
      BrowserWindow.getAllWindows()[0].hide();
    });
    const jobId = await page.evaluate(
      async (path) => {
        await window.desk.notificationSettings(false);
        const project = await window.desk.importProject(path);
        const jobs = await window.desk.build({
          projectId: project.id,
          platform: "ios",
          profile: "production",
          autoSubmit: false,
          clean: false,
        });
        return jobs[0].id;
      },
      join(h.root, "second"),
    );
    await app.evaluate((_, id) => {
      const monitor = (globalThis as any).__deskTray;
      const item = monitor.menu.items.find((item: any) => item.id === id);
      if (!item)
        throw new Error("Active build is missing from the native tray menu");
      const action = item.submenu.items.find(
        (item: any) => item.label === "Open build in Local Build Desk",
      );
      action.click();
    }, jobId);
    await expect(
      page.getByRole("heading", { name: "Build history" }),
    ).toBeVisible();
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
    ).toBe(true);
    await expect
      .poll(() => app.evaluate(() => !!(globalThis as any).__deskTray.tray))
      .toBe(false);
    await page.screenshot({ path: "test-results/tray-build-navigation.png" });
  } finally {
    await app.close();
    await h.cleanup();
  }
});
test("cancel reaches the headless owner through its socket and SIGINT exits cleanly", async () => {
  const h = await harness();
  try {
    const owner = h.launch([
      "build",
      "--project",
      join(h.root, "second"),
      "--platform",
      "ios",
    ]);
    await expect
      .poll(() => owner.output(), { timeout: 20000 })
      .toContain("fixture-active");
    const id = owner.output().match(/fixture-active ([0-9a-f-]+)/)![1];
    const cancel = h.launch(["cancel", "--job", id]);
    expect(await cancel.exit).toBe(0);
    expect(await owner.exit).toBe(1);
    const interrupt = h.launch([
      "build",
      "--project",
      join(h.root, "second"),
      "--platform",
      "ios",
    ]);
    await expect
      .poll(() => interrupt.output(), { timeout: 20000 })
      .toContain("fixture-active");
    interrupt.child.kill("SIGINT");
    expect(await interrupt.exit, interrupt.output()).toBe(130);
    expect(interrupt.output()).toContain("fixture-tray-disposed");
    const store = new Store(join(h.root, "data"));
    try {
      expect(
        store.list<Job>("jobs").every((job) => job.status === "cancelled"),
      ).toBe(true);
    } finally {
      store.close();
    }
  } finally {
    await h.cleanup();
  }
});
test("a disconnected CLI client does not abandon its queued native build", async () => {
  const h = await harness();
  try {
    // Keep the original owner alive until it accepts the client, even on a
    // loaded CI Mac where starting a second Electron process takes longer.
    const owner = h.launch(
      ["build", "--project", join(h.root, "first"), "--platform", "ios"],
      {
        IOS_SUBMIT_ENVIRONMENT_JSON: JSON.stringify({
          FIXTURE_WAIT_FOR_QUEUED: "true",
        }),
      },
    );
    await expect
      .poll(() => owner.output(), { timeout: 20000 })
      .toContain("fixture-active");
    const client = h.launch([
      "build",
      "--project",
      join(h.root, "second"),
      "--platform",
      "ios",
    ]);
    await expect
      .poll(() => client.output(), { timeout: 20000 })
      .toContain("fixture-active");
    client.child.kill("SIGTERM");
    await client.exit;
    expect(await owner.exit).toBe(0);
    const store = new Store(join(h.root, "data"));
    try {
      expect(store.list<Job>("jobs").map((job) => job.status)).toEqual([
        "succeeded",
        "succeeded",
      ]);
    } finally {
      store.close();
    }
  } finally {
    await h.cleanup();
  }
});

test("parallel CI clients keep independent environments, outputs and exit codes after the owner fails", async () => {
  const h = await harness();
  try {
    const owner = h.launch(
      ["build", "--source", join(h.root, "first"), "--platform", "ios"],
      {
        IOS_SUBMIT_ENVIRONMENT_JSON: JSON.stringify({
          FIXTURE_FAIL: "true",
          FIXTURE_WAIT_FOR_SECOND: "true",
          TOKEN: "owner-private-token",
        }),
      },
    );
    await expect
      .poll(() => owner.output(), { timeout: 20000 })
      .toContain("fixture-active");
    const client = h.launch(
      ["build", "--source", join(h.root, "second"), "--platform", "android"],
      {
        IOS_SUBMIT_ENVIRONMENT_JSON: JSON.stringify({
          TOKEN: "client-private-token",
        }),
      },
    );
    await expect
      .poll(() => client.output(), { timeout: 20000 })
      .toContain("fixture-active");
    expect(await client.exit).toBe(0);
    expect(await owner.exit).toBe(1);
    expect(owner.output()).not.toContain("owner-private-token");
    expect(client.output()).not.toContain("client-private-token");
    expect(client.output()).toContain("[REDACTED]");
    expect(client.output()).not.toContain("fixture requested failure");
    const store = new Store(join(h.root, "data"));
    try {
      const jobs = store.list<Job>("jobs");
      expect(jobs.map((job) => job.status)).toEqual(["failed", "succeeded"]);
      expect(jobs[1].startedAt! < jobs[0].finishedAt!).toBe(true);
      expect(JSON.stringify(jobs)).not.toContain("private-token");
      expect(store.credentialSummaries()).toHaveLength(0);
      expect(store.list("projects")).toHaveLength(0);
      expect(store.counter("ios:com.example.fixture")).toBe(0);
      expect(store.highWater("ios:com.example.fixture")).toBe(0);
      expect(store.highWater("android:com.example.fixture")).toBe(1);
    } finally {
      store.close();
    }
  } finally {
    await h.cleanup();
  }
});

test("interrupting the owning command cancels its job while another client finishes", async () => {
  const h = await harness();
  try {
    const owner = h.launch(
      ["build", "--source", join(h.root, "first"), "--platform", "ios"],
      {
        IOS_SUBMIT_ENVIRONMENT_JSON: JSON.stringify({
          FIXTURE_WAIT_FOR_QUEUED: "true",
        }),
      },
    );
    await expect
      .poll(() => owner.output(), { timeout: 20000 })
      .toContain("fixture-active");
    const client = h.launch([
      "build",
      "--source",
      join(h.root, "second"),
      "--platform",
      "android",
    ]);
    await expect
      .poll(() => client.output(), { timeout: 20000 })
      .toContain("fixture-active");
    owner.child.kill("SIGINT");
    expect(await client.exit).toBe(0);
    expect(await owner.exit).toBe(130);
  } finally {
    await h.cleanup();
  }
});

test("closing a temporary account window does not terminate the active CLI owner", async () => {
  const h = await harness();
  try {
    const owner = h.launch(
      ["build", "--project", join(h.root, "first"), "--platform", "ios"],
      {
        IOS_SUBMIT_ENVIRONMENT_JSON: JSON.stringify({
          FIXTURE_CLOSE_AUX_WINDOW: "true",
        }),
      },
    );
    expect(await owner.exit).toBe(0);
    expect(owner.output()).toContain("fixture-auxiliary-closed");
    const store = new Store(join(h.root, "data"));
    try {
      expect(store.list<Job>("jobs").map((job) => job.status)).toEqual([
        "succeeded",
      ]);
    } finally {
      store.close();
    }
  } finally {
    await h.cleanup();
  }
});

import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/core/database";
import { Engine } from "../src/core/engine";
import { Vault } from "../src/core/vault";
import {
  resolveInvocation,
  captureInvocationEnvironment,
} from "../src/cli/invocation";
import { ephemeralReason, ownerLaunch } from "../src/core/ephemeral";

const dataRoot = "/Users/me/Library/Application Support/Local Build Desk";
const job = "/Users/me/.cache/forgejo-runner/work/6977e7f2926fdfff";
// What a Forgejo host-mode job looks like to the CLI.
const forgejoJob = {
  CI: "true",
  FORGEJO_ACTIONS: "true",
  GITHUB_ACTIONS: "true",
  GITHUB_WORKSPACE: `${job}/hostexecutor`,
  RUNNER_TEMP: `${job}/tmp`,
  GITHUB_RUN_ID: "41",
  HOME: "/Users/me",
  USER: "me",
  SHELL: "/bin/zsh",
  TMPDIR: "/var/folders/tc/T/",
  LANG: "en_US.UTF-8",
  DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
  PATH: `${job}/hostexecutor/node_modules/.bin:${job}/tmp/bin:/opt/homebrew/bin:/usr/bin:/bin`,
};

it("recognises CI runners and honours an explicit LOCAL_BUILD_DESK_EPHEMERAL", () => {
  expect(ephemeralReason(forgejoJob)).toBe("FORGEJO_ACTIONS");
  expect(ephemeralReason({ GITLAB_CI: "true" })).toBe("GITLAB_CI");
  expect(ephemeralReason({ CI: "1" })).toBe("CI");
  expect(ephemeralReason({ CI: "false" })).toBeUndefined();
  expect(ephemeralReason({ HOME: "/Users/me" })).toBeUndefined();
  expect(ephemeralReason({ LOCAL_BUILD_DESK_EPHEMERAL: "1" })).toBe(
    "LOCAL_BUILD_DESK_EPHEMERAL",
  );
  expect(
    ephemeralReason({ ...forgejoJob, LOCAL_BUILD_DESK_EPHEMERAL: "0" }),
  ).toBeUndefined();
});

it("starts an owner from a CI job in dataRoot with only machine-level variables", () => {
  const launch = ownerLaunch({
    env: forgejoJob,
    callerEnv: forgejoJob,
    callerCwd: `${job}/hostexecutor`,
    dataRoot,
  });
  expect(launch.ephemeral).toBe("FORGEJO_ACTIONS");
  expect(launch.cwd).toBe(dataRoot);
  expect(launch.env).toEqual({
    HOME: "/Users/me",
    USER: "me",
    SHELL: "/bin/zsh",
    TMPDIR: "/var/folders/tc/T/",
    DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
    // Job folders are dropped from PATH; machine folders stay in order.
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    LOCAL_BUILD_DESK_DATA_DIR: dataRoot,
  });
});

it("drops a TMPDIR that points into the job and still sets a locale", () => {
  const callerEnv = { ...forgejoJob, TMPDIR: `${job}/tmp/`, LANG: "" };
  const launch = ownerLaunch({
    env: callerEnv,
    callerEnv,
    callerCwd: "/elsewhere",
    dataRoot,
  });
  expect(launch.env).not.toHaveProperty("TMPDIR");
  expect(launch.env.LANG).toBe("en_US.UTF-8");
});

it("keeps a terminal caller's environment but never its working directory", () => {
  const env = {
    HOME: "/Users/me",
    PATH: "/opt/homebrew/bin:/usr/bin",
    EDITOR: "vim",
    LANG: "fr_FR.UTF-8",
  };
  const launch = ownerLaunch({
    env,
    callerEnv: env,
    callerCwd: "/Users/me/projects/app",
    dataRoot,
  });
  expect(launch.ephemeral).toBeUndefined();
  expect(launch.cwd).toBe(dataRoot);
  expect(launch.env).toMatchObject({
    EDITOR: "vim",
    LANG: "fr_FR.UTF-8",
    LC_ALL: "fr_FR.UTF-8",
  });
});

it("never forwards LOCAL_BUILD_DESK_EPHEMERAL as a build setting", () => {
  expect(
    captureInvocationEnvironment(["build"], {
      LOCAL_BUILD_DESK_EPHEMERAL: "1",
    }),
  ).not.toHaveProperty("LOCAL_BUILD_DESK_EPHEMERAL");
});

let root: string, store: Store, engine: Engine;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "desk-ephemeral-"));
  store = new Store(join(root, "data"));
  const refuse = vi.fn(async () => {
    throw Error("Keychain must not be touched");
  });
  engine = new Engine(
    store,
    new Vault(store, { encrypt: refuse, decrypt: refuse }),
  );
});
afterEach(async () => {
  await engine.shutdown();
  store.close();
  await rm(root, { recursive: true, force: true });
});

it("resolves the source from the caller's directory, not the owner's", async () => {
  const checkout = join(root, "checkout");
  await mkdir(checkout);
  const invocation = await resolveInvocation(
    engine,
    {},
    {},
    undefined,
    checkout,
  );
  expect(invocation.project.path).toBe(checkout);
});

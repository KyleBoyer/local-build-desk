import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/core/database";
import { Vault } from "../src/core/vault";
import { Engine } from "../src/core/engine";
import { GoogleAPI } from "../src/core/stores";
import { resolveInvocation } from "../src/cli/invocation";
import type { Artifact, Job, Project } from "../src/core/types";
vi.mock("../src/core/build", () => ({
  hashArtifact: vi.fn(async () => ({ sha256: "hash" })),
  buildLocal: vi.fn(),
}));
let root: string, store: Store, engine: Engine;
let upload: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "desk-rollout-engine-"));
  store = new Store(join(root, "data"));
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
  const credential = await engine.vault.put({
    kind: "google",
    label: "Google",
    serviceAccount: {
      type: "service_account",
      client_email: "rollout-engine@example.com",
      private_key: "unused",
    },
  });
  store.putProject({
    id: "project",
    name: "Fixture",
    path: join(root, "source"),
    settings: { googleConnectionId: credential.id },
    profiles: ["production"],
    createdAt: "today",
  });
  vi.spyOn(GoogleAPI.prototype, "versions").mockResolvedValue([]);
  upload = vi
    .spyOn(GoogleAPI.prototype, "upload")
    .mockImplementation(async (_artifact, track, onEdit, ...rest) => {
      onEdit("edit", []);
      const options = rest[2] ?? {};
      return options.rollout
        ? {
            state: "accepted",
            destination: `Google Play · ${track} · rolled out`,
          }
        : { state: "draft", destination: `Google Play · ${track} · draft` };
    });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await engine.shutdown();
  store.close();
  await rm(root, { recursive: true, force: true });
});
let artifacts = 0;
function builtArtifact(buildNumber: string, submitted = false) {
  const n = ++artifacts;
  store.putJob({
    id: `build-${n}`,
    projectId: "project",
    projectName: "Fixture",
    platform: "android",
    profile: "production",
    status: "succeeded",
    stage: "complete",
    createdAt: "today",
    autoSubmit: false,
    clean: false,
    kind: "build",
    storeEligible: true,
    artifactId: `aab-${n}`,
    submission: submitted
      ? { state: "draft", destination: "Google Play · internal · draft" }
      : undefined,
  });
  store.putArtifact({
    id: `aab-${n}`,
    jobId: `build-${n}`,
    platform: "android",
    kind: "aab",
    path: join(root, `${n}.aab`),
    sha256: "hash",
    size: 1,
    bundleId: "com.app",
    version: "1.1.0",
    buildNumber,
  } as Artifact);
  return `aab-${n}`;
}
async function finished(id: string) {
  await new Promise<void>((resolve) => {
    const check = () => {
      if (!["running", "queued"].includes(store.get<Job>("jobs", id).status)) {
        engine.off("event", check);
        resolve();
      }
    };
    engine.on("event", check);
    check();
  });
  return store.get<Job>("jobs", id);
}
async function submitWith(
  flags: Record<string, any> = {},
  env: NodeJS.ProcessEnv = {},
) {
  const invocation = await resolveInvocation(
    engine,
    { "settings-from": "project", ...flags },
    env,
  );
  const job = await finished(
    (await engine.submit(builtArtifact("46"), invocation)).id,
  );
  return { job, options: upload.mock.calls.at(-1)?.[5] as any };
}
it("rolls out by default and records the effective setting on the job", async () => {
  const { job, options } = await submitWith();
  expect(options.rollout).toBe(true);
  expect(job.status).toBe("succeeded");
  expect(job.submission).toMatchObject({ state: "accepted", rollout: true });
  expect(job.projectSnapshot?.settings.playAutoRollout).toBeUndefined();
  expect(
    engine
      .logs(job.id)
      .some((entry) => /roll out to testers automatically/.test(entry.text)),
  ).toBe(true);
  // The default-change notice is written once per project.
  const second = await submitWith();
  expect(
    engine
      .logs(second.job.id)
      .some((entry) => /roll out to testers automatically/.test(entry.text)),
  ).toBe(false);
});
it.each([
  ["--set", { set: ["playAutoRollout=false"] }, {}],
  ["--play-auto-rollout", { "play-auto-rollout": "false" }, {}],
  [
    "LOCAL_BUILD_DESK_PLAY_AUTO_ROLLOUT",
    {},
    { LOCAL_BUILD_DESK_PLAY_AUTO_ROLLOUT: "false" },
  ],
  [
    "the legacy IOS_SUBMIT_PLAY_AUTO_ROLLOUT",
    {},
    { IOS_SUBMIT_PLAY_AUTO_ROLLOUT: "false" },
  ],
])("turns rollout off from %s", async (_name, flags, env) => {
  const { job, options } = await submitWith(flags, env);
  expect(options.rollout).toBe(false);
  expect(job.submission).toMatchObject({ state: "draft", rollout: false });
  expect(job.projectSnapshot?.settings.playAutoRollout).toBe(false);
});
it("turns rollout off from the configuration file", async () => {
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, "ios-submit.json"),
    JSON.stringify({ settings: { playAutoRollout: false } }),
  );
  const { options } = await submitWith({ source });
  expect(options.rollout).toBe(false);
});
it("rejects a non-boolean rollout value", async () => {
  await expect(
    resolveInvocation(
      engine,
      { "settings-from": "project" },
      { IOS_SUBMIT_PLAY_AUTO_ROLLOUT: "yes" },
    ),
  ).rejects.toThrow(/true or false/);
});
it("never rolls out non-internal tracks", async () => {
  const { options } = await submitWith({
    track: "alpha",
    set: ["playAutoRollout=true"],
  });
  expect(options.rollout).toBe(false);
});
it("identifies drafts Local Build Desk uploaded by bundle ID and version code", async () => {
  builtArtifact("44", true);
  builtArtifact("43", false);
  const { options } = await submitWith();
  expect(options.uploadedByDesk("44")).toBe(true);
  expect(options.uploadedByDesk("43")).toBe(false);
  expect(options.uploadedByDesk("42")).toBe(false);
});
it("reconciles a staged upload in its persisted rollout mode", async () => {
  const reconcile = vi
    .spyOn(GoogleAPI.prototype, "reconcile")
    .mockResolvedValue({ state: "accepted", destination: "Google Play" });
  const artifactId = builtArtifact("46");
  store.putJob({
    ...store.get<Job>("jobs", "build-" + artifacts),
    id: "staged",
    kind: "submit",
    status: "needs-attention",
    stage: "upload",
    artifactId,
    submission: {
      state: "uncertain",
      destination: "Google Play · internal · rollout",
      externalId: "original",
      baselineReleases: [],
      rollout: true,
      supersededVersionCodes: ["44"],
    },
  });
  // Turning the project setting off later does not change the staged mode.
  const project = store.get<Project>("projects", "project");
  project.settings.playAutoRollout = false;
  store.putProject(project);
  await engine.reconcile("staged");
  expect(reconcile.mock.calls[0][4]).toEqual({
    rollout: true,
    supersededVersionCodes: ["44"],
  });
  const job = store.get<Job>("jobs", "staged");
  expect(job.status).toBe("succeeded");
  expect(job.submission?.rollout).toBe(true);
});

it.each([
  ["--release-notes", { "release-notes": " Bug fixes " }, {}],
  [
    "LOCAL_BUILD_DESK_PLAY_RELEASE_NOTES",
    {},
    { LOCAL_BUILD_DESK_PLAY_RELEASE_NOTES: "Bug fixes" },
  ],
])("passes release notes from %s to the upload", async (_name, flags, env) => {
  const { options } = await submitWith(flags, env);
  expect(options.releaseNotes).toEqual([
    { language: "en-US", text: "Bug fixes" },
  ]);
});
it("uses the configured release-notes language and omits empty notes", async () => {
  const { options } = await submitWith({
    set: ["playReleaseNotes=Correcciones", "playReleaseNotesLanguage=es-419"],
  });
  expect(options.releaseNotes).toEqual([
    { language: "es-419", text: "Correcciones" },
  ]);
  expect((await submitWith()).options.releaseNotes).toBeUndefined();
});
it("rejects release notes over Google's 500-character limit", async () => {
  await expect(
    resolveInvocation(
      engine,
      { "settings-from": "project", "release-notes": "x".repeat(501) },
      {},
    ),
  ).rejects.toThrow(/Invalid invocation settings/);
});

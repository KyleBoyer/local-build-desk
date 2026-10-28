import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/core/database";
import { Vault } from "../src/core/vault";
import { Engine } from "../src/core/engine";
import type { Job, Project } from "../src/core/types";
import { AppleAPI } from "../src/core/stores";
vi.mock("../src/core/build", () => ({
  hashArtifact: vi.fn(),
  buildLocal: vi.fn(async (ctx: any) => {
    ctx.stage("snapshot");
    ctx.log("captured source");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 30);
      ctx.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Operation cancelled."));
      });
    });
    ctx.stage("compile");
  }),
}));
let root: string, store: Store, engine: Engine;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "desk-engine-test-"));
  store = new Store(root);
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
    profiles: ["production"],
  } as Project);
});
afterEach(async () => {
  await engine.shutdown();
  store.close();
  await rm(root, { recursive: true, force: true });
});
async function finished(ids: string[]) {
  await new Promise<void>((resolve) => {
    const check = () => {
      if (
        ids.every(
          (id) =>
            !["running", "queued"].includes(store.get<Job>("jobs", id).status),
        )
      ) {
        engine.off("event", check);
        resolve();
      }
    };
    engine.on("event", check);
    check();
  });
}
it("processes a persistent queue with live logs and separate per-platform jobs", async () => {
  const jobs = await engine.build({
    projectId: "project",
    platform: "all",
    profile: "production",
  });
  await finished(jobs.map((j) => j.id));
  expect(jobs.map((j) => store.get<Job>("jobs", j.id).status)).toEqual([
    "succeeded",
    "succeeded",
  ]);
  expect(
    engine.logs(jobs[0].id).some((l) => l.text === "captured source"),
  ).toBe(true);
  const [a, b] = jobs.map((j) => store.get<Job>("jobs", j.id));
  expect(b.startedAt! < a.finishedAt!).toBe(true);
});
it("cancels a running job and continues the queue", async () => {
  const jobs = await engine.build({
    projectId: "project",
    platform: "all",
    profile: "production",
  });
  engine.cancel(jobs[0].id);
  await finished(jobs.map((j) => j.id));
  expect(store.get<Job>("jobs", jobs[0].id).status).toBe("cancelled");
  expect(store.get<Job>("jobs", jobs[1].id).status).toBe("succeeded");
});
it("prevents retrying an unresolved upload", async () => {
  store.putJob({
    id: "uncertain",
    status: "needs-attention",
    submission: { state: "uncertain" },
  } as Job);
  await expect(engine.retry("uncertain")).rejects.toThrow(/Reconcile/);
});
it("allows external build storage and rejects recursive snapshots inside the imported project", () => {
  expect(() =>
    engine.saveSettings("project", { buildDirectory: join(root, "generated") }),
  ).toThrow(/outside the imported project/);
  engine.saveSettings("project", { buildDirectory: root + "-builds" });
  expect(
    store.get<Project>("projects", "project").settings.buildDirectory,
  ).toBe(root + "-builds");
});
it("retains a not-yet-visible accepted upload as processing and coalesces concurrent status refreshes", async () => {
  const connection = await engine.vault.put({
    kind: "apple",
    label: "fixture",
    teamId: "TEAM",
    keyId: "key",
    issuerId: "issuer",
    privateKey: "unused",
  });
  engine.saveSettings("project", { appleConnectionId: connection.id });
  store.putArtifact({
    id: "ipa",
    jobId: "processing",
    platform: "ios",
    kind: "ipa",
    bundleId: "com.example",
    version: "1.0.0",
    buildNumber: "4",
  } as any);
  store.putJob({
    id: "processing",
    projectId: "project",
    platform: "ios",
    artifactId: "ipa",
    status: "needs-attention",
    stage: "processing",
    submission: {
      state: "processing",
      destination: "TestFlight",
      uploadedAt: "2026-01-01T00:00:00Z",
    },
  } as Job);
  const build = vi.spyOn(AppleAPI.prototype, "build").mockResolvedValue([]);
  try {
    await Promise.all([
      engine.reconcile("processing"),
      engine.reconcile("processing"),
    ]);
    expect(build).toHaveBeenCalledOnce();
    let job = store.get<Job>("jobs", "processing");
    expect(job.submission?.state).toBe("processing");
    expect(job.submission?.lastCheckedAt).toBeDefined();
    expect(job.error).toBeUndefined();
    build.mockResolvedValue([
      { id: "apple-build", attributes: { processingState: "VALID" } },
    ]);
    await engine.reconcile("processing");
    job = store.get<Job>("jobs", "processing");
    expect(job.status).toBe("succeeded");
    expect(job.submission?.uploadedAt).toBe("2026-01-01T00:00:00Z");
  } finally {
    build.mockRestore();
  }
});
it("cancels and awaits an in-progress tool installation when closing", async () => {
  const setup = await import("../src/core/setup");
  const install = vi
    .spyOn(setup, "installTool")
    .mockImplementation(
      async (_tool, _accepted, _log, _path, _settings, signal) => {
        await new Promise<void>((_resolve, reject) =>
          signal!.addEventListener(
            "abort",
            () => reject(new Error("installation cancelled")),
            { once: true },
          ),
        );
        return {};
      },
    );
  try {
    const pending = engine
      .installTool("project", "android", true)
      .catch((error) => error);
    const second = engine
      .installTool("project", "android", true)
      .catch((error) => error);
    expect(install).toHaveBeenCalledOnce();
    await engine.shutdown();
    expect((await pending).message).toContain("installation cancelled");
    expect((await second).message).toContain("installation cancelled");
  } finally {
    install.mockRestore();
  }
});
it("does not open a new Google validation edit while a staged upload needs reconciliation", async () => {
  const credential = await engine.vault.put({
    kind: "google",
    label: "Google",
    serviceAccount: {
      type: "service_account",
      client_email: "test@example.com",
      private_key: "unused",
    },
  });
  const project = store.get<Project>("projects", "project");
  project.settings.googleConnectionId = credential.id;
  store.putProject(project);
  store.putJob({
    id: "pending-google",
    projectId: "project",
    platform: "android",
    status: "needs-attention",
    stage: "upload",
    submission: { state: "uncertain", externalId: "original-edit" },
  } as Job);
  await expect(engine.validateConnection(credential.id)).rejects.toThrow(
    /preserves its staged AAB/,
  );
  expect(store.get<Job>("jobs", "pending-google").submission?.externalId).toBe(
    "original-edit",
  );
});

it("limits same-platform compilations and permits configured extra slots", async () => {
  const request = {
    projectId: "project",
    platform: "ios" as const,
    profile: "production",
  };
  const [a] = await engine.build(request),
    [b] = await engine.build(request);
  await finished([a.id, b.id]);
  expect(
    store.get<Job>("jobs", a.id).finishedAt! <=
      store.get<Job>("jobs", b.id).startedAt!,
  ).toBe(true);
  engine.configureConcurrency({ ios: 2 });
  const [c] = await engine.build(request),
    [d] = await engine.build(request);
  await finished([c.id, d.id]);
  expect(
    store.get<Job>("jobs", d.id).startedAt! <
      store.get<Job>("jobs", c.id).finishedAt!,
  ).toBe(true);
  expect(() => engine.configureConcurrency({ ios: 0 })).toThrow(/1 and 8/);
});

it("verifies a pending Google credential against the intended app before assigning it", async () => {
  const { GoogleAPI } = await import("../src/core/stores");
  const project = store.get<Project>("projects", "project");
  project.packageName = "com.example.fixture";
  project.settings.googleConnectionId = "old";
  store.putProject(project);
  const saved = await engine.vault.put({
    kind: "google",
    label: "Pending",
    serviceAccount: {
      client_email: "pending@example.com",
      private_key: "unused",
    },
  });
  const validate = vi
    .spyOn(GoogleAPI.prototype, "validate")
    .mockResolvedValue("verified");
  try {
    await engine.validateConnection(saved.id, "project");
    expect(validate).toHaveBeenCalledWith("com.example.fixture");
    expect(
      store.get<Project>("projects", "project").settings.googleConnectionId,
    ).toBe("old");
  } finally {
    validate.mockRestore();
  }
});

it("does not mistake token authentication for app permission verification when the package is missing", async () => {
  const { GoogleAPI } = await import("../src/core/stores");
  const saved = await engine.vault.put({
    kind: "google",
    label: "Pending",
    serviceAccount: {
      client_email: "pending@example.com",
      private_key: "unused",
    },
  });
  const validate = vi
    .spyOn(GoogleAPI.prototype, "validate")
    .mockResolvedValue("authenticated only");
  try {
    await expect(
      engine.validateConnection(saved.id, "project"),
    ).rejects.toThrow(/android.package/);
    expect(validate).not.toHaveBeenCalled();
  } finally {
    validate.mockRestore();
  }
});
it("keeps the selected Google key until the CLI fallback verifies app access", async () => {
  const setup = await import("../src/core/setup");
  const saved = await engine.vault.put({
    kind: "google",
    label: "Pending",
    serviceAccount: {
      client_email: "pending@example.com",
      private_key: "unused",
    },
  });
  engine.saveSettings("project", { googleConnectionId: "original" });
  const create = vi
    .spyOn(setup, "createGoogleServiceAccount")
    .mockResolvedValue({ credential: saved, email: "pending@example.com" });
  const validate = vi
    .spyOn(engine, "validateConnection")
    .mockRejectedValueOnce(Error("Google Play 403"));
  try {
    expect(
      await engine.createGoogleConnection("project", "fixture-builds"),
    ).toMatchObject({ connectionId: saved.id, ready: false });
    expect(
      store.get<Project>("projects", "project").settings.googleConnectionId,
    ).toBe("original");
    validate.mockResolvedValueOnce("app verified");
    expect(
      await engine.createGoogleConnection("project", "fixture-builds"),
    ).toMatchObject({ ready: true });
    expect(validate).toHaveBeenLastCalledWith(saved.id, "project");
    expect(
      store.get<Project>("projects", "project").settings.googleConnectionId,
    ).toBe(saved.id);
  } finally {
    create.mockRestore();
    validate.mockRestore();
  }
});
it("protects pending unselected Google keys from opening API edits while a console bootstrap is active", async () => {
  const { GoogleAPI } = await import("../src/core/stores");
  const saved = await engine.vault.put({
    kind: "google",
    label: "Pending",
    serviceAccount: {
      client_email: "pending@example.com",
      private_key: "unused",
    },
  });
  const project = store.get<Project>("projects", "project");
  project.packageName = "com.example.fixture";
  store.putProject(project);
  const folder = join(root, "accounts");
  await mkdir(folder, { recursive: true });
  const path = join(folder, "project-google-store-bootstrap.json");
  const state = {
    identity: project.packageName,
    connectionId: saved.id,
    stage: "opening",
    consoleEditActive: true,
    submitted: {},
  };
  await writeFile(path, JSON.stringify({ storeSetup: state }));
  const validate = vi
    .spyOn(GoogleAPI.prototype, "validate")
    .mockResolvedValue("verified");
  try {
    await expect(
      engine.validateConnection(saved.id, "project"),
    ).rejects.toThrow(/console session/);
    expect(validate).not.toHaveBeenCalled();
    state.stage = "verifying";
    await writeFile(path, JSON.stringify({ storeSetup: state }));
    await engine.validateConnection(saved.id, "project");
    expect(validate).toHaveBeenCalledOnce();
  } finally {
    validate.mockRestore();
  }
});

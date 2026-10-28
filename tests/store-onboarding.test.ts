import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hashArtifact } from "../src/core/build";
import {
  verifyBootstrapArtifact,
  makeStoreSetup,
} from "../src/core/store-onboarding";
import type { Artifact, Job, Project } from "../src/core/types";
it("accepts only successful exact-project AABs and detects file replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-onboarding-"));
  try {
    const path = join(root, "app.aab");
    await writeFile(path, "signed fixture");
    const digest = await hashArtifact(path);
    const project = {
      id: "project",
      packageName: "com.example.fixture",
      settings: {},
    } as Project;
    const artifact = {
      id: "artifact",
      jobId: "job",
      kind: "aab",
      platform: "android",
      path,
      bundleId: project.packageName,
      buildNumber: "1",
      ...digest,
    } as Artifact;
    const job = {
      id: "job",
      projectId: project.id,
      status: "succeeded",
    } as Job;
    const store = {
      get: (table: string) =>
        table === "projects" ? project : table === "artifacts" ? artifact : job,
      list: () => [],
    } as any;
    expect((await verifyBootstrapArtifact(store, project, "artifact")).id).toBe(
      "artifact",
    );
    job.projectId = "other";
    await expect(
      verifyBootstrapArtifact(store, project, "artifact"),
    ).rejects.toThrow(/project/);
    job.projectId = project.id;
    artifact.kind = "apk";
    await expect(
      verifyBootstrapArtifact(store, project, "artifact"),
    ).rejects.toThrow(/AAB/);
    artifact.kind = "aab";
    await writeFile(path, "changed");
    await expect(
      verifyBootstrapArtifact(store, project, "artifact"),
    ).rejects.toThrow(/changed/);
    await expect(
      makeStoreSetup(store, project.id, {
        provider: "google",
        mode: "bootstrap",
        newApp: false,
        appName: "Fixture",
        language: "en-US",
      }),
    ).rejects.toThrow(/new Google/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

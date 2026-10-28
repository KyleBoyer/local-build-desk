// @vitest-environment jsdom
import { it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Project, Job, Artifact } from "../src/core/types";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const listeners = new Set<(event: any) => void>();
let state: { jobs: Job[]; artifacts: Artifact[] } = { jobs: [], artifacts: [] };
const api = {
  state: vi.fn(async () => state),
  onEvent: (fn: (event: any) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  build: vi.fn(),
  openStoreSetup: vi.fn(),
  testFlightUsers: vi.fn(),
  configureTestFlight: vi.fn(),
};
(window as any).desk = api;
const { StoreOnboarding, TestFlightSetup } =
  await import("../src/renderer/src/StoreOnboarding");
const project = {
  id: "project",
  name: "Fixture",
  packageName: "com.example.fixture",
  bundleId: "com.example.fixture",
  profiles: ["production"],
  settings: { androidSigningId: "upload" },
} as Project;
const host = document.createElement("div");
document.body.append(host);
let root = createRoot(host);
afterEach(async () => {
  await act(async () => root.unmount());
  host.replaceChildren();
  root = createRoot(host);
  vi.clearAllMocks();
  state = { jobs: [], artifacts: [] };
});
const operation = async (_name: string, fn: () => Promise<unknown>) => {
  await fn();
};
it("builds the first AAB locally and automatically selects the successful artifact without uploading", async () => {
  const job = {
    id: "job",
    projectId: project.id,
    status: "queued",
    stage: "queued",
  } as Job;
  state.jobs = [job];
  api.build.mockResolvedValue([job]);
  await act(async () =>
    root.render(
      <StoreOnboarding
        project={project}
        platform="android"
        newApp
        busy={false}
        operation={operation}
      />,
    ),
  );
  const button = [...host.querySelectorAll("button")].find(
    (el) => el.textContent === "Build first AAB locally",
  )!;
  await act(async () => button.click());
  expect(api.build).toHaveBeenCalledWith({
    projectId: "project",
    platform: "android",
    profile: "production",
    autoSubmit: false,
  });
  expect(api.openStoreSetup).not.toHaveBeenCalled();
  const artifact = {
    id: "artifact",
    jobId: "job",
    kind: "aab",
    bundleId: project.packageName,
    version: "1",
    buildNumber: "1",
    size: 100,
  } as Artifact;
  state = {
    jobs: [{ ...job, status: "succeeded", artifactId: artifact.id }],
    artifacts: [artifact],
  };
  await act(async () => {
    for (const listener of listeners) listener({ type: "state" });
  });
  expect(
    [...host.querySelectorAll("select")].some(
      (select) => select.value === "artifact",
    ),
  ).toBe(true);
});
it("loads and reviews teammates without sending an invitation until the explicit final action", async () => {
  api.testFlightUsers.mockResolvedValue([
    { id: "user", name: "Teammate", email: "test@example.com" },
  ]);
  api.configureTestFlight.mockResolvedValue({
    id: "group",
    name: "Internal testing",
  });
  await act(async () =>
    root.render(
      <TestFlightSetup
        project={project}
        busy={false}
        operation={operation}
        refresh={async () => {}}
      />,
    ),
  );
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((el) => el.textContent?.includes("Load eligible"))!
      .click(),
  );
  await act(async () =>
    host.querySelector<HTMLInputElement>("input[type=checkbox]")!.click(),
  );
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((el) => el.textContent === "Review group & invitations")!
      .click(),
  );
  expect(api.configureTestFlight).not.toHaveBeenCalled();
  expect(host.textContent).toContain("test@example.com");
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find(
        (el) => el.textContent === "Create group & invite selected teammates",
      )!
      .click(),
  );
  expect(api.configureTestFlight).toHaveBeenCalledWith("project", {
    name: "Internal testing",
    userIds: ["user"],
  });
});

import { it, expect } from "vitest";
import { compareBuilds } from "../src/core/comparison";
import type { Job } from "../src/core/types";
const job = (id: string, change: Partial<Job> = {}): Job => ({
  id,
  projectId: "project",
  projectName: "Fixture",
  bundleId: "com.example.app",
  platform: "ios",
  profile: "production",
  kind: "build",
  status: "succeeded",
  stage: "complete",
  createdAt: "2026-10-01",
  autoSubmit: false,
  clean: false,
  ...change,
});
it("selects the nearest successful matching app/platform and shows unknown legacy facts", () => {
  const previous = job("previous"),
    current = job("current", {
      createdAt: "2026-10-03",
      toolchain: {
        developerDirectory: "/Xcode",
        xcodeVersion: "27.2",
        iosSdk: "27.2",
      },
    });
  const result = compareBuilds(
    current,
    [
      previous,
      job("android", { platform: "android", createdAt: "2026-10-02" }),
      job("wrong", { bundleId: "com.other", createdAt: "2026-10-02" }),
      current,
    ],
    [],
  );
  expect(result.baselineId).toBe("previous");
  expect(result.fields.find((f) => f.field === "iOS SDK")).toMatchObject({
    before: "Not recorded",
    after: "27.2",
    changed: true,
  });
  expect(result.note).toContain("older");
});
it("preserves nested entitlement differences", () => {
  const facts = {
    configuration: "Release",
    distribution: "store",
    simulator: false,
    developmentClient: false,
    destination: "TestFlight",
    entitlements: { nested: { capability: "before" } },
  };
  const before = job("old", { facts }),
    after = job("new", {
      createdAt: "2026-10-02",
      facts: { ...facts, entitlements: { nested: { capability: "after" } } },
    });
  expect(
    compareBuilds(after, [before], []).fields.find(
      (f) => f.field === "Entitlements",
    ),
  ).toMatchObject({ changed: true });
  expect(compareBuilds(before, [], []).baselineId).toBeUndefined();
});

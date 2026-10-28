import { it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/database";
import type { Job } from "../src/core/types";
const sent: any[] = [];
vi.mock("electron", () => ({
  Notification: class extends EventEmitter {
    static isSupported() {
      return true;
    }
    constructor(public options: any) {
      super();
      sent.push(this);
    }
    show() {}
  },
}));
const { JobNotifications, completion } =
  await import("../src/main/notifications");
const sample = (change: Partial<Job> = {}): Job => ({
  id: "job",
  projectId: "project",
  projectName: "Fixture",
  platform: "ios",
  profile: "production",
  status: "running",
  stage: "upload",
  createdAt: "2026-10-01",
  autoSubmit: true,
  clean: false,
  kind: "build",
  ...change,
});
it("deduplicates processing/acceptance across events and restart and opens the exact job", () => {
  sent.length = 0;
  const root = mkdtempSync(join(tmpdir(), "desk-notifications-"));
  const store = new Store(root),
    open = vi.fn();
  try {
    store.putJob(sample());
    const notices = new JobNotifications(store, open);
    const job = sample({
      status: "needs-attention",
      submission: { state: "processing", destination: "TestFlight" },
    });
    store.putJob(job);
    notices.scan();
    notices.scan();
    expect(sent).toHaveLength(1);
    sent[0].emit("click");
    expect(open).toHaveBeenCalledWith("job");
    const restarted = new JobNotifications(store, open);
    restarted.scan();
    expect(sent).toHaveLength(1);
    job.status = "succeeded";
    job.submission!.state = "accepted";
    store.putJob(job);
    restarted.scan();
    expect(sent).toHaveLength(2);
    expect(sent[1].options.title).toContain("Ready in TestFlight");
    restarted.settings(false);
    store.putJob(
      sample({ id: "other", status: "failed", error: "private-token" }),
    );
    restarted.scan();
    expect(sent).toHaveLength(2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it("does not display cancellations or raw error secrets", () => {
  expect(completion(sample({ status: "cancelled" }))).toBeUndefined();
  expect(
    JSON.stringify(
      completion(sample({ status: "failed", error: "private-token" })),
    ),
  ).not.toContain("private-token");
  expect(
    completion(
      sample({
        platform: "android",
        status: "succeeded",
        submission: { state: "draft", destination: "internal" },
      }),
    )?.title,
  ).toContain("draft");
});

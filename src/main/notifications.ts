import { Notification } from "electron";
import { Store } from "../core/database";
import type { Job } from "../core/types";
export function completion(
  job: Job,
): { phase: string; title: string; body: string } | undefined {
  if (["queued", "running", "cancelled"].includes(job.status)) return;
  const label = `${job.projectName} · ${job.platform === "ios" ? "iOS" : "Android"} ${job.buildNumber ? "#" + job.buildNumber : ""} · ${job.profile}`;
  let phase: string, title: string;
  if (
    job.status === "failed" ||
    job.status === "interrupted" ||
    job.submission?.state === "rejected"
  ) {
    phase = job.status;
    title = "Build needs your attention";
  } else if (job.submission?.state === "processing") {
    phase = "processing";
    title = "Uploaded · Apple is processing";
  } else if (
    job.submission?.state === "uncertain" ||
    job.status === "needs-attention"
  ) {
    phase = "attention";
    title = "Upload needs reconciliation";
  } else if (job.submission?.state === "accepted") {
    phase = "accepted";
    title =
      job.platform === "ios"
        ? "Ready in TestFlight"
        : "Google Play upload accepted";
  } else if (job.submission?.state === "draft") {
    phase = "draft";
    title = "Google Play draft uploaded";
  } else if (job.status === "succeeded") {
    phase = "built";
    title = "Local build finished";
  } else return;
  return { phase, title, body: label + "\nClick to open this build." };
}
export class JobNotifications {
  private live = new Set<Notification>();
  private error?: string;
  constructor(
    private store: Store,
    private open: (id: string) => void,
    private disabled = false,
  ) {
    // First install does not replay years of completed builds.
    for (const job of store.list<Job>("jobs")) {
      const value = completion(job);
      if (
        value &&
        !store.preference<string | undefined>(
          "notification:" + job.id,
          undefined,
        )
      )
        store.setPreference("notification:" + job.id, value.phase);
    }
  }
  settings(enabled?: boolean) {
    if (enabled !== undefined)
      this.store.setPreference("notificationsEnabled", enabled);
    return {
      enabled: this.store.preference("notificationsEnabled", true),
      supported: !this.disabled && Notification.isSupported(),
      error: this.error,
    };
  }
  async restoreHistory() {
    if (this.disabled || process.platform !== "darwin") return;
    try {
      for (const notification of await Notification.getHistory()) {
        if (!notification.id.startsWith("desk-job-")) continue;
        const jobId = notification.id.slice("desk-job-".length);
        notification.on("click", () => this.open(jobId));
        this.live.add(notification);
      }
    } catch {
      /* macOS may not have authorized notifications yet. */
    }
  }
  scan() {
    for (const job of this.store.list<Job>("jobs")) {
      const value = completion(job);
      if (
        !value ||
        this.store.preference("notification:" + job.id, "") === value.phase
      )
        continue;
      this.store.setPreference("notification:" + job.id, value.phase);
      if (this.settings().enabled) this.show(value.title, value.body, job.id);
    }
  }
  show(
    title = "Local Build Desk notifications",
    body = "Build and upload results will appear here.",
    jobId?: string,
  ) {
    if (this.disabled || !Notification.isSupported()) return;
    const notification = new Notification({
      id: jobId ? "desk-job-" + jobId : undefined,
      groupId: "desk-builds",
      title,
      body,
    });
    this.live.add(notification);
    notification.on("click", () => {
      if (jobId) this.open(jobId);
    });
    notification.on("close", () => this.live.delete(notification));
    notification.on("failed", () => {
      this.error =
        "macOS could not deliver the notification. Allow Local Build Desk in System Settings → Notifications. Native notifications require a signed app.";
      this.live.delete(notification);
    });
    notification.show();
  }
}

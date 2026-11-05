import type { MonitorStatus } from "../mobile/types";
import {
  clipboard,
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import type { EventEmitter } from "node:events";
import type { DeskEvent, Job } from "../core/types";
import { elapsedLabel, stageGuidance } from "../core/progress";
import { icon, retinaIcon } from "./build-tray-icon";
import {
  createMenuClock,
  type MenuClock,
  type MenuClockRow,
} from "./menu-clock";

// Keep the monitor independent of windows: the same owner runs desktop and CLI jobs.
export function monitoredJobs(jobs: Job[]) {
  return jobs
    .filter(
      (job) =>
        ["queued", "running"].includes(job.status) ||
        (job.submission?.state === "processing" &&
          job.status === "needs-attention"),
    )
    .sort((a, b) => {
      const rank = (job: Job) =>
        job.status === "running" ? 0 : job.status === "queued" ? 1 : 2;
      return rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt);
    });
}

function short(value: string, length = 64) {
  const clean = value.replace(/[\x00-\x1f\x7f]/g, " ");
  return clean.length > length ? clean.slice(0, length - 1) + "…" : clean;
}
function elapsed(since: string | undefined, now: number) {
  const started = Date.parse(since ?? "");
  if (!Number.isFinite(started)) return undefined;
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  return (
    elapsedLabel(now - started) +
    (seconds >= 3600 ? ` ${String(seconds % 60).padStart(2, "0")}s` : "")
  );
}
function bytes(value: number) {
  return value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(1)} GB`
    : value >= 1024 ** 2
      ? `${(value / 1024 ** 2).toFixed(1)} MB`
      : `${Math.round(value / 1024)} KB`;
}
function progressClock(job: Job): { label: string; since?: string } {
  if (job.status === "queued")
    return { label: "Queued · waiting for a compiler" };
  if (job.submission?.state === "processing")
    return { label: "Apple processing", since: job.submission.uploadedAt };
  const work = job.progress;
  const percent =
    work?.percent ??
    (work?.totalBytes && work.completedBytes !== undefined
      ? (100 * work.completedBytes) / work.totalBytes
      : undefined);
  const validPercent =
    percent !== undefined &&
    Number.isFinite(percent) &&
    percent >= 0 &&
    percent <= 100;
  const stage = job.stage[0].toUpperCase() + job.stage.slice(1);
  const label = work?.label ? `${stage}: ${short(work.label)}` : stage;
  return {
    label: [label, validPercent ? `${Math.floor(percent)}%` : undefined]
      .filter(Boolean)
      .join(" · "),
    since: work?.startedAt ?? job.stageStartedAt ?? job.startedAt,
  };
}
export function jobTrayProgress(job: Job, now = Date.now()) {
  const { label, since } = progressClock(job);
  return [label, elapsed(since, now)].filter(Boolean).join(" · ");
}

export class BuildTray {
  private tray?: Tray;
  private timer?: ReturnType<typeof setInterval>;
  private menu?: Menu;
  private clock?: MenuClock;
  private structure = "";
  private lastTitle?: string;
  private lastTooltip?: string;
  private disposed = false;
  private readonly changed = (event: DeskEvent) => {
    if (event.type === "state") this.refresh();
  };
  constructor(
    private events: EventEmitter,
    private jobs: () => Job[],
    private actions: {
      openBuild?: (jobId: string) => void;
      showLogs: (jobId: string) => void;
      monitor?: () => MonitorStatus;
      openDesk?: () => void;
      quit?: () => void;
    },
    private disabled = process.platform !== "darwin",
  ) {
    events.on("event", this.changed);
    this.refresh();
  }
  refresh() {
    if (this.disabled || this.disposed) return;
    const jobs = monitoredJobs(this.jobs());
    const monitor = this.actions.monitor?.();
    if (!jobs.length && !monitor?.config.enabled) {
      this.clear();
      return;
    }
    if (!this.tray) {
      const image = nativeImage.createFromDataURL(icon);
      image.addRepresentation({ scaleFactor: 2, dataURL: retinaIcon });
      image.setTemplateImage(true);
      this.tray = new Tray(image, "c3267c2f-0375-4c03-8d78-d75c124222b3");
    }
    // Idle monitor changes arrive through its events. Only active jobs need
    // a clock; avoid AppKit/menu work every second while the desk is idle.
    if (jobs.length && !this.timer) {
      this.timer = setInterval(() => this.refresh(), 1000);
      this.timer.unref();
    } else if (!jobs.length && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const running = jobs.filter((job) => job.status === "running").length;
    const queued = jobs.filter((job) => job.status === "queued").length;
    const processing = jobs.length - running - queued;
    const summary =
      !jobs.length && monitor?.config.enabled
        ? monitor.running
          ? `Mobile monitor · ${monitor.clients} connected`
          : "Mobile monitor needs attention"
        : [
            running ? `${running} active` : "",
            queued ? `${queued} queued` : "",
            processing ? `${processing} processing` : "",
          ]
            .filter(Boolean)
            .join(" · ");
    const now = Date.now();
    const template: MenuItemConstructorOptions[] = [
      { id: "summary", label: `Local Build Desk · ${summary}`, enabled: false },
      { type: "separator" },
      ...jobs.map((job): MenuItemConstructorOptions => ({
        id: job.id,
        label: `${short(job.projectName, 32)} · ${job.platform === "ios" ? "iOS" : "Android"} · ${jobTrayProgress(job, now)}`,
        submenu: [
          {
            id: "identity",
            label: `${short(job.profile)}${job.buildNumber ? " · Build " + short(job.buildNumber) : ""} · ${job.kind === "submit" ? "Upload" : "Build"}`,
            enabled: false,
          },
          { id: "progress", label: jobTrayProgress(job, now), enabled: false },
          {
            id: "elapsed",
            label: `${job.status === "queued" ? "Waiting" : "Elapsed"}: ${elapsed(job.startedAt ?? job.createdAt, now) ?? "—"}`,
            enabled: false,
          },
          {
            id: "transfer",
            label:
              job.progress?.completedBytes !== undefined
                ? `Transferred: ${bytes(job.progress.completedBytes)}${job.progress.totalBytes ? " / " + bytes(job.progress.totalBytes) : ""}`
                : "",
            visible: job.progress?.completedBytes !== undefined,
            enabled: false,
          },
          {
            label:
              stageGuidance[
                job.submission?.state === "processing"
                  ? "processing"
                  : job.stage
              ],
            enabled: false,
          },
          { type: "separator" },
          ...(this.actions.openBuild
            ? [
                {
                  label: "Open build in Local Build Desk",
                  click: () => this.actions.openBuild!(job.id),
                },
              ]
            : []),
          {
            label: "Show log file in Finder",
            enabled: job.status !== "queued",
            click: () => this.actions.showLogs(job.id),
          },
          {
            label: "Copy status command",
            click: () =>
              clipboard.writeText(`local-build-desk status --job ${job.id}`),
          },
          {
            label: "Copy logs command",
            click: () =>
              clipboard.writeText(`local-build-desk logs --job ${job.id}`),
          },
        ],
      })),
      ...(monitor?.config.enabled
        ? [
            ...(jobs.length ? [{ type: "separator" as const }] : []),
            {
              label: monitor.running
                ? `Phone dashboard · ${monitor.clients} connected`
                : (monitor.error ?? "Mobile monitor unavailable"),
              enabled: false,
            },
            {
              label: "Open Local Build Desk",
              enabled: !!this.actions.openDesk,
              click: () => this.actions.openDesk?.(),
            },
            {
              label: "Copy phone dashboard address",
              enabled: !!monitor.url,
              click: () => {
                if (monitor.url) clipboard.writeText(monitor.url);
              },
            },
            {
              label: "Quit Local Build Desk",
              click: () => this.actions.quit?.(),
            },
          ]
        : []),
      { type: "separator" },
      {
        label: "Updates every second · percentages appear when available",
        enabled: false,
      },
    ];
    // Mutate existing native menu items while it is open. Replacing the whole
    // menu on every progress tick interrupts mouse/keyboard navigation.
    const structure =
      jobs.map((job) => job.id).join(",") + ":" + !!monitor?.config.enabled;
    if (this.menu && structure === this.structure)
      this.updateMenu(this.menu, template);
    else {
      // A new tree must never be painted using the previous tree's indices.
      this.clock?.dispose();
      this.structure = structure;
      this.menu = Menu.buildFromTemplate(template);
      this.tray.setContextMenu(this.menu);
      this.clock = createMenuClock();
    }
    const rows: MenuClockRow[] = [];
    const rowsByPath = new Map<string, MenuClockRow>();
    const collect = (
      items: MenuItemConstructorOptions[],
      path: number[] = [],
    ) => {
      items.forEach((item, index) => {
        const at = [...path, index];
        if (item.label !== undefined) {
          const row = { path: at, prefix: item.label.slice(0, 1024) };
          rows.push(row);
          rowsByPath.set(at.join(":"), row);
        }
        if (Array.isArray(item.submenu)) collect(item.submenu, at);
      });
    };
    collect(template);
    for (const [index, job] of jobs.entries()) {
      const progress = progressClock(job);
      const clock = (path: number[], prefix: string, since?: string) => {
        const start = Date.parse(since ?? "");
        if (!Number.isFinite(start)) return;
        const row = rowsByPath.get(path.join(":"));
        if (row) Object.assign(row, { prefix, since: start });
      };
      clock(
        [index + 2],
        `${short(job.projectName, 32)} · ${job.platform === "ios" ? "iOS" : "Android"} · ${progress.label} · `,
        progress.since,
      );
      clock([index + 2, 1], `${progress.label} · `, progress.since);
      clock(
        [index + 2, 2],
        `${job.status === "queued" ? "Waiting" : "Elapsed"}: `,
        job.startedAt ?? job.createdAt,
      );
    }
    this.clock?.update(rows);
    const title = jobs.length ? String(jobs.length) : "";
    if (title !== this.lastTitle) {
      this.tray.setTitle(title, { fontType: "monospacedDigit" });
      this.lastTitle = title;
    }
    const tooltip = `Local Build Desk · ${summary}\n${jobs.map((job) => `${short(job.projectName)} · ${jobTrayProgress(job, now)}`).join("\n")}`;
    if (tooltip !== this.lastTooltip) {
      this.tray.setToolTip(tooltip);
      this.lastTooltip = tooltip;
    }
  }
  private updateMenu(menu: Menu, items: MenuItemConstructorOptions[]) {
    for (let index = 0; index < items.length; index++) {
      const value = items[index],
        item = menu.items[index];
      if (value.label !== undefined && value.label !== item.label)
        item.label = value.label;
      if (value.enabled !== undefined && value.enabled !== item.enabled)
        item.enabled = value.enabled;
      if (value.visible !== undefined && value.visible !== item.visible)
        item.visible = value.visible;
      if (item.submenu && Array.isArray(value.submenu))
        this.updateMenu(item.submenu, value.submenu);
    }
  }
  private clear() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clock?.dispose();
    this.clock = undefined;
    this.tray?.destroy();
    this.tray = undefined;
    this.menu = undefined;
    this.structure = "";
    this.lastTitle = this.lastTooltip = undefined;
  }
  dispose() {
    this.disposed = true;
    this.events.off("event", this.changed);
    this.clear();
  }
}

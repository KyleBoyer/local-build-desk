import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Job } from "../src/core/types";

const native = vi.hoisted(() => ({ trays: [] as any[], copied: vi.fn() }));
vi.mock("electron", () => {
  const build = (items: any[]): any => ({
    items: items.map((item) => ({
      ...item,
      submenu: Array.isArray(item.submenu) ? build(item.submenu) : undefined,
    })),
  });
  return {
    clipboard: { writeText: native.copied },
    Menu: { buildFromTemplate: build },
    nativeImage: {
      createFromDataURL: () => ({
        addRepresentation: vi.fn(),
        setTemplateImage: vi.fn(),
      }),
    },
    Tray: class {
      menu: any;
      title = "";
      destroyed = false;
      replacements = 0;
      constructor() {
        native.trays.push(this);
      }
      setContextMenu(menu: any) {
        this.menu = menu;
        this.replacements++;
      }
      setTitle(value: string) {
        this.title = value;
      }
      setToolTip() {}
      destroy() {
        this.destroyed = true;
      }
    },
  };
});
import {
  BuildTray,
  jobTrayProgress,
  monitoredJobs,
} from "../src/main/build-tray";

const job = (change: Partial<Job> = {}): Job => ({
  id: "one",
  projectId: "project",
  projectName: "Fixture",
  platform: "ios",
  profile: "production",
  status: "running",
  stage: "compile",
  kind: "build",
  createdAt: "2026-10-28T12:00:00Z",
  startedAt: "2026-10-28T12:00:10Z",
  stageStartedAt: "2026-10-28T12:00:20Z",
  autoSubmit: false,
  clean: false,
  ...change,
});
afterEach(() => {
  vi.useRealTimers();
  native.trays.length = 0;
  vi.clearAllMocks();
});

it("orders running, queued, and pending processing without replaying failed/completed history", () => {
  expect(
    monitoredJobs([
      job({
        id: "failed",
        status: "failed",
        submission: { state: "processing", destination: "TestFlight" },
      }),
      job({ id: "accepted", status: "succeeded" }),
      job({
        id: "processing",
        status: "needs-attention",
        submission: { state: "processing", destination: "TestFlight" },
      }),
      job({ id: "queued", status: "queued" }),
      job(),
    ]).map((value) => value.id),
  ).toEqual(["one", "queued", "processing"]);
});

it("uses actual percentages or byte totals, and elapsed stage time without invented overall progress", () => {
  const now = Date.parse("2026-10-28T12:02:20Z");
  expect(jobTrayProgress(job(), now)).toBe("Compile · 2m 00s");
  expect(jobTrayProgress(job({ status: "queued" }), now)).toContain("Queued");
  const progress = {
    kind: "upload" as const,
    label: "Uploading AAB",
    startedAt: "2026-10-28T12:01:20Z",
    updatedAt: "2026-10-28T12:02:20Z",
    completedBytes: 25,
    totalBytes: 100,
  };
  expect(jobTrayProgress(job({ stage: "upload", progress }), now)).toBe(
    "Upload: Uploading AAB · 25% · 1m 00s",
  );
  expect(
    jobTrayProgress(job({ progress: { ...progress, percent: NaN } }), now),
  ).not.toContain("NaN");
  expect(
    jobTrayProgress(job({ progress: { ...progress, percent: 150 } }), now),
  ).not.toContain("150%");
});

it("updates native menu items in place, routes desktop/log actions, and removes the icon on idle", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-28T12:02:20Z"));
  const events = new EventEmitter(),
    openBuild = vi.fn(),
    showLogs = vi.fn();
  let jobs = [job(), job({ id: "two", status: "queued", platform: "android" })];
  const monitor = new BuildTray(
    events,
    () => jobs,
    { openBuild, showLogs },
    false,
  );
  try {
    const tray = native.trays[0],
      menu = tray.menu;
    expect(tray.title).toBe("2");
    expect(menu.items[0].label).toContain("1 active · 1 queued");
    expect(menu.items[2].label).toContain("Compile · 2m 00s");
    const details = menu.items[2].submenu.items;
    details
      .find((item: any) => item.label === "Open build in Local Build Desk")
      .click();
    details
      .find((item: any) => item.label === "Show log file in Finder")
      .click();
    expect(openBuild).toHaveBeenCalledWith("one");
    expect(showLogs).toHaveBeenCalledWith("one");
    jobs[0].stage = "upload";
    events.emit("event", { type: "state" });
    vi.advanceTimersByTime(1000);
    expect(tray.menu).toBe(menu);
    expect(tray.replacements).toBe(1);
    expect(menu.items[2].label).toContain("Upload · 2m 01s");
    jobs = [];
    events.emit("event", { type: "state" });
    expect(tray.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    jobs = [job()];
    events.emit("event", { type: "state" });
    expect(native.trays).toHaveLength(2);
  } finally {
    monitor.dispose();
  }
  expect(events.listenerCount("event")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("offers CLI commands without opening a GUI and never copies errors or raw tool output into the menu", () => {
  const events = new EventEmitter();
  const monitor = new BuildTray(
    events,
    () => [
      job({
        error: "private-token",
        progress: {
          kind: "work",
          label: "Compiling",
          detail: "private-token",
          startedAt: "invalid",
          updatedAt: "invalid",
        },
      }),
    ],
    { showLogs: vi.fn() },
    false,
  );
  try {
    const menu = native.trays[0].menu;
    expect(JSON.stringify(menu)).not.toContain("private-token");
    const details = menu.items[2].submenu.items;
    expect(
      details.some(
        (item: any) => item.label === "Open build in Local Build Desk",
      ),
    ).toBe(false);
    details.find((item: any) => item.label === "Copy status command").click();
    expect(native.copied).toHaveBeenCalledWith(
      "local-build-desk status --job one",
    );
  } finally {
    monitor.dispose();
  }
});

it("creates no native icon for idle or hidden replay sessions", () => {
  const events = new EventEmitter();
  const idle = new BuildTray(events, () => [], { showLogs: vi.fn() }, false);
  const hidden = new BuildTray(
    events,
    () => [job()],
    { showLogs: vi.fn() },
    true,
  );
  expect(native.trays).toHaveLength(0);
  idle.dispose();
  hidden.dispose();
});

it("keeps an idle phone monitor event-driven without repeating native menu writes", () => {
  vi.useFakeTimers();
  const events = new EventEmitter();
  let jobs: Job[] = [];
  const status = {
    config: { enabled: true },
    running: true,
    clients: 0,
    url: "https://127.0.0.1:43178",
  } as any;
  const monitor = new BuildTray(
    events,
    () => jobs,
    { showLogs: vi.fn(), monitor: () => status, openDesk: vi.fn() },
    false,
  );
  try {
    const tray = native.trays[0],
      title = vi.spyOn(tray, "setTitle"),
      tooltip = vi.spyOn(tray, "setToolTip"),
      item = tray.menu.items[0];
    let label = item.label;
    const setLabel = vi.fn((value) => {
      label = value;
    });
    Object.defineProperty(item, "label", {
      get: () => label,
      set: setLabel,
      configurable: true,
    });
    monitor.refresh();
    expect(setLabel).not.toHaveBeenCalled();
    expect(title).not.toHaveBeenCalled();
    expect(tooltip).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    status.clients = 1;
    monitor.refresh();
    expect(setLabel).toHaveBeenCalledTimes(1);
    expect(tooltip).toHaveBeenCalledTimes(1);
    jobs = [job()];
    events.emit("event", { type: "state" });
    expect(vi.getTimerCount()).toBe(1);
    jobs = [];
    events.emit("event", { type: "state" });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    monitor.dispose();
  }
});

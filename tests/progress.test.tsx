// @vitest-environment jsdom
import { it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { WorkProgress } from "../src/renderer/src/WorkProgress";
import { toolProgress } from "../src/core/progress";
it("shows measured bytes, elapsed time, and honest indeterminate work without a fake percentage", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T16:00:00Z"));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    const startedAt = "2026-10-27T15:58:55Z";
    await act(async () =>
      root.render(
        <WorkProgress
          label="Uploading"
          note="This can take a few minutes."
          startedAt={startedAt}
        />,
      ),
    );
    expect(
      host.querySelector("[role=progressbar]")?.hasAttribute("aria-valuenow"),
    ).toBe(false);
    expect(host.textContent).toContain("1m 05s elapsed");
    await act(async () => vi.advanceTimersByTime(2000));
    expect(host.textContent).toContain("1m 07s elapsed");
    await act(async () =>
      root.render(
        <WorkProgress
          label="Uploading"
          note="Waiting"
          startedAt={startedAt}
          progress={{
            kind: "upload",
            label: "Sending AAB",
            startedAt,
            updatedAt: new Date().toISOString(),
            completedBytes: 1000 ** 2,
            totalBytes: 2 * 1000 ** 2,
          }}
        />,
      ),
    );
    expect(
      host.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow"),
    ).toBe("50");
    expect(host.textContent).toContain("1.0 MB / 2.0 MB");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  }
});
it("extracts the real Xcode component percentage and resets it for signature verification", () => {
  const download = toolProgress(
    "Downloading iOS 27.2 Simulator (arm64): 55.8% (4.64 GB of 8.32 GB)",
  );
  expect(download?.percent).toBe(55.8);
  expect(download?.kind).toBe("download");
  expect(
    toolProgress("Verifying Xcode’s code signature and Apple origin…", download)
      ?.percent,
  ).toBeUndefined();
});

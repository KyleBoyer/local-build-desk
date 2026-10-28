// @vitest-environment jsdom
import { it, expect, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useLogFollow } from "../src/renderer/src/useLogFollow";
it("follows only a substantially visible log tail without scrolling the workspace or interrupting reading", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let intersection!: (entries: any[]) => void;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: any) {
        intersection = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Logs({
    count,
    search = false,
  }: {
    count: number;
    search?: boolean;
  }) {
    const ref = useLogFollow("job", count, search);
    return (
      <div ref={ref} role="log">
        {count}
      </div>
    );
  }
  try {
    await act(async () => root.render(<Logs count={1} />));
    const panel = host.firstElementChild as HTMLElement;
    let height = 1000;
    Object.defineProperty(panel, "scrollHeight", { get: () => height });
    Object.defineProperty(panel, "clientHeight", { get: () => 200 });
    const intoView = vi.fn();
    panel.scrollIntoView = intoView;
    intersection([{ isIntersecting: true, intersectionRatio: 0.05 }]);
    await act(async () => root.render(<Logs count={2} />));
    expect(panel.scrollTop).toBe(0);
    intersection([{ isIntersecting: true, intersectionRatio: 1 }]);
    expect(panel.scrollTop).toBe(1000);
    panel.scrollTop = 800;
    panel.dispatchEvent(new Event("scroll"));
    height = 1100;
    await act(async () => root.render(<Logs count={3} />));
    expect(panel.scrollTop).toBe(1100);
    panel.scrollTop = 100;
    panel.dispatchEvent(new Event("scroll"));
    height = 1200;
    await act(async () => root.render(<Logs count={4} />));
    expect(panel.scrollTop).toBe(100);
    panel.scrollTop = 1000;
    panel.dispatchEvent(new Event("scroll"));
    intersection([{ isIntersecting: false, intersectionRatio: 0 }]);
    height = 1300;
    await act(async () => root.render(<Logs count={5} />));
    expect(panel.scrollTop).toBe(1000);
    intersection([{ isIntersecting: true, intersectionRatio: 0.95 }]);
    expect(panel.scrollTop).toBe(1300);
    await act(async () => root.render(<Logs count={6} search />));
    height = 1400;
    await act(async () => root.render(<Logs count={7} search />));
    expect(panel.scrollTop).toBe(1300);
    expect(intoView).not.toHaveBeenCalled();
    expect(document.documentElement.scrollTop).toBe(0);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

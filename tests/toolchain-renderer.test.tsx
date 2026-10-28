// @vitest-environment jsdom
import { it, expect } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { DesktopAPI, DeskState, Check } from "../src/core/types";
it("keeps project SDK checks when the slower system-default check completes afterward", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let resolveState!: (state: DeskState) => void;
  let resolveSystem!: (checks: Check[]) => void;
  let resolveProject!: (checks: Check[]) => void;
  const previous = window.desk;
  window.desk = {
    state: () => new Promise((resolve) => (resolveState = resolve)),
    onEvent: () => () => {},
    inspect: () => new Promise(() => {}),
    xcodeInstallations: async () => [],
    doctor: (id?: string) =>
      new Promise((resolve) => {
        if (id) resolveProject = resolve;
        else resolveSystem = resolve;
      }),
  } as unknown as DesktopAPI;
  const { App } = await import("../src/renderer/src/App");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<App />));
    expect(resolveSystem).toBeTypeOf("function");
    await act(async () =>
      resolveState({
        dataPath: "/fixture/data",
        projects: [
          {
            id: "project",
            name: "Fixture",
            path: "/fixture",
            profiles: ["production"],
            settings: { minimumIosSdk: "27.2", iosSdk: "27.2" },
            createdAt: "",
          },
        ],
        jobs: [],
        artifacts: [],
        credentials: [],
      }),
    );
    await act(async () =>
      resolveProject([
        { name: "iOS SDK", status: "ok", detail: "Selected iOS 27.2 SDK" },
      ]),
    );
    const toolchain = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Toolchain",
    )!;
    await act(async () => toolchain.click());
    expect(container.textContent).toContain("Selected iOS 27.2 SDK");
    await act(async () =>
      resolveSystem([
        { name: "iOS SDK", status: "ok", detail: "Selected iOS 26.5 SDK" },
      ]),
    );
    expect(container.textContent).toContain("Selected iOS 27.2 SDK");
    expect(container.textContent).not.toContain("Selected iOS 26.5 SDK");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.desk = previous;
  }
});

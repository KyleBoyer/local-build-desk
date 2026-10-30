import { useCallback, useLayoutEffect, useRef } from "react";

/** Explicit navigation owns scroll/focus. Background refreshes and log events
 * never move the workspace. Restore the originating row after a drill-in. */
export function useDetailNavigation(selection: string | undefined) {
  const root = useRef<HTMLElement>(null);
  const origin = useRef({ y: 0, id: "" });
  const intent = useRef<"enter" | "back" | undefined>(undefined);
  const enter = useCallback((id: string, rememberList = true) => {
    origin.current = { y: rememberList ? window.scrollY : 0, id };
    intent.current = "enter";
  }, []);
  const back = useCallback(() => {
    intent.current = "back";
  }, []);
  useLayoutEffect(() => {
    const region = root.current;
    if (!region || !intent.current) return;
    if (
      (intent.current === "enter" && !selection) ||
      (intent.current === "back" && selection)
    )
      return;
    const restoring = intent.current === "back";
    const heading =
      region.querySelector<HTMLElement>("[data-detail-heading]") ??
      region.querySelector<HTMLElement>("h1, h2, h3");
    if (!heading) return;
    intent.current = undefined;
    const row = [
      ...region.querySelectorAll<HTMLElement>("[data-detail-id]"),
    ].find((el) => el.dataset.detailId === origin.current.id);
    const target = restoring ? (row ?? heading) : heading;
    if (target) {
      if (!restoring || target === heading) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
    window.scrollTo({
      top: restoring
        ? origin.current.y
        : Math.max(0, window.scrollY + region.getBoundingClientRect().top - 82),
      behavior: "instant",
    });
  });
  return { root, enter, back };
}

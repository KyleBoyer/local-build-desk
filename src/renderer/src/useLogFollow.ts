import { useEffect, useLayoutEffect, useRef } from "react";
// Follow only inside the log scroller. scrollIntoView also scrolls the workspace.
export function useLogFollow(jobId: string, count: number, searching: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useRef(false);
  const following = useRef(true);
  const enabled = useRef(!searching);
  enabled.current = !searching;
  const follow = () => {
    const panel = ref.current;
    if (panel && visible.current && following.current && enabled.current)
      panel.scrollTop = panel.scrollHeight;
  };
  useEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    following.current = true;
    visible.current = false;
    const onScroll = () => {
      following.current =
        panel.scrollHeight - panel.clientHeight - panel.scrollTop <= 32;
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible.current =
          entry.isIntersecting && entry.intersectionRatio >= 0.9;
        follow();
      },
      { threshold: [0, 0.9, 1] },
    );
    observer.observe(panel);
    panel.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      panel.removeEventListener("scroll", onScroll);
    };
  }, [jobId]);
  useLayoutEffect(follow, [jobId, count, searching]);
  return ref;
}

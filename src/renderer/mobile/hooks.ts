import { useEffect, useState } from "react";
import type { MonitorSnapshot } from "../../mobile/types";
import { request } from "./api";
export function useClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}
export function useMonitor(active: boolean) {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot>(),
    [connected, setConnected] = useState(false),
    [lastContact, setLastContact] = useState(0);
  useEffect(() => {
    if (!active) {
      setSnapshot(undefined);
      setConnected(false);
      return;
    }
    let events: EventSource | undefined,
      disposed = false,
      heartbeat = Date.now();
    const connect = () => {
      events?.close();
      if (disposed || document.hidden) return;
      events = new EventSource("/api/events");
      events.onopen = () => {
        setConnected(true);
        heartbeat = Date.now();
        setLastContact(heartbeat);
      };
      events.addEventListener("state", (event) => {
        setSnapshot(JSON.parse((event as MessageEvent).data));
        setConnected(true);
        heartbeat = Date.now();
        setLastContact(heartbeat);
      });
      events.addEventListener("heartbeat", () => {
        setConnected(true);
        heartbeat = Date.now();
        setLastContact(heartbeat);
      });
      events.addEventListener("logs", (event) => {
        const value = JSON.parse((event as MessageEvent).data);
        window.dispatchEvent(
          new CustomEvent("monitor-log", { detail: value.jobId }),
        );
      });
      events.addEventListener("session", () =>
        window.dispatchEvent(new Event("monitor-session-expired")),
      );
      events.onerror = () => {
        setConnected(false);
        void request("session").catch(() => {});
      };
    };
    const visibility = () => {
      if (document.hidden) {
        events?.close();
        setConnected(false);
      } else connect();
    };
    connect();
    const watchdog = setInterval(() => {
      if (!document.hidden && Date.now() - heartbeat > 45000) {
        setConnected(false);
        heartbeat = Date.now();
        connect();
      }
    }, 10000);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", connect);
    return () => {
      disposed = true;
      clearInterval(watchdog);
      events?.close();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", connect);
    };
  }, [active]);
  return { snapshot, connected, lastContact };
}

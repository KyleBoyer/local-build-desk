import type { App, Event } from "electron";
/** Close the engine exactly once. Squirrel may request quit again while the
 * first asynchronous cleanup is still running. Force-exit is allowed only for
 * an explicit update, after all engine/database cleanup has completed. */
export function installQuitController(
  app: Pick<App, "on" | "quit" | "exit">,
  cleanup: () => Promise<void>,
  installing: () => boolean,
  fallbackMs = 5000,
) {
  let ready = false;
  let closing: Promise<void> | undefined;
  app.on("before-quit", (event: Event) => {
    if (ready) return;
    event.preventDefault();
    if (closing) return;
    closing = cleanup()
      .then(() => {
        ready = true;
        if (installing()) {
          // A native updater can retain a windowless old process after will-quit.
          // Its replacement helper is already waiting for this process to exit.
          const fallback = setTimeout(() => app.exit(0), fallbackMs);
          fallback.unref?.();
        }
        app.quit();
      })
      .catch((error) => {
        console.error("Shutdown failed:", error);
        app.exit(1);
      });
  });
}

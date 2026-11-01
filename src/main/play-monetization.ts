import {
  BrowserWindow,
  session,
  shell,
  type DownloadItem,
  type WebContents,
} from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { GooglePromo } from "../core/monetization";
import { playAssist, type PageTask } from "./play-assist";

/**
 * Play Console has no API for promo codes or a paid app's price, so these
 * open in the desk's signed-in Play Console session. The assist finds the
 * page through the Console's own navigation, fills in what it can find by
 * label, and leaves the final Save to the person: those publish
 * codes and prices. Codes Play offers for download are saved privately.
 */
export type PlayAssistTarget =
  | {
      kind: "promo";
      dashboard: string;
      promo: GooglePromo;
      productTitle: string;
      productKind: "product" | "subscription";
      codesFolder: string;
    }
  | { kind: "appPrice"; dashboard: string; price: string; codesFolder: string };

async function inPage<T>(
  contents: WebContents,
  task: PageTask,
): Promise<T | undefined> {
  if (contents.isDestroyed()) return undefined;
  const url = new URL(contents.getURL() || "about:blank");
  if (url.hostname !== "play.google.com") return undefined;
  return contents
    .executeJavaScript(
      `(${playAssist.toString()})(${JSON.stringify(task)})`,
      true,
    )
    .catch(() => undefined);
}
async function poll<T>(
  read: () => Promise<T | undefined>,
  ok: (v: T) => boolean,
  ms: number,
) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined && ok(value)) return value;
    if (Date.now() > deadline) return value;
    await sleep(700);
  }
}

const allowed = (url: string) => {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      protocol === "https:" &&
      (hostname === "play.google.com" || hostname.endsWith(".google.com"))
    );
  } catch {
    return false;
  }
};

export async function openPlayAssist(
  target: PlayAssistTarget,
  parent: BrowserWindow | undefined,
  saved: (file: string) => void,
) {
  const partition = session.fromPartition("persist:desk-account-google");
  const window = new BrowserWindow({
    width: 1240,
    height: 880,
    title:
      target.kind === "promo"
        ? `Create promotion ${target.promo.name} · Local Build Desk`
        : "Set the paid app price · Local Build Desk",
    backgroundColor: "#101a23",
    ...(parent && !parent.isDestroyed() ? { parent } : {}),
    webPreferences: {
      session: partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const contents = window.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (allowed(url)) void contents.loadURL(url);
    else void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
  // Codes Play offers for download go to the private codes folder.
  const download = (
    _event: unknown,
    item: DownloadItem,
    source: WebContents,
  ) => {
    if (source !== contents || target.kind !== "promo") return;
    mkdirSync(target.codesFolder, { recursive: true, mode: 0o700 });
    const file = join(
      target.codesFolder,
      `${encodeURIComponent(`google:promo:${target.promo.name}`)}--play-${Date.now()}.csv`,
    );
    item.setSavePath(file);
    item.once("done", (_e, state) => {
      if (state === "completed") saved(file);
    });
  };
  partition.on("will-download", download);
  window.once("closed", () =>
    partition.removeListener("will-download", download),
  );

  await contents.loadURL(target.dashboard).catch(() => undefined);
  const banner = (text: string) => inPage(contents, { step: "banner", text });
  const signedIn = await poll(
    async () => (contents.isDestroyed() ? "" : contents.getURL()),
    (url) => new URL(url).hostname === "play.google.com",
    15000,
  );
  if (!signedIn || new URL(signedIn).hostname !== "play.google.com") return; // Google's sign-in is on screen.
  const patterns =
    target.kind === "promo"
      ? ["^promo codes$", "promo code"]
      : ["^app pricing$", "^pricing$"];
  const found = await poll(
    () => inPage<{ href?: string }>(contents, { step: "find-link", patterns }),
    (r) => !!r.href,
    20000,
  );
  if (!found?.href) {
    await banner(
      target.kind === "promo"
        ? "Open Monetize with Play → Products → Promo codes, then choose Create promotion."
        : `Open Monetize with Play → App pricing and set the price to $${target.price}.`,
    );
    return;
  }
  await contents.loadURL(found.href).catch(() => undefined);
  if (target.kind === "appPrice") {
    await poll(
      () =>
        banner(
          `Set the price to $${target.price} (USD), review the converted prices, then save.`,
        ),
      Boolean,
      15000,
    );
    return;
  }
  const opened = await poll(
    () =>
      inPage<{ done?: boolean }>(contents, {
        step: "open-form",
        patterns: ["create promotion", "create promo", "new promotion"],
      }),
    (r) => !!r.done,
    20000,
  );
  if (!opened?.done) {
    await banner(
      "Choose Create promotion; Local Build Desk will fill in what it can.",
    );
    return;
  }
  const fill = await poll(
    () =>
      inPage<{ filled?: string[]; missing?: string[] }>(contents, {
        step: "fill",
        promo: target.promo,
        productKind: target.productKind,
      }),
    (r) => (r.filled?.length ?? 0) >= 3,
    15000,
  );
  const step = (task: PageTask) =>
    poll(
      () => inPage<{ done?: boolean }>(contents, task),
      (r) => !!r.done,
      15000,
    ).then((r) => !!r?.done);
  const picked = await step({
    step: "pick-product",
    productId: target.promo.productId,
    productTitle: target.productTitle,
  });
  // Play's calendar names days without zero padding; a promotion ends at the
  // start of its end day, so it runs through the day after the file's end.
  const day = (iso: string, add = 0) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + add);
    return {
      date: `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`,
      shown: d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }),
    };
  };
  const started = await step({
    step: "pick-date",
    row: "^start date",
    ...day(target.promo.start),
  });
  const ended = await step({
    step: "pick-date",
    row: "^end date",
    ...day(target.promo.end, 1),
  });
  const filled = [
    ...(fill?.filled ?? []),
    ...(picked ? ["product"] : []),
    ...(started ? ["start"] : []),
    ...(ended ? ["end"] : []),
  ];
  const missing = [
    ...(fill?.missing ?? []),
    ...(picked ? [] : [`the product (${target.productTitle})`]),
    ...(started ? [] : [`the start (${target.promo.start})`]),
    ...(ended
      ? []
      : [`the end (${target.promo.end}, through the end of that day)`]),
  ];
  await banner(
    `Filled ${filled.join(", ") || "nothing"}. ${missing.length ? `Please set ${missing.join(", ")}. ` : ""}Check everything, then choose Save. Download the codes when Play offers them; they're saved privately, never in your repository.`,
  );
}

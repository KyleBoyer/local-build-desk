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

/**
 * Play Console has no API for promo codes or a paid app's price, so these
 * open in the desk's signed-in Play Console session. The assist finds the
 * page through the Console's own navigation, fills in what it can find by
 * label, and leaves the final Create or Save to the person: those publish
 * codes and prices. Codes Play offers for download are saved privately.
 */
export type PlayAssistTarget =
  | {
      kind: "promo";
      dashboard: string;
      promo: GooglePromo;
      productTitle: string;
      codesFolder: string;
    }
  | { kind: "appPrice"; dashboard: string; price: string; codesFolder: string };

type PageTask =
  | { step: "find-link"; patterns: string[] }
  | { step: "open-form"; patterns: string[] }
  | { step: "fill"; promo: GooglePromo; productTitle: string }
  | { step: "banner"; text: string };

// Runs in the sandboxed Play Console page, with no Node or credential access.
export function playAssist(task: PageTask): {
  href?: string;
  done?: boolean;
  filled?: string[];
  missing?: string[];
} {
  const text = (el: Element) =>
    (
      (el as HTMLElement).innerText ||
      el.getAttribute("aria-label") ||
      el.textContent ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
  const matches = (value: string, patterns: string[]) =>
    patterns.some((p) => new RegExp(p, "i").test(value));
  if (task.step === "find-link") {
    const link = Array.from(document.querySelectorAll("a[href]")).find((a) =>
      matches(text(a), task.patterns),
    );
    return { href: link ? (link as HTMLAnchorElement).href : undefined };
  }
  if (task.step === "open-form") {
    const button = Array.from(
      document.querySelectorAll("button, a[role=button], [role=button]"),
    ).find(
      (b) =>
        matches(text(b), task.patterns) && !(b as HTMLButtonElement).disabled,
    ) as HTMLElement | undefined;
    button?.click();
    return { done: !!button };
  }
  if (task.step === "banner") {
    let banner = document.getElementById("local-build-desk-assist");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "local-build-desk-assist";
      banner.setAttribute(
        "style",
        "position:fixed;z-index:2147483647;left:50%;transform:translateX(-50%);bottom:16px;max-width:640px;padding:12px 40px 12px 16px;border-radius:10px;background:#0f2a3d;color:#fff;font:14px/1.45 system-ui;box-shadow:0 8px 30px rgba(0,0,0,.35)",
      );
      const close = document.createElement("button");
      close.textContent = "×";
      close.setAttribute("aria-label", "Close");
      close.setAttribute(
        "style",
        "position:absolute;right:8px;top:6px;background:none;border:0;color:#fff;font-size:18px;cursor:pointer",
      );
      close.onclick = () => banner!.remove();
      banner.appendChild(document.createElement("span"));
      banner.appendChild(close);
      document.body.appendChild(banner);
    }
    banner.firstElementChild!.textContent = "Local Build Desk · " + task.text;
    return { done: true };
  }
  // Fill: inputs found by their label, set the way frameworks notice.
  const filled: string[] = [],
    missing: string[] = [];
  const fieldFor = (patterns: string[]) => {
    const labels = Array.from(
      document.querySelectorAll("label, mat-label, [class*=label]"),
    ).filter((l) => matches(text(l), patterns));
    for (const label of labels) {
      const control =
        (label as HTMLLabelElement).control ??
        label
          .closest(
            "[class*=form-field], [class*=input], material-input, fieldset, div",
          )
          ?.querySelector("input, textarea");
      if (control) return control as HTMLInputElement;
    }
    return Array.from(document.querySelectorAll("input, textarea")).find((i) =>
      matches(
        i.getAttribute("aria-label") ?? i.getAttribute("placeholder") ?? "",
        patterns,
      ),
    ) as HTMLInputElement | undefined;
  };
  const set = (name: string, patterns: string[], value: string) => {
    const input = fieldFor(patterns);
    if (!input) return void missing.push(name);
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    for (const type of ["input", "change", "blur"])
      input.dispatchEvent(new Event(type, { bubbles: true }));
    filled.push(name);
  };
  const choose = (name: string, patterns: string[]) => {
    const option = Array.from(
      document.querySelectorAll(
        "[role=radio], input[type=radio], label, mat-radio-button",
      ),
    ).find((o) => matches(text(o) || text(o.parentElement ?? o), patterns)) as
      HTMLElement | undefined;
    if (!option) return void missing.push(name);
    option.click();
    filled.push(name);
  };
  const p = task.promo;
  set("promotion name", ["promotion name", "^name$"], p.name);
  choose(
    "code type",
    p.kind === "custom" ? ["custom code"] : ["one-time", "one time"],
  );
  if (p.kind === "custom")
    set("custom code", ["custom code", "^code$"], p.code ?? "");
  set(
    p.kind === "custom" ? "redemption limit" : "number of codes",
    ["number of codes", "quantity", "redemption", "how many"],
    String(p.count),
  );
  missing.push(
    `product (${task.productTitle})`,
    `dates (${p.start} to ${p.end})`,
  );
  return { filled, missing };
}

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
        productTitle: target.productTitle,
      }),
    (r) => (r.filled?.length ?? 0) >= 2,
    15000,
  );
  await banner(
    `${fill?.filled?.length ? `Filled ${fill.filled.join(", ")}. ` : ""}Please set ${(fill?.missing ?? []).join(", ")}, check everything, then choose Create. Download the codes when Play offers them; they're saved privately, never in your repository.`,
  );
}

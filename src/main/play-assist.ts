import type { GooglePromo } from "../core/monetization";

// The Play Console page script for promo codes and the paid app price. It
// runs in the sandboxed page, with no Node or credential access, and does one
// step per call so the desktop side can wait for Play's Angular UI between them.

export type PageTask =
  | { step: "fill-testers"; emails: string[] }
  | { step: "find-link"; patterns: string[] }
  | { step: "open-form"; patterns: string[] }
  | {
      step: "fill";
      promo: GooglePromo;
      productKind: "product" | "subscription";
    }
  | { step: "pick-product"; productId: string; productTitle: string }
  /** date is Play's calendar form, such as 2026-11-2. */
  | { step: "pick-date"; row: string; date: string; shown: string }
  | { step: "banner"; text: string };

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
      document.querySelectorAll(
        "button, a[role=button], [role=button], [role=tab]",
      ),
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
  // Inputs are found through their form row: Play's labels aren't tied to
  // their inputs. Values are set the way Angular notices.
  const filled: string[] = [],
    missing: string[] = [];
  const setValue = (
    input: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ) => {
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    for (const type of ["input", "change", "keyup", "blur"])
      input.dispatchEvent(new Event(type, { bubbles: true }));
  };
  const fieldFor = (patterns: string[]) => {
    const labels = Array.from(
      document.querySelectorAll("label, mat-label, [class*=label]"),
    ).filter((l) => matches(text(l), patterns));
    for (const label of labels) {
      if ((label as HTMLLabelElement).control)
        return (label as HTMLLabelElement).control as HTMLInputElement;
      let scope: Element | null = label;
      for (let depth = 0; scope && depth < 5; depth++) {
        scope = scope.parentElement;
        const control = scope?.querySelector(
          "input:not([type=radio]):not([type=checkbox]), textarea",
        );
        if (control) return control as HTMLInputElement;
      }
    }
    return Array.from(document.querySelectorAll("input, textarea")).find((i) =>
      matches(
        i.getAttribute("aria-label") ?? i.getAttribute("placeholder") ?? "",
        patterns,
      ),
    ) as HTMLInputElement | undefined;
  };
  if (task.step === "fill-testers") {
    const patterns = [
      "^email addresses",
      "^add email addresses",
      "^(?:add )?license testers",
      "^testers.*email",
    ];
    const candidates = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        "input:not([type=password]):not([type=hidden]), textarea",
      ),
    ).filter((input) => {
      if (!input.getClientRects().length) return false;
      if (
        matches(
          input.getAttribute("aria-label") ??
            input.getAttribute("placeholder") ??
            "",
          patterns,
        )
      )
        return true;
      if (
        Array.from(input.labels ?? []).some((label) =>
          matches(text(label), patterns),
        )
      )
        return true;
      const row = input.closest("console-form-row, [class*=form-row]");
      return (
        !!row &&
        row.querySelectorAll("input,textarea").length === 1 &&
        matches(text(row), patterns)
      );
    });
    const input = candidates.length === 1 ? candidates[0] : undefined;
    if (!input || input.disabled || input.readOnly)
      return { done: false, missing: ["Email address editor"] };
    // Never overwrite an existing list silently: append and let the person
    // inspect the exact addresses before Console's final Save.
    const kept = input.value.split(/[\s,;]+/).filter(Boolean);
    setValue(input, [...new Set([...kept, ...task.emails])].join(", "));
    const name = fieldFor(["^list name$"]);
    if (name && !name.value) setValue(name, "Local Build Desk");
    return { done: true, filled: ["Email addresses"] };
  }
  const set = (name: string, patterns: string[], value: string) => {
    const input = fieldFor(patterns);
    if (!input) return void missing.push(name);
    setValue(input, value);
    filled.push(name);
  };
  /** A radio by the text next to it, such as "One-time product". */
  const choose = (name: string, patterns: string[]) => {
    const radio = Array.from(
      document.querySelectorAll("input[type=radio]"),
    ).find((r) => {
      let scope: Element | null = r;
      for (let depth = 0; scope && depth < 4; depth++) {
        scope = scope.parentElement;
        const label = scope ? text(scope) : "";
        if (label) return matches(label, patterns);
      }
      return false;
    }) as HTMLInputElement | undefined;
    if (!radio) return void missing.push(name);
    if (!radio.checked) radio.click();
    filled.push(name);
  };
  const visible = (e: Element) => e.getClientRects().length > 0;
  const formRow = (pattern: string) =>
    Array.from(
      document.querySelectorAll("console-form-row, [class*=form-row]"),
    ).find((r) => matches(text(r), [pattern]));
  const press = (e: Element) => {
    for (const type of ["mousedown", "mouseup", "click"])
      e.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  };
  if (task.step === "pick-product") {
    // "+ Product" opens "Select an active purchase option": search for the
    // product, choose its purchase option, Apply. One action per call.
    const row = formRow("^promotion type");
    if (row && text(row).includes(`${task.productTitle} - `))
      return { done: true };
    const dialog = Array.from(
      document.querySelectorAll("focus-trap, [role=dialog]"),
    ).find((d) => visible(d) && /purchase option/i.test(text(d)));
    if (!dialog) {
      const open = Array.from(
        row?.querySelectorAll("button, [role=button]") ?? [],
      ).find((b) => /product/i.test(text(b)) && visible(b)) as
        HTMLElement | undefined;
      open?.click();
      return { done: false };
    }
    const search = Array.from(dialog.querySelectorAll("input")).find((i) =>
      /search/i.test(i.getAttribute("aria-label") ?? ""),
    );
    if (search && search.value !== task.productId) {
      setValue(search, task.productId);
      return { done: false };
    }
    const rows = Array.from(
      dialog.querySelectorAll("[class*=table-row], [role=row]"),
    ).filter(visible);
    const header = rows.findIndex((r) => text(r).includes(task.productId));
    const option = rows
      .slice(header + 1)
      .find((r) =>
        r.querySelector("mat-radio-button, [role=radio], input[type=radio]"),
      );
    if (!option) return { done: false };
    if (!/selected/.test(option.className))
      press(
        option.querySelector(
          "mat-radio-button, [role=radio], input[type=radio]",
        )!,
      );
    const apply = Array.from(dialog.querySelectorAll("button")).find(
      (b) => /^apply$/i.test(text(b)) && !(b as HTMLButtonElement).disabled,
    );
    apply?.click();
    return { done: false };
  }
  if (task.step === "pick-date") {
    const row = formRow(task.row);
    if (!row) return { done: false };
    if (text(row).includes(task.shown)) return { done: true };
    const calendar = Array.from(
      document.querySelectorAll("material-calendar-picker"),
    ).find(visible);
    const cell = calendar?.querySelector(`[data-date="${task.date}"]`);
    if (cell) {
      cell.scrollIntoView({ block: "center" });
      press(cell);
      return { done: false };
    }
    const opener = (Array.from(row.querySelectorAll("*")).find(
      (e) => e.children.length === 0 && /select a date/i.test(text(e)),
    ) ?? row.querySelector("material-dropdown-select")) as HTMLElement | null;
    opener?.click();
    return { done: false };
  }
  const p = task.promo;
  set("promotion name", ["^promotion name"], p.name);
  choose(
    "promotion type",
    task.productKind === "subscription"
      ? ["^subscription$"]
      : ["^one-time product$"],
  );
  if (p.kind === "custom")
    set("custom code", ["custom code", "^code$"], p.code ?? "");
  set(
    p.kind === "custom" ? "redemption limit" : "number of codes",
    ["number of codes", "quantity", "redemption", "how many"],
    String(p.count),
  );
  return { filled, missing };
}

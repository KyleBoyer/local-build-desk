export interface AccountKeyRow {
  id: string;
  name: string;
  downloadable: boolean;
}
export interface AccountProbe {
  phase:
    | "login"
    | "terms"
    | "apps"
    | "keys"
    | "key-dialog"
    | "download-confirm"
    | "download"
    | "team"
    | "unknown";
  issuerId?: string;
  teamId?: string;
  detail?: string;
  keys?: AccountKeyRow[];
  form?: {
    nameReady: boolean;
    adminSelected: boolean;
    generateEnabled: boolean;
  };
}
export type AppleAction = {
  type:
    | "request-access"
    | "open-key-dialog"
    | "fill-key-dialog"
    | "generate-key"
    | "download-key"
    | "membership";
  name?: string;
  keyId?: string;
};
export interface AppleActionResult {
  done: boolean;
  detail?: string;
  target?: { tag: string; label: string; id: string; reason: string };
  candidates?: { tag: string; label: string; id: string }[];
}
// Standalone page functions are serialized into the app's own sandboxed provider view.
export function inspectApplePage(): AccountProbe {
  const visible = (e: Element) =>
    Boolean(
      (e as HTMLElement).offsetWidth ||
      (e as HTMLElement).offsetHeight ||
      e.getClientRects().length,
    );
  const normalized = (s: string) => s.replace(/\s+/g, " ").trim();
  const labels = (e: Element) =>
    [e.getAttribute("aria-label"), e.getAttribute("title"), e.textContent]
      .filter((x): x is string => !!x)
      .map(normalized);
  const text = (document.body?.innerText ?? "").slice(0, 150000);
  const controls = [
    ...document.querySelectorAll<HTMLElement>(
      "button,[role=button],a,[role=tab]",
    ),
  ].filter(visible);
  const dialog = [
    ...document.querySelectorAll<HTMLElement>(
      "[role=dialog],dialog,[aria-modal=true],.modal-dialog",
    ),
  ]
    .filter(visible)
    .find((e) => /API Key|Download|Request Access/i.test(e.innerText));
  const dialogText = dialog?.innerText ?? "";
  const identifier = (label: RegExp, pattern: RegExp) => {
    const element = [...document.querySelectorAll("p,span,dt,label,div")].find(
      (e) => label.test(normalized(e.textContent ?? "")),
    );
    let parent = element?.parentElement;
    for (let i = 0; parent && i < 4; i++, parent = parent.parentElement) {
      const value = parent.textContent?.match(pattern)?.[0];
      if (value) return value;
    }
    return undefined;
  };
  const issuerId =
    identifier(
      /^Issuer ID$/i,
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    ) ??
    text.match(
      /Issuer\s*ID[\s?:]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    )?.[1];
  const teamId =
    identifier(/^Team ID$/i, /\b[A-Z0-9]{10}\b/) ??
    text.match(/Team\s*ID[\s?:]*([A-Z0-9]{10})\b/)?.[1];
  if (
    /(?:^|\/)(?:login|signin)(?:\/|$)/i.test(location.pathname) ||
    [
      ...document.querySelectorAll(
        "input[type=password],input[autocomplete=one-time-code],input[name=accountName]",
      ),
    ].some(visible) ||
    /^(idmsa|appleid|account)\.apple\.com$/.test(location.hostname)
  )
    return { phase: "login" };
  if (
    /Request Access to the App Store Connect API/.test(dialogText) &&
    /agree|accordance/.test(dialogText)
  )
    return { phase: "terms", issuerId };
  if (
    dialog &&
    /API Key/i.test(dialogText) &&
    /download/i.test(dialogText) &&
    /once|only|saved|secure/i.test(dialogText)
  )
    return { phase: "download-confirm", issuerId };
  if (
    dialog &&
    /Generate.*API Key|New API Key/i.test(dialogText) &&
    /Access|Name/.test(dialogText)
  ) {
    const input = [
      ...dialog.querySelectorAll<HTMLInputElement>(
        "input[type=text],input:not([type])",
      ),
    ]
      .filter(visible)
      .find((e) => !/search|password|code/i.test(e.name + " " + e.id));
    const adminChip = dialog.querySelector("#roles");
    const adminSelected =
      /\bAdmin\b/.test(adminChip?.textContent ?? "") ||
      [...dialog.querySelectorAll("select,[role=combobox],[aria-haspopup]")]
        .filter(visible)
        .some((e) =>
          e instanceof HTMLSelectElement
            ? e.selectedOptions[0]?.text === "Admin"
            : labels(e).some((t) => t === "Admin"),
        );
    const generate = [
      ...dialog.querySelectorAll<HTMLElement>("button,[role=button]"),
    ]
      .filter(visible)
      .find((e) => labels(e).some((t) => /^Generate$/i.test(t)));
    return {
      phase: "key-dialog",
      issuerId,
      form: {
        nameReady: !!input?.value.trim(),
        adminSelected,
        generateEnabled:
          !!generate &&
          !generate.hasAttribute("disabled") &&
          generate.getAttribute("aria-disabled") !== "true",
      },
    };
  }
  if (teamId) return { phase: "team", teamId, issuerId };
  if (
    /App Store Connect API/.test(text) &&
    (/Team Keys|Issuer ID|Active\s*\(/.test(text) ||
      controls.some((e) =>
        labels(e).some((t) => /Request Access|Generate.*API Key/i.test(t)),
      ))
  ) {
    const rows = [...document.querySelectorAll("table tbody tr,[role=row]")]
      .filter(visible)
      .map((row) => {
        const cells = [
          ...row.querySelectorAll("td,th,[role=cell],[role=rowheader]"),
        ];
        const keyCell = cells.find((c) =>
          [...c.querySelectorAll("button,[role=button]")].some((button) =>
            labels(button).some((label) => /^Copy Key ID$/i.test(label)),
          ),
        );
        const id = (keyCell ? [keyCell] : cells)
          .map((c) =>
            normalized(c.textContent ?? "")
              .replace(/Copy Key ID$/i, "")
              .trim(),
          )
          .find((value) => /^[A-Z0-9]{10}$/.test(value));
        return id
          ? {
              id,
              name: normalized(cells[0]?.textContent ?? ""),
              downloadable: [
                ...row.querySelectorAll("button,a,[role=button]"),
              ].some((e) => labels(e).some((t) => /download/i.test(t))),
            }
          : undefined;
      })
      .filter((x): x is AccountKeyRow => !!x);
    return {
      phase: "keys",
      issuerId,
      detail: controls.some((e) =>
        labels(e).some((t) => /^Request Access$/i.test(t)),
      )
        ? "access-required"
        : "keys-enabled",
      keys: rows,
    };
  }
  if (
    controls.some((e) =>
      labels(e).some((t) => /^Download(?: API)? Key$/i.test(t)),
    )
  )
    return { phase: "download", issuerId };
  if (
    location.hostname === "appstoreconnect.apple.com" &&
    /^\/(?:teams\/[^/]+\/)?apps(?:\/|$)/.test(location.pathname)
  )
    return { phase: "apps" };
  return { phase: "unknown", issuerId };
}
export function performAppleAction(action: AppleAction): AppleActionResult {
  const visible = (e: Element) =>
    Boolean(
      (e as HTMLElement).offsetWidth ||
      (e as HTMLElement).offsetHeight ||
      e.getClientRects().length,
    );
  const normalized = (s: string) => s.replace(/\s+/g, " ").trim();
  const labels = (e: Element) =>
    [
      e.getAttribute("aria-label"),
      e.getAttribute("title"),
      e.textContent,
      e.querySelector("svg title")?.textContent,
    ]
      .filter((x): x is string => !!x)
      .map(normalized);
  const elements = (selector: string, scope: ParentNode = document) =>
    [...scope.querySelectorAll<HTMLElement>(selector)].filter(visible);
  const actionable = (scope: ParentNode = document) =>
    elements(
      "button,[role=button],[role=option],[role=menuitem],a",
      scope,
    ).filter(
      (e) =>
        !e.hasAttribute("disabled") &&
        e.getAttribute("aria-disabled") !== "true",
    );
  const describe = (e: HTMLElement) => ({
    tag: e.tagName.toLowerCase(),
    label: labels(e)[0] ?? "",
    id: e.id,
  });
  const activate = (e: HTMLElement, reason: string): AppleActionResult => {
    const target = { ...describe(e), reason };
    e.click();
    return { done: true, target };
  };
  const click = (pattern: RegExp, scope: ParentNode = document) => {
    const matched = actionable(scope).filter((e) =>
      labels(e).some((t) => pattern.test(t)),
    );
    const targets = matched.filter(
      (e) => !matched.some((other) => other !== e && e.contains(other)),
    );
    return targets.length === 1
      ? activate(targets[0], "accessible label")
      : {
          done: false,
          detail: targets.length
            ? "Ambiguous matching controls"
            : "No matching accessible control",
          candidates: targets.slice(0, 10).map(describe),
        };
  };
  const dialog =
    elements("[role=dialog],dialog,[aria-modal=true],.modal-dialog").find((e) =>
      /API Key|Download|Request Access/i.test(e.innerText),
    ) ?? document.body;
  if (action.type === "request-access") return click(/^Request Access$/i);
  if (action.type === "open-key-dialog") {
    const tab = elements("[role=tab],a").find(
      (e) =>
        labels(e).some((t) => /^Team Keys$/i.test(t)) &&
        (e.getAttribute("aria-selected") === "false" ||
          /individual-keys/.test(location.pathname)),
    );
    if (tab) return activate(tab, "switch to team keys");
    const named = click(
      /^(?:Generate(?: an?)? API Key|Add(?: API)? Key|Generate Key|Create API Key)$/i,
    );
    if (named.done) return named;
    // Apple's actual Active header contains an icon-only button with no accessible name.
    const heading = elements("h1,h2,h3,h4,[role=heading]").find((e) =>
      /^Active\s*\(\d+\)$/i.test(normalized(e.textContent ?? "")),
    );
    let parent = heading?.parentElement;
    for (
      let level = 0;
      parent && level < 3;
      level++, parent = parent.parentElement
    ) {
      const candidates = actionable(parent).filter(
        (e) =>
          e.matches("button,[role=button]") &&
          labels(e).every((t) => !t || /^[+＋]$/.test(t)),
      );
      if (candidates.length === 1)
        return activate(
          candidates[0],
          "unique icon button in Active API keys header",
        );
      if (candidates.length > 1)
        return {
          done: false,
          detail: "Ambiguous icon buttons in Active keys header",
          candidates: candidates.map(describe),
        };
    }
    return {
      done: false,
      detail: "Active API keys Add control was not found",
      candidates: actionable()
        .filter((e) => e.matches("button,[role=button]"))
        .slice(0, 30)
        .map(describe),
    };
  }
  if (action.type === "fill-key-dialog") {
    const input = elements("input[type=text],input:not([type])", dialog).find(
      (e) =>
        !/search|password|code/i.test(
          (e as HTMLInputElement).name + " " + e.id,
        ),
    ) as HTMLInputElement | undefined;
    if (input && !input.value.trim()) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, action.name ?? "Local Build Desk");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const select = elements("select", dialog).find((e) =>
      [...(e as HTMLSelectElement).options].some(
        (o) => normalized(o.text) === "Admin",
      ),
    ) as HTMLSelectElement | undefined;
    if (select) {
      select.value = [...select.options].find(
        (o) => normalized(o.text) === "Admin",
      )!.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        done: !!input?.value.trim(),
        detail: "Name and Admin access prepared",
      };
    }
    const adminChip = dialog.querySelector("#roles");
    const selected =
      /\bAdmin\b/.test(adminChip?.textContent ?? "") ||
      elements("[role=combobox],[aria-haspopup]", dialog).some((e) =>
        labels(e).some((t) => t === "Admin"),
      );
    if (selected)
      return {
        done: !!input?.value.trim(),
        detail: "Name and Admin access verified",
      };
    const matchingOptions = actionable().filter((e) =>
      labels(e).some((t) => /^Admin$/i.test(t)),
    );
    const option = matchingOptions.filter(
      (e) => !matchingOptions.some((other) => other !== e && e.contains(other)),
    );
    if (option.length === 1)
      return activate(option[0], "select Admin from the open access menu");
    const rolesInput = dialog.querySelector<HTMLInputElement>(
      'input[name="roles"],input[placeholder="Select Roles"]',
    );
    if (rolesInput && visible(rolesInput) && !rolesInput.disabled) {
      rolesInput.focus();
      rolesInput.click();
      return {
        done: true,
        target: {
          ...describe(rolesInput),
          reason: "open Apple searchable Select Roles input",
        },
      };
    }
    const accessLabel = elements("label", dialog).find(
      (e) => normalized(e.textContent ?? "") === "Access",
    );
    const labelledId = accessLabel?.getAttribute("for");
    const labelled = labelledId
      ? document.getElementById(labelledId)
      : undefined;
    if (labelled && visible(labelled) && !labelled.hasAttribute("disabled"))
      return activate(labelled, "open labelled Access selector");
    const combo = elements(
      "select,[role=combobox],[aria-haspopup=listbox],[aria-haspopup=true]",
      dialog,
    ).filter((e) => !e.hasAttribute("disabled"));
    if (combo.length === 1) return activate(combo[0], "open access dropdown");
    const opened = click(
      /^(?:Access|Select(?: Access)?|Choose(?: Access)?|Select a role|Select an access level)$/i,
      dialog,
    );
    return {
      ...opened,
      detail: opened.done
        ? "Opened Access dropdown"
        : "Name prepared; Access selector did not match",
      candidates: opened.candidates ?? actionable(dialog).map(describe),
    };
  }
  if (action.type === "generate-key") return click(/^Generate$/i, dialog);
  if (action.type === "download-key") {
    if (
      dialog !== document.body &&
      /download.*once|only.*download/i.test(dialog.innerText)
    )
      return click(/^Download$/i, dialog);
    if (action.keyId) {
      const row = elements("tr,[role=row]").find((e) =>
        e.textContent?.includes(action.keyId!),
      );
      if (row) {
        const result = click(/download/i, row);
        if (result.done) return result;
      }
    }
    return click(/^Download(?: API)? Key$/i);
  }
  if (action.type === "membership")
    return click(/^Membership details$|^Membership$/i);
  return { done: false };
}

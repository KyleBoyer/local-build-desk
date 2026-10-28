import type { StoreSetupState } from "../core/types";

export interface StoreProbe {
  phase:
    | "login"
    | "terms"
    | "blocked"
    | "loading"
    | "apple-list"
    | "apple-form"
    | "google-accounts"
    | "google-list"
    | "google-form"
    | "app"
    | "release"
    | "uploading"
    | "capabilities"
    | "identifier-picker"
    | "identifier-register"
    | "unknown";
  developerId?: string;
  appId?: string;
  appUrl?: string;
  internalUrl?: string;
  /** The page is Play's release editor for the internal testing track. */
  internalEditor?: boolean;
  /** An existing draft release can be reopened instead of creating one. */
  draftEditable?: boolean;
  ready?: boolean;
  /** Required provider choices the automation deliberately leaves to the person. */
  missing?: string[];
  /** The provider's submit control is present but still disabled. */
  createDisabled?: boolean;
  created?: boolean;
  identityMatches?: boolean;
  fileInputs?: number;
  uploaded?: boolean;
  draftSaved?: boolean;
  capabilityReady?: boolean;
  confirmCapabilities?: boolean;
  existingAssignment?: boolean;
  canCreateIdentifier?: boolean;
  error?: string;
  terms?: boolean;
}
export type StoreAction =
  | "new-app"
  | "fill-app"
  | "create-app"
  | "select-account"
  | "open-app"
  | "open-internal"
  | "open-testing"
  | "edit-release"
  | "new-release"
  | "save-draft"
  | "configure-capability"
  | "new-identifier"
  | "fill-identifier"
  | "register-identifier"
  | "apply-identifier"
  | "save-capabilities"
  | "confirm-capabilities";
// Functions run in the sandboxed provider view. They never read auth inputs.
export function inspectStorePage(target: StoreSetupState): StoreProbe {
  const visible = (el: Element) =>
    !!(
      (el as HTMLElement).offsetWidth ||
      (el as HTMLElement).offsetHeight ||
      el.getClientRects().length
    );
  const norm = (v: string) => v.replace(/\s+/g, " ").trim();
  const label = (el: Element) => {
    const ref = (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    const clone = el.cloneNode(true) as Element;
    clone
      .querySelectorAll("[aria-hidden=true],svg,material-icon,.pc-help-text")
      .forEach((e) => e.remove());
    return norm(
      ref ||
        el.getAttribute("aria-label") ||
        clone.textContent ||
        (el instanceof HTMLInputElement
          ? [...(el.labels ?? [])].map((item) => item.textContent).join(" ")
          : "") ||
        "",
    );
  };
  if (
    /^(?:accounts\.google\.com|idmsa\.apple\.com|appleid\.apple\.com|account\.apple\.com)$/.test(
      location.hostname,
    ) ||
    [
      ...document.querySelectorAll(
        "input[type=password],input[autocomplete=one-time-code]",
      ),
    ].some(visible)
  )
    return { phase: "login" };
  const body = norm(document.body?.innerText ?? "");
  if (/browser or app may not be secure|disallowed_useragent/i.test(body))
    return { phase: "blocked" };
  const controls = [
    ...document.querySelectorAll<HTMLElement>(
      "button,a,[role=button],[role=tab],[role=menuitem]",
    ),
  ].filter(visible);
  const inputs = [
    ...document.querySelectorAll<HTMLInputElement>(
      "input:not([type=password]):not([type=hidden]),textarea,select",
    ),
  ].filter(visible);
  const fieldName = (el: HTMLInputElement) =>
    norm(
      [
        el.getAttribute("aria-label"),
        el.name,
        el.id,
        ...(el.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent),
        ...[...(el.labels ?? [])].map((l) => l.textContent),
      ]
        .filter(Boolean)
        .join(" "),
    );
  const value = (rx: RegExp, expected: string) =>
    inputs.some((el) => rx.test(fieldName(el)) && el.value === expected);
  const selected = (rx: RegExp) =>
    [
      ...document.querySelectorAll<HTMLInputElement>(
        "input[type=checkbox],input[type=radio],[role=checkbox],[role=radio]",
      ),
    ]
      .filter(visible)
      .some(
        (el) =>
          rx.test(label(el) || fieldName(el)) &&
          (el.checked || el.getAttribute("aria-checked") === "true"),
      );
  const dialog = [
    ...document.querySelectorAll<HTMLElement>(
      "dialog,[role=dialog],[aria-modal=true],.modal-dialog",
    ),
  ]
    .filter(visible)
    .at(-1);
  const has = (rx: RegExp) => controls.some((el) => rx.test(label(el)));
  const links = controls.filter(
    (el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement,
  );
  const developerId = location.pathname.match(/\/developers\/(\d+)/)?.[1];
  const appId =
    location.pathname.match(/\/app\/(\d+)/)?.[1] ??
    (location.hostname === "appstoreconnect.apple.com"
      ? location.pathname.match(/\/apps\/(\d+)/)?.[1]
      : undefined);
  const identityMatches = [
    ...document.querySelectorAll("span,p,code,li,[data-package-name]"),
  ]
    .filter(visible)
    .some((el) => norm(el.textContent ?? "") === target.identity);
  const terms =
    has(/^(?:Accept|Agree and continue|Accept agreement|Accept terms)$/i) ||
    /review and accept (?:the|these).*terms|accept.*developer distribution agreement/i.test(
      dialog?.innerText ?? "",
    );
  if (terms) return { phase: "terms", terms: true, developerId, appId };
  const alerts = [
    ...document.querySelectorAll<HTMLElement>(
      "[role=alert],.error-message,.validation-error",
    ),
  ]
    .filter(visible)
    .map(label)
    .filter(Boolean);
  // App Store Connect marks form errors only with text: a banner plus a plain
  // message under each field. Report the innermost field message, not the banner.
  const problem =
    /already|not available|invalid|required|must|can't|cannot|isn't|not allowed/i;
  const formErrors =
    dialog && /one or more validation errors/i.test(dialog.textContent ?? "")
      ? [...dialog.querySelectorAll<HTMLElement>("*")]
          .filter(
            (el) =>
              visible(el) &&
              problem.test(el.textContent ?? "") &&
              !/one or more validation errors/i.test(el.textContent ?? "") &&
              ![...el.children].some((child) =>
                problem.test(child.textContent ?? ""),
              ),
          )
          .map((el) => norm(el.textContent ?? ""))
      : [];
  const error =
    formErrors[0] ??
    alerts.find((text) =>
      /error|failed|invalid|already|not available|not allowed|permission|must|taken/i.test(
        text,
      ),
    ) ??
    (dialog && /one or more validation errors/i.test(dialog.textContent ?? "")
      ? "The provider rejected the form. Review the highlighted fields."
      : undefined);
  if (target.mode === "capabilities") {
    const id = target.identifiers?.[target.capabilityIndex ?? 0] ?? "";
    const fields = inputs.some((el) =>
      /identifier|container id|group id/i.test(fieldName(el)),
    );
    if (fields && /Register|Create|Add/i.test(dialog?.innerText ?? body))
      return {
        phase: "identifier-register",
        ready: value(/identifier|container id|group id/i, id),
        error,
      };
    if (
      dialog &&
      has(/^Confirm$/i) &&
      /Modify|capabilit|provisioning/i.test(dialog.innerText)
    )
      return {
        phase: "capabilities",
        ready: true,
        confirmCapabilities: true,
        error,
      };
    if (
      dialog &&
      /iCloud|App Groups|containers|groups/i.test(dialog.innerText)
    ) {
      const rows = [
        ...dialog.querySelectorAll<HTMLElement>(
          "tr,[role=row],label,[role=option]",
        ),
      ]
        .filter(visible)
        .filter((el) =>
          new RegExp(
            "(^|\\s)" + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|\\s)",
          ).test(label(el)),
        );
      const selectedRow = rows.some((row) =>
        [
          ...row.querySelectorAll<HTMLInputElement>(
            "input[type=checkbox],[role=checkbox]",
          ),
        ].some(
          (el) => el.checked || el.getAttribute("aria-checked") === "true",
        ),
      );
      return {
        phase: "identifier-picker",
        capabilityReady: rows.length > 0,
        existingAssignment: selectedRow,
        canCreateIdentifier: has(
          /^(?:Create|Register|Add)(?: new)?(?: iCloud)?(?: container| group)?$/i,
        ),
        error,
      };
    }
    if (
      /\/bundleId\/edit\//i.test(location.pathname) ||
      /Edit your App ID|Edit.*App ID Configuration|Capabilities/i.test(body)
    )
      return {
        phase: "capabilities",
        ready: body.includes(target.identity),
        error,
      };
    return { phase: "unknown", error };
  }
  if (location.hostname === "appstoreconnect.apple.com") {
    if (dialog && /New App/i.test(dialog.innerText)) {
      // User Access decides which team members can see the app, so it is the
      // person's choice. Apple keeps Create disabled until it is made.
      const access = [
        ...dialog.querySelectorAll<HTMLInputElement>("input[type=radio]"),
      ].filter(
        (el) =>
          /useraccess/i.test(el.name) ||
          /^(?:Limited|Full) Access$/i.test(
            norm([...(el.labels ?? [])].map((l) => l.textContent).join(" ")),
          ),
      );
      const create = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
        .filter(visible)
        .find((el) => /^Create$/i.test(label(el)));
      return {
        phase: "apple-form",
        missing:
          access.length && !access.some((el) => el.checked)
            ? ["User Access"]
            : [],
        createDisabled: !!create && create.disabled,
        ready:
          value(/^name|app name/i, target.appName) &&
          value(/sku/i, target.sku || target.identity) &&
          inputs.some(
            (el) =>
              /bundle id/i.test(fieldName(el)) &&
              (
                (el instanceof HTMLSelectElement
                  ? el.selectedOptions[0]?.textContent
                  : el.value) ?? ""
              ).includes(target.identity),
          ) &&
          inputs.some(
            (el) =>
              /primary language/i.test(fieldName(el)) &&
              (el.value === target.language ||
                /English.*(?:U\.S\.|United States)/i.test(
                  (el as any).selectedOptions?.[0]?.textContent ?? "",
                )),
          ) &&
          selected(/^iOS$/i),
        error,
      };
    }
    if (appId) return { phase: "app", appId, created: true, error };
    if (/\/apps(?:\/|$)/.test(location.pathname))
      return { phase: "apple-list", error };
  }
  if (location.hostname === "play.google.com") {
    if (!developerId) return { phase: "google-accounts", error };
    if (
      /create-app|createApp/.test(location.pathname) ||
      inputs.some((el) => /^app name$/i.test(fieldName(el)))
    )
      return {
        phase: "google-form",
        developerId,
        ready:
          value(/^app name$/i, target.appName) &&
          selected(target.appType === "game" ? /^Game$/i : /^App$/i) &&
          selected(target.pricing === "paid" ? /^Paid$/i : /^Free$/i) &&
          (inputs.some(
            (el) =>
              /language/i.test(fieldName(el)) && el.value === target.language,
          ) ||
            has(new RegExp(target.language.replace("-", "[-– ]"), "i"))),
        error,
      };
    const rows = [
      ...document.querySelectorAll<HTMLElement>(
        "tr,[role=row],[role=listitem],.app-card",
      ),
    ].filter(visible);
    const hits = rows.filter((row) => row.innerText.includes(target.identity));
    const nameHits = rows.filter((row) =>
      norm(row.innerText).includes(target.appName),
    );
    const candidates = hits.length ? hits : target.newApp ? nameHits : [];
    const appLinks =
      candidates.length === 1
        ? [
            ...candidates[0].querySelectorAll<HTMLAnchorElement>("a[href]"),
          ].filter((a) => /\/app\/\d+/.test(a.pathname))
        : [];
    const appUrl = [...new Set(appLinks.map((a) => a.href))];
    // Play's Test and release page links the track from a generic "Get started"
    // card button, so recognize the internal track by its path as well.
    const internal = [
      ...new Set(
        links
          .filter(
            (el) =>
              /^Internal testing$/i.test(label(el)) ||
              /\/app\/\d+\/(?:tracks\/internal-testing|testing\/internal)(?:\/|$)/.test(
                el.pathname,
              ),
          )
          .map((el) => el.href),
      ),
    ];
    const internalUrl = internal.length === 1 ? internal[0] : undefined;
    if (!appId)
      return {
        phase: "google-list",
        developerId,
        appUrl: appUrl.length === 1 ? appUrl[0] : undefined,
        error,
      };
    if (target.mode === "record")
      return {
        phase: "app",
        developerId,
        appId,
        created: true,
        identityMatches,
        error,
      };
    // Play keeps an aria-hidden splash progress bar on every page; only count
    // progress shown to people.
    const uploading =
      /uploading|processing.*(?:bundle|upload)|upload.*in progress/i.test(
        body,
      ) ||
      [...document.querySelectorAll("[role=progressbar]")].some(
        (el) => visible(el) && !el.closest("[aria-hidden=true]"),
      );
    const internalEditor = [
      ...document.querySelectorAll<HTMLElement>("h1,h2,[role=heading]"),
    ]
      .filter(visible)
      .some((el) => /internal testing release/i.test(el.textContent ?? ""));
    const draftEditable = controls.some(
      (el) =>
        /^Edit release$/i.test(label(el)) &&
        !el.hasAttribute("disabled") &&
        el.getAttribute("aria-disabled") !== "true",
    );
    const version = target.artifact?.buildNumber;
    const versionRx = version
      ? new RegExp("(^|[^0-9])" + version + "([^0-9]|$)")
      : /a^/;
    const uploaded =
      !!version &&
      rows.some(
        (row) =>
          versionRx.test(row.innerText) &&
          /App bundle|Android App Bundle|\.aab|Version code/i.test(
            row.innerText,
          ),
      );
    const draftSaved =
      !!version &&
      !/\/releases?\/(?:new|create|[^/]+\/edit)(?:\/|$)/i.test(
        location.pathname,
      ) &&
      !uploading &&
      !has(/^(?:Save|Save as draft|Save draft)$/i) &&
      rows.some(
        (row) => versionRx.test(row.innerText) && /Draft/i.test(row.innerText),
      );
    // The release editor also has an OBB expansion-file input without an
    // accept list; when an input names .aab, only those count.
    const fileInputs = [
      ...document.querySelectorAll<HTMLInputElement>("input[type=file]"),
    ].filter((el) => !el.disabled);
    const bundleInputs = fileInputs.filter((el) => /aab/i.test(el.accept));
    const files = bundleInputs.length
      ? bundleInputs
      : fileInputs.filter(
          (el) => !el.accept || /octet-stream|zip/i.test(el.accept),
        );
    if (uploading)
      return {
        phase: "uploading",
        developerId,
        appId,
        internalUrl,
        internalEditor,
        error,
      };
    if (
      files.length ||
      has(
        /^Create new release$|^Create release$|^Save as draft$|^Save draft$/i,
      ) ||
      draftEditable ||
      uploaded ||
      draftSaved
    )
      return {
        phase: "release",
        developerId,
        appId,
        internalUrl,
        internalEditor,
        draftEditable,
        fileInputs: files.length,
        uploaded,
        draftSaved,
        error,
      };
    return {
      phase: "app",
      developerId,
      appId,
      internalUrl,
      created: true,
      identityMatches,
      error,
    };
  }
  return {
    phase: /loading|please wait/i.test(body) ? "loading" : "unknown",
    error,
  };
}
export function performStoreAction(
  action: StoreAction,
  target: StoreSetupState,
): { done: boolean; detail?: string } {
  if (
    /^(?:accounts\.google\.com|idmsa\.apple\.com|appleid\.apple\.com|account\.apple\.com)$/.test(
      location.hostname,
    ) ||
    document.querySelector(
      "input[type=password],input[autocomplete=one-time-code]",
    )
  )
    return { done: false, detail: "Sign-in remains in the provider page." };
  const visible = (el: Element) =>
    !!(
      (el as HTMLElement).offsetWidth ||
      (el as HTMLElement).offsetHeight ||
      el.getClientRects().length
    );
  const norm = (v: string) => v.replace(/\s+/g, " ").trim();
  const label = (el: Element) => {
    const clone = el.cloneNode(true) as Element;
    clone
      .querySelectorAll("[aria-hidden=true],svg,material-icon,.pc-help-text")
      .forEach((e) => e.remove());
    return norm(
      (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim() ||
        el.getAttribute("aria-label") ||
        clone.textContent ||
        (el instanceof HTMLInputElement
          ? [...(el.labels ?? [])].map((item) => item.textContent).join(" ")
          : "") ||
        "",
    );
  };
  const controls = [
    ...document.querySelectorAll<HTMLElement>(
      "button,a,[role=button],[role=tab],[role=menuitem]",
    ),
  ].filter(visible);
  const click = (rx: RegExp, scope: ParentNode = document) => {
    let hits = controls.filter(
      (el) =>
        scope.contains(el) &&
        rx.test(label(el)) &&
        !el.hasAttribute("disabled") &&
        el.getAttribute("aria-disabled") !== "true",
    );
    hits = hits.filter(
      (el) => !hits.some((other) => other !== el && el.contains(other)),
    );
    // A menu trigger often shares its item's label (App Store Connect's "+" is
    // aria-labelled "New App"). Once that menu is open, its item is the target.
    const inMenu = hits.filter((el) =>
      el.closest("[role=menu],[role=menuitem]"),
    );
    if (hits.length > 1 && inMenu.length === 1) hits = inMenu;
    if (hits.length !== 1)
      return {
        done: false,
        detail:
          !hits.length &&
          controls.some((el) => scope.contains(el) && rx.test(label(el)))
            ? "The provider's button is still disabled. Complete the remaining required choices on the page. No action was taken."
            : hits.length
              ? "The expected enabled control was not unique. No action was taken."
              : "The expected control was not found on the page. No action was taken.",
      };
    hits[0].click();
    return { done: true };
  };
  const dialog = [
    ...document.querySelectorAll<HTMLElement>(
      "dialog,[role=dialog],[aria-modal=true],.modal-dialog",
    ),
  ]
    .filter(visible)
    .at(-1);
  const inputs = [
    ...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "input:not([type=hidden]):not([type=password]),select",
    ),
  ].filter(visible);
  const fieldName = (el: HTMLInputElement | HTMLSelectElement) =>
    norm(
      [
        el.getAttribute("aria-label"),
        el.name,
        el.id,
        ...(el.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent),
        ...[...(el.labels ?? [])].map((l) => l.textContent),
      ]
        .filter(Boolean)
        .join(" "),
    );
  const fill = (rx: RegExp, value: string) => {
    const hits = inputs.filter((el) => rx.test(fieldName(el)));
    if (hits.length !== 1) return false;
    const el = hits[0];
    if (el instanceof HTMLSelectElement) {
      const opts = [...el.options].filter(
        (o) => o.value === value || o.textContent?.includes(value),
      );
      if (opts.length !== 1) return false;
      el.value = opts[0].value;
    } else
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  };
  const check = (rx: RegExp, scope: ParentNode = document) => {
    const hits = [
      ...scope.querySelectorAll<HTMLInputElement>(
        "input[type=checkbox],input[type=radio],[role=checkbox],[role=radio]",
      ),
    ]
      .filter(visible)
      .filter((el) =>
        rx.test(
          label(el) || fieldName(el) || el.closest("label")?.textContent || "",
        ),
      );
    if (hits.length !== 1) return false;
    const el = hits[0];
    if (!el.checked && el.getAttribute("aria-checked") !== "true") el.click();
    return true;
  };
  const id = target.identifiers?.[target.capabilityIndex ?? 0] ?? "";
  switch (action) {
    case "select-account": {
      const choices = [
        ...document.querySelectorAll<HTMLElement>(
          "[role=listbox] [role=option]",
        ),
      ].filter(visible);
      if (choices.length !== 1)
        return {
          done: false,
          detail: "Choose the intended developer account.",
        };
      choices[0].click();
      return { done: true };
    }
    case "new-app":
      return click(/^New App$|^Create app$|^Add app$|^Add$|^Add new app$/i);
    case "fill-app": {
      const name = fill(/^name|app name/i, target.appName);
      if (target.provider === "apple") {
        const sku = fill(/sku/i, target.sku || target.identity);
        const bundle = fill(/bundle id/i, target.identity);
        const language = fill(/primary language/i, target.language);
        const ios = check(/^iOS$/i);
        return {
          done: name && sku && bundle && language && ios,
          detail:
            "Preparing name, iOS, language, SKU and exact bundle ID. Review any remaining required choice.",
        };
      }
      fill(/package name/i, target.identity); // Newer Play forms can collect the package before the first upload.
      const kind = check(target.appType === "game" ? /^Game$/i : /^App$/i);
      const pricing = check(target.pricing === "paid" ? /^Paid$/i : /^Free$/i);
      const language = fill(/(?:default )?language/i, target.language);
      if (!language) {
        const options = [
          ...document.querySelectorAll<HTMLElement>("[role=option]"),
        ]
          .filter(visible)
          .filter((el) => label(el).includes(target.language));
        if (options.length === 1) {
          options[0].click();
          return { done: true };
        }
        const choice = click(
          /^Default language$|^Select (?:default )?language$/i,
        );
        if (choice.done) return choice;
      }
      return {
        done: name && kind && pricing && language,
        detail:
          "Review language and required declarations on the provider page. Agreements are never accepted automatically.",
      };
    }
    case "create-app":
      return click(
        target.provider === "apple" ? /^Create$/i : /^Create app$/i,
        dialog ?? document,
      );
    case "open-app":
      return {
        done: false,
        detail: "Open the intended app from the app list.",
      };
    case "open-internal":
      return click(/^Internal testing$/i);
    case "open-testing":
      return click(/^Test and release$|^Testing$/i);
    case "new-release": {
      // The header button and the empty-state link do the same thing.
      const header = document.querySelector<HTMLElement>(
        "[debug-id=create-android-release-button]:not([disabled])",
      );
      if (header && visible(header)) {
        header.click();
        return { done: true };
      }
      return click(/^Create new release$|^Create release$/i);
    }
    case "edit-release":
      return click(/^Edit release$/i);
    case "save-draft":
      return click(/^Save as draft$|^Save draft$|^Save$/i);
    case "configure-capability": {
      const kind = id.startsWith("iCloud.") ? /^iCloud$/i : /^App Groups$/i;
      const rows = [
        ...document.querySelectorAll<HTMLElement>(
          "tr,[role=row],section,.capability",
        ),
      ]
        .filter(visible)
        .filter((el) =>
          [...el.querySelectorAll("label,span,h3,h4")].some((item) =>
            kind.test(norm(item.textContent ?? "")),
          ),
        );
      const row = rows.filter(
        (el) => !rows.some((other) => other !== el && el.contains(other)),
      );
      if (row.length !== 1)
        return {
          done: false,
          detail: "Locate the capability for this exact App ID.",
        };
      const enabled = check(kind, row[0]);
      const configure = click(/^Configure$|^Edit$/i, row[0]);
      return configure.done ? configure : { done: enabled };
    }
    case "new-identifier":
      return click(
        /^(?:Create|Register|Add)(?: new)?(?: iCloud)?(?: container| group)?$/i,
        dialog ?? document,
      );
    case "fill-identifier":
      return {
        done:
          fill(/identifier|container id|group id/i, id) &&
          fill(/description|name/i, id.replace(/[^A-Za-z0-9 ._-]/g, " ")),
      };
    case "register-identifier":
      return click(/^Register$|^Create$/i, dialog ?? document);
    case "apply-identifier": {
      if (!dialog) return { done: false };
      const rows = [
        ...dialog.querySelectorAll<HTMLElement>(
          "tr,[role=row],label,[role=option]",
        ),
      ]
        .filter(visible)
        .filter((el) =>
          norm(el.textContent ?? "")
            .split(/\s+/)
            .includes(id),
        );
      const leaf = rows.filter(
        (el) => !rows.some((other) => other !== el && el.contains(other)),
      );
      if (leaf.length !== 1) return { done: false };
      const boxes = [
        ...leaf[0].querySelectorAll<HTMLInputElement>(
          "input[type=checkbox],[role=checkbox]",
        ),
      ];
      if (boxes.length !== 1) return { done: false };
      if (
        !boxes[0].checked &&
        boxes[0].getAttribute("aria-checked") !== "true"
      ) {
        boxes[0].click();
        return { done: true };
      }
      return click(/^Continue$|^Save$|^Apply$/i, dialog);
    }
    case "save-capabilities":
      return click(/^Save$|^Continue$/i);
    case "confirm-capabilities":
      return dialog ? click(/^Confirm$|^Save$/i, dialog) : { done: false };
  }
}

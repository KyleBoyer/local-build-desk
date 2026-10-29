export interface GoogleProbe {
  phase:
    | "signed-out"
    | "login"
    | "blocked-login"
    | "terms"
    | "policy"
    | "project-create"
    | "api"
    | "service-list"
    | "service-create"
    | "service-details"
    | "service-grants"
    | "key-dialog"
    | "play-accounts"
    | "play-apps"
    | "play-create"
    | "play-users"
    | "play-user"
    | "play-app-select"
    | "play-permissions"
    | "play-invite"
    | "play-invite-confirm"
    | "unknown";
  cloudProject?: string;
  developerId?: string;
  accountUrl?: string;
  singleAccountOption?: boolean;
  serviceUrl?: string;
  servicePresent?: boolean;
  serviceMenuOpen?: boolean;
  keyMenuOpen?: boolean;
  apiEnabled?: boolean;
  targetUserPresent?: boolean;
  /** On an existing user's page: the target app is in its app permissions. */
  targetAppGranted?: boolean;
  /** On an existing user's page: there are unsaved permission changes. */
  saveEnabled?: boolean;
  targetAppPresent?: boolean;
  appScoped?: boolean;
  permissionsReady?: boolean;
  permissionsEditorAvailable?: boolean;
  unsafePermissions?: boolean;
  formReady?: boolean;
  error?: string;
}
export interface GoogleTarget {
  cloudProject: string;
  email: string;
  packageName: string;
  appName: string;
}
export type GoogleActionType =
  | "select-developer"
  | "sign-in"
  | "fill-project"
  | "create-project"
  | "enable-api"
  | "open-service-create"
  | "fill-service"
  | "create-service"
  | "finish-service"
  | "open-keys"
  | "add-key"
  | "new-key"
  | "select-json"
  | "create-key"
  | "open-users"
  | "open-invite"
  | "fill-invite"
  | "open-apps"
  | "select-app"
  | "apply-app"
  | "select-permissions"
  | "open-permissions"
  | "apply-permissions"
  | "invite"
  | "confirm-invite"
  | "open-add-app"
  | "save-user"
  | "open-play-create"
  | "fill-play-create";
export interface GoogleAction {
  type: GoogleActionType;
  target: GoogleTarget;
}
export interface GoogleActionResult {
  done: boolean;
  detail?: string;
  candidates?: string[];
}
// These functions run in the sandboxed provider view, with no Node or credential access.
export function inspectGooglePage(target: GoogleTarget): GoogleProbe {
  const visible = (el: Element) =>
    !!(
      (el as HTMLElement).offsetWidth ||
      (el as HTMLElement).offsetHeight ||
      el.getClientRects().length
    );
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const label = (el: Element) => {
    const labelled = (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    const clone = el.cloneNode(true) as Element;
    clone
      .querySelectorAll("[aria-hidden=true],material-icon,[role=img],svg")
      .forEach((icon) => icon.remove());
    return clean(
      labelled || el.getAttribute("aria-label") || clone.textContent || "",
    );
  };
  const controls = [
    ...document.querySelectorAll<HTMLElement>(
      "button,a,[role=button],[role=tab],[role=menuitem]",
    ),
  ].filter(visible);
  if (
    location.hostname === "accounts.google.com" ||
    [
      ...document.querySelectorAll(
        "input[type=password],input[autocomplete=one-time-code]",
      ),
    ].some(visible)
  ) {
    const body = document.body?.innerText ?? "";
    return {
      phase:
        /browser or app may not be secure|disallowed_useragent|unsupported browser/i.test(
          body,
        )
          ? "blocked-login"
          : "login",
    };
  }
  const body = clean((document.body?.innerText ?? "").slice(0, 200000));
  const cloudProject =
    new URL(location.href).searchParams.get("project") ?? undefined;
  const developerId = location.pathname.match(/\/developers\/(\d+)/)?.[1];
  if (
    /service[- ]account key creation (?:is|has been) (?:disabled|blocked)|(?:not allowed|not permitted) to create (?:service[- ]account )?keys|organization policy (?:that )?(?:blocks|prevents|disables|does not allow) (?:the )?(?:creation of )?service[- ]account key/i.test(
      body,
    )
  )
    return { phase: "policy", cloudProject };
  if (
    /accept.*(?:terms of service|developer distribution agreement)|agree and continue|review and accept.*agreement/i.test(
      body,
    ) &&
    [...document.querySelectorAll("input[type=checkbox],[role=checkbox]")].some(
      visible,
    )
  )
    return { phase: "terms", cloudProject, developerId };
  const dialog = [
    ...document.querySelectorAll<HTMLElement>(
      "[role=dialog],dialog,[aria-modal=true]",
    ),
  ]
    .filter(visible)
    .at(-1);
  const inputs = [
    ...document.querySelectorAll<HTMLInputElement>(
      "input:not([type=hidden]),textarea",
    ),
  ].filter(visible);
  const namedInput = (rx: RegExp) =>
    inputs.some((input) =>
      rx.test(
        clean(
          [
            input.getAttribute("aria-label"),
            input.name,
            input.id,
            ...[...(input.labels ?? [])].map((l) => l.textContent),
          ].join(" "),
        ),
      ),
    );
  if (
    location.hostname === "console.cloud.google.com" &&
    controls.some((el) =>
      /^Sign (?:in|into)(?: to)? Google(?: Cloud)?(?: Platform)?$/i.test(
        label(el),
      ),
    )
  )
    return { phase: "signed-out", cloudProject };
  const serviceEmailPresent =
    !!target.email &&
    (body.includes(target.email) ||
      inputs.some(
        (input) =>
          /email/i.test(
            [
              input.getAttribute("aria-label"),
              input.name,
              input.id,
              ...[...(input.labels ?? [])].map((label) => label.textContent),
            ].join(" "),
          ) && input.value === target.email,
      ));
  if (location.hostname === "console.cloud.google.com") {
    if (dialog && /key type|private key|JSON.*P12/i.test(dialog.innerText))
      return {
        phase: "key-dialog",
        cloudProject,
        servicePresent: serviceEmailPresent,
        formReady: [
          ...dialog.querySelectorAll<HTMLElement>(
            "input[type=radio],[role=radio]",
          ),
        ].some(
          (el) =>
            (el instanceof HTMLInputElement
              ? el.checked
              : el.getAttribute("aria-checked") === "true") &&
            /JSON/i.test(
              el.getAttribute("aria-label") ??
                el.closest("label")?.textContent ??
                (el instanceof HTMLInputElement
                  ? [...(el.labels ?? [])].map((l) => l.textContent).join(" ")
                  : (el.textContent ?? "")),
            ),
        ),
      };
    if (/\/projectcreate/.test(location.pathname))
      return {
        phase: "project-create",
        cloudProject,
        formReady:
          namedInput(/project.*name/i) &&
          inputs.some((input) => input.value === target.cloudProject),
      };
    if (/\/apis\/(?:library|api)\//.test(location.pathname))
      return {
        phase: "api",
        cloudProject,
        apiEnabled:
          controls.some((e) =>
            /^Manage(?: (?:this )?API)?$|^Disable API$/i.test(label(e)),
          ) || /API enabled|Status Enabled/i.test(body),
      };
    if (
      /\/serviceaccounts\/create/.test(location.pathname) &&
      controls.some((e) => /^Done$/i.test(label(e))) &&
      !namedInput(/service.?account.?name/i)
    )
      return {
        phase: "service-grants",
        cloudProject,
        unsafePermissions: [
          ...document.querySelectorAll<HTMLElement>(
            "mat-chip,[role=option][aria-selected=true]",
          ),
        ]
          .filter(visible)
          .some((el) => /Owner|Editor|Admin/i.test(el.innerText)),
      };
    if (/\/serviceaccounts\/create/.test(location.pathname))
      return {
        phase: "service-create",
        cloudProject,
        formReady:
          inputs.some((input) => input.value === "local-build-desk") &&
          inputs.some((input) => input.value === "Local Build Desk"),
      };
    if (/\/serviceaccounts\/details\//.test(location.pathname))
      return {
        phase: "service-details",
        cloudProject,
        servicePresent: serviceEmailPresent,
        keyMenuOpen: controls.some((el) => /^Create new key$/i.test(label(el))),
      };
    if (/\/serviceaccounts/.test(location.pathname)) {
      const rows = [
        ...document.querySelectorAll<HTMLElement>("tr,[role=row]"),
      ].filter(visible);
      const row = rows.find(
        (row) => !!target.email && row.innerText.includes(target.email),
      );
      const links = [
        ...(row ?? document).querySelectorAll<HTMLAnchorElement>("a[href]"),
      ].filter(visible);
      const service = links.find(
        (link) =>
          /\/serviceaccounts\/details\//.test(link.href) &&
          (row || label(link) === target.email),
      );
      return {
        phase: "service-list",
        cloudProject,
        servicePresent: !!row,
        serviceUrl: service?.href,
        serviceMenuOpen: controls.some((element) =>
          /^Create service account$/i.test(label(element)),
        ),
      };
    }
  }
  if (location.hostname === "play.google.com") {
    const checks = [
      ...document.querySelectorAll<HTMLElement>(
        "input[type=checkbox],[role=checkbox]",
      ),
    ].filter(visible);
    const checked = (el: HTMLElement) =>
      el instanceof HTMLInputElement
        ? el.checked
        : el.getAttribute("aria-checked") === "true";
    const checkLabel = (el: HTMLElement) => {
      const text = (node: Element | null) => {
        if (!node) return "";
        const clone = node.cloneNode(true) as Element;
        clone
          .querySelectorAll(
            ".pc-help-text,[aria-hidden=true],material-icon,svg",
          )
          .forEach((help) => help.remove());
        return clone.textContent ?? "";
      };
      const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/);
      return clean(
        ids
          .map((id) => text(document.getElementById(id)))
          .join(" ")
          .trim() ||
          el.getAttribute("aria-label") ||
          (el instanceof HTMLInputElement
            ? [...(el.labels ?? [])].map(text).join(" ")
            : "") ||
          text(el.closest("label")) ||
          text(el),
      );
    };
    const appTab = controls.find(
      (el) =>
        el.getAttribute("role") === "tab" &&
        /^App permissions$/i.test(label(el)),
    );
    const allowed =
      /^(?:View app information(?:\s*\(read.only\))?(?: and download bulk reports)?|Release apps to testing tracks)(?:\s|$)/i;
    const unsafe = checks.some(
      (el) =>
        checked(el) &&
        /admin|all apps|account permissions|financial|production|manage.*users/i.test(
          checkLabel(el),
        ),
    );
    const appScope = [
      ...document.querySelectorAll<HTMLElement>(
        "tr,[role=row],section,[role=group],article",
      ),
    ]
      .filter(visible)
      .filter((el) => el.innerText.includes(target.packageName))
      .at(-1);
    const packagePattern = /\b[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)+\b/g;
    const packages = (element: HTMLElement) => {
      // Material layouts can concatenate adjacent labels in innerText. Keep
      // text-node boundaries so a package followed by “View…” stays exact.
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const parts: string[] = [];
      while (walker.nextNode())
        parts.push(walker.currentNode.textContent ?? "");
      return [
        ...new Set(
          parts
            .join(" ")
            .replace(/\S+@\S+/g, "")
            .match(packagePattern) ?? [],
        ),
      ];
    };
    const siblingApps = [
      ...document.querySelectorAll<HTMLElement>("section,[role=group],article"),
    ]
      .filter(visible)
      .some(
        (element) =>
          appScope &&
          element !== appScope &&
          !element.contains(appScope) &&
          !appScope.contains(element) &&
          packages(element).some((value) => value !== target.packageName),
      );
    const otherAppRows = [
      ...document.querySelectorAll<HTMLElement>("tr,[role=row]"),
    ]
      .filter(visible)
      .some(
        (row) =>
          !row.innerText.includes(target.packageName) &&
          packages(row).some((value) => value !== target.packageName),
      );
    const appScoped =
      !!appScope &&
      !otherAppRows &&
      !siblingApps &&
      packages(appScope).every((value) => value === target.packageName) &&
      (!appTab || appTab.getAttribute("aria-selected") === "true") &&
      !/all apps/i.test(appScope.innerText) &&
      !checks.some((el) => checked(el) && /all apps/i.test(checkLabel(el)));
    const permissionDialog =
      !!dialog && /^Permissions for\s/i.test(dialog.innerText.trim());
    const derivedRead = (el: HTMLElement) =>
      el.hasAttribute("disabled") &&
      /^View app quality information\s*\(read.only\)/i.test(checkLabel(el));
    const permissionsReady =
      (appScoped || permissionDialog) &&
      checks.some(
        (el) => checked(el) && /^View app information/i.test(checkLabel(el)),
      ) &&
      checks.some(
        (el) =>
          checked(el) &&
          /^Release apps to testing tracks/i.test(checkLabel(el)),
      ) &&
      !checks.some(
        (el) =>
          checked(el) &&
          !allowed.test(checkLabel(el)) &&
          !derivedRead(el) &&
          !checkLabel(el).includes(target.packageName),
      );
    if (permissionDialog)
      return {
        phase: "play-permissions",
        developerId,
        permissionsReady,
        unsafePermissions: unsafe,
      };
    const picker =
      dialog && /Select apps|Add apps|Choose apps/i.test(dialog.innerText)
        ? dialog
        : [...document.querySelectorAll<HTMLElement>("[role=listbox]")]
            .filter(visible)
            .find((el) => /Apps to select from/i.test(label(el)));
    if (picker) {
      const rows = [
        ...picker.querySelectorAll<HTMLElement>("tr,[role=row],[role=option]"),
      ].filter(visible);
      const targetRow = rows.find((row) =>
        row.innerText.includes(target.packageName),
      );
      return {
        phase: "play-app-select",
        developerId,
        targetAppPresent:
          !!targetRow &&
          [
            ...targetRow.querySelectorAll<HTMLElement>(
              "input[type=checkbox],[role=checkbox]",
            ),
          ].some(checked),
        unsafePermissions: rows.some(
          (row) =>
            !row.innerText.includes(target.packageName) &&
            packages(row).some((value) => value !== target.packageName) &&
            [
              ...row.querySelectorAll<HTMLElement>(
                "input[type=checkbox],[role=checkbox]",
              ),
            ].some(checked),
        ),
      };
    }
    if (
      dialog &&
      /Send invite\?/i.test(dialog.innerText) &&
      dialog.innerText.includes(target.email)
    )
      return {
        phase: "play-invite-confirm",
        developerId,
        appScoped,
        unsafePermissions: unsafe,
      };
    if (
      /create-app|createApp/.test(location.pathname) ||
      namedInput(/^app name$/i)
    )
      return { phase: "play-create", developerId };
    if (
      inputs.some(
        (input) =>
          input.type === "email" ||
          /email address/i.test(input.getAttribute("aria-label") ?? ""),
      ) &&
      controls.some((e) => /^Invite user$/i.test(label(e)))
    )
      return {
        phase: "play-invite",
        developerId,
        appScoped,
        permissionsReady,
        permissionsEditorAvailable:
          appScoped &&
          controls.some((el) => /^Manage permissions$/i.test(label(el))),
        unsafePermissions: unsafe,
        formReady: inputs.some((input) => input.value === target.email),
      };
    // An existing user's own page: app access is added there with Add app and
    // saved with Save changes, keeping access to the user's other apps.
    const userPage = location.pathname.match(
      /\/users-and-permissions\/([^/]+)\/?$/,
    );
    if (
      userPage &&
      decodeURIComponent(userPage[1]).toLowerCase() ===
        target.email.toLowerCase()
    )
      return {
        phase: "play-user",
        developerId,
        targetAppGranted: [
          ...document.querySelectorAll<HTMLElement>("tr,[role=row]"),
        ]
          .filter(visible)
          .some((row) => row.innerText.includes(target.packageName)),
        saveEnabled: controls.some(
          (el) =>
            /^Save changes$/i.test(label(el)) &&
            !el.hasAttribute("disabled") &&
            el.getAttribute("aria-disabled") !== "true",
        ),
      };
    if (
      /users-and-permissions|usersAndPermissions/i.test(location.pathname) ||
      controls.some((e) => /^Invite new users?$/i.test(label(e)))
    )
      return {
        phase: "play-users",
        developerId,
        targetUserPresent: [
          ...document.querySelectorAll<HTMLElement>("tr,[role=row]"),
        ]
          .filter(visible)
          .some((row) => row.innerText.includes(target.email)),
      };
    if (!developerId) {
      const links = controls.filter(
        (el): el is HTMLAnchorElement =>
          el instanceof HTMLAnchorElement &&
          /\/developers\/\d+/.test(el.pathname),
      );
      const urls = [...new Set(links.map((link) => link.href))];
      return {
        phase: "play-accounts",
        accountUrl: urls.length === 1 ? urls[0] : undefined,
        singleAccountOption:
          !urls.length &&
          [...document.querySelectorAll("[role=listbox] [role=option]")].filter(
            visible,
          ).length === 1,
      };
    }
    return {
      phase: "play-apps",
      developerId,
      targetAppPresent: body.includes(target.packageName),
    };
  }
  return { phase: "unknown", cloudProject, developerId };
}
export function performGoogleAction(action: GoogleAction): GoogleActionResult {
  const target = action.target;
  if (
    !["console.cloud.google.com", "play.google.com"].includes(location.hostname)
  )
    return {
      done: false,
      detail:
        "Waiting for the provider page. Login fields are never automated.",
    };
  const visible = (el: Element) =>
    !!(
      (el as HTMLElement).offsetWidth ||
      (el as HTMLElement).offsetHeight ||
      el.getClientRects().length
    );
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const name = (el: Element) => {
    const labelled = (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    const clone = el.cloneNode(true) as Element;
    clone
      .querySelectorAll("[aria-hidden=true],material-icon,[role=img],svg")
      .forEach((icon) => icon.remove());
    return norm(
      labelled || el.getAttribute("aria-label") || clone.textContent || "",
    );
  };
  const controls = [
    ...document.querySelectorAll<HTMLElement>(
      "button,a,[role=button],[role=tab],[role=menuitem]",
    ),
  ].filter(visible);
  const dialog = [
    ...document.querySelectorAll<HTMLElement>(
      "[role=dialog],dialog,[aria-modal=true]",
    ),
  ]
    .filter(visible)
    .at(-1);
  const click = (
    rx: RegExp,
    scope: ParentNode = document,
  ): GoogleActionResult => {
    let hits = controls.filter(
      (el) =>
        scope.contains(el) &&
        rx.test(name(el)) &&
        !el.hasAttribute("disabled") &&
        el.getAttribute("aria-disabled") !== "true",
    );
    hits = hits.filter(
      (element) =>
        !hits.some((other) => other !== element && element.contains(other)),
    );
    if (hits.length !== 1)
      return {
        done: false,
        detail: "No unique enabled control matched.",
        candidates: hits.slice(0, 8).map(name),
      };
    hits[0].click();
    return { done: true };
  };
  const inputs = [
    ...document.querySelectorAll<HTMLInputElement>(
      "input:not([type=hidden]):not([type=password]),textarea",
    ),
  ].filter(visible);
  const inputLabel = (el: HTMLInputElement) =>
    norm(
      [
        el.getAttribute("aria-label"),
        ...(el.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent),
        el.type === "email" ? "email" : "",
        el.name,
        el.id,
        ...[...(el.labels ?? [])].map((l) => l.textContent),
      ]
        .filter(Boolean)
        .join(" "),
    );
  const fill = (rx: RegExp, value: string) => {
    const hits = inputs.filter((el) => rx.test(inputLabel(el)));
    if (hits.length !== 1) return false;
    const el = hits[0];
    const setter = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  };
  const check = (rx: RegExp, scope: ParentNode = document) => {
    const labelText = (el: Element | null) => {
      if (!el) return "";
      const clone = el.cloneNode(true) as Element;
      clone
        .querySelectorAll(".pc-help-text,[aria-hidden=true],material-icon,svg")
        .forEach((help) => help.remove());
      return clone.textContent ?? "";
    };
    const hits = [
      ...scope.querySelectorAll<HTMLElement>(
        "input[type=checkbox],input[type=radio],[role=checkbox],[role=radio]",
      ),
    ]
      .filter(visible)
      .filter((el) =>
        rx.test(
          norm(
            (el.getAttribute("aria-labelledby") ?? "")
              .split(/\s+/)
              .map((id) => labelText(document.getElementById(id)))
              .join(" ")
              .trim() ||
              el.getAttribute("aria-label") ||
              (el instanceof HTMLInputElement
                ? [...(el.labels ?? [])].map(labelText).join(" ")
                : "") ||
              labelText(el.closest("label")) ||
              labelText(el),
          ),
        ),
      );
    if (hits.length !== 1) return false;
    const el = hits[0],
      checked =
        el instanceof HTMLInputElement
          ? el.checked
          : el.getAttribute("aria-checked") === "true";
    if (!checked) el.click();
    return true;
  };
  switch (action.type) {
    case "sign-in":
      return click(
        /^Sign (?:in|into)(?: to)? Google(?: Cloud)?(?: Platform)?$/i,
      );
    case "fill-project": {
      const named = fill(/project.?name/i, target.appName + " builds");
      const identified = fill(/project.?id/i, target.cloudProject);
      if (named && !identified) {
        const edit = click(/^Edit project ID$|^Edit$/i);
        if (edit.done) return edit;
      }
      return {
        done: named && identified,
        detail: identified
          ? undefined
          : "Project ID may need its Edit control opened.",
      };
    }
    case "create-project":
      return click(/^Create$/i);
    case "enable-api":
      return click(/^Enable(?: (?:this )?API)?$/i);
    case "open-service-create": {
      const direct = click(/^Create service account$/i);
      return direct.done
        ? direct
        : click(/^More actions(?: Service accounts)?$/i);
    }
    case "fill-service": {
      const a = fill(/service.?account.?name/i, "Local Build Desk");
      const b = fill(/service.?account.?(?:id|ID)/i, "local-build-desk");
      return { done: a && b };
    }
    case "create-service":
      return click(/^Create and continue$|^Create$/i);
    case "finish-service":
      return click(/^Done$/i);
    case "open-keys":
      return click(/^Keys$/i);
    case "add-key":
      return click(/^Add key$/i);
    case "new-key":
      return click(/^Create new key$/i);
    case "select-json":
      return { done: check(/^JSON(?:\s|$)/i, dialog ?? document) };
    case "create-key":
      return click(/^Create$/i, dialog ?? document);
    case "open-users":
      return click(/^Users and permissions$/i);
    case "open-invite":
      return click(/^Invite new users?$|^Invite user$/i);
    case "select-developer": {
      const choices = [
        ...document.querySelectorAll<HTMLElement>(
          "[role=listbox] [role=option]",
        ),
      ].filter(visible);
      if (choices.length !== 1)
        return {
          done: false,
          detail: "Choose the intended Google Play developer account.",
        };
      choices[0].click();
      return { done: true };
    }
    case "fill-invite":
      return { done: fill(/email/i, target.email) };
    case "open-apps": {
      const tab = controls.find(
        (el) =>
          el.getAttribute("role") === "tab" &&
          /^App permissions$/i.test(name(el)),
      );
      if (tab?.getAttribute("aria-selected") !== "true" && tab) {
        tab.click();
        return { done: true };
      }
      return click(/^Add app(?:s)?$/i);
    }
    case "select-app": {
      const picker =
        dialog ??
        [...document.querySelectorAll<HTMLElement>("[role=listbox]")]
          .filter(visible)
          .find((el) => /Apps to select from/i.test(name(el)));
      if (!picker) return { done: false };
      const rows = [
        ...picker.querySelectorAll<HTMLElement>(
          "tr,[role=row],[role=option],label",
        ),
      ]
        .filter(visible)
        .filter((el) => el.innerText.includes(target.packageName));
      if (rows.length !== 1)
        return {
          done: false,
          detail: "Choose the exact package in the app selector.",
        };
      const boxes = rows[0].querySelectorAll<HTMLElement>(
        "input[type=checkbox],[role=checkbox]",
      );
      if (boxes.length !== 1) return { done: false };
      const box = boxes[0];
      if (
        !(box instanceof HTMLInputElement
          ? box.checked
          : box.getAttribute("aria-checked") === "true")
      )
        box.click();
      return { done: true };
    }
    case "open-add-app":
      return click(/^Add app\b/i);
    case "save-user":
      return click(/^Save changes$/i);
    case "apply-app": {
      const picker =
        dialog ??
        [...document.querySelectorAll<HTMLElement>("[role=listbox]")]
          .filter(visible)
          .find((el) => /Apps to select from/i.test(name(el)));
      return click(/^Apply$|^Add$/i, picker?.parentElement ?? document);
    }
    case "open-permissions": {
      const rows = [...document.querySelectorAll<HTMLElement>("tr,[role=row]")]
        .filter(visible)
        .filter((row) => row.innerText.includes(target.packageName));
      return rows.length === 1
        ? click(/^Manage permissions$/i, rows[0])
        : { done: false };
    }
    case "apply-permissions":
      return dialog ? click(/^Apply$/i, dialog) : { done: false };
    case "select-permissions": {
      const read = check(/^View app information(?:\s|$)/i);
      const release = check(/^Release apps to testing tracks(?:\s|$)/i);
      return { done: read && release };
    }
    case "invite":
      return click(/^Invite user$|^Send invitation$/i);
    case "confirm-invite":
      return dialog &&
        /Send invite\?/i.test(dialog.innerText) &&
        dialog.innerText.includes(target.email)
        ? click(/^Send invite$/i, dialog)
        : { done: false };
    case "open-play-create":
      return click(/^Create app$/i);
    case "fill-play-create":
      return {
        done: fill(/^app name$/i, target.appName),
        detail:
          "Review language, pricing, and declarations in Google Play before creating the app.",
      };
  }
}

// A keys page need not repeat the email. Pin the numeric identity discovered
// from its matching list row, rather than trusting a display name alone.
export function matchesGoogleServiceRoute(
  current: string,
  pinned: string,
  project: string,
): boolean {
  try {
    const a = new URL(current),
      b = new URL(pinned);
    const identity = (url: URL) =>
      url.pathname.match(
        /\/iam-admin\/serviceaccounts\/details\/(\d+)(?:\/|$)/,
      )?.[1];
    return (
      a.protocol === "https:" &&
      b.protocol === "https:" &&
      a.hostname === "console.cloud.google.com" &&
      b.hostname === a.hostname &&
      a.searchParams.get("project") === project &&
      b.searchParams.get("project") === project &&
      !!identity(a) &&
      identity(a) === identity(b)
    );
  } catch {
    return false;
  }
}

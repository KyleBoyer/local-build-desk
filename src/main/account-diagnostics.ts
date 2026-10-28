import {
  mkdirSync,
  appendFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { WebContents } from "electron";
export function redactDiagnosticText(value: string): string {
  return value
    .replace(
      /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?(?:-----END[^-]*PRIVATE KEY-----|$)/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b/g,
      "[REDACTED JWT]",
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED EMAIL]")
    .replace(
      /((?:authorization|cookie|set-cookie|password|passcode|verification.?code|access.?token|refresh.?token|token|secret|private.?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\b\d{6,8}\b/g, "[REDACTED CODE]")
    .slice(0, 100000);
}
export function diagnosticURL(value: string) {
  try {
    const u = new URL(value);
    const path = redactDiagnosticText(u.pathname).replace(
      /\/[^/]{60,}/g,
      "/[REDACTED]",
    );
    const keys = [...new Set(u.searchParams.keys())].filter(
      (k) =>
        !/(?:token|code|password|assertion|credential|key|auth|session)/i.test(
          k,
        ),
    );
    return `${u.origin}${path}${keys.length ? "?" + keys.map((k) => encodeURIComponent(k) + "=[omitted]").join("&") : ""}`;
  } catch {
    return "[invalid URL]";
  }
}
export function diagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[depth limit]";
  if (typeof value === "string")
    return /^https?:\/\//.test(value)
      ? diagnosticURL(value)
      : redactDiagnosticText(value);
  if (Array.isArray(value))
    return value.slice(0, 150).map((x) => diagnosticValue(x, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/^(?:headers|requestHeaders|responseHeaders|postData|body|cookies|authorization|password|passcode|otp|token|privateKey|private_key|secret|credentials)$/i.test(
              key,
            ),
        )
        .map(([key, item]) => [key, diagnosticValue(item, depth + 1)]),
    );
  return value;
}
// Safe DOM evidence. Never collect raw HTML, inline JavaScript, input values, or login-frame content.
export function captureAccountDOM() {
  const clean = (s: string) =>
    s
      .replace(
        /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?(?:-----END[^-]*PRIVATE KEY-----|$)/g,
        "[REDACTED PRIVATE KEY]",
      )
      .replace(
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
        "[REDACTED EMAIL]",
      )
      .replace(
        /\b[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b/g,
        "[REDACTED JWT]",
      )
      .replace(/\b\d{6,8}\b/g, "[REDACTED CODE]");
  const url = new URL(location.href);
  const auth =
    /(?:^|\.)(?:idmsa|appleid|account|accounts)\.(?:apple|google)\.com$/.test(
      url.hostname,
    ) ||
    /login|signin|appleauth|oauth/i.test(url.pathname) ||
    !!document.querySelector(
      "input[type=password],input[autocomplete=one-time-code]",
    );
  if (auth)
    return {
      auth: true,
      title: "Authentication page — content intentionally omitted",
      html: "<!-- Authentication DOM intentionally omitted -->",
      controls: [],
      frames: document.querySelectorAll("iframe").length,
    };
  const visible = (e: Element) =>
    Boolean(
      (e as HTMLElement).offsetWidth ||
      (e as HTMLElement).offsetHeight ||
      e.getClientRects().length,
    );
  const controls = [
    ...document.querySelectorAll(
      "button,[role=button],a,input,select,[role=combobox],[role=option]",
    ),
  ]
    .filter(visible)
    .slice(0, 120)
    .map((e) => ({
      tag: e.tagName.toLowerCase(),
      role: e.getAttribute("role"),
      label: clean(
        (
          e.getAttribute("aria-label") ??
          e.getAttribute("title") ??
          e.textContent ??
          ""
        )
          .trim()
          .slice(0, 200),
      ),
      id: e.id,
      type: e.getAttribute("type"),
      testId: e.getAttribute("data-testid") ?? e.getAttribute("data-test-id"),
      disabled:
        e.hasAttribute("disabled") ||
        e.getAttribute("aria-disabled") === "true",
      svg: e.querySelector("svg")
        ? {
            label: e.querySelector("svg")!.getAttribute("aria-label"),
            class: e.querySelector("svg")!.getAttribute("class"),
          }
        : undefined,
    }));
  const clone = document.body.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(
      "script,style,noscript,template,iframe,canvas,img,video,audio,object,embed,svg,input[type=hidden]",
    )
    .forEach((el) => el.remove());
  const allowed = new Set([
    "id",
    "class",
    "role",
    "type",
    "name",
    "title",
    "placeholder",
    "aria-label",
    "aria-labelledby",
    "aria-controls",
    "aria-expanded",
    "aria-selected",
    "aria-disabled",
    "data-testid",
    "data-test-id",
    "disabled",
    "open",
    "tabindex",
    "aria-modal",
    "aria-hidden",
    "aria-activedescendant",
    "aria-multiselectable",
    "aria-checked",
  ]);
  for (const element of [clone, ...clone.querySelectorAll("*")]) {
    for (const attr of [...element.attributes])
      if (!allowed.has(attr.name)) element.removeAttribute(attr.name);
      else element.setAttribute(attr.name, clean(attr.value));
    if (element.matches("input,textarea,[contenteditable=true]")) {
      element.removeAttribute("value");
      element.textContent = "";
    }
  }
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  while (walker.nextNode())
    walker.currentNode.textContent = clean(
      walker.currentNode.textContent ?? "",
    );
  return {
    auth: false,
    title: clean(document.title),
    html: clone.outerHTML.slice(0, 350000),
    controls,
    frames: document.querySelectorAll("iframe").length,
  };
}
export function authDiagnosticURL(value: string) {
  try {
    const u = new URL(value);
    return (
      /(?:^|\.)(?:idmsa|appleid|account|accounts)\.(?:apple|google)\.com$/.test(
        u.hostname,
      ) || /login|signin|appleauth|oauth/i.test(u.pathname)
    );
  } catch {
    return false;
  }
}
export function observePasskeyOutcome() {
  const credentials = navigator.credentials;
  if (!credentials || !credentials.get) return;
  const original = credentials.get.bind(credentials);
  if ((credentials.get as any).__deskObserved) return;
  const wrapped = async function (options?: CredentialRequestOptions) {
    const started = Date.now();
    const passkey = !!options && "publicKey" in options;
    if (passkey)
      console.debug("__LBD_PASSKEY__" + JSON.stringify({ stage: "started" }));
    try {
      const result = await original(options);
      if (passkey)
        console.debug(
          "__LBD_PASSKEY__" +
            JSON.stringify({
              stage: "completed",
              durationMs: Date.now() - started,
            }),
        );
      return result;
    } catch (error) {
      if (passkey)
        console.debug(
          "__LBD_PASSKEY__" +
            JSON.stringify({
              stage: "failed",
              errorName: error instanceof DOMException ? error.name : "Error",
              durationMs: Date.now() - started,
            }),
        );
      throw error;
    }
  };
  (wrapped as any).__deskObserved = true;
  try {
    credentials.get = wrapped;
  } catch {}
}
export class AccountDiagnostics {
  readonly directory: string;
  private sequence = 0;
  private detached = false;
  private snapshotHashes = new Map<string, string>();
  private requests = new Map<
    string,
    { url: string; method: string; started: number; type?: string }
  >();
  constructor(root: string, provider: string, projectId: string) {
    const parent = join(root, "diagnostics", "accounts");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    this.directory = join(
      parent,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${provider}-${randomUUID().slice(0, 8)}`,
    );
    mkdirSync(this.directory, { mode: 0o700 });
    this.record("session.started", {
      provider,
      projectId,
      version: 2,
      policy:
        "No auth bodies, headers, cookies, password/OTP values, inline JS, or private-key contents. DOM fixtures are sanitized.",
    });
    const old = readdirSync(parent)
      .sort()
      .filter((name) => name !== this.directory.split("/").at(-1));
    for (const name of old.slice(0, Math.max(0, old.length - 19)))
      rmSync(join(parent, name), { recursive: true, force: true });
  }
  record(event: string, data: unknown = {}) {
    if (this.detached) return;
    appendFileSync(
      join(this.directory, "events.jsonl"),
      JSON.stringify({
        sequence: ++this.sequence,
        time: new Date().toISOString(),
        event,
        data: diagnosticValue(data),
      }) + "\n",
      { mode: 0o600 },
    );
  }
  async snapshot(contents: WebContents, reason: string) {
    try {
      const evidence = await contents.executeJavaScript(
        `(${captureAccountDOM.toString()})()`,
      );
      const html = redactDiagnosticText(evidence.html ?? "");
      const hash = createHash("sha256").update(html).digest("hex");
      if (this.snapshotHashes.get(reason) === hash) return;
      this.snapshotHashes.set(reason, hash);
      const name = `${String(this.sequence + 1).padStart(5, "0")}-${reason.replace(/[^a-z0-9_-]/gi, "-").slice(0, 70)}`;
      writeFileSync(join(this.directory, name + ".html"), html, {
        mode: 0o600,
      });
      writeFileSync(
        join(this.directory, name + ".json"),
        JSON.stringify(
          diagnosticValue({ ...evidence, html: undefined }),
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
      this.record("page.snapshot", {
        reason,
        artifact: name,
        auth: evidence.auth,
        controlCount: evidence.controls?.length,
      });
    } catch (error) {
      this.record("page.snapshot.error", { reason, error: String(error) });
    }
  }
  async attach(contents: WebContents) {
    const record = this.record.bind(this);
    const onAuthPage = (...urls: (string | undefined)[]) =>
      [contents.getURL(), ...urls].some((u) => !!u && authDiagnosticURL(u));
    contents.on(
      "console-message",
      (_event, level, message, lineNumber, sourceId) => {
        if (message.startsWith("__LBD_PASSKEY__")) {
          try {
            const event = JSON.parse(message.slice("__LBD_PASSKEY__".length));
            record("authentication.passkey", {
              stage: event.stage,
              errorName: event.errorName,
              durationMs: event.durationMs,
            });
          } catch {}
          return;
        }
        const auth =
          authDiagnosticURL(contents.getURL()) || authDiagnosticURL(sourceId);
        record("javascript.console", {
          level,
          message: auth ? "[authentication console text omitted]" : message,
          source: sourceId,
          line: lineNumber,
        });
      },
    );
    contents.on("render-process-gone", (_event, details) =>
      record("renderer.gone", details),
    );
    contents.on(
      "did-fail-load",
      (_event, code, description, url, isMainFrame) =>
        record("navigation.failed", { code, description, url, isMainFrame }),
    );
    contents.on(
      "did-navigate",
      (_event, url, httpResponseCode, httpStatusText) => {
        record("navigation.complete", {
          url,
          httpResponseCode,
          httpStatusText,
        });
        void this.snapshot(contents, "navigation");
      },
    );
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      record("navigation.in-page", { url, isMainFrame });
      if (isMainFrame) void this.snapshot(contents, "navigation-in-page");
    });
    contents.on("will-redirect", (_event, url, _isInPlace, isMainFrame) =>
      record("navigation.redirect", { url, isMainFrame }),
    );
    try {
      contents.debugger.attach("1.3");
      contents.debugger.on("message", (_event, method, params) => {
        if (method === "Network.requestWillBeSent") {
          this.requests.set(params.requestId, {
            url: params.request.url,
            method: params.request.method,
            started: Date.now(),
            type: params.type,
          });
          record("network.request", {
            requestId: params.requestId,
            url: params.request.url,
            method: params.request.method,
            type: params.type,
            initiator: params.initiator?.type,
          });
        } else if (method === "Network.responseReceived") {
          const request = this.requests.get(params.requestId);
          record("network.response", {
            requestId: params.requestId,
            url: params.response.url,
            status: params.response.status,
            mimeType: params.response.mimeType,
            fromDiskCache: params.response.fromDiskCache,
            durationMs: request ? Date.now() - request.started : undefined,
          });
        } else if (method === "Network.loadingFailed") {
          record("network.failed", {
            requestId: params.requestId,
            ...this.requests.get(params.requestId),
            error: params.errorText,
            blockedReason: params.blockedReason,
            cancelled: params.canceled,
          });
          this.requests.delete(params.requestId);
        } else if (method === "Network.loadingFinished")
          this.requests.delete(params.requestId);
        else if (method === "Runtime.exceptionThrown") {
          const exception = params.exceptionDetails;
          record("javascript.exception", {
            text: exception.text,
            description: onAuthPage(exception.url)
              ? "[authentication exception text omitted]"
              : exception.exception?.description,
            url: exception.url,
            line: exception.lineNumber,
            column: exception.columnNumber,
            stack: exception.stackTrace?.callFrames?.map((f: any) => ({
              functionName: f.functionName,
              url: f.url,
              line: f.lineNumber,
              column: f.columnNumber,
            })),
          });
        } else if (method === "Log.entryAdded")
          record("javascript.log", {
            level: params.entry.level,
            source: params.entry.source,
            text: onAuthPage(params.entry.url)
              ? "[authentication log text omitted]"
              : params.entry.text,
            url: params.entry.url,
          });
      });
      await contents.debugger.sendCommand("Page.enable");
      await contents.debugger.sendCommand(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: `(${observePasskeyOutcome.toString()})()` },
      );
      await contents.debugger.sendCommand("Page.enable");
      await contents.debugger.sendCommand(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: `(${observePasskeyOutcome.toString()})()` },
      );
      await contents.debugger.sendCommand("Network.enable");
      await contents.debugger.sendCommand("Runtime.enable");
      await contents.debugger.sendCommand("Log.enable");
      record("capture.enabled", {
        network: "metadata only",
        javascript: "messages and stack locations",
        dom: "sanitized semantic snapshots",
      });
    } catch (error) {
      record("capture.degraded", { error: String(error) });
    }
  }
  close() {
    this.record("session.closed");
    this.detached = true;
  }
}

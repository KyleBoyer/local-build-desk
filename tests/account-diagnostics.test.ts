import { it, expect, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { mkdtemp, readFile, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  captureAccountDOM,
  diagnosticURL,
  diagnosticValue,
  redactDiagnosticText,
  AccountDiagnostics,
  authDiagnosticURL,
  observePasskeyOutcome,
} from "../src/main/account-diagnostics";
function page(
  html: string,
  url = "https://appstoreconnect.apple.com/access/integrations/api",
) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", {
    get() {
      return 100;
    },
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
  });
  return dom;
}
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
it("omits login and MFA HTML completely, including all field values and scripts", () => {
  const dom = page(
    '<input type="password" value="never-store-password"><input autocomplete="one-time-code" value="678901"><script>const token="private"</script>',
    "https://appstoreconnect.apple.com/login",
  );
  const snapshot = dom.window.eval(
    `(${captureAccountDOM.toString()})()`,
  ) as any;
  expect(snapshot.auth).toBe(true);
  expect(JSON.stringify(snapshot)).not.toMatch(
    /never-store-password|678901|const token/,
  );
});
it("keeps useful page structure while removing values, inline JS, private keys, and emails", () => {
  const dom = page(
    '<h3>Active (1)</h3><button role="button" onclick="secret()"><svg><path d="M1"/></svg></button><input value="PRIVATE_INPUT" name="keyName"><textarea>PRIVATE_TEXTAREA</textarea><script>PRIVATE_SCRIPT</script><p>person@example.com</p><pre>-----BEGIN PRIVATE KEY-----\nSECRET_KEY_BYTES\n-----END PRIVATE KEY-----</pre>',
  );
  const snapshot = dom.window.eval(
    `(${captureAccountDOM.toString()})()`,
  ) as any;
  expect(snapshot.html).toContain("Active (1)");
  expect(snapshot.html).toContain('role="button"');
  expect(snapshot.html).not.toMatch(
    /PRIVATE_INPUT|PRIVATE_TEXTAREA|PRIVATE_SCRIPT|SECRET_KEY_BYTES|person@example.com|onclick/,
  );
  expect(snapshot.controls.length).toBe(2);
});
it("logs network metadata without headers, bodies, cookies, tokens, or URL query values", () => {
  const safe = JSON.stringify(
    diagnosticValue({
      url: "https://apple.com/login?password=secret&target=apps&code=123456",
      method: "POST",
      status: 401,
      headers: { Authorization: "Bearer SECRET" },
      postData: "password=secret",
      cookies: [{ value: "cookie-secret" }],
      message:
        "password=secret Authorization=BearerSecret code: 123456 person@example.com",
    }),
  );
  expect(safe).not.toMatch(
    /BearerSecret|cookie-secret|person@example.com|123456|password=secret|"headers"|postData/,
  );
  expect(safe).toContain("401");
  expect(safe).toContain("target=[omitted]");
  expect(diagnosticURL("https://apple.com/path#auth-token")).not.toContain(
    "auth-token",
  );
});
it("creates owner-only persistent diagnostics and deduplicates unchanged failure snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-diagnostics-test-"));
  dirs.push(root);
  const log = new AccountDiagnostics(root, "apple", "fixture");
  const dom = page("<h3>Active (1)</h3>");
  const contents = {
    executeJavaScript: async (code: string) => dom.window.eval(code),
  };
  log.record("automation.action.result", { done: false });
  await log.snapshot(contents as any, "failed-add");
  await log.snapshot(contents as any, "failed-add");
  log.close();
  const files = await readdir(log.directory);
  expect(files.filter((f) => f.endsWith(".html"))).toHaveLength(1);
  expect((await stat(log.directory)).mode & 0o077).toBe(0);
  const events = await readFile(join(log.directory, "events.jsonl"), "utf8");
  expect(events).toContain("automation.action.result");
  expect(events).toContain("page.snapshot");
  expect(events).toContain("session.closed");
});
it("treats Apple and Google sign-in hosts as authentication pages", () => {
  expect(authDiagnosticURL("https://idmsa.apple.com/appleauth/auth")).toBe(
    true,
  );
  expect(authDiagnosticURL("https://accounts.google.com/v3/signin")).toBe(true);
  expect(
    authDiagnosticURL(
      "https://appstoreconnect.apple.com/access/integrations/api",
    ),
  ).toBe(false);
  expect(authDiagnosticURL("not a url")).toBe(false);
});
it("reports passkey outcomes without credential data", async () => {
  const dom = new JSDOM("", {
    url: "https://idmsa.apple.com/",
    runScripts: "outside-only",
  });
  const messages: string[] = [];
  dom.window.console.debug = (m: string) => messages.push(m);
  Object.defineProperty(dom.window.navigator, "credentials", {
    value: {
      get: async () => {
        throw new dom.window.DOMException("cancelled", "NotAllowedError");
      },
    },
  });
  dom.window.eval(`(${observePasskeyOutcome.toString()})()`);
  dom.window.eval(`(${observePasskeyOutcome.toString()})()`);
  await expect(
    dom.window.eval(
      "navigator.credentials.get({ publicKey: { challenge: new Uint8Array(1) } })",
    ),
  ).rejects.toThrow();
  const events = messages.map((m) =>
    JSON.parse(m.replace("__LBD_PASSKEY__", "")),
  );
  expect(events.map((e) => e.stage)).toEqual(["started", "failed"]);
  expect(events[1].errorName).toBe("NotAllowedError");
});

it("records passkey outcome names without challenges or returned credential material", async () => {
  const dom = page("<p>Sign in</p>", "https://idmsa.apple.com/appleauth/auth");
  const messages: string[] = [];
  Object.defineProperty(dom.window.navigator, "credentials", {
    value: {
      get: async () => {
        throw new dom.window.DOMException(
          "secret challenge value",
          "NotAllowedError",
        );
      },
    },
    configurable: true,
  });
  dom.window.console.debug = (text: unknown) => messages.push(String(text));
  dom.window.eval(`(${observePasskeyOutcome.toString()})()`);
  await expect(
    dom.window.navigator.credentials.get({
      publicKey: { challenge: Buffer.from("SECRET_CHALLENGE") },
    } as any),
  ).rejects.toThrow();
  expect(messages.join("\n")).toContain("NotAllowedError");
  expect(messages.join("\n")).not.toMatch(
    /SECRET_CHALLENGE|secret challenge value/,
  );
});

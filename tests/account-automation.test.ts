import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import {
  inspectApplePage,
  performAppleAction,
} from "../src/main/account-automation";
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
function inspect(dom: JSDOM): ReturnType<typeof inspectApplePage> {
  return dom.window.eval(`(${inspectApplePage.toString()})()`) as ReturnType<
    typeof inspectApplePage
  >;
}
function act(
  dom: JSDOM,
  input: Parameters<typeof performAppleAction>[0],
): ReturnType<typeof performAppleAction> {
  return dom.window.eval(
    `(${performAppleAction.toString()})(${JSON.stringify(input)})`,
  ) as ReturnType<typeof performAppleAction>;
}
it("confirms the one-time download using the captured live Apple dialog", () => {
  const dom = page(
    readFileSync(
      new URL("./fixtures/apple/download-confirm-live.html", import.meta.url),
      "utf8",
    ),
  );
  expect(inspect(dom).phase).toBe("download-confirm");
  const buttons = [...dom.window.document.querySelectorAll("button")];
  const download = buttons.find(
    (button) => button.textContent?.trim() === "Download",
  )!;
  let clicks = 0;
  download.addEventListener("click", () => clicks++);
  expect(act(dom, { type: "download-key" }).done).toBe(true);
  expect(clicks).toBe(1);
});
describe("app-owned Apple account automation", () => {
  it("detects sign-in/MFA without returning credential input values", () => {
    const dom = page(
      '<input name="accountName" value="user@example.com"><input type="password" value="never-read-this"><input autocomplete="one-time-code" value="123456">',
    );
    const result = inspect(dom);
    expect(result.phase).toBe("login");
    expect(JSON.stringify(result)).not.toMatch(
      /never-read|123456|user@example/,
    );
  });
  it("pauses for legal API-access terms without checking or submitting", () => {
    const dom = page(
      '<div role="dialog">Request Access to the App Store Connect API You agree to use this API <input type="checkbox"><button>Submit</button></div>',
    );
    expect(inspect(dom).phase).toBe("terms");
    expect(
      dom.window.document.querySelector<HTMLInputElement>("input")!.checked,
    ).toBe(false);
  });
  it("recognizes API access and extracts the nonsecret issuer identifier", () => {
    const dom = page(
      "<h1>App Store Connect API</h1><p>Issuer ID 11111111-2222-4333-8444-555555555555</p><button>Generate API Key</button>",
    );
    const result = inspect(dom);
    expect(result.phase).toBe("keys");
    expect(result.issuerId).toBe("11111111-2222-4333-8444-555555555555");
  });
  it("prepares key name and access but never clicks Generate until explicitly approved", () => {
    const dom = page(
      '<div role="dialog"><h2>Generate API Key</h2><label>Name<input type="text"></label><label>Access<select><option>Choose</option><option value="ADMIN">Admin</option></select></label><button id="generate">Generate</button></div>',
    );
    let generated = false;
    dom.window.document
      .getElementById("generate")!
      .addEventListener("click", () => {
        generated = true;
      });
    expect(inspect(dom).phase).toBe("key-dialog");
    const result = act(dom, {
      type: "fill-key-dialog",
      name: "Local Build Desk",
    });
    expect(result.done).toBe(true);
    expect(dom.window.document.querySelector("input")!.value).toBe(
      "Local Build Desk",
    );
    expect(dom.window.document.querySelector("select")!.value).toBe("ADMIN");
    expect(generated).toBe(false);
    act(dom, { type: "generate-key" });
    expect(generated).toBe(true);
  });
  it("detects a Team ID and degrades safely when Apple changes its UI", () => {
    expect(
      inspect(
        page(
          "<h1>Membership details</h1><p>Team ID ABCDE12345</p>",
          "https://developer.apple.com/account/",
        ),
      ).teamId,
    ).toBe("ABCDE12345");
    expect(inspect(page("<h1>A changed page</h1>")).phase).toBe("unknown");
    expect(
      act(page("<button>Unrelated action</button>"), {
        type: "open-key-dialog",
      }).done,
    ).toBe(false);
  });
});

import { readFileSync } from "node:fs";
it("opens Apple’s actual unlabeled Add Key button using the captured Active header fixture", () => {
  const html = readFileSync(
    new URL("./fixtures/apple/keys-live.html", import.meta.url),
    "utf8",
  );
  const dom = page(html);
  const heading = [...dom.window.document.querySelectorAll("h3")].find(
    (e) => e.textContent?.trim() === "Active (1)",
  )!;
  const add = heading.parentElement!.querySelector("button")!;
  let clicked = 0;
  add.addEventListener("click", () => clicked++);
  const probe = inspect(dom);
  expect(probe.phase).toBe("keys");
  expect(probe.issuerId).toBe("11111111-2222-4333-8444-555555555555");
  const result = act(dom, { type: "open-key-dialog" });
  expect(result.done).toBe(true);
  expect(result.target?.reason).toContain("Active");
  expect(clicked).toBe(1);
});
it("matches controls with duplicated accessible/text labels and portal-rendered Admin options", () => {
  const dom = page(
    '<div role="dialog"><h2>Generate API Key</h2><input type="text" name="keyName"><button role="combobox" aria-haspopup="listbox">Choose</button><button aria-label="Generate">Generate</button></div><div role="listbox"><div role="option" tabindex="0">Admin</div></div>',
  );
  let chosen = false;
  dom.window.document
    .querySelector("[role=option]")!
    .addEventListener("click", () => (chosen = true));
  act(dom, { type: "fill-key-dialog" });
  expect(chosen).toBe(true);
  let generated = false;
  dom.window.document
    .querySelector("[aria-label=Generate]")!
    .addEventListener("click", () => (generated = true));
  expect(act(dom, { type: "generate-key" }).done).toBe(true);
  expect(generated).toBe(true);
});
it("distinguishes successful login redirects, download confirmations, and unready key forms", () => {
  expect(
    inspect(page("<h1>Apps</h1>", "https://appstoreconnect.apple.com/apps"))
      .phase,
  ).toBe("apps");
  expect(
    inspect(
      page(
        '<div role="dialog">Download API Key You can only download this key once.<button>Download</button></div>',
      ),
    ).phase,
  ).toBe("download-confirm");
  const probe = inspect(
    page(
      '<div role="dialog"><h2>Generate API Key</h2><label>Name<input type="text"></label><label>Access<select><option>Choose</option><option>Admin</option></select></label><button disabled>Generate</button></div>',
    ),
  );
  expect(probe.form).toEqual({
    nameReady: false,
    adminSelected: false,
    generateEnabled: false,
  });
});
it("opens Apple’s actual searchable Select Roles input and verifies its selected Admin chip", () => {
  const html = readFileSync(
    new URL("./fixtures/apple/key-dialog-live.html", import.meta.url),
    "utf8",
  );
  const dom = page(html);
  const roles =
    dom.window.document.querySelector<HTMLInputElement>("input[name=roles]")!;
  let opened = false;
  // The captured <dialog> lacks `open` (Apple shows it via CSS), so jsdom won't focus inside it; the click still lands.
  dom.window.document.querySelector("dialog")?.setAttribute("open", "");
  roles.addEventListener("click", () => (opened = true));
  roles.addEventListener("click", () => (opened = true));
  const result = act(dom, { type: "fill-key-dialog" });
  expect(result.done).toBe(true);
  expect(result.target?.reason).toContain("Select Roles");
  expect(opened).toBe(true);
  dom.window.document
    .querySelector("#roles")!
    .insertAdjacentHTML(
      "afterbegin",
      '<span class="Chip">Admin<button aria-label="Remove Admin">×</button></span>',
    );
  dom.window.document
    .querySelector("dialog button[disabled]")
    ?.removeAttribute("disabled");
  const probe = inspect(dom);
  expect(probe.form?.adminSelected).toBe(true);
});
it("does not confuse the live menu option with a selected role and clicks its inner button once", () => {
  const html = readFileSync(
    new URL("./fixtures/apple/roles-menu-live.html", import.meta.url),
    "utf8",
  );
  const dom = page(html);
  expect(inspect(dom).form?.adminSelected).toBe(false);
  const admin = [
    ...dom.window.document.querySelectorAll("[role=menuitem] button"),
  ].find((b) => b.textContent?.trim() === "Admin")!;
  let count = 0;
  admin.addEventListener("click", () => count++);
  const result = act(dom, { type: "fill-key-dialog" });
  expect(result.done).toBe(true);
  expect(result.target?.tag).toBe("button");
  expect(count).toBe(1);
});
it("reads key IDs from individual table cells even when row text has no whitespace boundaries", () => {
  const html = readFileSync(
    new URL("./fixtures/apple/keys-live.html", import.meta.url),
    "utf8",
  );
  const dom = page(html);
  expect(inspect(dom).keys?.[0]?.id).toBe("EXAMPLE123");
  const table = dom.window.document.querySelector("tbody")!;
  table.insertAdjacentHTML(
    "afterbegin",
    "<tr><td>Local Build Desk</td><td>TESTKEY123</td><td><button>Download API Key</button></td></tr>",
  );
  expect(inspect(dom).keys?.find((k) => k.name === "Local Build Desk")).toEqual(
    { id: "TESTKEY123", name: "Local Build Desk", downloadable: true },
  );
});
it("records the original clicked label even if React immediately reuses the option element", () => {
  const dom = page(
    '<div role="dialog"><h2>Generate API Key</h2><input name="name"><div role="menu"><button>Admin</button></div></div>',
  );
  const button = dom.window.document.querySelector("button")!;
  button.addEventListener("click", () => (button.textContent = "App Manager"));
  const result = act(dom, { type: "fill-key-dialog" });
  expect(result.target?.label).toBe("Admin");
});

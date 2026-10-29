import { it, expect } from "vitest";
import { JSDOM } from "jsdom";
import {
  inspectStorePage,
  performStoreAction,
  type StoreAction,
} from "../src/main/store-automation";
import { storeScope } from "../src/core/store-onboarding";
import type { StoreSetupState } from "../src/core/types";
const target: StoreSetupState = {
  provider: "apple",
  mode: "record",
  appName: "Fixture",
  identity: "com.example.fixture",
  language: "en-US",
  sku: "fixture",
  stage: "opening",
  submitted: {},
};
function page(html: string, url = "https://appstoreconnect.apple.com/apps") {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", {
    get: () => 100,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
  });
  return dom;
}
const probe = (dom: JSDOM, t = target) =>
  dom.window.eval(
    `(${inspectStorePage.toString()})(${JSON.stringify(t)})`,
  ) as ReturnType<typeof inspectStorePage>;
const act = (dom: JSDOM, action: StoreAction, t = target) =>
  dom.window.eval(
    `(${performStoreAction.toString()})(${JSON.stringify(action)},${JSON.stringify(t)})`,
  ) as ReturnType<typeof performStoreAction>;
it("fills the Apple app form with exact identity and language without submitting", () => {
  const dom = page(
    '<dialog open><h2>New App</h2><label>iOS<input type=checkbox></label><label>Name<input></label><label>SKU<input></label><label>Bundle ID<select><option>Pick</option><option value="bundle">com.example.fixture</option><option>com.example.fixture.other</option></select></label><label>Primary Language<select><option>Pick</option><option value=en-US>English (U.S.)</option></select></label><button>Create</button></dialog>',
  );
  let clicks = 0;
  dom.window.document.querySelector("button")!.onclick = () => clicks++;
  // Prefix matches are ambiguous and must not pick a different bundle.
  expect(act(dom, "fill-app").done).toBe(false);
  dom.window.document.querySelector("select")!.lastElementChild!.remove();
  expect(act(dom, "fill-app").done).toBe(true);
  expect(probe(dom).ready).toBe(true);
  expect(clicks).toBe(0);
});
it("never automates credentials, MFA, agreements, or rollout", () => {
  const dom = page(
    "<input type=password value=secret><input autocomplete=one-time-code value=123456>",
    "https://accounts.google.com/signin",
  );
  expect(probe(dom)).toEqual({ phase: "login" });
  expect(act(dom, "create-app").done).toBe(false);
  const terms = page(
    "<button>Accept terms</button><button>Start rollout to internal testing</button>",
  );
  expect(probe(terms).phase).toBe("terms");
  expect(act(terms, "save-draft").done).toBe(false);
});
it("identifies exact uploaded version and requires a draft summary after the editor closes", () => {
  const t = {
    ...target,
    provider: "google" as const,
    mode: "bootstrap" as const,
    artifact: {
      id: "a",
      name: "fixture.aab",
      sha256: "a".repeat(64),
      size: 2,
      version: "1",
      buildNumber: "11",
    },
  };
  const dom = page(
    "<table><tr><td>App bundle 111 fixture.aab</td></tr></table><button>Save as draft</button>",
    "https://play.google.com/console/developers/123/app/456/testing/internal/releases/new",
  );
  expect(probe(dom, t).uploaded).toBe(false);
  dom.window.document.querySelector("td")!.textContent =
    "App bundle 11 fixture.aab";
  expect(probe(dom, t).uploaded).toBe(true);
  expect(probe(dom, t).draftSaved).toBeFalsy();
  dom.window.document.querySelector("button")!.remove();
  dom.window.document.querySelector("td")!.textContent = "Draft 11";
  expect(probe(dom, t).draftSaved).toBeFalsy();
  dom.reconfigure({
    url: "https://play.google.com/console/developers/123/app/456/testing/internal",
  });
  expect(probe(dom, t).draftSaved).toBe(true);
});
it("resume scope retains mutation history after learning provider IDs, while approvals bind them", () => {
  const learned = { ...target, appId: "456", developerId: "123" };
  expect(storeScope(learned, "resume")).toBe(storeScope(target, "resume"));
  expect(storeScope(learned, "create")).not.toBe(storeScope(target, "create"));
  expect(storeScope({ ...learned, identity: "com.other" }, "resume")).not.toBe(
    storeScope(learned, "resume"),
  );
});
it("selects only the configured capability identifier and preserves other assignments", () => {
  const t = {
    ...target,
    mode: "capabilities" as const,
    identifiers: ["iCloud.com.example.fixture"],
  };
  const dom = page(
    "<dialog open><h2>iCloud Containers</h2><table><tr><td>iCloud.com.other</td><td><input type=checkbox checked></td></tr><tr><td>iCloud.com.example.fixture</td><td><input type=checkbox></td></tr></table><button>Apply</button></dialog>",
    "https://developer.apple.com/account/resources/identifiers/bundleId/edit/bundle",
  );
  expect(probe(dom, t).capabilityReady).toBe(true);
  expect(act(dom, "apply-identifier", t).done).toBe(true);
  const checks =
    dom.window.document.querySelectorAll<HTMLInputElement>("input");
  expect(checks[0].checked).toBe(true);
  expect(checks[1].checked).toBe(true);
});

it("recognizes a provider redirect to the exact existing Play app without confusing package prefixes", () => {
  const t = { ...target, provider: "google" as const };
  const dom = page(
    "<h1>Fixture</h1><span>com.example.fixture</span>",
    "https://play.google.com/console/developers/123/app/456/app-dashboard",
  );
  expect(probe(dom, t)).toMatchObject({
    phase: "app",
    appId: "456",
    identityMatches: true,
  });
  dom.window.document.querySelector("span")!.textContent =
    "com.example.fixture.other";
  expect(probe(dom, t).identityMatches).toBe(false);
});
it("chooses the open menu's New App item over a trigger with the same label", () => {
  const dom = page(
    '<h1>Apps</h1><button aria-label="New App" id="trigger">+</button><ul><li role="menuitem"><button id="item">New App</button></li><li role="menuitem"><button>New App Bundle</button></li></ul>',
  );
  const clicked: string[] = [];
  for (const id of ["trigger", "item"])
    dom.window.document.getElementById(id)!.onclick = () => clicked.push(id);
  expect(act(dom, "new-app").done).toBe(true);
  expect(clicked).toEqual(["item"]);
  // Two matching items in the same menu are still ambiguous.
  dom.window.document
    .querySelector("ul")!
    .insertAdjacentHTML(
      "beforeend",
      '<li role="menuitem"><button>New App</button></li>',
    );
  expect(act(dom, "new-app").done).toBe(false);
});
it("reports App Store Connect's unmarked form validation message instead of waiting for a record", () => {
  const dom = page(
    '<div role="dialog"><h2>New App</h2><p><span>There are one or more validation errors below.</span></p><label>iOS<input type=checkbox checked></label><label>Name<input name="name" value="Fixture"></label><p>The app name you entered is already being used. If you have trademark rights to this name and would like it released for your use, submit a claim.</p><button>Create</button></div>',
  );
  expect(probe(dom).error).toMatch(
    /^The app name you entered is already being used/,
  );
});
it("leaves Apple's User Access choice to the person and explains a disabled Create", () => {
  const dom = page(
    '<div role="dialog"><h2>New App</h2><label>iOS<input type=checkbox checked></label><label>Name<input name="name" value="Fixture"></label><label>Limited Access<input type=radio name=userAccess></label><label>Full Access<input type=radio name=userAccess></label><button disabled>Create</button></div>',
  );
  const result = probe(dom);
  expect(result.missing).toEqual(["User Access"]);
  expect(result.createDisabled).toBe(true);
  expect(act(dom, "create-app").detail).toMatch(/still disabled/);
  const radios = dom.window.document.querySelectorAll("input[type=radio]");
  (radios[1] as HTMLInputElement).checked = true;
  expect(probe(dom).missing).toEqual([]);
});
it("finds Play's internal testing track from a generic Get started card link", () => {
  const dom = page(
    '<h1>Test and release</h1><a href="/console/developers/1/app/2/test-and-release">Test and release</a><div><h3>Open testing</h3><a aria-label="Get started with Open testing" href="/console/developers/1/app/2/tracks/open-testing">Get started</a></div><div><h3>Internal testing</h3><a aria-label="Get started with Internal testing" href="/console/developers/1/app/2/tracks/internal-testing?releaseType=defaultReleases">Get started</a></div>',
    "https://play.google.com/console/developers/1/app/2/test-and-release",
  );
  expect(
    probe(dom, {
      ...target,
      provider: "google",
      mode: "bootstrap",
      appId: "2",
      developerId: "1",
    }).internalUrl,
  ).toBe(
    "https://play.google.com/console/developers/1/app/2/tracks/internal-testing?releaseType=defaultReleases",
  );
});
it("reads Play's current release editor: splash progress, OBB input, and editor heading", () => {
  const google = {
    ...target,
    provider: "google" as const,
    mode: "bootstrap" as const,
    appId: "2",
    developerId: "1",
    artifact: {
      id: "a",
      name: "app.aab",
      sha256: "x",
      size: 1,
      buildNumber: "7",
      version: "1.0",
    },
  };
  const editor = page(
    '<div aria-hidden="true" role="progressbar"></div><h1>Create internal testing release</h1><input type=file accept=".aab" multiple><input type=file><button>Save as draft</button>',
    "https://play.google.com/console/developers/1/app/2/tracks/470/releases/1/prepare",
  );
  expect(probe(editor, google)).toMatchObject({
    phase: "release",
    fileInputs: 1,
    internalEditor: true,
  });
  const track = page(
    "<h1>Internal testing</h1><div role='progressbar' aria-label='Set up internal testing track' aria-valuenow='1' aria-valuemax='3'></div><button disabled>Create new release</button><button>Edit release</button>",
    "https://play.google.com/console/developers/1/app/2/tracks/internal-testing",
  );
  expect(probe(track, google)).toMatchObject({
    phase: "release",
    draftEditable: true,
  });
});
it("recognizes a saved draft from Play's release card, not the track's draft status", () => {
  const google = {
    ...target,
    provider: "google" as const,
    mode: "bootstrap" as const,
    appId: "2",
    developerId: "1",
    artifact: {
      id: "a",
      name: "app.aab",
      sha256: "x",
      size: 1,
      buildNumber: "7",
      version: "1.0",
    },
  };
  const html = (card: string) =>
    `<h1>Internal testing</h1><p>Inactive · Draft release</p><div role="progressbar" aria-label="Set up internal testing track"></div><h2>Releases</h2><div><div><div role="heading">${card}</div></div> <button>Edit release</button> <span>Draft</span></div><h2>Release history</h2>`;
  const url =
    "https://play.google.com/console/developers/1/app/2/tracks/internal-testing";
  expect(probe(page(html("7 (1.0)"), url), google).draftSaved).toBe(true);
  expect(probe(page(html("6 (0.9)"), url), google).draftSaved).toBe(false);
});

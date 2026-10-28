import { DeskError } from "../../src/core/errors";
import { app, session, ipcMain } from "electron";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { AccountSetupManager } from "../../src/main/account-setup";
import { methods, type Method } from "../../src/main/validation";
import type { StoreSetupState, StoreSetupRequest } from "../../src/core/types";
const root = process.env.LOCAL_BUILD_DESK_DATA_DIR!;
mkdirSync(root, { recursive: true });
app.setPath("userData", root);
app.setName("Local Build Desk Store Replay");
if (process.platform === "darwin") app.setActivationPolicy("accessory");
const scenario = process.env.DESK_STORE_SCENARIO || "apple";
const provider =
  scenario.startsWith("apple") || scenario === "capabilities"
    ? "apple"
    : "google";
const mode =
  scenario === "capabilities"
    ? "capabilities"
    : scenario.startsWith("bootstrap")
      ? "bootstrap"
      : "record";
const bytes = "signed-aab-fixture-content";
writeFileSync(join(root, "fixture.aab"), bytes);
const outcome = {
  creates: 0,
  rejected: 0,
  uploads: 0,
  drafts: 0,
  verified: 0,
  profiles: 0,
  ...(() => {
    try {
      return JSON.parse(readFileSync(join(root, "outcome.json"), "utf8"));
    } catch {
      return {};
    }
  })(),
};
const save = () =>
  writeFileSync(join(root, "outcome.json"), JSON.stringify(outcome));
save();
const project = {
  id: "fixture",
  bundleId: "com.example.fixture",
  packageName: "com.example.fixture",
  settings: {},
};
const request: StoreSetupRequest = {
  provider,
  mode,
  appName: "Fixture",
  language: "en-US",
  sku: "fixture",
  newApp: true,
  appType: "app",
  pricing: "free",
  artifactId: mode === "bootstrap" ? "artifact" : undefined,
};
const state: StoreSetupState = {
  ...request,
  identity: "com.example.fixture",
  // apple-stuck resumes a session saved after a create Apple never completed.
  stage: scenario === "apple-stuck" ? "verifying" : "opening",
  submitted: scenario === "apple-stuck" ? { create: "earlier attempt" } : {},
  ...(provider === "google" ? { developerId: "123" } : {}),
  ...(mode === "bootstrap"
    ? {
        appId: "456",
        artifact: {
          id: "artifact",
          name: "fixture.aab",
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.length,
          buildNumber: "11",
          version: "1.0",
        },
      }
    : {}),
  ...(mode === "capabilities"
    ? {
        appId: "bundle",
        identifiers: [
          "iCloud.com.example.fixture",
          "group.com.example.fixture",
        ],
      }
    : {}),
};
const engine = Object.assign(new EventEmitter(), {
  store: { root, get: () => project },
  storeSetupContext: async () => structuredClone(state),
  bootstrapFile: async () => join(root, "fixture.aab"),
  finishStoreSetup: async () => {
    if (mode === "bootstrap" && (outcome.uploads !== 1 || outcome.drafts !== 1))
      throw Error("Draft not saved");
    if (
      mode === "record" &&
      outcome.creates !== (scenario === "google-existing" ? 0 : 1)
    )
      throw provider === "apple"
        ? new DeskError(
            "STORE_APP_PENDING",
            "Apple has not exposed this bundle ID's app record yet.",
          )
        : Error("App not created");
    outcome.verified++;
    if (mode === "capabilities") outcome.profiles++;
    save();
    return "Store setup verified for com.example.fixture.";
  },
});
const page = (body: string, script = "") =>
  new Response(
    `<!doctype html><html><head><meta charset=utf-8><style>body{font:15px system-ui}button{margin:12px}dialog{position:relative}label{display:block;margin:10px}</style></head><body>${body}<script>${script}</script></body></html>`,
    { headers: { "Content-Type": "text/html;charset=utf-8" } },
  );
app.whenReady().then(async () => {
  const partition = session.fromPartition("persist:desk-account-" + provider);
  partition.protocol.handle("https", async (request) => {
    const url = new URL(request.url),
      path = url.pathname;
    if (path === "/fixture-reject") {
      outcome.rejected++;
      save();
      return new Response("{}");
    }
    if (path === "/fixture-create") {
      outcome.creates++;
      save();
      return new Response("{}");
    }
    if (path === "/fixture-upload") {
      const text = await request.text();
      if (text !== bytes) return new Response("wrong AAB", { status: 400 });
      outcome.uploads++;
      save();
      return new Response("{}");
    }
    if (path === "/fixture-draft") {
      outcome.drafts++;
      save();
      return new Response("{}");
    }
    if (scenario === "apple-taken" && path === "/apps")
      // Mirrors App Store Connect: a "+" trigger labelled like its menu item, and
      // a taken name reported as plain text under the field with nothing created.
      return page(
        '<h1>Apps</h1><button aria-label="New App" id=plus>+</button>',
        `document.querySelector('#plus').onclick=()=>{if(document.querySelector('#menu'))return;document.body.insertAdjacentHTML('beforeend','<ul id=menu><li role=menuitem><button id=new>New App</button></li><li role=menuitem><button>New App Bundle</button></li></ul>');document.querySelector('#new').onclick=()=>{document.body.insertAdjacentHTML('beforeend','<div role=dialog><h2>New App</h2><p id=banner></p><label>iOS<input type=checkbox></label><label>Name<input id=name></label><p id=nameError></p><label>SKU<input></label><label>Bundle ID<select><option>Pick</option><option value=bundle>com.example.fixture</option></select></label><label>Primary Language<select><option>Pick</option><option value=en-US>English (U.S.)</option></select></label><label>Limited Access<input type=radio name=userAccess></label><label>Full Access<input type=radio name=userAccess></label><button id=create disabled>Create</button></div>');for(const r of document.querySelectorAll('[name=userAccess]'))r.onchange=()=>document.querySelector('#create').disabled=false;document.querySelector('#name').oninput=()=>document.querySelector('#nameError').textContent='';document.querySelector('#create').onclick=async()=>{if(document.querySelector('#name').value==='Fixture'){await fetch('/fixture-reject');document.querySelector('#banner').textContent='There are one or more validation errors below.';document.querySelector('#nameError').textContent='The app name you entered is already being used.';return;}await fetch('/fixture-create');location.href='/apps/456';};};};`,
      );
    if (provider === "apple" && mode === "record") {
      if (path === "/apps")
        return page(
          "<h1>Apps</h1><button id=new>New App</button>",
          `document.querySelector('#new').onclick=()=>{document.body.insertAdjacentHTML('beforeend','<dialog open><h2>New App</h2><label>iOS<input type=checkbox></label><label>Name<input></label><label>SKU<input></label><label>Bundle ID<select><option>Pick</option><option value=bundle>com.example.fixture</option></select></label><label>Primary Language<select><option>Pick</option><option value=en-US>English (U.S.)</option></select></label><button id=create>Create</button></dialog>');document.querySelector('#create').onclick=async()=>{await fetch('/fixture-create');location.href='/apps/456';};};`,
        );
      return page(
        "<h1>Fixture</h1><ul><li>com.example.fixture</li></ul><div role=progressbar>App setup progress</div>",
      );
    }
    if (mode === "capabilities")
      return page(
        "<h1>Edit your App ID Configuration</h1><p>com.example.fixture</p><table><tr><td><label>iCloud<input type=checkbox checked></label></td><td><button id=cloud>Configure</button></td></tr><tr><td><label>App Groups<input type=checkbox checked></label></td><td><button id=groups>Configure</button></td></tr></table><button id=save>Save</button>",
        `for(const [key,id] of [['cloud','iCloud.com.example.fixture'],['groups','group.com.example.fixture']])document.querySelector('#'+key).onclick=()=>{document.body.insertAdjacentHTML('beforeend','<dialog open><h2>iCloud containers / App Groups</h2><table><tr><td>'+id+'</td><td><input type=checkbox></td></tr><tr><td>group.com.other</td><td><input type=checkbox checked></td></tr></table><button id=apply>Apply</button></dialog>');document.querySelector('#apply').onclick=()=>document.querySelector('dialog').remove();};document.querySelector('#save').onclick=()=>{document.body.insertAdjacentHTML('beforeend','<dialog open><h2>Modify capabilities?</h2><button id=confirm>Confirm</button></dialog>');document.querySelector('#confirm').onclick=()=>document.querySelector('dialog').remove();};`,
      );
    if (mode === "record") {
      if (path.endsWith("/apps") && scenario === "google-existing")
        return Response.redirect(
          "https://play.google.com/console/developers/123/app/456/app-dashboard",
        );
      if (path.endsWith("/apps"))
        return page(
          "<h1>All apps</h1><button id=new>Create app</button>",
          `document.querySelector('#new').onclick=()=>location.href='/console/developers/123/create-app';`,
        );
      if (path.endsWith("/create-app"))
        return page(
          "<h1>Create app</h1><label>App name<input></label><label>Default language<select><option>Pick</option><option value=en-US>English – en-US</option></select></label><label>App<input type=radio name=kind></label><label>Game<input type=radio name=kind></label><label>Free<input type=radio name=price></label><label>Paid<input type=radio name=price></label><label>Accept developer agreement<input id=terms type=checkbox></label><button id=create disabled>Create app</button>",
          `document.querySelector('#terms').onchange=()=>document.querySelector('#create').disabled=!document.querySelector('#terms').checked;document.querySelector('#create').onclick=async()=>{await fetch('/fixture-create');location.href='/console/developers/123/app/456/app-dashboard';};`,
        );
      return page(
        "<h1>Fixture</h1><ul><li>com.example.fixture</li></ul><div role=progressbar>App setup progress</div>",
      );
    }
    if (path.endsWith("/app-dashboard"))
      return page(
        '<h1>Fixture</h1><p>com.example.fixture</p><a href="/console/developers/123/app/456/testing/internal">Internal testing</a>',
      );
    if (path.endsWith("/releases/new"))
      return page(
        "<h1>Create internal release</h1><input type=file accept=.aab><div id=result></div>",
        `document.querySelector('input').onchange=async(e)=>{document.querySelector('#result').textContent='Uploading';await fetch('/fixture-upload',{method:'POST',body:await e.target.files[0].text()});if(${JSON.stringify(scenario === "bootstrap-uncertain")}){document.querySelector('#result').textContent='Upload result unknown';return;}document.querySelector('#result').innerHTML='<table><tr><td>App bundle 11 fixture.aab</td></tr></table><button id=save>Save as draft</button>';document.querySelector('#save').onclick=async()=>{await fetch('/fixture-draft');location.href='/console/developers/123/app/456/testing/internal';};};`,
      );
    return page(
      `<h1>Internal testing</h1>${outcome.drafts ? "<table><tr><td>Draft 11</td></tr></table>" : ""}<button id=create>Create new release</button>`,
      `document.querySelector('#create').onclick=()=>location.href='/console/developers/123/app/456/testing/internal/releases/new';`,
    );
  });
  const manager = new AccountSetupManager(engine as any, () => undefined, {
    hidden: true,
  });
  ipcMain.handle(
    "desk:invoke",
    async (event, method: Method, args: unknown[]) => {
      try {
        if (!manager.owns(event.sender)) throw Error("wrong sender");
        const values = methods[method].parse(args) as any[];
        if (method === "accountState")
          return { ok: true, value: manager.state(event.sender) };
        if (method === "approveStoreSetup")
          await manager.approveStore(event.sender);
        else if (method === "updateAccountSetup")
          manager.update(event.sender, values[0]);
        else if (method === "retryAccountAutomation")
          manager.retry(event.sender);
        else if (method === "closeAccountSetup")
          manager.get(event.sender).host.close();
        else throw Error("Unavailable");
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
  );
  await manager.openStore("fixture", request);
});
app.on("window-all-closed", () => app.quit());

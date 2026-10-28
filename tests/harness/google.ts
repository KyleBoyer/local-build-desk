import { app, session, ipcMain } from "electron";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { EventEmitter } from "node:events";
import { AccountSetupManager } from "../../src/main/account-setup";
import { methods, type Method } from "../../src/main/validation";
import type { Project } from "../../src/core/types";
const root = process.env.LOCAL_BUILD_DESK_DATA_DIR!;
mkdirSync(root, { recursive: true });
app.setPath("userData", root);
app.setName("Local Build Desk Google Replay");
if (process.platform === "darwin") app.setActivationPolicy("accessory");
const scenario = process.env.DESK_GOOGLE_SCENARIO ?? "success";
const target = {
  project: "fixture-builds",
  email: "local-build-desk@fixture-builds.iam.gserviceaccount.com",
};
const project = {
  id: "fixture",
  name: "Fixture",
  path: root,
  packageName: "com.example.fixture",
  profiles: [],
  createdAt: new Date().toISOString(),
  settings: { googleConnectionId: "original-connection" },
} as Project;
const outcome = {
  projects: 0,
  apis: [] as string[],
  services: 0,
  keys: 0,
  imports: 0,
  invites: 0,
  ...JSON.parse(
    (() => {
      try {
        return readFileSync(join(root, "outcome.json"), "utf8");
      } catch {
        return "{}";
      }
    })(),
  ),
};
const save = () =>
  writeFileSync(join(root, "outcome.json"), JSON.stringify(outcome));
let activationChecks = 0;
const engine = Object.assign(new EventEmitter(), {
  store: {
    root,
    get() {
      return project;
    },
  },
  vault: { remove() {} },
  googleCredentialDetails: async (id: string, verifyToken = true) => {
    if (
      scenario === "activation" &&
      id === "new-connection" &&
      verifyToken &&
      ++activationChecks <= 2
    )
      throw Error("Google authentication failed: Invalid JWT Signature.");
    if (id === "original-connection") {
      if (scenario === "resume-existing")
        return {
          email: "old@fixture-builds.iam.gserviceaccount.com",
          cloudProject: target.project,
        };
      throw Error("Fixture original connection is unavailable");
    }
    return { email: target.email, cloudProject: target.project };
  },
  saveCredential: async (input: any) => {
    if (
      statSync(input.keyPath).mode & 0o077 ||
      statSync(dirname(input.keyPath)).mode & 0o077
    )
      throw Error("Key download is not private");
    const data = JSON.parse(readFileSync(input.keyPath, "utf8"));
    if (data.client_email !== target.email) throw Error("Wrong account");
    outcome.imports++;
    save();
    return { id: "new-connection" };
  },
  validateConnection: async (_id: string, projectId?: string) => {
    if (_id === "original-connection" && scenario === "resume-existing")
      return "Existing app access verified";
    if (projectId !== "fixture")
      throw Error("Must verify the intended package, not just the token");
    if (!outcome.invites)
      throw Error("Google Play 403: app permissions required");
    return "Google Play permissions verified";
  },
  saveSettings(_id: string, settings: any) {
    project.settings = settings;
    writeFileSync(join(root, "settings.json"), JSON.stringify(settings));
  },
});
const page = (body: string, script = "") =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><style>body{font:15px system-ui;padding:28px;background:#fff;color:#17212b}button,a{margin:12px;padding:12px}input{margin:8px}dialog{position:relative}table{width:100%}</style></head><body>${body}<script>${script}</script></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
app.whenReady().then(async () => {
  const partition = session.fromPartition("persist:desk-account-google");
  partition.protocol.handle("https", async (request) => {
    const url = new URL(request.url),
      path = url.pathname;
    if (path === "/fixture-project") {
      outcome.projects++;
      save();
      return new Response("{}");
    }
    if (path === "/fixture-enable") {
      outcome.apis.push(url.searchParams.get("api"));
      save();
      return new Response("{}");
    }
    if (path === "/fixture-service") {
      outcome.services++;
      save();
      return new Response("{}");
    }
    if (path === "/fixture-key") {
      outcome.keys++;
      save();
      return new Response("{}", {
        status: ["ambiguous", "resume-existing"].includes(scenario) ? 503 : 200,
      });
    }
    if (path === "/fixture-invite") {
      outcome.invites++;
      save();
      return new Response("{}");
    }
    if (path === "/fixture-key.json")
      return new Response(
        JSON.stringify({
          type: "service_account",
          project_id: target.project,
          client_email: target.email,
          private_key:
            "-----BEGIN PRIVATE KEY-----\nGOOGLE_FIXTURE_PRIVATE_BYTES_NEVER_LOG\n-----END PRIVATE KEY-----",
        }),
        {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition":
              'attachment; filename="fixture-builds-key.json"',
          },
        },
      );
    if (url.hostname === "walkthroughs.googleusercontent.com")
      return page("<p>Google walkthrough</p>", "location.hash='help';");
    if (url.hostname === "console.cloud.google.com") {
      if (path === "/projectcreate")
        return page(
          '<h1>Create project</h1><label>Project name<input></label><label>Project ID<input></label><button id="project">Create</button>',
          `document.querySelector('#project').onclick=async()=>{await fetch('/fixture-project');location.href='https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com?project=fixture-builds';};`,
        );

      if (path.includes("/apis/api/"))
        return page(
          "<h1>API/Service Details</h1><button>Disable API</button><p>Status Enabled</p>",
        );
      if (path.includes("/apis/library/")) {
        const api = path.split("/").pop()!;
        return page(
          `<h1>${api}</h1><button id=enable>${outcome.apis.includes(api) ? "Manage" : "Enable"}</button>`,
          `document.querySelector('#enable').onclick=async()=>{await fetch('/fixture-enable?api=${api}');location.href='https://console.cloud.google.com/apis/api/${api}/metrics?project=fixture-builds';}`,
        );
      }
      if (path.includes("/serviceaccounts/create"))
        return page(
          "<h1>Create service account</h1><label>Service account name<input></label><label>Service account ID<input></label><button id=create>Create and continue</button>",
          `document.querySelector('#create').onclick=async()=>{await fetch('/fixture-service');location.href='https://console.cloud.google.com/iam-admin/serviceaccounts?project=fixture-builds';};`,
        );
      if (path.includes("/serviceaccounts/details/"))
        return page(
          `<h1>Local Build Desk</h1><p>Google automatically disables service account keys detected in public repositories. Configure the iam.serviceAccountKeyExposureResponse organization policy. Block service account key creation using organization policies.</p><button id=add>Add key</button>`,
          `document.querySelector('#add').onclick=()=>{if(document.querySelector('#new'))return;document.body.insertAdjacentHTML('beforeend','<div id="new" role="menuitem">Create new key</div>');document.querySelector('#new').onclick=()=>{document.querySelector('#new').remove();document.body.insertAdjacentHTML('beforeend','<dialog open role="dialog"><h2>Key type</h2><label><input type="radio" name="type">JSON</label><label><input type="radio" name="type">P12</label><button id="key">Create</button></dialog>');document.querySelector('#key').onclick=async()=>{await fetch('/fixture-key');if(${JSON.stringify(["ambiguous", "resume-existing"].includes(scenario))})return;const link=document.createElement('a');link.href='https://console.cloud.google.com/fixture-key.json';link.download='fixture-builds-key.json';document.body.append(link);link.click();};};};`,
        );
      return page(
        `<h1>Service accounts</h1>${outcome.services ? `<table><tr><td><a href="/iam-admin/serviceaccounts/details/111/keys?project=fixture-builds">${target.email}</a></td></tr></table>` : '<button id="more" aria-label="More actions Service accounts">More actions</button>'}`,
        `const more=document.querySelector('#more');if(more)more.onclick=()=>{if(!document.querySelector('#create-link'))document.body.insertAdjacentHTML('beforeend','<a id="create-link" role="menuitem" href="/iam-admin/serviceaccounts/create?project=fixture-builds">Create service account</a>');};`,
      );
    }
    if (url.hostname === "play.google.com") {
      if (path === "/console/developers")
        return page(
          '<div role="listbox"><div role="option" id="developer">Fixture developer</div></div>',
          `document.querySelector('#developer').onclick=()=>location.href='/console/developers/123/apps';`,
        );
      if (path.endsWith("/invite-user"))
        return page(
          "<iframe hidden src=https://walkthroughs.googleusercontent.com/tutorial></iframe><h1>Invite user</h1><span id=email-label>Email address</span><input type=email aria-label=user@example.com aria-labelledby=email-label><button role=tab aria-selected=true>App permissions</button><div id=apps><button id=add-app>Add app<material-icon role=img aria-hidden=true>arrow_drop_down</material-icon></button></div><button id=invite>Invite user</button>",
          `let selected=false;const edit=()=>{document.body.insertAdjacentHTML('beforeend','<dialog open role="dialog"><h2>Permissions for Fixture</h2><span id="read">View app information (read-only)<div class="pc-help-text">View information but not financial data. No production changes.</div></span><input type="checkbox" checked aria-labelledby="read"><span id="quality">View app quality information (read-only)</span><input type="checkbox" disabled checked aria-labelledby="quality"><span id="release">Release apps to testing tracks<div class="pc-help-text">No production publishing.</div></span><input type="checkbox" aria-labelledby="release"><button id="save-permissions">Apply</button></dialog>');document.querySelector('#save-permissions').onclick=()=>{document.querySelector('dialog').remove();document.querySelector('#apps').innerHTML='<table><tr><td>com.example.fixture</td><td>3</td><td><button id="manage">Manage permissions</button></td></tr></table>';document.querySelector('#manage').onclick=edit;};};document.querySelector('#add-app').onclick=()=>{document.body.insertAdjacentHTML('beforeend','<div id="picker"><div role="listbox" aria-label="Apps to select from"><div role="option">Select all<input type="checkbox"></div><div role="option">Fixture com.example.fixture<input id="target-app" type="checkbox" aria-label="Select row"></div></div><button id="apply">Apply</button></div>');document.querySelector('#target-app').onchange=()=>document.querySelector('#picker input').checked=document.querySelector('#target-app').checked;document.querySelector('#apply').onclick=()=>{selected=document.querySelector('#target-app').checked;document.querySelector('#picker').remove();if(selected)edit();};};document.querySelector('#invite').onclick=()=>{document.body.insertAdjacentHTML('beforeend','<dialog open role=dialog><h2>Send invite?</h2><p>local-build-desk@fixture-builds.iam.gserviceaccount.com will be invited to access Fixture</p><button id=confirm-invite>Send invite</button></dialog>');document.querySelector('#confirm-invite').onclick=async()=>{await fetch('/fixture-invite');location.href='/console/developers/123/users-and-permissions';};};`,
        );
      if (path.includes("/users-and-permissions"))
        return page(
          `<h1>Users and permissions</h1>${outcome.invites ? `<table><tr><td>${target.email}</td></tr></table>` : '<a href="/console/developers/123/users-and-permissions/invite-user">Invite new user</a>'}`,
        );
      return page(
        '<h1>All apps</h1><table><tr><td>com.example.fixture</td></tr></table><a href="/console/developers/123/users-and-permissions">Users and permissions</a>',
      );
    }
    return page("<h1>Sign in</h1>");
  });
  const manager = new AccountSetupManager(engine as any, () => undefined, {
    hidden: true,
  });
  ipcMain.handle(
    "desk:invoke",
    async (event, method: Method, args: unknown[]) => {
      try {
        if (!manager.owns(event.sender)) throw Error("Unexpected sender");
        const values = methods[method].parse(args) as any[];
        switch (method) {
          case "accountState":
            return { ok: true, value: manager.state(event.sender) };
          case "updateAccountSetup":
            manager.update(event.sender, values[0]);
            break;
          case "approveGoogleSetup":
            await manager.approveGoogle(event.sender);
            break;
          case "retryAccountAutomation":
            manager.retry(event.sender);
            break;
          case "accountNavigate":
            await manager.navigate(event.sender, values[0]);
            break;
          case "completeAccountSetup":
            await manager.complete(event.sender);
            break;
          case "closeAccountSetup":
            manager.get(event.sender).host.close();
            break;
          default:
            throw Error("Unavailable in fixture");
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
  );
  await manager.open(
    project.id,
    "google",
    "connection",
    scenario === "cli-fallback" ? "new-connection" : undefined,
  );
});
app.on("window-all-closed", () => app.quit());

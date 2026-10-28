import { app, session, ipcMain } from "electron";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { AccountSetupManager } from "../../src/main/account-setup";
import { methods, type Method } from "../../src/main/validation";
import type { Project } from "../../src/core/types";
import { EventEmitter } from "node:events";
const root = process.env.LOCAL_BUILD_DESK_DATA_DIR!;
mkdirSync(root, { recursive: true });
app.setPath("userData", root);
app.setName("Local Build Desk Test");
if (process.platform === "darwin") app.setActivationPolicy("accessory");
const project = {
  id: "fixture",
  name: "Fixture",
  settings: {},
  path: root,
} as Project;
try {
  project.settings = JSON.parse(
    readFileSync(join(root, "settings.json"), "utf8"),
  );
} catch {}
const scenario = process.env.DESK_REPLAY_SCENARIO ?? "success";
const isXcode = scenario.startsWith("xcode");
if (isXcode)
  project.settings = {
    ...project.settings,
    buildDirectory: root,
    minimumIosSdk: "27.2",
  };
let outcomes = { generated: 0, credentials: 0, validated: 0 };
try {
  outcomes = JSON.parse(readFileSync(join(root, "outcomes.json"), "utf8"));
} catch {}
const save = () =>
  writeFileSync(join(root, "outcomes.json"), JSON.stringify(outcomes));
const events = new EventEmitter();
const engine = Object.assign(events, {
  store: {
    root,
    get() {
      return project;
    },
  },
  saveCredential: async (input: { keyPath: string }) => {
    if (
      statSync(input.keyPath).mode & 0o077 ||
      statSync(dirname(input.keyPath)).mode & 0o077
    )
      throw new Error("Downloaded key permissions are too broad");
    outcomes.credentials++;
    save();
    return { id: "connected" };
  },
  validateConnection: async () => {
    outcomes.validated++;
    save();
    return "verified";
  },
  saveSettings(_id: string, settings: any) {
    project.settings = settings;
    writeFileSync(join(root, "settings.json"), JSON.stringify(settings));
  },
  installXcode: async (_id: string, path: string, acceptLicense: boolean) => {
    events.emit("event", {
      type: "log",
      jobId: "setup:fixture",
      entry: {
        time: new Date().toISOString(),
        stage: "configure",
        text: "Fixture iOS component progress: 50%",
      },
    });
    const callsPath = join(root, "xcode-calls.json");
    let calls: { path: string; acceptLicense: boolean }[] = [];
    try {
      calls = JSON.parse(readFileSync(callsPath, "utf8"));
    } catch {}
    calls.push({ path, acceptLicense });
    writeFileSync(callsPath, JSON.stringify(calls));
    if (scenario === "xcode-failure" && calls.length === 1)
      throw new Error("Fixture Xcode download validation failed");
    return {
      installation: {
        developerDirectory: join(
          root,
          "toolchains/Xcode-27.2.app/Contents/Developer",
        ),
        version: "27.2",
        build: "27B48",
        iosSdks: ["27.2"],
        selected: true,
      },
      requiresLicense: !acceptLicense,
      licenseText: "Fixture Xcode and Apple SDKs Agreement",
    };
  },
  vault: { remove() {} },
});
app.whenReady().then(async () => {
  const provider = session.fromPartition("persist:desk-account-apple");
  let apiVisits = 0;
  const html = readFileSync(
    join(process.cwd(), "tests/fixtures/apple/keys-live.html"),
    "utf8",
  );
  const script = `<script>
 const showDialog=()=>{document.body.insertAdjacentHTML('beforeend','<dialog open role="dialog"><h2>Generate API Key</h2><label>Name<input id="name" name="name"></label><label>Access</label><div id="roles"><input name="roles" placeholder="Select Roles"></div><button id="generate" disabled>Generate</button></dialog>');
 const modal=document.querySelector('dialog');const name=modal.querySelector('#name');const roles=modal.querySelector('input[name=roles]');const generate=modal.querySelector('#generate');const update=()=>generate.disabled=!(name.value&&document.querySelector('#roles .chip'));name.addEventListener('input',update);roles.addEventListener('focus',()=>{if(document.querySelector('[role=menu]'))return;document.body.insertAdjacentHTML('beforeend','<div role="menu"><button id="admin">Admin</button></div>');document.querySelector('#admin').onclick=()=>{document.querySelector('#roles').insertAdjacentHTML('afterbegin','<span class="chip">Admin</span>');document.querySelector('[role=menu]').remove();update();};});generate.onclick=()=>{fetch('/fixture-generated',{method:'POST'});if(${JSON.stringify(scenario === "ambiguous")})return;modal.remove();document.querySelector('tbody').insertAdjacentHTML('afterbegin','<tr role="row"><td>Local Build Desk</td><td>TESTKEY123</td><td><button class="download">Download API Key</button></td></tr>');document.querySelector('.download').onclick=()=>{document.body.insertAdjacentHTML('beforeend','<dialog open role="dialog"><h2>Download API Key</h2><p>You can only download this key once.</p><button id="download-confirm">Download</button></dialog>');document.querySelector('#download-confirm').onclick=()=>{const link=document.createElement('a');link.href='https://appstoreconnect.apple.com/fixture-key.p8';link.download='AuthKey_TESTKEY123.p8';document.body.append(link);link.click();document.querySelector('dialog').remove();};};};};
 const heading=[...document.querySelectorAll('h3')].find(h=>h.textContent?.trim()==='Active (1)');heading.parentElement.querySelector('button').onclick=showDialog;
 if(${JSON.stringify(scenario === "ambiguous" && outcomes.generated > 0)}){showDialog();document.querySelector('#name').value='Local Build Desk';document.querySelector('#roles').insertAdjacentHTML('afterbegin','<span class="chip">Admin</span>');document.querySelector('#generate').disabled=false;}
 </script>`;
  provider.protocol.handle("https", async (request) => {
    const url = new URL(request.url);
    if (isXcode) {
      if (url.pathname.endsWith(".xip"))
        return new Response("fixture xip bytes", {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition":
              'attachment; filename="Xcode_27.2_Release_Candidate.xip"',
          },
        });
      return new Response(
        '<h1>Apple downloads</h1><a href="https://download.developer.apple.com/Developer_Tools/Xcode_26.6/Xcode_26.6.xip">Xcode 26.6</a><a href="https://download.developer.apple.com/Developer_Tools/Xcode_27.2_Release_Candidate/Xcode_27.2_Release_Candidate.xip">Xcode 27.2 RC</a>',
        { headers: { "Content-Type": "text/html" } },
      );
    }
    if (url.pathname === "/fixture-generated") {
      outcomes.generated++;
      save();
      return new Response("{}", {
        status: scenario === "ambiguous" ? 503 : 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/fixture-key.p8")
      return new Response(
        "TEST_PRIVATE_KEY_BYTES_MUST_NOT_APPEAR_IN_DIAGNOSTICS",
        {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition":
              'attachment; filename="AuthKey_TESTKEY123.p8"',
          },
        },
      );
    if (url.hostname === "developer.apple.com")
      return new Response(
        "<h1>Membership details</h1><p>Team ID</p><p>TEAM123456</p>",
        { headers: { "Content-Type": "text/html" } },
      );
    if (url.pathname.includes("/access/integrations/api") && apiVisits++ === 0)
      return new Response(
        '<script>location.replace("https://appstoreconnect.apple.com/apps")</script>',
        { headers: { "Content-Type": "text/html" } },
      );
    if (url.pathname === "/apps")
      return new Response("<h1>Apps</h1>", {
        headers: { "Content-Type": "text/html" },
      });
    return new Response(html + script, {
      headers: { "Content-Type": "text/html" },
    });
  });
  const manager = new AccountSetupManager(engine as any, () => undefined, {
    hidden: true,
  });
  ipcMain.handle(
    "desk:invoke",
    async (event, method: Method, args: unknown[]) => {
      try {
        if (!manager.owns(event.sender)) throw new Error("Unexpected caller");
        const values = methods[method].parse(args) as any[];
        switch (method) {
          case "accountState":
            return { ok: true, value: manager.state(event.sender) };
          case "approveAccountKey":
            await manager.approveKey(event.sender);
            break;
          case "approveXcodeLicense":
            await manager.approveXcodeLicense(event.sender);
            break;
          case "accountNavigate":
            await manager.navigate(event.sender, values[0]);
            break;
          case "updateAccountSetup":
            manager.update(event.sender, values[0]);
            break;
          case "retryAccountAutomation":
            manager.retry(event.sender);
            break;
          case "completeAccountSetup":
            await manager.complete(event.sender);
            break;
          case "closeAccountSetup":
            manager.get(event.sender).host.close();
            break;
          default:
            throw new Error("Not available in test harness");
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
  );
  await manager.open(project.id, "apple", isXcode ? "xcode" : "connection");
});
app.on("window-all-closed", () => app.quit());

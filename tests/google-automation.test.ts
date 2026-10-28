import { it, expect } from "vitest";
import { JSDOM } from "jsdom";
import {
  inspectGooglePage,
  matchesGoogleServiceRoute,
  performGoogleAction,
  type GoogleTarget,
  type GoogleActionType,
} from "../src/main/google-automation";
const target: GoogleTarget = {
  cloudProject: "fixture-builds",
  email: "local-build-desk@fixture-builds.iam.gserviceaccount.com",
  packageName: "com.example.fixture",
  appName: "Fixture",
};
function page(
  html: string,
  path = "https://console.cloud.google.com/iam-admin/serviceaccounts?project=fixture-builds",
) {
  const dom = new JSDOM(html, { url: path, runScripts: "outside-only" });
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
const probe = (dom: JSDOM) =>
  dom.window.eval(
    `(${inspectGooglePage.toString()})(${JSON.stringify(target)})`,
  ) as ReturnType<typeof inspectGooglePage>;
const act = (dom: JSDOM, type: GoogleActionType) =>
  dom.window.eval(
    `(${performGoogleAction.toString()})(${JSON.stringify({ type, target })})`,
  ) as ReturnType<typeof performGoogleAction>;
it("recognizes Google login and browser blocks without collecting auth values", () => {
  const dom = page(
    "<input type=email value=private@example.com><input type=password value=never-log-this><input autocomplete=one-time-code value=123456>",
    "https://accounts.google.com/signin",
  );
  expect(probe(dom)).toEqual({ phase: "login" });
  expect(act(dom, "fill-invite").done).toBe(false);
  dom.window.document.body.append("This browser or app may not be secure");
  expect(probe(dom).phase).toBe("blocked-login");
});
it("prepares a Cloud project without submitting or accepting terms", () => {
  const dom = page(
    "<label>Project name<input></label><label>Project ID<input></label><button>Create</button>",
    "https://console.cloud.google.com/projectcreate",
  );
  let clicks = 0;
  dom.window.document.querySelector("button")!.onclick = () => clicks++;
  expect(act(dom, "fill-project").done).toBe(true);
  expect(probe(dom).formReady).toBe(true);
  expect(clicks).toBe(0);
  dom.window.document.body.innerHTML =
    "<label><input type=checkbox>Accept Terms of Service</label><button>Agree and continue</button>";
  expect(probe(dom).phase).toBe("terms");
  expect(
    (dom.window.document.querySelector("input") as HTMLInputElement).checked,
  ).toBe(false);
});
it("fills a service account and skips project-wide role grants", () => {
  const dom = page(
    "<label>Service account name<input></label><label>Service account ID<input></label><button>Create and continue</button>",
    "https://console.cloud.google.com/iam-admin/serviceaccounts/create?project=fixture-builds",
  );
  expect(act(dom, "fill-service").done).toBe(true);
  expect(probe(dom).formReady).toBe(true);
  dom.window.document.body.innerHTML =
    "<h2>Grant this service account access</h2><select><option>Select a role</option><option>Owner</option></select><button>Done</button>";
  expect(probe(dom).phase).toBe("service-grants");
  expect(dom.window.document.querySelector("select")!.selectedIndex).toBe(0);
});
it("detects an existing matching service account and scoped key controls", () => {
  const dom = page(
    `<table><tr><td><a href="/iam-admin/serviceaccounts/details/123/keys?project=fixture-builds">${target.email}</a></td></tr></table>`,
  );
  expect(probe(dom).serviceUrl).toContain("/details/123/keys");
  expect(probe(dom).servicePresent).toBe(true);
  dom.reconfigure({
    url: "https://console.cloud.google.com/iam-admin/serviceaccounts/details/123/keys?project=fixture-builds",
  });
  dom.window.document.body.innerHTML = `<h1>${target.email}</h1><button>Add key</button><button role=menuitem>Create new key</button><dialog open><h2>Key type</h2><label><input type=radio name=type>JSON</label><label><input type=radio name=type>P12</label><button>Create</button></dialog>`;
  expect(probe(dom).phase).toBe("key-dialog");
  expect(act(dom, "select-json").done).toBe(true);
  expect(probe(dom).formReady).toBe(true);
});
it("stops for organization policy instead of automating a policy bypass", () => {
  expect(
    probe(
      page(
        "<h1>Service account key creation is disabled by organization policy</h1>",
      ),
    ).phase,
  ).toBe("policy");
});
function invite(extra = "", selected = true) {
  return page(
    `<input type=email aria-label="Email address" value="${target.email}"><button role=tab aria-selected=${selected}>App permissions</button><section role=group>${target.packageName}</section><label><input type=checkbox checked>View app information (read-only)</label><label><input type=checkbox checked>Release apps to testing tracks</label>${extra}<button>Invite user</button>`,
    "https://play.google.com/console/developers/123/users-and-permissions/invite-user",
  );
}
it("requires exactly app-scoped read and testing access before invitation approval", () => {
  const material = invite();
  const section = material.window.document.querySelector("section")!;
  for (const label of [...material.window.document.querySelectorAll("label")])
    section.append(label);
  expect(probe(material).appScoped).toBe(true);
  const dom = invite();
  expect(probe(dom)).toMatchObject({
    phase: "play-invite",
    formReady: true,
    appScoped: true,
    permissionsReady: true,
    unsafePermissions: false,
  });
  for (const extra of [
    "<label><input type=checkbox checked>Release to production</label>",
    "<label><input type=checkbox checked>View financial data</label>",
    "<label><input type=checkbox checked>Admin (all permissions)</label>",
  ])
    expect(probe(invite(extra)).unsafePermissions).toBe(true);
  expect(probe(invite("", false)).appScoped).toBe(false);
  expect(
    probe(invite('<section role="group">uk.co.other</section>')).appScoped,
  ).toBe(false);
  expect(
    probe(invite("<table><tr><td>uk.co.other</td></tr></table>")).appScoped,
  ).toBe(false);
  expect(
    probe(invite("<table><tr><td>com.other.app</td></tr></table>")).appScoped,
  ).toBe(false);
});
it("selects only the exact package and never toggles legal declarations", () => {
  const dom = page(
    '<dialog open><h2>Select apps</h2><table><tr><td>com.example.fixture</td><td><input type=checkbox aria-label="com.example.fixture"></td></tr><tr><td>com.other.app</td><td><input type=checkbox aria-label="com.other.app"></td></tr></table><button>Apply</button></dialog>',
    "https://play.google.com/console/developers/123/users-and-permissions/invite-user",
  );
  expect(act(dom, "select-app").done).toBe(true);
  expect(probe(dom).targetAppPresent).toBe(true);
  expect(probe(dom).unsafePermissions).toBe(false);
  (
    dom.window.document.querySelectorAll("input")[1] as HTMLInputElement
  ).checked = true;
  expect(probe(dom).unsafePermissions).toBe(true);
});

it("handles the live Cloud API accessible labels and nested sign-in control", () => {
  const dom = page(
    '<a><button aria-label="Sign into Google Cloud Platform">Sign into Google Cloud Platform</button></a><button aria-label="enable this API">Enable</button>',
    "https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com?project=fixture-builds",
  );
  let signedIn = 0;
  dom.window.document.querySelector("button")!.onclick = (event) => {
    event.preventDefault();
    signedIn++;
  };
  expect(probe(dom).phase).toBe("signed-out");
  expect(act(dom, "sign-in").done).toBe(true);
  expect(signedIn).toBe(1);
  dom.window.document.querySelector("a")!.remove();
  expect(act(dom, "enable-api").done).toBe(true);
  dom.window.document
    .querySelector("button")!
    .setAttribute("aria-label", "manage this API");
  expect(probe(dom).apiEnabled).toBe(true);
});

it("recognizes the real API metrics redirect as enabled without clicking Disable API", () => {
  const dom = page(
    "<h1>API/Service Details</h1><button>Disable API</button><p>Status Enabled</p>",
    "https://console.cloud.google.com/apis/api/iam.googleapis.com/metrics?project=fixture-builds",
  );
  expect(probe(dom)).toMatchObject({
    phase: "api",
    apiEnabled: true,
    cloudProject: "fixture-builds",
  });
  let disabled = 0;
  dom.window.document.querySelector("button")!.onclick = () => disabled++;
  expect(act(dom, "enable-api").done).toBe(false);
  expect(disabled).toBe(0);
});

it("opens the responsive service-account toolbar before locating Create", () => {
  const dom = page(
    '<button aria-label="More actions Service accounts">More actions</button>',
  );
  dom.window.document.querySelector("button")!.onclick = () =>
    dom.window.document.body.insertAdjacentHTML(
      "beforeend",
      '<button role="menuitem">Create service account</button>',
    );
  expect(probe(dom).serviceMenuOpen).toBe(false);
  expect(act(dom, "open-service-create").done).toBe(true);
  expect(probe(dom).serviceMenuOpen).toBe(true);
  let created = 0;
  (
    dom.window.document.querySelector("[role=menuitem]") as HTMLElement
  ).onclick = () => created++;
  expect(act(dom, "open-service-create").done).toBe(true);
  expect(created).toBe(1);
});

it("does not mistake the real keys-page security recommendations for an enforced policy", () => {
  const dom = page(
    "<h1>Local Build Desk</h1><p>Service account keys could pose a security risk if compromised.</p><p>Google automatically disables service account keys detected in public repositories. You can customize this behavior by using the iam.serviceAccountKeyExposureResponse organization policy.</p><p>Block service account key creation using organization policies.</p><button>Add key</button>",
    "https://console.cloud.google.com/iam-admin/serviceaccounts/details/123/keys?project=fixture-builds",
  );
  expect(probe(dom).phase).toBe("service-details");
  dom.window.document.body.append(
    " Service account key creation is disabled in this organization.",
  );
  expect(probe(dom).phase).toBe("policy");
});
it("pins the selected service identity across detail, keys and dialog pages", () => {
  const pinned =
    "https://console.cloud.google.com/iam-admin/serviceaccounts/details/123?project=fixture-builds";
  expect(
    matchesGoogleServiceRoute(
      pinned.replace("?", "/keys?"),
      pinned,
      "fixture-builds",
    ),
  ).toBe(true);
  expect(
    matchesGoogleServiceRoute(
      pinned.replace("123", "1234"),
      pinned,
      "fixture-builds",
    ),
  ).toBe(false);
  expect(
    matchesGoogleServiceRoute(
      pinned.replace("fixture-builds", "another-project"),
      pinned,
      "fixture-builds",
    ),
  ).toBe(false);
  expect(
    matchesGoogleServiceRoute(
      pinned.replace("console.cloud.google.com", "example.com"),
      pinned,
      "fixture-builds",
    ),
  ).toBe(false);
});

it("recognizes custom menu items before requesting a new key", () => {
  const dom = page(
    `<h1>${target.email}</h1><button>Add key</button><div role="menuitem">Create new key</div>`,
    "https://console.cloud.google.com/iam-admin/serviceaccounts/details/123/keys?project=fixture-builds",
  );
  expect(probe(dom).keyMenuOpen).toBe(true);
  let clicked = 0;
  (
    dom.window.document.querySelector("[role=menuitem]") as HTMLElement
  ).onclick = () => clicked++;
  expect(act(dom, "new-key").done).toBe(true);
  expect(clicked).toBe(1);
});
it("fills Google's externally labelled email control", () => {
  const dom = page(
    '<span id="email-label">Email address</span><input type=email aria-label="user@example.com" aria-labelledby="email-label">',
    "https://play.google.com/console/developers/123/users-and-permissions/invite",
  );
  expect(act(dom, "fill-invite").done).toBe(true);
  expect(dom.window.document.querySelector("input")!.value).toBe(target.email);
});
it("selects a sole Play developer option and requires choice for multiple accounts", () => {
  const dom = page(
    "<div role=listbox><div role=option>BoyerLabs</div></div>",
    "https://play.google.com/console/developers",
  );
  let clicks = 0;
  dom.window.document
    .querySelector("[role=option]")!
    .addEventListener("click", () => clicks++);
  expect(probe(dom).singleAccountOption).toBe(true);
  expect(act(dom, "select-developer").done).toBe(true);
  expect(clicks).toBe(1);
  dom.window.document
    .querySelector("[role=listbox]")!
    .insertAdjacentHTML("beforeend", "<div role=option>Other account</div>");
  expect(probe(dom).singleAccountOption).toBe(false);
  expect(act(dom, "select-developer").done).toBe(false);
  expect(clicks).toBe(1);
});

it("ignores decorative Google icon text and reads external checkbox labels", () => {
  const dom = page(
    "<input type=email><button role=tab aria-selected=true>App permissions</button><button id=add>Add app<material-icon role=img>arrow_drop_down</material-icon></button><section>com.example.fixture<span id=read>View app information (read-only)</span><input type=checkbox aria-labelledby=read><span id=release>Release apps to testing tracks</span><input type=checkbox aria-labelledby=release></section><button>Invite user</button>",
    "https://play.google.com/console/developers/123/users-and-permissions/invite",
  );
  let clicked = false;
  dom.window.document
    .querySelector("#add")!
    .addEventListener("click", () => (clicked = true));
  expect(act(dom, "open-apps").done).toBe(true);
  expect(clicked).toBe(true);
  expect(act(dom, "select-permissions").done).toBe(true);
  expect(probe(dom).permissionsReady).toBe(true);
});

it("ignores auto-selected Select all header when the only selected app is the target", () => {
  const dom = page(
    '<div role=listbox aria-label="Apps to select from"><div role=option>Select all<input type=checkbox checked></div><div role=option>com.example.fixture<input type=checkbox checked></div><button>Apply</button></div>',
    "https://play.google.com/console/developers/123/users-and-permissions/invite",
  );
  expect(probe(dom)).toMatchObject({
    phase: "play-app-select",
    targetAppPresent: true,
    unsafePermissions: false,
  });
  dom.window.document
    .querySelector("[role=listbox]")!
    .insertAdjacentHTML(
      "beforeend",
      "<div role=option>com.example.other<input type=checkbox checked></div>",
    );
  expect(probe(dom).unsafePermissions).toBe(true);
});

it("confirms only the intended service-account invitation with app scope visible", () => {
  const dom = page(
    "<button role=tab aria-selected=true>App permissions</button><table><tr><td>com.example.fixture</td><td>3</td></tr></table><dialog open role=dialog><h2>Send invite?</h2><p>local-build-desk@fixture-builds.iam.gserviceaccount.com will be invited to access Fixture</p><button>Send invite</button></dialog>",
    "https://play.google.com/console/developers/123/users-and-permissions/invite",
  );
  let clicks = 0;
  dom.window.document
    .querySelector("dialog button")!
    .addEventListener("click", () => clicks++);
  expect(probe(dom)).toMatchObject({
    phase: "play-invite-confirm",
    appScoped: true,
    unsafePermissions: false,
  });
  expect(act(dom, "confirm-invite").done).toBe(true);
  expect(clicks).toBe(1);
  dom.window.document.querySelector("dialog p")!.textContent =
    "other@example.com will be invited";
  expect(act(dom, "confirm-invite").done).toBe(false);
  expect(clicks).toBe(1);
});

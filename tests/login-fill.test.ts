// @vitest-environment jsdom
import { beforeAll, expect, it, vi } from "vitest";
import { FILL, FORMS } from "../src/main/login-fill";

beforeAll(() => {
  // jsdom doesn't lay out. Elements get a box unless they or an ancestor are
  // marked collapsed, which stands in for Apple's zero-height section.
  HTMLElement.prototype.getBoundingClientRect = function () {
    const collapsed = !!this.closest("[data-collapsed]");
    const size = collapsed && this.hasAttribute("data-collapsed") ? 0 : 10;
    return { width: 100, height: size, top: 0, left: 0 } as DOMRect;
  };
  const style = window.getComputedStyle;
  window.getComputedStyle = (el: Element) => {
    const computed = style(el);
    return el.hasAttribute("data-collapsed")
      ? ({
          ...computed,
          display: "block",
          visibility: "visible",
          overflowX: "hidden",
          overflowY: "hidden",
        } as CSSStyleDeclaration)
      : ({
          ...computed,
          display: "block",
          visibility: "visible",
          overflowX: "visible",
          overflowY: "visible",
        } as CSSStyleDeclaration);
  };
});

const run = (args: object) =>
  // eslint-disable-next-line no-eval
  (0, eval)(`(${FILL})`)(args) as string;
const value = (id: string) =>
  (document.getElementById(id) as HTMLInputElement).value;
const login = {
  form: FORMS.apple,
  account: "dev@example.com",
  username: "dev@example.com",
  password: "secret",
};

// Apple's sign-in as it renders today: the password field is already in the
// page, inside an aria-hidden section collapsed to zero height.
const appleFirstStep = `
  <form>
    <input id="account_name_text_field">
    <div class="password" aria-hidden="true">
      <div data-collapsed><input id="password_text_field" type="password" tabindex="-1"></div>
    </div>
    <button id="sign-in" type="button">Continue</button>
  </form>`;
const appleSecondStep = (account: string) => `
  <form>
    <input id="account_name_text_field" value="${account}">
    <div class="password"><div><input id="password_text_field" type="password"></div></div>
    <button id="sign-in" type="button">Sign In</button>
  </form>`;

it("types the Apple ID first while Apple's password field is still collapsed", async () => {
  document.body.innerHTML = appleFirstStep;
  const click = vi.fn();
  document.getElementById("sign-in")!.addEventListener("click", click);
  expect(run(login)).toBe("username");
  expect(value("account_name_text_field")).toBe("dev@example.com");
  expect(value("password_text_field")).toBe("");
  await new Promise((r) => setTimeout(r, 200));
  expect(click).toHaveBeenCalledTimes(1);
  // Still collapsed (Apple hasn't answered yet): nothing to do.
  expect(run(login)).toBe("");
  expect(value("password_text_field")).toBe("");
});

it("fills the password once Apple shows it, and only once", async () => {
  document.body.innerHTML = appleSecondStep("dev@example.com");
  const click = vi.fn();
  document.getElementById("sign-in")!.addEventListener("click", click);
  expect(run(login)).toBe("password");
  expect(value("password_text_field")).toBe("secret");
  await new Promise((r) => setTimeout(r, 200));
  expect(click).toHaveBeenCalledTimes(1);
  // Both filled: a refused password isn't retyped.
  expect(run(login)).toBe("");
});

it("never types the saved password under a different Apple ID", () => {
  document.body.innerHTML = appleSecondStep("someone.else@example.com");
  expect(run(login)).toBe("");
  expect(value("password_text_field")).toBe("");
});

it("switches a passkey-first prompt to the password", () => {
  document.body.innerHTML = `
    <input id="account_name_text_field" value="dev@example.com">
    <div aria-hidden="true"><input id="password_text_field" type="password"></div>
    <button id="continue-password" type="button">Continue with Password</button>`;
  const reveal = vi.fn();
  document
    .getElementById("continue-password")!
    .addEventListener("click", reveal);
  expect(run(login)).toBe("reveal");
  expect(reveal).toHaveBeenCalledTimes(1);
});

it("waits for the username allowance instead of skipping to the password", () => {
  document.body.innerHTML = appleFirstStep.replace(
    /aria-hidden="true"|data-collapsed/g,
    "",
  );
  // The username was typed recently, so only the password is allowed; the
  // account field is empty again (Apple reset it), so do nothing.
  expect(run({ ...login, username: undefined })).toBe("");
  expect(value("password_text_field")).toBe("");
});

it("fills Google's identifier, then its password page", () => {
  const google = { ...login, form: FORMS.google };
  document.body.innerHTML = `<input type="email" name="identifier" id="identifierId"><div id="identifierNext"><button>Next</button></div>`;
  expect(run(google)).toBe("username");
  document.body.innerHTML = `<input type="password" name="Passwd"><div id="passwordNext"><button>Next</button></div>`;
  expect(run(google)).toBe("password");
});

it("leaves the password alone when it isn't offered", () => {
  document.body.innerHTML = `<input id="password_text_field" type="password">`;
  expect(run({ ...login, password: undefined })).toBe("");
  expect(value("password_text_field")).toBe("");
});

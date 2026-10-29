// @vitest-environment jsdom
import { beforeAll, expect, it, vi } from "vitest";
import { FILL, FORMS } from "../src/main/login-fill";

beforeAll(() => {
  // jsdom doesn't lay out; treat every element as visible.
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    get: () => document.body,
  });
});

const run = (args: object) =>
  // eslint-disable-next-line no-eval
  (0, eval)(`(${FILL})`)(args) as string;

it("fills Apple's sign-in one step at a time and continues", async () => {
  document.body.innerHTML = `
    <form><input id="account_name_text_field"><input id="password_text_field">
    <button id="sign-in" type="button">Continue</button></form>`;
  const click = vi.fn();
  document.getElementById("sign-in")!.addEventListener("click", click);
  const typed = vi.fn();
  document
    .getElementById("account_name_text_field")!
    .addEventListener("input", typed);
  const args = {
    form: FORMS.apple,
    username: "dev@example.com",
    password: "secret",
  };
  // The password field comes first when it's showing and empty.
  expect(run({ form: FORMS.apple, username: "dev@example.com" })).toBe(
    "username",
  );
  expect(
    (document.getElementById("account_name_text_field") as HTMLInputElement)
      .value,
  ).toBe("dev@example.com");
  expect(typed).toHaveBeenCalled();
  expect(run(args)).toBe("password");
  await new Promise((r) => setTimeout(r, 200));
  expect(click).toHaveBeenCalledTimes(2);
  // Both filled: nothing more to do, so a rejected password isn't retyped.
  expect(run(args)).toBe("");
});

it("fills Google's identifier, then its password page", () => {
  document.body.innerHTML = `<input type="email" name="identifier" id="identifierId"><div id="identifierNext"><button>Next</button></div>`;
  expect(
    run({
      form: FORMS.google,
      username: "dev@example.com",
      password: "secret",
    }),
  ).toBe("username");
  document.body.innerHTML = `<input type="password" name="Passwd"><div id="passwordNext"><button>Next</button></div>`;
  expect(
    run({
      form: FORMS.google,
      username: "dev@example.com",
      password: "secret",
    }),
  ).toBe("password");
});

it("leaves the password alone when it isn't offered", () => {
  document.body.innerHTML = `<input id="password_text_field">`;
  expect(run({ form: FORMS.apple, username: "dev@example.com" })).toBe("");
  expect(
    (document.getElementById("password_text_field") as HTMLInputElement).value,
  ).toBe("");
});

import type { WebContents } from "electron";

// Fills a saved Apple ID or Google account into the sign-in pages shown in
// the desk's account windows, so an expired session resumes with at most a
// two-factor prompt. Credentials go only into frames on the provider's own
// sign-in hosts over HTTPS, and a password is submitted at most once every
// few minutes, so a wrong or changed password can't loop or lock the account.

export interface SavedLogin {
  username: string;
  password: string;
}

interface Form {
  hosts: string[];
  user: string;
  userSubmit: string;
  pass: string;
  passSubmit: string;
}

export const FORMS: Record<"apple" | "google", Form> = {
  apple: {
    hosts: ["idmsa.apple.com", "appleid.apple.com", "account.apple.com"],
    user: "#account_name_text_field",
    userSubmit: "#sign-in",
    pass: "#password_text_field",
    passSubmit: "#sign-in",
  },
  google: {
    hosts: ["accounts.google.com"],
    user: 'input[type="email"][name="identifier"], #identifierId',
    userSubmit: "#identifierNext button, #identifierNext",
    pass: 'input[type="password"][name="Passwd"]',
    passSubmit: "#passwordNext button, #passwordNext",
  },
};

const PASSWORD_EVERY = 3 * 60 * 1000;
const USERNAME_EVERY = 60 * 1000;

/**
 * Runs in the sign-in frame: fills the next empty visible field and
 * continues. A plain string, so nothing from the bundler reaches the page.
 */
export const FILL = `(args) => {
  const visible = (el) => !!el && el.offsetParent !== null && !el.disabled;
  const set = (el, value) => {
    // Through the native setter, so the page's framework sees the change.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const submit = (selector, field) => {
    const button = document.querySelector(selector);
    if (button && button.offsetParent !== null) button.click();
    else if (field.form) field.form.requestSubmit();
  };
  const pass = document.querySelector(args.form.pass);
  if (args.password !== undefined && visible(pass) && !pass.value) {
    set(pass, args.password);
    setTimeout(() => submit(args.form.passSubmit, pass), 150);
    return "password";
  }
  const user = document.querySelector(args.form.user);
  if (args.username !== undefined && visible(user) && !user.value) {
    set(user, args.username);
    setTimeout(() => submit(args.form.userSubmit, user), 150);
    return "username";
  }
  return "";
}`;

/**
 * Watches `contents` for the provider's sign-in form and fills the saved
 * login into it. Stops when the contents are destroyed.
 */
export function attachLoginFill(
  contents: WebContents,
  provider: "apple" | "google",
  savedLogin: () => Promise<SavedLogin | undefined>,
  onFill?: (step: string) => void,
) {
  const form = FORMS[provider];
  let last = { username: 0, password: 0 };
  let busy = false;
  const timer = setInterval(async () => {
    if (contents.isDestroyed()) return clearInterval(timer);
    if (busy) return;
    busy = true;
    try {
      const frames = contents.mainFrame.framesInSubtree.filter((frame) => {
        try {
          const url = new URL(frame.url);
          return url.protocol === "https:" && form.hosts.includes(url.hostname);
        } catch {
          return false;
        }
      });
      if (!frames.length) return;
      const login = await savedLogin();
      if (!login) return;
      const now = Date.now();
      const allow = {
        username:
          now - last.username > USERNAME_EVERY ? login.username : undefined,
        password:
          now - last.password > PASSWORD_EVERY ? login.password : undefined,
      };
      if (allow.username === undefined && allow.password === undefined) return;
      for (const frame of frames) {
        const step = (await frame
          .executeJavaScript(`(${FILL})(${JSON.stringify({ form, ...allow })})`)
          .catch(() => "")) as string;
        if (step === "username" || step === "password") {
          last = { ...last, [step]: now };
          onFill?.(step);
          break;
        }
      }
    } finally {
      busy = false;
    }
  }, 1500);
  contents.once("destroyed", () => clearInterval(timer));
}

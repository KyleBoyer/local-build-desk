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
  /** A button that switches a passkey-first prompt to the password field. */
  passReveal?: string;
}

export const FORMS: Record<"apple" | "google", Form> = {
  apple: {
    hosts: ["idmsa.apple.com", "appleid.apple.com", "account.apple.com"],
    user: "#account_name_text_field",
    userSubmit: "#sign-in",
    pass: "#password_text_field",
    passSubmit: "#sign-in",
    passReveal: "#continue-password",
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
 *
 * Apple's page renders the password field before the account name is
 * entered, collapsed to zero height inside an aria-hidden section, so
 * visibility means actually taking up space, and the account name always
 * goes first while it's showing and empty.
 */
export const FILL = `(args) => {
  const visible = (el) => {
    if (!el || el.disabled || el.closest('[aria-hidden="true"]')) return false;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    for (let a = el.parentElement; a; a = a.parentElement) {
      const style = getComputedStyle(a);
      if (style.display === "none" || style.visibility === "hidden") return false;
      // A collapsed section that clips its contents hides them.
      if (style.overflowX !== "visible" || style.overflowY !== "visible") {
        const outer = a.getBoundingClientRect();
        if (outer.width < 1 || outer.height < 1) return false;
      }
    }
    return true;
  };
  const set = (el, value) => {
    // Through the native setter, so the page's framework sees the change.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const submit = (selector, field) => {
    const button = document.querySelector(selector);
    if (visible(button)) button.click();
    else if (field.form) field.form.requestSubmit();
  };
  const user = document.querySelector(args.form.user);
  const userShowing = visible(user);
  if (userShowing && !user.value) {
    if (args.username === undefined) return "";
    set(user, args.username);
    setTimeout(() => submit(args.form.userSubmit, user), 150);
    return "username";
  }
  // Never type the saved password under an account someone typed by hand.
  const sameAccount =
    !userShowing ||
    !args.account ||
    user.value.trim().toLowerCase() === args.account.trim().toLowerCase();
  const pass = document.querySelector(args.form.pass);
  if (args.password !== undefined && sameAccount && visible(pass) && !pass.value) {
    set(pass, args.password);
    setTimeout(() => submit(args.form.passSubmit, pass), 150);
    return "password";
  }
  // Passkey-first prompts hide the password behind a button.
  const reveal = args.form.passReveal && document.querySelector(args.form.passReveal);
  if (args.password !== undefined && sameAccount && !visible(pass) && visible(reveal)) {
    reveal.click();
    return "reveal";
  }
  return "";
}`;

/**
 * Watches `contents` for the provider's sign-in form and fills the saved
 * login into it. Stops when the contents are destroyed.
 */
// Shared by every window for a provider (they share one sign-in session), so
// reopening a window doesn't retype a password Apple or Google just refused.
const lastFill: Record<
  "apple" | "google",
  { username: number; password: number }
> = {
  apple: { username: 0, password: 0 },
  google: { username: 0, password: 0 },
};

export function attachLoginFill(
  contents: WebContents,
  provider: "apple" | "google",
  savedLogin: () => Promise<SavedLogin | undefined>,
  onFill?: (step: string) => void,
  /** Fill only while this holds, e.g. while the window is on screen. */
  active: () => boolean = () => true,
) {
  const form = FORMS[provider];
  let busy = false;
  const timer = setInterval(async () => {
    if (contents.isDestroyed()) return clearInterval(timer);
    if (busy || !active()) return;
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
      const now = Date.now(),
        last = lastFill[provider];
      const allow = {
        username:
          now - last.username > USERNAME_EVERY ? login.username : undefined,
        password:
          now - last.password > PASSWORD_EVERY ? login.password : undefined,
      };
      if (allow.username === undefined && allow.password === undefined) return;
      for (const frame of frames) {
        const step = (await frame
          .executeJavaScript(
            `(${FILL})(${JSON.stringify({ form, account: login.username, ...allow })})`,
          )
          .catch(() => "")) as string;
        if (step === "username" || step === "password") {
          last[step] = now;
          onFill?.(step);
          break;
        }
        if (step === "reveal") {
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

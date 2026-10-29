import { app, BrowserWindow, session } from "electron";
import type { AppleWebSession } from "../core/app-store-compliance";
import { DeskError } from "../core/errors";
import { attachLoginFill, type SavedLogin } from "./login-fill";

// App Store Connect's web API (/iris/v1), for the few things Apple's public
// API doesn't cover (App Privacy). Requests run inside an App Store Connect
// page in the desk's own Apple partition, the session Apple setup signs in
// with, so they carry exactly what the website sends: its cookies, its origin
// and its CSRF header. The page stays hidden unless the person needs to sign in.

const ORIGIN = "https://appstoreconnect.apple.com";
const SIGN_IN_TIMEOUT = 10 * 60 * 1000;
const IDLE_CLOSE = 60 * 1000;

interface Reply {
  status: number;
  text: string;
}

const SIGNED_OUT: Reply = { status: 401, text: "" };

/**
 * App Store Connect redirects between its pages and Apple's sign-in while a
 * page loads; a load replaced by a redirect isn't a failure.
 */
async function load(window: BrowserWindow, url: string) {
  try {
    await window.loadURL(url);
  } catch (error) {
    if (!/ERR_ABORTED/.test((error as Error).message)) throw error;
  }
}

export function appleWebSession(
  parent: () => BrowserWindow | undefined,
  savedLogin: () => Promise<SavedLogin | undefined>,
): AppleWebSession {
  let page: BrowserWindow | undefined;
  let loading: Promise<BrowserWindow> | undefined;
  let idle: NodeJS.Timeout | undefined;
  let signingIn: Promise<void> | undefined;

  const open = () =>
    (loading ??= (async () => {
      const owner = parent();
      const window = new BrowserWindow({
        show: false,
        width: 1100,
        height: 820,
        title: "Sign in to App Store Connect · Local Build Desk",
        backgroundColor: "#101a23",
        ...(owner && !owner.isDestroyed() ? { parent: owner } : {}),
        webPreferences: {
          session: session.fromPartition("persist:desk-account-apple"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      window.on("closed", () => {
        page = undefined;
        loading = undefined;
      });
      attachLoginFill(window.webContents, "apple", savedLogin);
      await load(window, `${ORIGIN}/apps`);
      page = window;
      return window;
    })().catch((error) => {
      loading = undefined;
      throw error;
    }));

  const keepAlive = () => {
    clearTimeout(idle);
    idle = setTimeout(() => page?.close(), IDLE_CLOSE);
  };

  async function call(
    path: string,
    method: string,
    body?: unknown,
  ): Promise<Reply> {
    const window = await open();
    keepAlive();
    // Signed out, the page ends up on Apple's sign-in instead, where App Store
    // Connect's requests can't be made.
    if (!window.webContents.getURL().startsWith(ORIGIN)) return SIGNED_OUT;
    const request = {
      url: `/iris/v1${path}`,
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    // Runs in App Store Connect's own origin; nothing from the page comes back
    // except the status and response text.
    return (
      window.webContents
        .executeJavaScript(
          `(async (r) => {
        const response = await fetch(r.url, {
          method: r.method,
          credentials: "include",
          headers: {
            "x-csrf-itc": "[asc-ui]",
            "content-type": "application/vnd.api+json",
            accept: "application/vnd.api+json, application/json",
          },
          body: r.body,
        });
        return { status: response.status, text: await response.text() };
      })(${JSON.stringify(request)})`,
        )
        // An expired session redirects the request itself to Apple's sign-in,
        // which the browser reports as a failed fetch.
        .catch((error: Error) => {
          if (/Failed to fetch/.test(error.message)) return SIGNED_OUT;
          throw error;
        })
    );
  }

  const signedIn = async () =>
    (await call("/apps?limit=1", "GET")).status === 200;

  async function signIn() {
    const window = await open();
    if (await signedIn()) return;
    await load(window, `${ORIGIN}/login`);
    // Bring it to the front: a sign-in behind other windows is easy to miss.
    window.show();
    app.focus({ steal: true });
    window.focus();
    const started = Date.now();
    try {
      for (;;) {
        if (window.isDestroyed())
          throw new DeskError(
            "APPLE_WEB_SIGN_IN",
            "App Store Connect sign-in was closed before it finished.",
          );
        if (Date.now() - started > SIGN_IN_TIMEOUT)
          throw new DeskError(
            "APPLE_WEB_SIGN_IN",
            "Timed out waiting for the App Store Connect sign-in.",
          );
        await new Promise((ready) => setTimeout(ready, 2000));
        if (await signedIn().catch(() => false)) break;
      }
    } finally {
      if (!window.isDestroyed()) window.hide();
    }
  }

  return {
    async request(path, { method = "GET", body, interactive = false } = {}) {
      let reply = await call(path, method, body);
      if (reply.status === 401 || reply.status === 403) {
        if (!interactive)
          throw new DeskError(
            "APPLE_WEB_SIGN_IN",
            "Sign in to App Store Connect in Local Build Desk to read or set App Privacy.",
          );
        await (signingIn ??= signIn().finally(() => (signingIn = undefined)));
        reply = await call(path, method, body);
      }
      let data: any = {};
      try {
        data = reply.text ? JSON.parse(reply.text) : {};
      } catch {
        // An HTML error page; the status says enough.
      }
      if (reply.status < 200 || reply.status >= 300)
        throw new DeskError(
          `APPLE_WEB_${reply.status}`,
          `App Store Connect ${reply.status} (${method} ${path.split("?")[0]}): ${
            data.errors?.map((e: any) => e.detail ?? e.title).join("; ") ??
            "request failed"
          }`,
        );
      return data;
    },
  };
}

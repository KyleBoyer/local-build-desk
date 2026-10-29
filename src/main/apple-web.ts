import { BrowserWindow, session } from "electron";
import type { AppleWebSession } from "../core/app-store-compliance";
import { DeskError } from "../core/errors";

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

export function appleWebSession(
  parent: () => BrowserWindow | undefined,
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
      await window.loadURL(`${ORIGIN}/apps`);
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
    const request = {
      url: `/iris/v1${path}`,
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    // Runs in App Store Connect's own origin; nothing from the page comes back
    // except the status and response text.
    return window.webContents.executeJavaScript(
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
    );
  }

  const signedIn = async () =>
    (await call("/apps?limit=1", "GET")).status === 200;

  async function signIn() {
    const window = await open();
    if (window.webContents.getURL().startsWith(ORIGIN) && (await signedIn()))
      return;
    await window.loadURL(`${ORIGIN}/login`);
    window.show();
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
        if (
          window.webContents.getURL().startsWith(ORIGIN) &&
          (await signedIn().catch(() => false))
        )
          break;
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

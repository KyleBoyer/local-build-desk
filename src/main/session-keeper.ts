import { session, type Cookie } from "electron";

// Apple's and Google's web sign-ins keep part of their state in session
// cookies, which a browser drops when it quits. The desk's account partitions
// keep them instead: every session cookie is saved again with an expiry, so a
// restarted desk resumes the sign-in for as long as Apple or Google still
// accept it (they decide when it really ends, and send the person back to
// sign in). Cookie values never leave the partition's own cookie store.

/** How long a kept session cookie lives on disk. */
const KEEP_DAYS = 30;

export const ACCOUNT_PARTITIONS = [
  "persist:desk-account-apple",
  "persist:desk-account-google",
] as const;

/** The URL a cookie belongs to, as cookies.set wants it. */
function cookieUrl(cookie: Cookie) {
  const host = (cookie.domain ?? "").replace(/^\./, "");
  return `${cookie.secure ? "https" : "http"}://${host}${cookie.path ?? "/"}`;
}

export function keepSessions(partition: string) {
  const cookies = session.fromPartition(partition).cookies;
  let flush: NodeJS.Timeout | undefined;
  cookies.on("changed", (_event, cookie, _cause, removed) => {
    if (removed || !cookie.session || !cookie.domain) return;
    const hostOnly = cookie.hostOnly ?? !cookie.domain.startsWith(".");
    void cookies
      .set({
        url: cookieUrl(cookie),
        name: cookie.name,
        value: cookie.value,
        // A host-only cookie (and every __Host- cookie) must stay host-only.
        ...(hostOnly || cookie.name.startsWith("__Host-")
          ? {}
          : { domain: cookie.domain }),
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: Date.now() / 1000 + KEEP_DAYS * 24 * 60 * 60,
      })
      .catch(() => undefined);
    // Write to disk soon after a sign-in settles, not on every cookie.
    clearTimeout(flush);
    flush = setTimeout(
      () => void cookies.flushStore().catch(() => undefined),
      2000,
    );
  });
}

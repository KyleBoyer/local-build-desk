import { expect, it, vi } from "vitest";

const set = vi.fn(async () => undefined);
const flushStore = vi.fn(async () => undefined);
let changed: (
  event: unknown,
  cookie: any,
  cause: string,
  removed: boolean,
) => void;
vi.mock("electron", () => ({
  session: {
    fromPartition: () => ({
      cookies: {
        on: (_: string, listener: typeof changed) => (changed = listener),
        set,
        flushStore,
      },
    }),
  },
}));

it("keeps session cookies across restarts, leaving the rest alone", async () => {
  vi.useFakeTimers();
  const { keepSessions } = await import("../src/main/session-keeper");
  keepSessions("persist:desk-account-apple");
  const now = Date.now() / 1000;
  changed(
    {},
    {
      name: "myacinfo",
      value: "v1",
      domain: ".apple.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
      session: true,
      hostOnly: false,
    },
    "explicit",
    false,
  );
  changed(
    {},
    {
      name: "itctx",
      value: "v2",
      domain: "appstoreconnect.apple.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      session: true,
      hostOnly: true,
    },
    "explicit",
    false,
  );
  changed(
    {},
    {
      name: "persistent",
      value: "v",
      domain: ".apple.com",
      path: "/",
      session: false,
      expirationDate: now + 99,
    },
    "explicit",
    false,
  );
  changed(
    {},
    {
      name: "gone",
      value: "v",
      domain: ".apple.com",
      path: "/",
      session: true,
    },
    "expired",
    true,
  );
  expect(set).toHaveBeenCalledTimes(2);
  const [shared, hostOnly] = set.mock.calls.map((c: any) => c[0]);
  expect(shared).toMatchObject({
    url: "https://apple.com/",
    name: "myacinfo",
    value: "v1",
    domain: ".apple.com",
    httpOnly: true,
    secure: true,
  });
  expect(shared.expirationDate).toBeGreaterThan(now + 29 * 86400);
  // A host-only cookie must not gain a domain (that would widen it).
  expect(hostOnly).toMatchObject({
    url: "https://appstoreconnect.apple.com/",
    name: "itctx",
  });
  expect(hostOnly).not.toHaveProperty("domain");
  vi.advanceTimersByTime(2500);
  expect(flushStore).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

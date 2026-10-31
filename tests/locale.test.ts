import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/core/database";
import { Engine } from "../src/core/engine";
import { Vault } from "../src/core/vault";
import {
  resolveInvocation,
  captureInvocationEnvironment,
} from "../src/cli/invocation";
import { toolEnvironment } from "../src/core/config";
import { buildLocale, utf8LocaleOf } from "../src/core/locale";

let root: string, store: Store, engine: Engine;
const encrypt = vi.fn(async () => {
  throw Error("Keychain must not be touched");
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "desk-locale-"));
  store = new Store(join(root, "data"));
  engine = new Engine(store, new Vault(store, { encrypt, decrypt: encrypt }));
  store.putProject({
    id: "template",
    name: "Fixture",
    path: join(root, "desktop"),
    profiles: ["production"],
    createdAt: "today",
    settings: { iosSdk: "26.5" },
  });
});
afterEach(async () => {
  await engine.shutdown();
  store.close();
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("reads the first full UTF-8 locale in setlocale order", () => {
  expect(utf8LocaleOf({ LANG: "en_GB.UTF-8" })).toBe("en_GB.UTF-8");
  expect(
    utf8LocaleOf({
      LC_ALL: "de_DE.utf8",
      LC_CTYPE: "fr_FR.UTF-8",
      LANG: "en_US.UTF-8",
    }),
  ).toBe("de_DE.utf8");
  // Terminal.app's bare LC_CTYPE names no language, so LANG is used.
  expect(utf8LocaleOf({ LC_CTYPE: "UTF-8", LANG: "en_AU.UTF-8" })).toBe(
    "en_AU.UTF-8",
  );
  expect(utf8LocaleOf({ LC_CTYPE: "UTF-8" })).toBeUndefined();
  expect(utf8LocaleOf({ LANG: "C" })).toBeUndefined();
  expect(utf8LocaleOf({})).toBeUndefined();
});

it("gives native tools the run's locale, else the desk's, else en_US.UTF-8", () => {
  expect(buildLocale("fr_FR.UTF-8", { LANG: "en_GB.UTF-8" })).toEqual({
    LANG: "fr_FR.UTF-8",
    LC_ALL: "fr_FR.UTF-8",
  });
  expect(buildLocale(undefined, { LANG: "en_GB.UTF-8" }).LANG).toBe(
    "en_GB.UTF-8",
  );
  // A desk opened from Finder has no locale at all.
  expect(buildLocale(undefined, {})).toEqual({
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
  });
  // LC_ALL=C would otherwise win over LANG and break CocoaPods.
  expect(buildLocale(undefined, { LC_ALL: "C" }).LC_ALL).toBe("en_US.UTF-8");
});

it("sets a UTF-8 locale in the tool environment even when the desk has none", () => {
  vi.stubEnv("LANG", "");
  vi.stubEnv("LC_ALL", "");
  vi.stubEnv("LC_CTYPE", "");
  expect(toolEnvironment()).toMatchObject({
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
  });
  expect(toolEnvironment({ locale: "ja_JP.UTF-8" })).toMatchObject({
    LANG: "ja_JP.UTF-8",
    LC_ALL: "ja_JP.UTF-8",
  });
});

it("forwards the caller's locale to the running desk as a run setting", async () => {
  const source = join(root, "checkout");
  await mkdir(source);
  const forwarded = captureInvocationEnvironment(
    ["build", "--source", source],
    {
      LANG: "en_GB.UTF-8",
      HOME: "/Users/someone",
    },
  );
  // Only the locale travels, as an invocation variable; HOME and LANG stay behind.
  expect(forwarded).toEqual({ LOCAL_BUILD_DESK_LOCALE: "en_GB.UTF-8" });
  const invocation = await resolveInvocation(
    engine,
    { "settings-from": "template", source },
    forwarded,
  );
  expect(invocation.project.settings.locale).toBe("en_GB.UTF-8");
  expect(toolEnvironment(invocation.project.settings).LANG).toBe("en_GB.UTF-8");
  // The saved template is not changed by a run.
  expect(
    store.get<any>("projects", "template").settings.locale,
  ).toBeUndefined();
});

it("keeps an explicit LOCAL_BUILD_DESK_LOCALE and skips non-UTF-8 callers", async () => {
  expect(
    captureInvocationEnvironment(["build"], {
      LANG: "en_GB.UTF-8",
      LOCAL_BUILD_DESK_LOCALE: "de_DE.UTF-8",
    }).LOCAL_BUILD_DESK_LOCALE,
  ).toBe("de_DE.UTF-8");
  expect(
    captureInvocationEnvironment(["build"], { LANG: "C" }),
  ).not.toHaveProperty("LOCAL_BUILD_DESK_LOCALE");
  const source = join(root, "checkout");
  await mkdir(source);
  await expect(
    resolveInvocation(
      engine,
      { "settings-from": "template", source },
      { LOCAL_BUILD_DESK_LOCALE: "C; rm -rf /" },
    ),
  ).rejects.toThrow(/Invalid invocation settings/);
});

import { it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("electron", () => ({}));
const {
  CLICommand,
  installCLICommand,
  installable,
  removeCLICommand,
  shimScript,
} = await import("../src/main/cli-command");
const app =
  "/Applications/Local Build Desk.app/Contents/MacOS/Local Build Desk";
let home: string;
const env = (loginPath: string | undefined, shell = "/bin/zsh") => ({
  home,
  executable: app,
  loginPath,
  shell,
});
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "desk-cli-command-"));
});
afterEach(() => rm(home, { recursive: true, force: true }));
it("writes an executable shim that runs the app's CLI", async () => {
  const bin = join(home, ".local/bin");
  const status = installCLICommand(env(`/usr/bin:${bin}`));
  const file = join(bin, "local-build-desk");
  expect(status).toMatchObject({ state: "installed", path: file });
  expect(status.profile).toBeUndefined();
  expect(await readFile(file, "utf8")).toBe(shimScript(app));
  expect(shimScript(app)).toContain(`exec "${app}" --desk-cli "$@"`);
  expect((await stat(file)).mode & 0o777).toBe(0o755);
  expect(existsSync(join(home, ".zprofile"))).toBe(false);
});
it("adds ~/.local/bin to the login profile once when no user directory is on PATH", async () => {
  await writeFile(join(home, ".zprofile"), "export EDITOR=vim");
  const first = installCLICommand(env("/usr/bin:/bin"));
  expect(first).toMatchObject({
    state: "installed",
    path: join(home, ".local/bin/local-build-desk"),
    profile: join(home, ".zprofile"),
  });
  expect(first.message).toMatch(/new terminal/);
  installCLICommand(env("/usr/bin:/bin"));
  const profile = await readFile(join(home, ".zprofile"), "utf8");
  expect(profile.startsWith("export EDITOR=vim\n")).toBe(true);
  expect(profile.match(/\.local\/bin/g)).toHaveLength(1);
  removeCLICommand(env("/usr/bin:/bin"));
  expect(await readFile(join(home, ".zprofile"), "utf8")).toBe(
    "export EDITOR=vim\n",
  );
  expect(existsSync(join(home, ".local/bin/local-build-desk"))).toBe(false);
});
it("updates its own shim when the app moves but never replaces another command", async () => {
  const bin = join(home, "bin");
  await mkdir(bin);
  const file = join(bin, "local-build-desk");
  await writeFile(file, shimScript("/Applications/Old.app/Contents/MacOS/Old"));
  installCLICommand(env(bin));
  expect(await readFile(file, "utf8")).toBe(shimScript(app));
  await writeFile(file, "#!/bin/sh\necho someone else\n");
  expect(installCLICommand(env(bin))).toMatchObject({
    state: "blocked",
    path: file,
  });
  removeCLICommand(env(bin));
  expect(await readFile(file, "utf8")).toContain("someone else");
});
it("leaves PATH alone for shells it cannot configure", () => {
  const status = installCLICommand(env(undefined, "/opt/homebrew/bin/fish"));
  expect(status.profile).toBeUndefined();
  expect(status.message).toMatch(/Add ~\/\.local\/bin to your shell's PATH/);
});
it("installs only from an app in an Applications folder", () => {
  expect(installable(app, home)).toBe(true);
  expect(
    installable(
      join(
        home,
        "Applications/Local Build Desk.app/Contents/MacOS/Local Build Desk",
      ),
      home,
    ),
  ).toBe(true);
  expect(
    installable(
      "/private/var/folders/x/AppTranslocation/1/d/Local Build Desk.app/Contents/MacOS/Local Build Desk",
      home,
    ),
  ).toBe(false);
  expect(
    installable(
      "/Volumes/Work/release/mac-arm64/Local Build Desk.app/Contents/MacOS/Local Build Desk",
      home,
    ),
  ).toBe(false);
});
it("follows the Preferences switch and remembers turning it off", async () => {
  const preferences = new Map<string, unknown>();
  const store = {
    preference: <T>(key: string, fallback: T) =>
      (preferences.has(key) ? preferences.get(key) : fallback) as T,
    setPreference: (key: string, value: unknown) => preferences.set(key, value),
  };
  const bin = join(home, ".local/bin");
  const command = new CLICommand(store, async () => env(bin), true);
  expect(command.status().state).toBe("pending");
  expect(await command.sync()).toMatchObject({ state: "installed" });
  expect(await command.sync(false)).toMatchObject({
    enabled: false,
    state: "removed",
  });
  expect(existsSync(join(bin, "local-build-desk"))).toBe(false);
  expect(await command.sync()).toMatchObject({ state: "removed" });
  const unsupported = new CLICommand(store, async () => env(bin), false);
  expect(await unsupported.sync(true)).toMatchObject({ state: "unsupported" });
  expect(preferences.get("cliCommandEnabled")).toBe(false);
});

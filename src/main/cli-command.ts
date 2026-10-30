import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { CLI_NAME } from "../core/naming";
import { messageOf } from "../core/errors";
import type { CLICommandStatus } from "../core/types";

// Identifies files this app wrote, so it never replaces or removes anyone
// else's command or profile lines.
const marker = "# Installed by Local Build Desk";
const profileStart = "# >>> Local Build Desk command >>>";
const profileEnd = "# <<< Local Build Desk command <<<";

export interface CLICommandEnvironment {
  home: string;
  /** The packaged app's executable, which runs the CLI with --desk-cli. */
  executable: string;
  /** PATH as the user's terminals see it, or undefined when unknown. */
  loginPath: string | undefined;
  shell: string;
}

export function shimScript(executable: string) {
  return `#!/bin/sh
${marker}. Runs its command-line interface.
unset ELECTRON_RUN_AS_NODE
exec ${JSON.stringify(executable)} --desk-cli "$@"
`;
}

const ours = (file: string) => {
  try {
    return readFileSync(file, "utf8").includes(marker);
  } catch {
    return false;
  }
};
const writable = (directory: string) => {
  try {
    accessSync(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};
const write = (file: string, content: string, mode: number) => {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode });
  renameSync(temporary, file);
};
const tilde = (path: string, home: string) =>
  path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;

/** Only a stably installed app may own the command; a translocated or
 * development copy would point it at a path that disappears. */
export function installable(executable: string, home: string) {
  const bundle = executable.split("/Contents/MacOS/")[0];
  return ["/Applications", join(home, "Applications")].includes(
    dirname(bundle),
  );
}

export function profileFor(shell: string, home: string) {
  const name = basename(shell);
  if (name === "zsh") return join(home, ".zprofile");
  if (name === "bash") return join(home, ".bash_profile");
  return undefined;
}

/** Puts a `local-build-desk` shim in a directory on the user's PATH. It
 * prefers a user directory already on PATH and otherwise adds ~/.local/bin to
 * the login shell's profile. */
export function installCLICommand(
  env: CLICommandEnvironment,
): CLICommandStatus {
  const { home, executable, loginPath } = env;
  const pathDirs = (loginPath ?? "").split(":").filter(Boolean);
  for (const directory of pathDirs) {
    const file = join(directory, CLI_NAME);
    if (!existsSync(file)) continue;
    if (!ours(file))
      return {
        enabled: true,
        state: "blocked",
        path: file,
        message: `Another ${CLI_NAME} command already exists at ${tilde(file, home)}. Remove it to let Local Build Desk install its own.`,
      };
    if (readFileSync(file, "utf8") !== shimScript(executable))
      write(file, shimScript(executable), 0o755);
    return {
      enabled: true,
      state: "installed",
      path: file,
      message: `Run ${CLI_NAME} in any terminal. Installed at ${tilde(file, home)}.`,
    };
  }
  const local = join(home, ".local/bin");
  const directory =
    [local, join(home, "bin"), "/usr/local/bin"].find(
      (candidate) =>
        pathDirs.includes(candidate) &&
        (writable(candidate) || (candidate === local && !existsSync(local))),
    ) ?? local;
  mkdirSync(directory, { recursive: true });
  const file = join(directory, CLI_NAME);
  invariantOurs(file, home);
  write(file, shimScript(executable), 0o755);
  if (pathDirs.includes(directory))
    return {
      enabled: true,
      state: "installed",
      path: file,
      message: `Run ${CLI_NAME} in any terminal. Installed at ${tilde(file, home)}.`,
    };
  const profile = profileFor(env.shell, home);
  if (!profile)
    return {
      enabled: true,
      state: "installed",
      path: file,
      message: `Installed at ${tilde(file, home)}. Add ${tilde(directory, home)} to your shell's PATH to run ${CLI_NAME} by name.`,
    };
  const current = existsSync(profile) ? readFileSync(profile, "utf8") : "";
  if (!current.includes(profileStart))
    write(
      profile,
      `${current}${current && !current.endsWith("\n") ? "\n" : ""}${profileStart}
export PATH="$HOME/.local/bin:$PATH"
${profileEnd}
`,
      0o644,
    );
  return {
    enabled: true,
    state: "installed",
    path: file,
    profile,
    message: `Installed at ${tilde(file, home)} and added to PATH in ${tilde(profile, home)}. Open a new terminal to run ${CLI_NAME}.`,
  };
}

function invariantOurs(file: string, home: string) {
  if (existsSync(file) && !ours(file))
    throw new Error(
      `Another ${CLI_NAME} command already exists at ${tilde(file, home)}. Remove it to let Local Build Desk install its own.`,
    );
}

/** Removes only the shims and profile lines this app wrote. */
export function removeCLICommand(env: CLICommandEnvironment): CLICommandStatus {
  const { home } = env;
  const directories = new Set([
    ...(env.loginPath ?? "").split(":").filter(Boolean),
    join(home, ".local/bin"),
    join(home, "bin"),
    "/usr/local/bin",
  ]);
  for (const directory of directories) {
    const file = join(directory, CLI_NAME);
    if (ours(file)) rmSync(file, { force: true });
  }
  const profile = profileFor(env.shell, home);
  if (profile && existsSync(profile)) {
    const content = readFileSync(profile, "utf8");
    const start = content.indexOf(profileStart);
    const end = content.indexOf(profileEnd);
    if (start >= 0 && end > start)
      write(
        profile,
        content.slice(0, start) +
          content.slice(end + profileEnd.length).replace(/^\n/, ""),
        0o644,
      );
  }
  return {
    enabled: false,
    state: "removed",
    message: `The ${CLI_NAME} command is not installed. Turn this on to add it to your PATH.`,
  };
}

/** PATH as a new terminal sees it. GUI apps start with launchd's minimal
 * PATH, so ask the user's interactive login shell. */
export function loginShellPath(shell: string): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(
      shell,
      ["-ilc", 'printf "\\n__LBD_PATH__%s__LBD_PATH__\\n" "$PATH"'],
      { timeout: 5000 },
      (_error, stdout) =>
        done(/__LBD_PATH__(.*)__LBD_PATH__/.exec(String(stdout))?.[1]),
    );
  });
}

interface Preferences {
  preference<T>(key: string, fallback: T): T;
  setPreference(key: string, value: unknown): void;
}

/** Keeps the command in sync with the Preferences switch (on by default). */
export class CLICommand {
  private current: CLICommandStatus;
  constructor(
    private readonly store: Preferences,
    private readonly environment: () => Promise<CLICommandEnvironment>,
    private readonly supported: boolean,
  ) {
    this.current = supported
      ? {
          enabled: store.preference("cliCommandEnabled", true),
          state: "pending",
          message: "Checking the command…",
        }
      : {
          enabled: false,
          state: "unsupported",
          message: `The ${CLI_NAME} command is installed by the copy of Local Build Desk in Applications.`,
        };
  }
  status() {
    return this.current;
  }
  async sync(enabled?: boolean): Promise<CLICommandStatus> {
    if (!this.supported) return this.current;
    if (enabled !== undefined)
      this.store.setPreference("cliCommandEnabled", enabled);
    const wanted = this.store.preference("cliCommandEnabled", true);
    try {
      const env = await this.environment();
      this.current = wanted ? installCLICommand(env) : removeCLICommand(env);
    } catch (error) {
      this.current = {
        enabled: wanted,
        state: "error",
        message: messageOf(error),
      };
    }
    return this.current;
  }
}

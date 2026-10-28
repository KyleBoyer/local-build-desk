import { join } from "node:path";
import { symlink } from "node:fs/promises";
import { privateDirectory } from "./vault";
import { snapshot } from "./snapshot";
import { run, type CommandOptions, type CommandResult } from "./process";
import { toolEnvironment } from "./config";
import { invariant, DeskError, messageOf } from "./errors";
import type { Store } from "./database";
import type { Project, Platform } from "./types";
import { terminalInvocation } from "./terminal";
type Execute = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;
export async function transferVersionCounter(
  store: Store,
  project: Project,
  platform: Platform,
  profile: string,
  identity: string,
  autoIncrement: boolean,
  mode: "handoff" | "resume",
  execute: Execute = run,
) {
  const key = `${platform}:${identity}`;
  invariant(
    store.counter(key) !== undefined,
    "COUNTER_UNSEEDED",
    "Initialize the local version counter first.",
  );
  return privateDirectory(async (root) => {
    const source = join(root, "source");
    await snapshot(
      project.path,
      source,
      { ios: false, android: false },
      new AbortController().signal,
    );
    await symlink(
      join(project.path, "node_modules"),
      join(source, "node_modules"),
      "dir",
    );
    await execute("git", ["init", "-q"], { cwd: source });
    const options: CommandOptions = {
      cwd: source,
      env: { ...toolEnvironment(project.settings), CI: "1" },
      timeout: 90000,
    };
    const readRemote = async () => {
      const result = await execute(
        "eas",
        [
          "build:version:get",
          "--platform",
          platform,
          "--profile",
          profile,
          "--json",
        ],
        options,
      );
      const value = JSON.parse(result.stdout)[
        platform === "ios" ? "buildNumber" : "versionCode"
      ];
      const number = Number(value);
      invariant(
        value !== undefined && Number.isSafeInteger(number) && number >= 0,
        "EAS_COUNTER",
        "EAS did not return an integer remote counter. Configure remote versioning before transferring ownership.",
      );
      return number;
    };
    const remote = await readRemote();
    store.seed(key, remote);
    if (mode === "resume") {
      store.setAuthority(key, "local");
      return {
        platform,
        identity,
        authority: "local",
        lastReserved: store.highWater(key),
        nextMinimum: store.highWater(key)! + 1,
        easCounter: remote,
        message:
          "Resumed local counters after importing EAS's last reservation. Stop EAS builds before returning to local builds.",
      };
    }
    const last = store.handoff(key);
    const target = Math.max(last + (autoIncrement ? 0 : 1), remote, 1);
    store.seed(key, target);
    try {
      if (target !== remote) {
        const terminal = terminalInvocation("eas", [
          "build:version:set",
          "--platform",
          platform,
          "--profile",
          profile,
        ]);
        await execute(terminal.command, terminal.args, {
          ...options,
          input: `${target}\r`,
          inputAfter:
            /What version would you like to (?:set|initialize it with)\?/,
        });
      }
      const verified = await readRemote();
      invariant(
        verified >= target,
        "EAS_COUNTER_UNCONFIRMED",
        `EAS counter update was not confirmed. Local builds remain blocked for safety. Recheck EAS, then run versions --resume-local when ready.`,
      );
      store.seed(key, verified);
      return {
        platform,
        identity,
        authority: "eas",
        lastReserved: store.highWater(key),
        easCounter: verified,
        nextEasBuild: autoIncrement ? verified + 1 : verified,
        message: autoIncrement
          ? "EAS now owns this counter. Its next increment is above every local reservation. Use versions --resume-local before returning to local builds."
          : "This fixed EAS build number is reserved for its next build. Enable autoIncrement or repeat the handoff before each EAS build. Use versions --resume-local before returning to local builds.",
      };
    } catch (error) {
      throw new DeskError(
        "EAS_COUNTER_UNCONFIRMED",
        `EAS handoff could not be confirmed: ${messageOf(error)} Local builds remain paused to prevent duplicate versions. Check the EAS counter, then run versions --resume-local before returning to local builds.`,
      );
    }
  });
}

import { isAbsolute, relative, resolve } from "node:path";
import { buildLocale } from "./locale";

/**
 * CI jobs run the CLI from a workspace the runner deletes when the job ends.
 * A desk owner started from such a job outlives it, so it must not keep the
 * job's working directory (npm and CocoaPods fail once it is gone), its temp
 * folders, or any job-scoped variables.
 */

// Set by common CI services. `CI` alone covers most others.
const CI_MARKERS = [
  "FORGEJO_ACTIONS",
  "GITEA_ACTIONS",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "BITRISE_IO",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "TF_BUILD",
  "CI",
];
const off = /^(?:0|false|no)$/i;

/**
 * Why this invocation counts as ephemeral (the variable that says so), or
 * undefined for an ordinary terminal. LOCAL_BUILD_DESK_EPHEMERAL=1 forces it on
 * and =0 forces it off, for runners the markers don't recognise.
 */
export function ephemeralReason(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.LOCAL_BUILD_DESK_EPHEMERAL;
  if (explicit)
    return off.test(explicit) ? undefined : "LOCAL_BUILD_DESK_EPHEMERAL";
  return CI_MARKERS.find((name) => env[name] && !off.test(env[name]!));
}

// Machine-level settings a long-lived owner may keep from a CI caller.
const MACHINE_VARIABLES = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "DEVELOPER_DIR",
  "JAVA_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "LOCAL_BUILD_DESK_DISABLE_UPDATES",
  "LOCAL_BUILD_DESK_TEST_UI",
];

// Folders that belong to one job on common runners.
const SCRATCH_VARIABLES = [
  "GITHUB_WORKSPACE",
  "RUNNER_TEMP",
  "RUNNER_WORKSPACE",
  "CI_PROJECT_DIR",
  "CI_BUILDS_DIR",
  "BUILDKITE_BUILD_CHECKOUT_PATH",
  "WORKSPACE",
  "BUILD_SOURCESDIRECTORY",
  "AGENT_TEMPDIRECTORY",
];

export interface OwnerLaunch {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Set when the caller is ephemeral; names the variable that showed it. */
  ephemeral?: string;
}

/**
 * Working directory and environment for a background desk owner started by a
 * CLI call. `callerEnv` is the caller's full environment, used to recognise CI
 * and its job folders; `env` is what the owner may inherit, with invocation
 * variables (credentials included) already removed.
 */
export function ownerLaunch(options: {
  env: NodeJS.ProcessEnv;
  callerEnv: NodeJS.ProcessEnv;
  callerCwd: string;
  dataRoot: string;
}): OwnerLaunch {
  const { env, callerEnv, callerCwd, dataRoot } = options;
  const ephemeral = ephemeralReason(callerEnv);
  let next: NodeJS.ProcessEnv;
  if (ephemeral) {
    const scratch = [
      callerCwd,
      ...SCRATCH_VARIABLES.map((name) => callerEnv[name]),
    ]
      .filter((path): path is string => !!path && isAbsolute(path))
      .map((path) => resolve(path));
    const inScratch = (path: string) =>
      scratch.some((root) => {
        const rel = relative(root, resolve(path));
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      });
    next = {};
    for (const name of MACHINE_VARIABLES) {
      const value = env[name];
      if (value && !(isAbsolute(value) && inScratch(value))) next[name] = value;
    }
    next.PATH =
      (env.PATH ?? "")
        .split(":")
        .filter((entry) => entry && !(isAbsolute(entry) && inScratch(entry)))
        .join(":") || "/usr/bin:/bin:/usr/sbin:/sbin";
  } else {
    next = { ...env };
  }
  Object.assign(next, buildLocale(undefined, callerEnv));
  next.LOCAL_BUILD_DESK_DATA_DIR = dataRoot;
  // The owner serves many callers; none of their folders is a safe home.
  return { cwd: dataRoot, env: next, ephemeral };
}

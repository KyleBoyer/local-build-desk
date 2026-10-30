import { existsSync } from "node:fs";
import { join } from "node:path";
/** The CLI's command, configuration file and environment prefix. The
 * pre-rename `ios-submit` names remain accepted aliases so existing CI
 * runners and committed configuration keep working. */
export const CLI_NAME = "local-build-desk";
export const ENV_PREFIX = "LOCAL_BUILD_DESK_";
export const LEGACY_ENV_PREFIX = "IOS_SUBMIT_";
export const CONFIG_FILE = "local-build-desk.json";
export const LEGACY_CONFIG_FILE = "ios-submit.json";
// App-internal variables share the prefix but never configure a build.
const internal = new Set(["DATA_DIR", "TEST_UI", "DISABLE_UPDATES"]);
export function isInvocationVariable(key: string) {
  return (
    key.startsWith(ENV_PREFIX) && !internal.has(key.slice(ENV_PREFIX.length))
  );
}
/** Copies `env`, filling each LOCAL_BUILD_DESK_* name from its IOS_SUBMIT_*
 * alias. The new name wins when both are set. */
export function withCurrentNames(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX) || value === undefined) continue;
    const name = ENV_PREFIX + key.slice(LEGACY_ENV_PREFIX.length);
    if (isInvocationVariable(name)) result[name] ??= value;
  }
  return result;
}
/** The project's configuration file, preferring the current name. */
export function configFileIn(root: string) {
  const current = join(root, CONFIG_FILE);
  const legacy = join(root, LEGACY_CONFIG_FILE);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

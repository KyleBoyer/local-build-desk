import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

export default function prepareElectron() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Electron installs its native runtime lazily. Finish once before workers
  // launch either Playwright or the CLI directly against that same directory.
  execFileSync(
    process.execPath,
    [createRequire(import.meta.url).resolve("electron/cli.js"), "--version"],
    { env, stdio: "inherit", timeout: 120000 },
  );
}

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const require = createRequire(import.meta.url);
const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  import.meta.url.includes("/out/cli/") ? "../.." : "../..",
);
const electron = require("electron") as string;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [root, "--desk-cli", ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));

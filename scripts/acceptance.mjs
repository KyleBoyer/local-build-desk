// Repository acceptance checks use isolated test projects, never a real account.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
for (const args of [
  ["run", "typecheck"],
  ["test"],
  ...(process.argv.includes("--ui") ? [["run", "test:ui"]] : []),
]) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(npm, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (status) => resolve(status ?? 1));
  });
  if (code !== 0) process.exit(code);
}

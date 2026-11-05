import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform !== "darwin") process.exit(0);
const require = createRequire(import.meta.url);
const headers = join(
  dirname(require.resolve("node-api-headers/package.json")),
  "include",
);
mkdirSync(join(root, "out/native"), { recursive: true });
const result = spawnSync(
  "xcrun",
  [
    "clang++",
    "-std=c++17",
    "-fobjc-arc",
    "-mmacosx-version-min=12.0",
    "-DNAPI_VERSION=8",
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "-framework",
    "Cocoa",
    "-I",
    headers,
    join(root, "native/menu-clock.mm"),
    join(root, "native/menu-clock-addon.mm"),
    "-o",
    join(root, "out/native/menu-clock.node"),
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);

import { it, expect } from "vitest";
import { runTerminal } from "../src/core/terminal";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
it("provides a real TTY to interactive commands from socket-backed stdin", async () => {
  const result = await runTerminal(
    process.execPath,
    [
      "-e",
      "if(!process.stdin.isTTY)throw Error('not a TTY');process.stdout.write('What version? ');process.stdin.once('data',d=>{console.log('received:'+d.toString().trim());process.exit(0);});",
    ],
    { input: "71\r", inputAfter: /What version\?/, timeout: 5000 },
  );
  expect(result.stdout).toContain("received:71");
  await expect(
    runTerminal(process.execPath, ["-e", "process.exit(7)"], { timeout: 5000 }),
  ).rejects.toThrow(/exited with 7/);
});
it("cancels the terminal child group as well as its bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-terminal-"));
  const controller = new AbortController();
  const file = join(root, "pid");
  try {
    const operation = runTerminal(
      process.execPath,
      [
        "-e",
        "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);",
        file,
      ],
      { signal: controller.signal, timeout: 5000 },
    );
    let pid = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      pid = Number(await readFile(file, "utf8").catch(() => 0));
      if (pid) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(pid).toBeGreaterThan(0);
    controller.abort();
    await expect(operation).rejects.toThrow(/cancelled/);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
});

import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { symbolicateCrash, crashFrames } from "../src/core/crash-symbols";
import { run } from "../src/core/process";
const raw = (id = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", offset = 12) =>
  JSON.stringify({ app_name: "Fixture" }) +
  "\n" +
  JSON.stringify({
    faultingThread: 0,
    exception: { type: "EXC_BAD_ACCESS", signal: "SIGSEGV" },
    bundleInfo: { CFBundleShortVersionString: "1.0", CFBundleVersion: "42" },
    usedImages: [
      { uuid: id, base: 4294967296, arch: "arm64", name: "Fixture" },
    ],
    threads: [{ frames: [{ imageIndex: 0, imageOffset: offset }] }],
  });
it("decodes IPS frames only with matching UUID/architecture symbols and handles missing/no logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "lbd-symbol-fixture-"));
  try {
    const dwarf = join(root, "App.dSYM/Contents/Resources/DWARF");
    await mkdir(dwarf, { recursive: true });
    await writeFile(join(dwarf, "App"), "fixture");
    const calls: string[][] = [];
    const execute: any = async (_command: string, args: string[]) => {
      calls.push(args);
      return {
        code: 0,
        stdout:
          args[0] === "dwarfdump"
            ? "UUID: AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE (arm64) App"
            : "purchaseHandler (in Fixture) (App.swift:12)\n",
        stderr: "",
      };
    };
    const report = await symbolicateCrash(raw(), [join(root, "App.dSYM")], {
      execute,
    });
    expect(report.state).toBe("symbolicated");
    expect(report.text).toContain("purchaseHandler");
    expect(report.text).toContain("Exception: EXC_BAD_ACCESS · SIGSEGV");
    expect(report.text).toContain("Version / build: 1.0 · 42");
    expect(calls.at(-1)).toContain("0x10000000c");
    const mismatch = await symbolicateCrash(
      raw("11111111-1111-1111-1111-111111111111"),
      [root],
      { execute },
    );
    expect(mismatch.state).toBe("missing-symbols");
    expect(mismatch.text).not.toContain("purchaseHandler");
    expect((await symbolicateCrash("", [])).state).toBe("no-log");
    expect((await symbolicateCrash("Unknown crash format", [])).state).toBe(
      "unavailable",
    );
    const malformed = raw().replace(
      '"base":4294967296',
      '"base":"unsupported-address"',
    );
    expect(await symbolicateCrash(malformed, [])).toMatchObject({
      state: "unavailable",
      raw: malformed,
      text: malformed,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      symbolicateCrash(raw(), [root], { signal: controller.signal, execute }),
    ).rejects.toThrow(/abort/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it.runIf(process.platform === "darwin")(
  "symbolicates a real local Mach-O with Apple's dwarfdump and atos",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lbd-live-symbols-"));
    try {
      await writeFile(
        join(root, "fixture.c"),
        "__attribute__((noinline)) int purchase_handler_fixture(void) { return 42; }\nint main(void) { return purchase_handler_fixture(); }\n",
      );
      const binary = join(root, "fixture");
      await run("xcrun", [
        "clang",
        "-g",
        "-O0",
        join(root, "fixture.c"),
        "-o",
        binary,
      ]);
      await run("xcrun", ["dsymutil", binary]);
      const metadata = await run("xcrun", [
        "dwarfdump",
        "--uuid",
        `${binary}.dSYM`,
      ]);
      const match = /UUID:\s+([\da-f-]+)\s+\(([^)]+)\)/i.exec(metadata.stdout)!;
      const symbols = await run("xcrun", ["nm", "-n", binary]);
      const address = /([\da-f]+)\s+T\s+_purchase_handler_fixture/i.exec(
        symbols.stdout,
      )![1];
      const input = JSON.stringify({
        usedImages: [
          { uuid: match[1], base: 4294967296, arch: match[2], name: "fixture" },
        ],
        threads: [
          {
            frames: [
              {
                imageIndex: 0,
                imageOffset: Number(BigInt(`0x${address}`) - 4294967296n),
              },
            ],
          },
        ],
      });
      const report = await symbolicateCrash(input, [`${binary}.dSYM`]);
      expect(report.state).toBe("symbolicated");
      expect(report.text).toContain("purchase_handler_fixture");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

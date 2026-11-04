import { readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { run } from "./process";
import { invariant } from "./errors";

export interface ReadableCrash {
  raw: string;
  text: string;
  state:
    "symbolicated" | "partial" | "missing-symbols" | "no-log" | "unavailable";
  resolved: number;
  frames: number;
  missingUuids: string[];
  notes: string[];
}
type Image = { uuid: string; base: string; arch: string; name: string };
type Frame = {
  thread: string;
  number: number;
  image?: Image;
  offset: string;
  symbol?: string;
};
const uuid = (v: string) => v.replaceAll("-", "").toUpperCase();
const hex = (v: string | number | bigint) => `0x${BigInt(v).toString(16)}`;
function crashDocument(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(raw.slice(raw.indexOf("\n") + 1));
    } catch {
      return undefined;
    }
  }
}
function crashHeading(raw: string) {
  const doc = crashDocument(raw);
  if (!doc)
    return raw
      .split("\n")
      .slice(0, 250)
      .filter((line) =>
        /^(Process|Identifier|Version|OS Version|Hardware Model|Exception Type|Exception Codes|Termination Reason|Application Specific Information):/.test(
          line,
        ),
      )
      .map((line) => line.slice(0, 1000))
      .join("\n");
  const words = (parts: unknown[]) =>
    parts
      .filter((v) => v !== undefined && v !== null && v !== "")
      .map(String)
      .join(" · ");
  return [
    ["App", doc.procName ?? doc.bundleInfo?.CFBundleIdentifier],
    [
      "Version / build",
      words([
        doc.bundleInfo?.CFBundleShortVersionString,
        doc.bundleInfo?.CFBundleVersion,
      ]),
    ],
    ["System", doc.osVersion?.train],
    ["Device", doc.modelCode],
    [
      "Exception",
      words([
        doc.exception?.type,
        doc.exception?.signal,
        doc.exception?.subtype,
      ]),
    ],
    [
      "Termination",
      words([
        doc.termination?.namespace,
        doc.termination?.code,
        doc.termination?.indicator,
      ]),
    ],
  ]
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([label, value]) => `${label}: ${String(value).slice(0, 1000)}`)
    .join("\n");
}

export function crashFrames(raw: string): Frame[] {
  const json = crashDocument(raw);
  if (json?.threads && json?.usedImages) {
    const images: Image[] = json.usedImages.map((i: any) => ({
      uuid: String(i.uuid ?? ""),
      base: hex(i.base ?? 0),
      arch: i.arch ?? "arm64",
      name: i.name ?? "Unknown image",
    }));
    const selected = json.threads
      .map((t: any, i: number) => ({
        ...t,
        label: `Thread ${i}${t.triggered || i === json.faultingThread ? " · crashed" : ""}`,
      }))
      .sort(
        (a: any, b: any) =>
          Number(b.label.includes("crashed")) -
          Number(a.label.includes("crashed")),
      )
      .slice(0, 30);
    return selected
      .flatMap((t: any) =>
        (t.frames ?? []).slice(0, 150).map((f: any, number: number) => ({
          thread: t.label,
          number,
          image: images[f.imageIndex],
          offset: hex(f.imageOffset ?? 0),
          symbol: f.symbol
            ? `${f.symbol}${f.symbolLocation ? ` + ${f.symbolLocation}` : ""}`
            : undefined,
        })),
      )
      .slice(0, 500);
  }
  const images = new Map<string, Image>();
  for (const line of raw.split("\n")) {
    const m =
      /^\s*(0x[\da-f]+)\s+-\s+0x[\da-f]+\s+\+?(\S+)\s+(arm64e?|x86_64)\s+<([\da-f-]+)>/i.exec(
        line,
      );
    if (m) images.set(m[2], { base: m[1], name: m[2], arch: m[3], uuid: m[4] });
  }
  const frames: Frame[] = [];
  let thread = "Crash frames";
  for (const line of raw.split("\n")) {
    if (/^Thread \d+/.test(line)) thread = line.trim();
    const m = /^\s*(\d+)\s+(\S+)\s+(0x[\da-f]+)\s+(.*)$/i.exec(line);
    if (!m || !images.has(m[2])) continue;
    const image = images.get(m[2])!;
    const address = BigInt(m[3]),
      base = BigInt(image.base);
    if (address < base) continue;
    frames.push({
      thread,
      number: Number(m[1]),
      image,
      offset: hex(address - base),
      symbol: /^0x[\da-f]+\s*\+/.test(m[4]) ? undefined : m[4],
    });
    if (frames.length === 500) break;
  }
  return frames;
}
export async function symbolicateCrash(
  raw: string,
  roots: string[],
  options: {
    developerDirectory?: string;
    signal?: AbortSignal;
    execute?: typeof run;
  } = {},
): Promise<ReadableCrash> {
  const report: ReadableCrash = {
    raw,
    text: "",
    state: "no-log",
    resolved: 0,
    frames: 0,
    missingUuids: [],
    notes: [],
  };
  if (!raw.trim()) {
    report.notes.push(
      "The tester did not share a crash log. Device, OS and build information are still available in the inbox.",
    );
    return report;
  }
  invariant(
    Buffer.byteLength(raw) <= 8 * 1024 * 1024,
    "CRASH_SIZE",
    "This report exceeds the 8 MB local symbolication limit. Open it in Xcode.",
  );
  let frames: Frame[];
  try {
    frames = crashFrames(raw);
  } catch {
    report.state = "unavailable";
    report.text = raw.slice(0, 100000);
    report.notes.push(
      "The report contains unsupported frame/address data. The original is retained for Xcode inspection.",
    );
    return report;
  }
  report.frames = frames.length;
  if (!frames.length) {
    report.state = "unavailable";
    report.text = raw.slice(0, 100000);
    report.notes.push(
      "This report format has no supported symbolication frames. The original report is retained below.",
    );
    return report;
  }
  const execute = options.execute ?? run,
    env = options.developerDirectory
      ? { DEVELOPER_DIR: options.developerDirectory }
      : undefined;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(90000)])
    : AbortSignal.timeout(90000);
  const symbols = new Map<string, string>();
  const wanted = new Set(
    frames
      .filter((f) => !f.symbol && f.image?.uuid)
      .map((f) => `${uuid(f.image!.uuid)}:${f.image!.arch}`),
  );
  let visited = 0;
  const walk = async (
    folder: string,
    root: string,
    depth = 0,
  ): Promise<void> => {
    signal.throwIfAborted();
    if (depth > 8 || visited > 2000) return;
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(
      () => [],
    )) {
      const path = join(folder, entry.name);
      if (++visited > 2000) return;
      if (entry.isDirectory()) await walk(path, root, depth + 1);
      else if (
        entry.isFile() &&
        path.includes(`${sep}Contents${sep}Resources${sep}DWARF${sep}`)
      ) {
        const actual = await realpath(path);
        if (!actual.startsWith(root + sep)) continue;
        const result = await execute("xcrun", ["dwarfdump", "--uuid", actual], {
          env,
          signal,
          timeout: 10000,
          allowFailure: true,
        });
        for (const match of result.stdout.matchAll(
          /UUID:\s+([\da-f-]+)\s+\(([^)]+)\)/gi,
        )) {
          const key = `${uuid(match[1])}:${match[2]}`;
          if (wanted.has(key)) symbols.set(key, actual);
        }
      }
    }
  };
  for (const folder of wanted.size ? roots.slice(0, 15) : []) {
    const root = await realpath(folder).catch(() => undefined);
    if (root) await walk(root, root);
  }
  const missing = new Set<string>();
  for (const [key, path] of symbols) {
    const matching = frames.filter(
      (f) =>
        !f.symbol && f.image && `${uuid(f.image.uuid)}:${f.image.arch}` === key,
    );
    // ASLR base can differ between images; batch only identical load addresses.
    for (const base of new Set(matching.map((f) => f.image!.base))) {
      const group = matching.filter((f) => f.image!.base === base),
        arch = group[0].image!.arch;
      const result = await execute(
        "xcrun",
        [
          "atos",
          "-arch",
          arch,
          "-o",
          path,
          "-l",
          base,
          ...group.map((f) => hex(BigInt(base) + BigInt(f.offset))),
        ],
        { env, signal, timeout: 20000, allowFailure: true },
      );
      if (result.code !== 0) {
        report.notes.push(
          `Symbolication failed for ${group[0].image!.name}. Check the selected Xcode toolchain.`,
        );
        continue;
      }
      const lines = result.stdout.trim().split("\n");
      group.forEach((f, i) => {
        const value = lines[i]?.trim();
        if (value && !/^0x[\da-f]+(?:\s|$)/i.test(value)) {
          f.symbol = value;
          report.resolved++;
        }
      });
    }
  }
  for (const f of frames)
    if (!f.symbol && f.image?.uuid)
      missing.add(`${f.image.name}: ${f.image.uuid} (${f.image.arch})`);
  report.missingUuids = [...missing];
  report.state = frames.every((f) => f.symbol)
    ? "symbolicated"
    : frames.some((f) => f.symbol)
      ? "partial"
      : "missing-symbols";
  let thread = "";
  report.text = frames
    .map((f) => {
      const heading = f.thread !== thread ? `\n${f.thread}\n` : "";
      thread = f.thread;
      return `${heading}${f.number.toString().padStart(3)}  ${f.image?.name ?? "Unknown image"}  ${f.symbol ?? `+ ${f.offset} [matching symbols unavailable]`}`;
    })
    .join("\n")
    .trim();
  report.text = [crashHeading(raw), report.text].filter(Boolean).join("\n\n");
  if (missing.size)
    report.notes.push(
      "Only matching UUID/architecture dSYMs are used. System-framework symbols may require Xcode’s device support; unavailable symbols are shown explicitly.",
    );
  return report;
}

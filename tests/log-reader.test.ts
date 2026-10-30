import { it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLogPage } from "../src/core/log-reader";
import { logPreview, logWindow } from "../src/core/log-window";
import { LOG_PAGE_ENTRIES, LOG_PAGE_TEXT_BUDGET } from "../src/core/types";
import { methods } from "../src/main/validation";
let root: string, path: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "desk-log-reader-"));
  path = join(root, "logs.jsonl");
});
afterEach(async () => rm(root, { recursive: true, force: true }));
const line = (text: string) =>
  JSON.stringify({ time: "2026-10-30T12:00:00.000Z", stage: "compile", text }) +
  "\n";
it("pages backward through complete UTF-8 records exactly once and searches the whole retained history", async () => {
  const texts = Array.from(
    { length: 1700 },
    (_, i) =>
      `${i}: ${"折り🧩".repeat(i % 90)}${i % 500 === 0 ? " EARLY needle" : ""}`,
  );
  await writeFile(path, texts.map(line).join(""));
  let before: number | undefined;
  const result: string[] = [];
  do {
    const page = await readLogPage(path, { before });
    expect(page.rows.length).toBeLessThanOrEqual(LOG_PAGE_ENTRIES);
    expect(
      page.rows.reduce((size, r) => size + r.entry.text.length, 0),
    ).toBeLessThanOrEqual(LOG_PAGE_TEXT_BUDGET);
    result.unshift(...page.rows.map((r) => r.entry.text));
    if (!page.hasEarlier) break;
    expect(page.before).toBeLessThan(before ?? page.end);
    before = page.before;
  } while (true);
  expect(result).toEqual(texts);
  const matches = await readLogPage(path, { search: "early NEEDLE" });
  expect(matches.rows.map((r) => r.entry.text)).toEqual(
    texts.filter((t) => t.includes("needle")),
  );
  expect(matches.hasEarlier).toBe(false);
});
it("keeps a byte budget without losing the first record of the next page", async () => {
  const texts = Array.from(
    { length: 30 },
    (_, i) => `${i}: ${"x".repeat(14000)}`,
  );
  await writeFile(path, texts.map(line).join(""));
  const last = await readLogPage(path);
  expect(last.rows.length).toBeLessThan(30);
  expect(last.hasEarlier).toBe(true);
  const first = await readLogPage(path, { before: last.before });
  expect([...first.rows, ...last.rows].map((r) => r.entry.text)).toEqual(texts);
});
it("handles partial writes, missing files, malformed rows, and oversized records with bounded memory", async () => {
  expect((await readLogPage(path)).rows).toEqual([]);
  const unfinished = line("last 🧩");
  await writeFile(
    path,
    line("first") +
      "{broken}\n" +
      line("x".repeat(1200000)) +
      line("z".repeat(70000)) +
      unfinished.slice(0, -1),
  );
  const page = await readLogPage(path);
  expect(page.rows.map((r) => r.entry.text)).toEqual([
    "first",
    logPreview("z".repeat(70000)),
  ]);
  expect(page.skipped).toBe(2);
  expect(page.shortened).toBe(1);
  await appendFile(path, "\n");
  expect((await readLogPage(path)).rows.at(-1)?.entry.text).toBe("last 🧩");
  await expect(readLogPage(path, { before: -1 })).rejects.toThrow(/cursor/);
  await expect(
    readLogPage(path, { before: Number.MAX_SAFE_INTEGER }),
  ).rejects.toThrow(/reset/);
  await expect(readLogPage(path, { search: "x".repeat(301) })).rejects.toThrow(
    /300/,
  );
  await writeFile(path, "");
  expect((await readLogPage(path)).rows).toEqual([]);
});
it("yields during long searches and cancels them without reading the whole file", async () => {
  await writeFile(path, line("native output " + "x".repeat(260)).repeat(50608));
  const controller = new AbortController();
  const reading = readLogPage(
    path,
    { search: "not present" },
    controller.signal,
  );
  const timer = setTimeout(() => controller.abort(), 0);
  await expect(reading).rejects.toThrow(/abort/i);
  clearTimeout(timer);
});
it("applies the same size limits to live bursts and validates renderer requests", () => {
  const rows = Array.from({ length: 2000 }, (_, i) => ({
    entry: { text: logPreview(`${i}: ${"x".repeat(20000)}`) },
  }));
  const window = logWindow(rows);
  expect(window.length).toBeLessThan(LOG_PAGE_ENTRIES);
  expect(window.at(-1)).toBe(rows.at(-1));
  expect(
    window.reduce((size, r) => size + r.entry.text.length, 0),
  ).toBeLessThanOrEqual(LOG_PAGE_TEXT_BUDGET);
  expect(
    methods.logPage.safeParse(["job", { before: 0, search: "needle" }]).success,
  ).toBe(true);
  for (const input of [
    ["../secret"],
    ["job", { before: -1 }],
    ["job", { before: Infinity }],
    ["job", { search: "x".repeat(301) }],
    ["job", { path: "/secret" }],
  ])
    expect(methods.logPage.safeParse(input).success).toBe(false);
});

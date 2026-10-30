import { open, type FileHandle } from "node:fs/promises";
import {
  LOG_PAGE_ENTRIES,
  LOG_PAGE_TEXT_BUDGET,
  type LogPage,
  type LogPageRequest,
  type LogRow,
} from "./types";
import { logPreview } from "./log-window";

const CHUNK = 64 * 1024;
const MAX_RECORD = 1024 * 1024;
/** Reverse, bounded reads: the initial view never parses an entire build log.
 * Cursors are record byte offsets, including with multibyte text and corrupt
 * rows. Ignore an unfinished tail until the writer appends its newline. */
async function* records(file: FileHandle, end: number, signal?: AbortSignal) {
  let position = end,
    suffix: Buffer = Buffer.alloc(0),
    tail = true,
    oversized = false;
  while (position > 0) {
    signal?.throwIfAborted();
    const start = Math.max(0, position - CHUNK);
    const chunk = Buffer.alloc(position - start);
    const { bytesRead } = await file.read(chunk, 0, chunk.length, start);
    if (bytesRead !== chunk.length)
      throw new Error(
        "Build log changed while reading. Try Latest output again.",
      );
    const bytes = Buffer.concat([chunk, suffix]);
    let boundary = bytes.length;
    for (let i = bytes.length - 1; i >= 0; i--) {
      if (bytes[i] !== 10) continue;
      signal?.throwIfAborted();
      if (!tail)
        yield {
          offset: start + i + 1,
          bytes:
            oversized || boundary - i - 1 > MAX_RECORD
              ? undefined
              : bytes.subarray(i + 1, boundary),
        };
      tail = false;
      oversized = false;
      boundary = i;
    }
    suffix = bytes.subarray(0, boundary);
    if (suffix.length > MAX_RECORD) {
      suffix = Buffer.alloc(0);
      oversized = true;
    }
    position = start;
  }
  if (!tail && (suffix.length || oversized))
    yield { offset: 0, bytes: oversized ? undefined : suffix };
}

export async function readLogPage(
  path: string,
  request: LogPageRequest = {},
  signal?: AbortSignal,
): Promise<LogPage> {
  if (
    request.before !== undefined &&
    (!Number.isSafeInteger(request.before) || request.before < 0)
  )
    throw new Error("Invalid build log cursor.");
  if (
    request.search !== undefined &&
    (typeof request.search !== "string" || request.search.length > 300)
  )
    throw new Error("Log search must be at most 300 characters.");
  const page: LogPage = {
    rows: [],
    before: 0,
    end: 0,
    hasEarlier: false,
    shortened: 0,
    skipped: 0,
    path,
  };
  const file = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!file) return page;
  try {
    signal?.throwIfAborted();
    const size = (await file.stat()).size;
    if (request.before !== undefined && request.before > size)
      throw new Error("Build log was reset. Choose Latest output.");
    page.end = request.before ?? size;
    const query = request.search?.toLowerCase() ?? "";
    let textSize = 0;
    for await (const record of records(file, page.end, signal)) {
      page.before = record.offset;
      if (!record.bytes) {
        page.skipped++;
        continue;
      }
      let entry;
      try {
        entry = JSON.parse(record.bytes.toString("utf8"));
      } catch {
        page.skipped++;
        continue;
      }
      if (
        typeof entry?.time !== "string" ||
        typeof entry?.stage !== "string" ||
        typeof entry?.text !== "string"
      ) {
        page.skipped++;
        continue;
      }
      if (query && !entry.text.toLowerCase().includes(query)) continue;
      const text = logPreview(entry.text);
      if (page.rows.length && textSize + text.length > LOG_PAGE_TEXT_BUDGET) {
        // This record belongs to the next page, so retain its terminating LF.
        page.before = record.offset + record.bytes.length + 1;
        page.hasEarlier = true;
        break;
      }
      if (text !== entry.text) page.shortened++;
      page.rows.push({
        offset: record.offset,
        entry: { time: entry.time, stage: entry.stage, text },
      } satisfies LogRow);
      textSize += text.length;
      if (page.rows.length === LOG_PAGE_ENTRIES) {
        page.hasEarlier = record.offset > 0;
        break;
      }
    }
    page.rows.reverse();
    return page;
  } finally {
    await file.close();
  }
}

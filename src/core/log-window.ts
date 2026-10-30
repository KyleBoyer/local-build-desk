import {
  LOG_ENTRY_TEXT_LIMIT,
  LOG_PAGE_ENTRIES,
  LOG_PAGE_TEXT_BUDGET,
} from "./types";
export function logPreview(text: string) {
  return text.length > LOG_ENTRY_TEXT_LIMIT
    ? text.slice(0, LOG_ENTRY_TEXT_LIMIT) +
        "\n[Entry shortened. Open the complete log to read all of it.]"
    : text;
}
/** Same row/text budget for retained pages and bursts of live output. */
export function logWindow<T extends { entry: { text: string } }>(
  rows: T[],
): T[] {
  let start = rows.length,
    size = 0;
  while (start > 0 && rows.length - start < LOG_PAGE_ENTRIES) {
    const length = rows[start - 1].entry.text.length;
    if (start < rows.length && size + length > LOG_PAGE_TEXT_BUDGET) break;
    size += length;
    start--;
  }
  return rows.slice(start);
}

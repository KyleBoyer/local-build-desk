import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uploadStream } from "../src/core/transfer";
it("does not report an artifact sent before the transport consumes it, and streams the exact bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-transfer-"));
  const file = join(root, "app.aab");
  const bytes = Buffer.alloc(1024 * 1024, 7);
  await writeFile(file, bytes);
  const updates: number[] = [];
  const stream = uploadStream(file, bytes.length, (value) =>
    updates.push(value),
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(updates).toEqual([0]);
    const reader = stream.body.getReader();
    const first = await reader.read();
    expect(first.value!.length).toBeLessThan(bytes.length);
    expect(updates.at(-1)).toBeLessThan(bytes.length);
    const chunks = [Buffer.from(first.value!)];
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(Buffer.from(part.value));
    }
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(updates.at(-1)).toBe(bytes.length);
  } finally {
    stream.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import { frameSchema } from "../src/core/release-check-schema";
import { frameScreenshot, wrapHeadline } from "../src/core/screenshot-frame";

function png(width: number, height: number, rgb: [number, number, number]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: width }, () => rgb).flat()),
  ]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

it("wraps a headline to the frame's width with the real font", () => {
  const frame = frameSchema.parse({ fontFamily: "Helvetica" });
  const lines = wrapHeadline(
    "A puzzle you solve by folding the world",
    frame,
    60,
    500,
  );
  expect(lines.length).toBeGreaterThan(1);
  expect(lines.join(" ")).toBe("A puzzle you solve by folding the world");
});

it("frames a capture at its own size with background, headline and screenshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lbd-frame-"));
  await writeFile(join(dir, "raw.png"), png(600, 1200, [255, 0, 0]));
  const framed = await frameScreenshot(
    join(dir, "raw.png"),
    join(dir, "framed.png"),
    frameSchema.parse({
      background: "#000080",
      borderColor: "#00ff00",
      borderWidth: 0.01,
    }),
    "Fold the world",
  );
  const out = await readFile(framed.path);
  expect(out.readUInt32BE(16)).toBe(600);
  expect(out.readUInt32BE(20)).toBe(1200);
  expect(framed.size).toBe(out.length);
  // Decode via resvg to sample pixels: corner is background, center is the capture.
  const pixels = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="600" height="1200"><image width="600" height="1200" xlink:href="data:image/png;base64,${out.toString("base64")}"/></svg>`,
  ).render().pixels;
  const at = (x: number, y: number) => [
    ...pixels.subarray((y * 600 + x) * 4, (y * 600 + x) * 4 + 3),
  ];
  expect(at(5, 5)).toEqual([0, 0, 128]);
  expect(at(300, 800)).toEqual([255, 0, 0]);
  expect(at(5, 1195)).toEqual([0, 0, 128]);
});

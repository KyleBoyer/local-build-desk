import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Resvg, type ResvgRenderOptions } from "@resvg/resvg-js";
import type { ScreenshotFrame } from "./release-check-schema";
import { invariant } from "./errors";

const escape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const fontOptions = (frame: ScreenshotFrame): ResvgRenderOptions["font"] => ({
  loadSystemFonts: true,
  defaultFontFamily: frame.fontFamily,
});

/** Breaks a headline into lines no wider than `width`, measuring each
 * candidate with the frame's real font. */
export function wrapHeadline(
  text: string,
  frame: ScreenshotFrame,
  size: number,
  width: number,
) {
  const measure = (line: string) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width * 4}" height="${size * 3}"><text x="0" y="${size * 2}" font-family="${escape(frame.fontFamily)}" font-weight="${frame.fontWeight}" font-size="${size}">${escape(line)}</text></svg>`;
    return new Resvg(svg, { font: fontOptions(frame) }).getBBox()?.width ?? 0;
  };
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next) > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

/** Google Play rejects screenshots more than twice as long as they are wide;
 * taller captures get a 9:16 canvas of the same width. */
export function playCanvas(width: number, height: number) {
  return height > width * 2
    ? { width, height: Math.round((width * 16) / 9) }
    : { width, height };
}

/** Renders a store image, by default at the capture's own size: optional
 * headline at the top, then the screenshot scaled to fit, with rounded
 * corners and an optional border, over a plain or gradient background. */
export async function frameScreenshot(
  input: string,
  output: string,
  frame: ScreenshotFrame,
  headline?: string,
  canvas?: (width: number, height: number) => { width: number; height: number },
) {
  const png = await readFile(input);
  invariant(
    png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "SCREENSHOT_FORMAT",
    "Only PNG captures can be framed.",
  );
  const shotW = png.readUInt32BE(16),
    shotH = png.readUInt32BE(20);
  const { width: W, height: H } = canvas?.(shotW, shotH) ?? {
    width: shotW,
    height: shotH,
  };
  const margin = Math.round(W * 0.07),
    size = Math.round(W * frame.headlineSize),
    lineHeight = Math.round(size * 1.18);
  const lines = headline
    ? wrapHeadline(headline, frame, size, W - margin * 2)
    : [];
  const textTop = Math.round(H * 0.045);
  const textBottom = lines.length
    ? textTop + lines.length * lineHeight + Math.round(size * 0.25)
    : 0;
  const gap = lines.length ? Math.round(W * 0.045) : Math.round(H * 0.05);
  const available = H - textBottom - gap - Math.round(H * 0.04);
  const scale = Math.min(
    (W * frame.screenshotScale) / shotW,
    available / shotH,
  );
  const w = Math.round(shotW * scale),
    h = Math.round(shotH * scale),
    x = Math.round((W - w) / 2),
    y = textBottom + gap;
  const radius = Math.round(w * frame.cornerRadius),
    border = Math.round(W * frame.borderWidth);
  const fill = frame.backgroundEnd ? "url(#bg)" : frame.background;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
${frame.backgroundEnd ? `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${frame.background}"/><stop offset="1" stop-color="${frame.backgroundEnd}"/></linearGradient>` : ""}
<clipPath id="shot"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" ry="${radius}"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="${fill}"/>
${lines
  .map(
    (line, i) =>
      `<text x="${W / 2}" y="${textTop + (i + 1) * lineHeight - Math.round(size * 0.18)}" text-anchor="middle" fill="${frame.textColor}" font-family="${escape(frame.fontFamily)}" font-weight="${frame.fontWeight}" font-size="${size}">${escape(line)}</text>`,
  )
  .join("\n")}
${border ? `<rect x="${x - border / 2}" y="${y - border / 2}" width="${w + border}" height="${h + border}" rx="${radius + border / 2}" ry="${radius + border / 2}" fill="none" stroke="${frame.borderColor ?? frame.textColor}" stroke-width="${border}"/>` : ""}
<image x="${x}" y="${y}" width="${w}" height="${h}" clip-path="url(#shot)" preserveAspectRatio="none" xlink:href="data:image/png;base64,${png.toString("base64")}"/>
</svg>`;
  const rendered = new Resvg(svg, {
    font: fontOptions(frame),
    fitTo: { mode: "original" },
  })
    .render()
    .asPng();
  await writeFile(output, rendered);
  return {
    path: output,
    size: rendered.length,
    sha256: createHash("sha256").update(rendered).digest("hex"),
  };
}

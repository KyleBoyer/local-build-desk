import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { invariant } from "./errors";
// Minimal protobuf reader for the public AAPT2 XmlNode/XmlElement/XmlAttribute wire format.
// Schema: https://android.googlesource.com/platform/frameworks/base/+/master/tools/aapt2/Resources.proto
interface Wire {
  tag: number;
  data: Buffer | number;
}
function fields(buffer: Buffer): Wire[] {
  let offset = 0;
  const out: Wire[] = [];
  const variable = () => {
    let value = 0,
      multiplier = 1;
    for (let i = 0; i < 10; i++) {
      invariant(
        offset < buffer.length,
        "AAB_PROTO",
        "Truncated manifest protobuf.",
      );
      const byte = buffer[offset++];
      value += (byte & 127) * multiplier;
      if (!(byte & 128)) return value;
      multiplier *= 128;
    }
    throw new Error("Invalid protobuf integer.");
  };
  while (offset < buffer.length) {
    const key = variable(),
      tag = key >>> 3,
      type = key & 7;
    invariant(tag > 0, "AAB_PROTO", "Invalid manifest tag.");
    if (type === 0) out.push({ tag, data: variable() });
    else if (type === 2) {
      const length = variable();
      invariant(
        offset + length <= buffer.length,
        "AAB_PROTO",
        "Manifest length is invalid.",
      );
      out.push({ tag, data: buffer.subarray(offset, offset + length) });
      offset += length;
    } else if (type === 1) offset += 8;
    else if (type === 5) offset += 4;
    else throw new Error(`Unsupported protobuf wire type ${type}`);
    invariant(
      offset <= buffer.length,
      "AAB_PROTO",
      "Truncated manifest field.",
    );
  }
  return out;
}
function child(values: Wire[], tag: number) {
  const value = values.find((f) => f.tag === tag)?.data;
  return Buffer.isBuffer(value) ? value : undefined;
}
function text(values: Wire[], tag: number) {
  return child(values, tag)?.toString();
}
export function parseBundleManifest(buffer: Buffer): {
  packageName: string;
  versionCode: string;
  versionName: string;
} {
  const element = child(fields(buffer), 1);
  invariant(element, "AAB_MANIFEST", "Bundle has no manifest element.");
  const root = fields(element);
  invariant(
    text(root, 3) === "manifest",
    "AAB_MANIFEST",
    "Bundle root is not a manifest.",
  );
  const attrs: Record<string, string> = {};
  for (const entry of root.filter((f) => f.tag === 4)) {
    invariant(
      Buffer.isBuffer(entry.data),
      "AAB_ATTRIBUTE",
      "Invalid manifest attribute.",
    );
    const attr = fields(entry.data);
    const name = text(attr, 2);
    let value = text(attr, 3);
    if (value === undefined || value === "") {
      const compiled = child(attr, 6);
      if (compiled) {
        const item = fields(compiled);
        const str = child(item, 2) ?? child(item, 3);
        const prim = child(item, 7);
        if (str) value = text(fields(str), 1);
        if (prim) {
          const number = fields(prim).find((f) => [6, 7].includes(f.tag))?.data;
          if (typeof number === "number") value = String(number);
        }
      }
    }
    if (name && value !== undefined) attrs[name] = value;
  }
  invariant(
    attrs.package && attrs.versionCode && attrs.versionName,
    "AAB_METADATA",
    "Unable to read bundle package, versionCode, and versionName.",
  );
  return {
    packageName: attrs.package,
    versionCode: attrs.versionCode,
    versionName: attrs.versionName,
  };
}
export async function readBundleManifest(path: string, signal?: AbortSignal) {
  const result = await promisify(execFile)(
    "/usr/bin/unzip",
    ["-p", path, "base/manifest/AndroidManifest.xml"],
    { encoding: "buffer", maxBuffer: 4 * 1024 * 1024, signal },
  );
  return parseBundleManifest(result.stdout);
}

import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MonitorConfig } from "./types";
export function privateIPv4(address: string) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
export function monitorInterfaces() {
  return Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? []).flatMap((a) =>
      a.family === "IPv4" && !a.internal && privateIPv4(a.address)
        ? [
            {
              address: a.address,
              label: `${name} · ${a.address}${a.address.startsWith("100.") ? " · private VPN" : ""}`,
            },
          ]
        : [],
    ),
  );
}
export const monitorConfigSchema = z
  .object({
    tls: z.enum(["self-signed", "custom", "off"]).default("self-signed"),
    enabled: z.boolean(),
    host: z
      .string()
      .refine(
        privateIPv4,
        "Choose a private IPv4 address on this Mac or 127.0.0.1.",
      ),
    port: z.number().int().min(1024).max(65535),
    publicOrigin: z
      .string()
      .max(512)
      .optional()
      .transform((value) => value?.trim() || undefined),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.publicOrigin)
      try {
        const url = new URL(config.publicOrigin);
        if (
          config.host !== "127.0.0.1" ||
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        )
          throw Error();
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["publicOrigin"],
          message:
            "An HTTPS reverse-proxy origin requires loopback binding and a URL without a path, credentials or query.",
        });
      }
  });
export const defaultMonitorConfig: MonitorConfig = {
  tls: "self-signed",
  enabled: false,
  host: "127.0.0.1",
  port: 43178,
};
export function readMonitorConfig(root: string): MonitorConfig {
  try {
    return monitorConfigSchema.parse(
      JSON.parse(readFileSync(join(root, "mobile-monitor.json"), "utf8")),
    );
  } catch {
    return { ...defaultMonitorConfig };
  }
}
export function writeMonitorConfig(root: string, value: MonitorConfig) {
  const config = monitorConfigSchema.parse(value);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temp = join(root, `.monitor-${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(config), { mode: 0o600 });
  renameSync(temp, join(root, "mobile-monitor.json"));
  return config;
}

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  stat,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Store } from "../src/core/database";
import { MonitorAuth } from "../src/mobile/auth";
import { MonitorTLS } from "../src/mobile/tls";
import { MobileMonitor } from "../src/mobile/server";
import { monitorJob, monitorLogs, monitorSnapshot } from "../src/mobile/data";
import {
  defaultMonitorConfig,
  monitorConfigSchema,
  privateIPv4,
  readMonitorConfig,
  writeMonitorConfig,
} from "../src/mobile/config";
import type { Engine } from "../src/core/engine";
import type { Job, Project } from "../src/core/types";
async function freePort() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as any).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port as number;
}
let root: string, store: Store, monitor: MobileMonitor, engine: Engine;
const key = randomBytes(32);
const encryption = {
  async encrypt(value: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv);
    return Buffer.concat([
      iv,
      cipher.update(value),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  },
  async decrypt(value: Buffer) {
    const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
    cipher.setAuthTag(value.subarray(-16));
    return Buffer.concat([
      cipher.update(value.subarray(12, -16)),
      cipher.final(),
    ]).toString();
  },
};
const project = {
  id: "project",
  name: "Crease",
  path: "/private/source/crease",
  settings: {
    appleConnectionId: "private-credential",
    buildDirectory: "/private/builds",
  },
  bundleId: "com.example.crease",
  createdAt: "now",
  profiles: ["production"],
} as Project;
const job = {
  id: "job",
  projectId: "project",
  projectName: "Crease",
  platform: "ios",
  profile: "production",
  kind: "build",
  status: "running",
  stage: "compile",
  createdAt: new Date().toISOString(),
  projectSnapshot: project,
  invocation: { secret: "private-token" },
  progress: {
    kind: "download",
    label: "Download",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedBytes: 50,
    totalBytes: 100,
  },
  error:
    "apiKey=private-token /private/source/crease/private.txt /private/builds/temp",
  checkpoints: [],
} as unknown as Job;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "desk-mobile-"));
  store = new Store(root);
  const events = new EventEmitter();
  engine = Object.assign(events, {
    store,
    state: () => ({
      projects: [project],
      jobs: [job],
      artifacts: [],
      credentials: [{ secret: "never-export" }],
    }),
    async screenshotPreview() {
      return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8l0AAAAASUVORK5CYII=";
    },
    async storeReleases() {
      return { releases: [], checkedAt: "now", channels: {} };
    },
  }) as unknown as Engine;
  const assets = join(root, "assets");
  await mkdir(assets);
  await writeFile(
    join(assets, "mobile.html"),
    '<html><script src="/assets/mobile-fixture.js"></script></html>',
  );
  monitor = new MobileMonitor(engine, assets, "test", encryption);
});
afterEach(async () => {
  await monitor.dispose();
  store.close();
  await rm(root, { recursive: true, force: true });
});
function request(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    host?: string;
    origin?: string;
    ca?: string;
    etag?: string;
    action?: boolean;
  } = {},
) {
  const status = monitor.status(),
    url = new URL(path, status.localUrl);
  return new Promise<{ status: number; headers: any; body: string }>(
    (resolve, reject) => {
      const body =
          options.body === undefined ? undefined : JSON.stringify(options.body),
        headers: any = {};
      if (body) {
        headers["content-type"] = "application/json";
        headers["content-length"] = Buffer.byteLength(body);
      }
      if (options.action) headers["x-lbd-action"] = "1";
      if (options.cookie) headers.cookie = options.cookie;
      if (options.etag) headers["if-none-match"] = options.etag;
      if (options.host) headers.host = options.host;
      if (options.origin) headers.origin = options.origin;
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: options.method ?? "GET",
          headers,
          ca: options.ca,
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    },
  );
}
async function start(tls: "off" | "self-signed" = "off") {
  const status = await monitor.configure({
    ...defaultMonitorConfig,
    enabled: true,
    tls,
    port: await freePort(),
  });
  expect(status.error).toBeUndefined();
  return status;
}
async function pair(ca?: string) {
  const code = await monitor.pairing();
  const r = await request("/api/pair", {
    method: "POST",
    origin: monitor.status().url,
    body: { code: code.code, name: "Test phone" },
    ca,
  });
  expect(r.status).toBe(200);
  return {
    cookie: r.headers["set-cookie"][0].split(";")[0],
    response: r,
    code,
  };
}
describe("mobile monitor", () => {
  it("requires an available private address and defaults to disabled self-signed HTTPS", async () => {
    expect(readMonitorConfig(root)).toEqual(defaultMonitorConfig);
    for (const ip of [
      "10.1.2.3",
      "172.16.1.2",
      "192.168.1.2",
      "100.64.0.1",
      "127.0.0.1",
    ])
      expect(privateIPv4(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "0.0.0.0", "::"])
      expect(privateIPv4(ip)).toBe(false);
    expect(() =>
      monitorConfigSchema.parse({ ...defaultMonitorConfig, host: "8.8.8.8" }),
    ).toThrow();
    expect(() =>
      monitorConfigSchema.parse({
        ...defaultMonitorConfig,
        publicOrigin: "http://bad.example",
      }),
    ).toThrow();
    writeMonitorConfig(root, defaultMonitorConfig);
    expect((await stat(join(root, "mobile-monitor.json"))).mode & 0o777).toBe(
      0o600,
    );
    const bad = await monitor.configure({
      ...defaultMonitorConfig,
      enabled: true,
      host: "192.168.254.254",
    });
    expect(bad.running).toBe(false);
    expect(bad.error).toMatch(/not available/);
  });
  it("persists only hashed sessions, expires codes, and revokes devices across restarts", () => {
    let clock = Date.now();
    const auth = new MonitorAuth(store, () => clock);
    const code = auth.pairingCode();
    clock += 300001;
    expect(auth.pair(code.code, "Phone")).toBeUndefined();
    const fresh = auth.pairingCode();
    const paired = auth.pair(fresh.code, "Phone")!;
    expect(auth.pair(fresh.code, "Another")).toBeUndefined();
    expect(
      JSON.stringify(store.preference("monitor-devices", [])),
    ).not.toContain(paired.token);
    expect(
      new MonitorAuth(store, () => clock).session(paired.token)?.name,
    ).toBe("Phone");
    expect(JSON.stringify(auth.devices())).not.toContain("hash");
    auth.revoke(paired.device.id);
    expect(auth.session(paired.token)).toBeUndefined();
    const next = auth.pair(auth.pairingCode().code, "Expiring phone")!;
    clock += 30 * 24 * 60 * 60 * 1000 + 1;
    expect(auth.session(next.token)).toBeUndefined();
  });
  it("serves only the mobile entry, rejects DNS rebinding/CSRF, and exposes a read-only authenticated whitelist", async () => {
    await start();
    expect((await request("/")).body).toContain("mobile-");
    expect((await request("/")).headers["content-security-policy"]).toContain(
      "script-src 'self'",
    );
    expect((await request("/api/state")).status).toBe(401);
    expect((await request("/", { host: "evil.example" })).status).toBe(403);
    expect(
      (
        await request("/api/pair", {
          method: "POST",
          origin: "https://evil.example",
          body: { code: "x" },
        })
      ).status,
    ).toBe(403);
    expect((await request("/../package.json")).status).toBe(404);
    const { cookie, response, code } = await pair();
    expect(response.headers["set-cookie"][0]).toContain(
      "HttpOnly; SameSite=Strict",
    );
    expect(
      (
        await request("/api/pair", {
          method: "POST",
          origin: monitor.status().url,
          body: { code: code.code },
        })
      ).status,
    ).toBe(401);
    const state = await request("/api/state", { cookie });
    expect(state.status).toBe(200);
    for (const privateValue of [
      "private-token",
      "private-credential",
      "never-export",
      "projectSnapshot",
      "invocation",
      "/private/source",
      "/private/builds",
    ])
      expect(state.body).not.toContain(privateValue);
    expect(
      (
        await request("/api/build", {
          method: "POST",
          origin: monitor.status().url,
          cookie,
          body: {},
        })
      ).status,
    ).toBe(405);
    expect((await request("/api/jobs/job/captures", { cookie })).status).toBe(
      400,
    );
    expect(
      (await request("/api/jobs/job/captures/0", { cookie })).headers[
        "content-type"
      ],
    ).toBe("image/png");
    expect(
      (await request("/api/history?query=crease&offset=0", { cookie })).body,
    ).toContain("Crease");
    expect((await request("/api/history?offset=-1", { cookie })).status).toBe(
      400,
    );
    const image = await request("/api/jobs/job/captures/0", { cookie });
    expect(image.headers["cache-control"]).toBe("private, no-cache");
    const cached = await request("/api/jobs/job/captures/0", {
      cookie,
      etag: image.headers.etag,
    });
    expect(cached.status).toBe(304);
    expect(cached.body).toBe("");
    monitor.revoke();
    expect(
      (
        await request("/api/jobs/job/captures/0", {
          cookie,
          etag: image.headers.etag,
        })
      ).status,
    ).toBe(401);
    expect((await request("/api/state", { cookie })).status).toBe(401);
  });
  it("generates usable TLS with an encrypted private key, secure sessions, certificate reuse and custom import", async () => {
    await start("self-signed");
    const saved = store.preference<{ cert: string; key: string }>(
      "monitor-local-tls",
      {} as any,
    );
    expect(saved.cert).toContain("BEGIN CERTIFICATE");
    expect(Buffer.from(saved.key, "base64").toString()).not.toContain(
      "PRIVATE KEY",
    );
    expect(monitor.status().certificate?.selfSigned).toBe(true);
    await expect(request("/")).rejects.toThrow(/self.signed/i);
    expect((await request("/", { ca: saved.cert })).status).toBe(200);
    const { response } = await pair(saved.cert);
    expect(response.headers["set-cookie"][0]).toContain("; Secure");
    const tls = new MonitorTLS(store, encryption);
    await tls.options({ ...defaultMonitorConfig, tls: "self-signed" });
    expect(tls.information?.fingerprint).toBe(
      monitor.status().certificate?.fingerprint,
    );
    const cert = join(root, "custom.pem"),
      privateKey = join(root, "custom.key");
    await writeFile(cert, saved.cert);
    await writeFile(
      privateKey,
      await encryption.decrypt(Buffer.from(saved.key, "base64")),
      { mode: 0o600 },
    );
    await tls.import({ certificatePath: cert, keyPath: privateKey });
    expect(
      (await tls.options({ ...defaultMonitorConfig, tls: "custom" }))?.cert,
    ).toBe(saved.cert);
    await expect(
      tls.options({
        ...defaultMonitorConfig,
        tls: "custom",
        host: "192.168.254.254",
      }),
    ).rejects.toThrow(/listen IP/);
  });
  it("streams state and log changes, then invalidates a revoked connection", async () => {
    await start();
    const { cookie } = await pair();
    const chunks: string[] = [];
    const req = httpRequest(
      new URL("/api/events", monitor.status().url),
      { headers: { cookie } },
      (res) => res.on("data", (c) => chunks.push(c.toString())),
    );
    req.end();
    await expect.poll(() => chunks.join("")).toContain("event: state");
    engine.emit("event", { type: "log", jobId: "job" });
    await expect.poll(() => chunks.join("")).toContain("event: logs");
    engine.emit("event", { type: "state" });
    await expect
      .poll(() => chunks.filter((c) => c.includes("event: state")).length)
      .toBe(2);
    monitor.revoke();
    await expect.poll(() => chunks.join("")).toContain("event: session");
    req.destroy();
    expect((await request("/api/state", { cookie })).status).toBe(401);
  });
  it("bounds log reads, redacts secrets/paths/ANSI, handles incomplete UTF-8 tails and file resets", async () => {
    await mkdir(join(root, "jobs/job"), { recursive: true });
    const file = join(root, "jobs/job/logs.jsonl"),
      row = (text: string) =>
        JSON.stringify({ time: "now", stage: "compile", text }) + "\n";
    await writeFile(
      file,
      row("\u001b[31mapiKey=private-token /private/source/crease 🚀") +
        '{"partial":',
    );
    const first = await monitorLogs(engine, "job");
    expect(first.entries[0].text).toBe("apiKey=[REDACTED] [Mac path] 🚀");
    const partial = await monitorLogs(engine, "job", first.cursor);
    expect(partial.cursor).toBe(first.cursor);
    expect(partial.hasMore).toBe(false);
    await writeFile(file, row("new"));
    const reset = await monitorLogs(engine, "job", 10000);
    expect(reset.reset).toBe(true);
    expect(reset.entries[0].text).toBe("new");
    await writeFile(file, "x".repeat(600000));
    const oversized = await monitorLogs(engine, "job", 0);
    expect(oversized.cursor).toBe(512 * 1024);
    expect(oversized.hasMore).toBe(true);
  });
  it("paginates full history without leaking project settings or artifact paths", async () => {
    const original = engine.state;
    engine.state = () => ({
      ...original.call(engine),
      jobs: Array.from({ length: 80 }, (_, i) => ({
        ...job,
        id: `job${i}`,
        buildNumber: String(i),
        status: "succeeded",
      })),
    });
    await start();
    const { cookie } = await pair();
    const page = JSON.parse(
      (await request("/api/history?offset=30&status=succeeded", { cookie }))
        .body,
    );
    expect(page.total).toBe(80);
    expect(page.jobs).toHaveLength(30);
    expect(page.jobs[0].id).toBe("job30");
    expect(
      JSON.stringify(monitorJob(job, [], [project.path, "/private/builds"])),
    ).not.toContain("private-token");
    expect(monitorSnapshot(engine, "test", "now").jobs).toHaveLength(80);
  });
});

describe("scoped mobile controls", () => {
  const base = "/api/projects/project/releases/appstore%3Aversion/";
  async function setup() {
    await start("self-signed");
    const ca = store.preference<{ cert: string }>(
      "monitor-local-tls",
      {} as any,
    ).cert;
    const paired = await pair(ca);
    const id = monitor.status().devices[0]!.id;
    const post = (
      path: string,
      body: unknown = {},
      extra: Record<string, unknown> = {},
    ) =>
      request(path, {
        method: "POST",
        body,
        cookie: paired.cookie,
        ca,
        origin: monitor.status().url,
        action: true,
        ...extra,
      });
    const prepare = vi.fn(async () => ({
      token: "desktop-token",
      title: "Release approved version",
      identity: "com.example.crease 1.0 (3)",
      changes: ["Release version 1.0"],
      warnings: ["Public release"],
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    }));
    const apply = vi.fn(async () => ({
      message: "Release requested",
      receiptId: "receipt",
    }));
    Object.assign(engine, {
      preparePublishing: prepare,
      applyStoreAction: apply,
    });
    return { ca, paired, id, post, prepare, apply };
  }
  it("keeps old and newly paired devices read-only, persists explicit grants, and disallows plaintext writes", async () => {
    const { id, paired, post, prepare } = await setup();
    expect((await post(base + "release-preview")).status).toBe(403);
    monitor.permissions(id, { manageQueue: true, releaseApple: false });
    expect((await post(base + "release-preview")).status).toBe(403);
    monitor.permissions(id, { manageQueue: false, releaseApple: true });
    expect((await post(base + "release-preview")).status).toBe(200);
    expect(new MonitorAuth(store).devices()[0]?.permissions?.releaseApple).toBe(
      true,
    );
    await start("off");
    const denied = await request(base + "release-preview", {
      method: "POST",
      body: {},
      cookie: paired.cookie,
      origin: monitor.status().url,
      action: true,
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toContain("HTTPS");
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it("requires same-origin JSON and an action header, and rejects extra commands", async () => {
    const { id, post, prepare } = await setup();
    monitor.permissions(id, { manageQueue: false, releaseApple: true });
    expect(
      (
        await post(
          base + "release-preview",
          {},
          { origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await post(base + "release-preview", {}, { action: false })).status,
    ).toBe(403);
    expect(
      (await post(base + "release-preview", { kind: "submit" })).status,
    ).toBe(400);
    expect((await post("/api/build")).status).toBe(405);
    expect(prepare).not.toHaveBeenCalled();
  });
  it("binds single-use preview handles to the phone, project and release, including simultaneous confirmations", async () => {
    const { id, post, prepare, apply, ca } = await setup();
    monitor.permissions(id, { manageQueue: false, releaseApple: true });
    const preview = JSON.parse((await post(base + "release-preview")).body);
    expect(preview.token).not.toBe("desktop-token");
    expect(prepare).toHaveBeenCalledWith("project", "appstore:version", {
      kind: "release",
    });
    const other = await pair(ca);
    const otherId = monitor.status().devices.find((d) => d.id !== id)!.id;
    monitor.permissions(otherId, { manageQueue: false, releaseApple: true });
    expect(
      (
        await post(
          base + "release-confirm",
          { token: preview.token },
          { cookie: other.cookie },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await post(
          base.replace("appstore%3Aversion", "appstore%3Aother") +
            "release-confirm",
          { token: preview.token },
        )
      ).status,
    ).toBe(409);
    expect(
      (await post(base + "release-confirm", { token: "desktop-token" })).status,
    ).toBe(400);
    const results = await Promise.all([
      post(base + "release-confirm", { token: preview.token }),
      post(base + "release-confirm", { token: preview.token }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(apply).toHaveBeenCalledExactlyOnceWith("project", "desktop-token");
  });
  it("invalidates previews on permission changes, revocation, expiry and monitor restart", async () => {
    const { id, post, prepare, apply } = await setup();
    monitor.permissions(id, { manageQueue: false, releaseApple: true });
    let token = JSON.parse((await post(base + "release-preview")).body).token;
    monitor.permissions(id, { manageQueue: false, releaseApple: true });
    expect((await post(base + "release-confirm", { token })).status).toBe(409);
    prepare.mockResolvedValueOnce({
      ...(await prepare()),
      expiresAt: new Date(0).toISOString(),
    });
    token = JSON.parse((await post(base + "release-preview")).body).token;
    expect((await post(base + "release-confirm", { token })).status).toBe(409);
    token = JSON.parse((await post(base + "release-preview")).body).token;
    await monitor.stop();
    await monitor.start();
    expect((await post(base + "release-confirm", { token })).status).toBe(409);
    token = JSON.parse((await post(base + "release-preview")).body).token;
    monitor.revoke(id);
    expect((await post(base + "release-confirm", { token })).status).toBe(401);
    expect(apply).not.toHaveBeenCalled();
  });
  it("does not retain a preview if permission changes during provider reads", async () => {
    const { id, post, prepare, apply } = await setup();
    monitor.permissions(id, { manageQueue: false, releaseApple: true });
    const result = await prepare();
    let finish!: (value: typeof result) => void;
    prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = post(base + "release-preview");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    monitor.permissions(id, { manageQueue: false, releaseApple: false });
    finish(result);
    expect((await pending).status).toBe(403);
    expect(apply).not.toHaveBeenCalled();
  });
  it("never reuses an unanswered confirmation and reconciles only receipts from the selected release", async () => {
    const { id, post, apply, ca, paired } = await setup();
    monitor.permissions(id, { manageQueue: false, releaseApple: true });
    const receiptId = "8f042f08-7e54-4fba-ae71-0134768862b2";
    const reconcile = vi.fn(async () => ({ state: "complete" }));
    Object.assign(engine, {
      readPublishing: async () => ({
        receipts: [
          {
            id: receiptId,
            title: "Release",
            state: "uncertain",
            updatedAt: "now",
            recovery: { secret: "never-export" },
          },
        ],
      }),
      reconcilePublishing: reconcile,
    });
    apply.mockRejectedValueOnce(Error("Connection lost"));
    const preview = JSON.parse((await post(base + "release-preview")).body);
    expect(
      (await post(base + "release-confirm", { token: preview.token })).status,
    ).toBe(409);
    expect(
      (await post(base + "release-confirm", { token: preview.token })).status,
    ).toBe(409);
    expect(apply).toHaveBeenCalledTimes(1);
    const status = await request(base + "release-status", {
      ca,
      cookie: paired.cookie,
    });
    expect(status.body).not.toContain("recovery");
    expect(
      (
        await post(base + "release-reconcile", {
          receiptId: "6e2c1d4f-25a8-446c-b324-de4bf029c548",
        })
      ).status,
    ).toBe(404);
    expect(reconcile).not.toHaveBeenCalled();
    expect((await post(base + "release-reconcile", { receiptId })).status).toBe(
      200,
    );
    expect(reconcile).toHaveBeenCalledExactlyOnceWith("project", receiptId);
  });
  it("cancels only jobs that are still queued and refreshes only completed pending uploads", async () => {
    const { id, post } = await setup();
    const cancel = vi.fn(),
      reconcile = vi.fn(async () => {});
    let selected = { ...job, status: "queued" };
    Object.assign(engine, {
      state: () => ({ projects: [project], jobs: [selected], artifacts: [] }),
      cancel,
      reconcile,
    });
    monitor.permissions(id, { manageQueue: false, releaseApple: true });
    expect((await post("/api/jobs/job/cancel-queued")).status).toBe(403);
    monitor.permissions(id, { manageQueue: true, releaseApple: false });
    expect((await post("/api/jobs/job/cancel-queued")).status).toBe(200);
    selected.status = "running";
    expect((await post("/api/jobs/job/cancel-queued")).status).toBe(409);
    expect((await post("/api/jobs/job/reconcile")).status).toBe(409);
    expect(cancel).toHaveBeenCalledTimes(1);
    selected = {
      ...selected,
      status: "succeeded",
      submission: { state: "processing", destination: "TestFlight" },
    } as typeof selected;
    expect((await post("/api/jobs/job/reconcile")).status).toBe(200);
    expect(reconcile).toHaveBeenCalledExactlyOnceWith("job");
    expect((await post("/api/jobs/unknown/cancel-queued")).status).toBe(404);
  });
});

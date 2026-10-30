import { createServer as createHTTPSServer } from "node:https";
import type { TLSSocket } from "node:tls";
import type { Encryption } from "../core/vault";
import { MonitorTLS, type CertificateFiles } from "./tls";
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { EventEmitter } from "node:events";
import QRCode from "qrcode";
import { z } from "zod";
import type { Engine } from "../core/engine";
import type { DeskEvent, Job } from "../core/types";
import { messageOf } from "../core/errors";
import {
  monitorConfigSchema,
  monitorInterfaces,
  readMonitorConfig,
  writeMonitorConfig,
  privateIPv4,
} from "./config";
import { MonitorAuth } from "./auth";
import { monitorSnapshot, monitorJob, monitorLogs, monitorText } from "./data";
import type { MonitorConfig, MonitorStatus, MonitorPairing } from "./types";
const cookieName = "lbd_monitor";
const pairs = z
  .object({
    code: z.string().min(1).max(80),
    name: z.string().max(80).default("Mobile browser"),
  })
  .strict();
const baseHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
const loopback = (value: string) =>
  value === "::1" || value === "127.0.0.1" || value === "::ffff:127.0.0.1";
export class MobileMonitor extends EventEmitter {
  private server?: Server;
  private config: MonitorConfig;
  private error?: string;
  private startedAt = new Date().toISOString();
  private auth: MonitorAuth;
  private tls: MonitorTLS;
  private streams = new Map<
    ServerResponse,
    { device: string; timer: ReturnType<typeof setInterval> }
  >();
  private requests = new Map<ServerResponse, string>();
  private rate = new Map<string, { count: number; until: number }>();
  private stateTimer?: ReturnType<typeof setTimeout>;
  private logTimer?: ReturnType<typeof setTimeout>;
  private dirtyLogs = new Set<string>();
  private readonly event = (event: DeskEvent) => {
    if (!this.server) return;
    if (event.type === "state" && !this.stateTimer)
      this.stateTimer = setTimeout(() => {
        this.stateTimer = undefined;
        this.broadcast(
          "state",
          monitorSnapshot(this.engine, this.version, this.startedAt),
        );
      }, 750);
    if (event.type === "log" && event.jobId) {
      this.dirtyLogs.add(event.jobId);
      if (!this.logTimer)
        this.logTimer = setTimeout(() => {
          this.logTimer = undefined;
          for (const jobId of this.dirtyLogs) this.broadcast("logs", { jobId });
          this.dirtyLogs.clear();
        }, 500);
    }
  };
  constructor(
    private engine: Engine,
    private assetsRoot: string,
    private version: string,
    encryption: Encryption,
  ) {
    super();
    this.config = readMonitorConfig(engine.store.root);
    this.auth = new MonitorAuth(engine.store);
    this.tls = new MonitorTLS(engine.store, encryption);
    engine.on("event", this.event);
  }
  status(): MonitorStatus {
    const url = this.server
      ? this.config.publicOrigin
        ? new URL(this.config.publicOrigin).origin
        : `${this.config.tls === "off" ? "http" : "https"}://${this.config.host}:${this.config.port}`
      : undefined;
    return {
      config: this.config,
      running: !!this.server,
      url,
      localUrl: this.server
        ? `${this.config.tls === "off" ? "http" : "https"}://${this.config.host}:${this.config.port}`
        : undefined,
      error: this.error,
      devices: this.auth.devices(),
      clients: this.streams.size,
      certificate: this.tls.information,
      interfaces: [
        { address: "127.0.0.1", label: "This Mac / HTTPS reverse proxy" },
        ...monitorInterfaces(),
      ],
    };
  }
  private cleanError(error: unknown) {
    let roots = [this.engine.store.root];
    try {
      roots.push(
        ...this.engine
          .state()
          .projects.flatMap((p) => [p.path, p.settings.buildDirectory ?? ""]),
      );
    } catch {}
    return monitorText(messageOf(error), roots) ?? "Request failed.";
  }
  private changed() {
    this.emit("changed");
  }
  async start() {
    if (!this.config.enabled || this.server) return this.status();
    try {
      if (
        this.config.host !== "127.0.0.1" &&
        !monitorInterfaces().some((n) => n.address === this.config.host)
      )
        throw Error(
          "The selected network address is not available on this Mac. Choose its current Wi-Fi or VPN address.",
        );
      const handler = (req: IncomingMessage, res: ServerResponse) => {
        void this.handle(req, res).catch((error) => {
          if (!res.headersSent)
            this.json(res, 500, { error: this.cleanError(error) });
          else res.destroy();
        });
      };
      const tls = await this.tls.options(this.config);
      const server = tls
        ? createHTTPSServer({ ...tls, maxHeaderSize: 16384 }, handler)
        : createServer({ maxHeaderSize: 16384 }, handler);
      server.maxConnections = 100;
      server.requestTimeout = 15000;
      server.headersTimeout = 10000;
      server.keepAliveTimeout = 5000;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.config.port, this.config.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      server.on("error", (error) => {
        this.error = this.cleanError(error);
        this.changed();
      });
      this.server = server;
      this.startedAt = new Date().toISOString();
      this.error = undefined;
    } catch (error) {
      this.error = this.cleanError(error);
    }
    this.changed();
    return this.status();
  }
  async configure(value: MonitorConfig, files?: CertificateFiles) {
    const next = monitorConfigSchema.parse(value);
    if (files) await this.tls.import(files);
    await this.stop();
    this.config = writeMonitorConfig(this.engine.store.root, next);
    await this.start();
    this.changed();
    return this.status();
  }
  async stop() {
    const server = this.server;
    this.server = undefined;
    this.auth.clearPairing();
    if (this.stateTimer) clearTimeout(this.stateTimer);
    if (this.logTimer) clearTimeout(this.logTimer);
    this.stateTimer = this.logTimer = undefined;
    this.dirtyLogs.clear();
    for (const res of this.streams.keys()) res.end();
    for (const res of this.requests.keys()) res.destroy();
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    this.changed();
  }
  async dispose() {
    await this.stop();
    this.engine.off("event", this.event);
  }
  async pairing(): Promise<MonitorPairing> {
    const status = this.status();
    if (!status.url)
      throw Error("Start the mobile monitor before pairing a phone.");
    const pair = this.auth.pairingCode(),
      url = status.url + "/#pair=" + encodeURIComponent(pair.code);
    return {
      ...pair,
      url,
      qrDataUrl: await QRCode.toDataURL(url, {
        width: 320,
        margin: 3,
        errorCorrectionLevel: "M",
        color: { dark: "#0e1217", light: "#ffffff" },
      }),
    };
  }
  revoke(id?: string) {
    this.auth.revoke(id);
    for (const [res, stream] of this.streams)
      if (!id || stream.device === id) {
        this.send(res, "session", { expired: true });
        res.end();
      }
    for (const [res, device] of this.requests)
      if (!id || device === id) res.destroy();
    this.changed();
    return this.status();
  }
  private json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, {
      ...baseHeaders,
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(value));
  }
  private allowed(key: string, limit: number, period = 60000) {
    const now = Date.now();
    for (const [id, bucket] of this.rate)
      if (bucket.until < now) this.rate.delete(id);
    const bucket = this.rate.get(key) ?? { count: 0, until: now + period };
    bucket.count++;
    this.rate.set(key, bucket);
    return bucket.count <= limit;
  }
  private send(res: ServerResponse, event: string, data: unknown) {
    if (res.destroyed || res.writableEnded) return;
    const ok = res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (!ok && res.writableLength > 256 * 1024) res.destroy();
  }
  private broadcast(event: string, data: unknown) {
    for (const res of this.streams.keys()) this.send(res, event, data);
  }
  private token(req: IncomingMessage) {
    return req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
  }
  private async body(req: IncomingMessage) {
    if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? ""))
      throw Error("Send a JSON request.");
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) throw Error("Request is too large.");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  private origin(req: IncomingMessage) {
    const host = req.headers.host,
      local = `${this.config.host}:${this.config.port}`,
      publicUrl = this.config.publicOrigin
        ? new URL(this.config.publicOrigin)
        : undefined;
    const hosts = new Set([
      local,
      ...(this.config.host === "127.0.0.1"
        ? [`localhost:${this.config.port}`]
        : []),
    ]);
    if (publicUrl && loopback(req.socket.remoteAddress ?? ""))
      hosts.add(publicUrl.host);
    if (!host || !hosts.has(host)) return;
    const secure =
      !!(req.socket as TLSSocket).encrypted ||
      (!!publicUrl &&
        host === publicUrl.host &&
        loopback(req.socket.remoteAddress ?? ""));
    return { origin: `${secure ? "https" : "http"}://${host}`, secure };
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const address = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (!privateIPv4(address) && !loopback(address))
      return this.json(res, 403, { error: "Private network access only." });
    const origin = this.origin(req);
    if (!origin) return this.json(res, 403, { error: "Unexpected host." });
    const url = new URL(req.url ?? "/", origin.origin),
      path = url.pathname;
    if (req.method === "POST") {
      if (
        req.headers.origin !== origin.origin ||
        req.headers["sec-fetch-site"] === "cross-site"
      )
        return this.json(res, 403, {
          error: "Use this monitor's own page to pair or sign out.",
        });
    }
    if (path === "/api/pair" && req.method === "POST") {
      if (
        !this.allowed(`pair:${address}`, 5) ||
        !this.allowed("pair:global", 30)
      )
        return this.json(res, 429, {
          error: "Too many pairing attempts. Try again in a minute.",
        });
      let input: z.infer<typeof pairs>;
      try {
        input = pairs.parse(await this.body(req));
      } catch {
        return this.json(res, 400, {
          error: "Enter the pairing code shown on your Mac.",
        });
      }
      const paired = this.auth.pair(input.code, input.name);
      if (!paired)
        return this.json(res, 401, {
          error:
            "That code is invalid, expired, or already used. Generate a new code on the Mac.",
        });
      res.setHeader(
        "Set-Cookie",
        `${cookieName}=${paired.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${origin.secure ? "; Secure" : ""}`,
      );
      this.changed();
      return this.json(res, 200, { device: paired.device });
    }
    if (path.startsWith("/api/")) {
      if (!this.allowed(`api-address:${address}`, 1200))
        return this.json(res, 429, {
          error: "Too many requests. Try again shortly.",
        });
      const device = this.auth.session(this.token(req));
      if (!device)
        return this.json(res, 401, {
          error: "Pair this browser with Local Build Desk on your Mac.",
        });
      if (!this.allowed(`api:${device.id}`, 600))
        return this.json(res, 429, {
          error: "Too many requests. Try again shortly.",
        });
      if (path === "/api/logout" && req.method === "POST") {
        res.setHeader(
          "Set-Cookie",
          `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${origin.secure ? "; Secure" : ""}`,
        );
        this.json(res, 200, { ok: true });
        this.revoke(device.id);
        return;
      }
      if (req.method !== "GET")
        return this.json(res, 405, {
          error: "The mobile monitor is read-only.",
        });
      this.requests.set(res, device.id);
      res.once("close", () => this.requests.delete(res));
      if (path === "/api/session")
        return this.json(res, 200, {
          device: { id: device.id, name: device.name },
          version: this.version,
        });
      if (path === "/api/state")
        return this.json(
          res,
          200,
          monitorSnapshot(this.engine, this.version, this.startedAt),
        );
      if (path === "/api/events") {
        for (const [old, stream] of [...this.streams]
          .filter(([, s]) => s.device === device.id)
          .slice(0, -1))
          old.end();
        res.writeHead(200, {
          ...baseHeaders,
          "Content-Type": "text/event-stream; charset=utf-8",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        this.send(
          res,
          "state",
          monitorSnapshot(this.engine, this.version, this.startedAt),
        );
        const token = this.token(req);
        const timer = setInterval(() => {
          if (!this.auth.session(token)) {
            this.send(res, "session", { expired: true });
            res.end();
          } else this.send(res, "heartbeat", { now: new Date().toISOString() });
        }, 15000);
        timer.unref();
        this.streams.set(res, { device: device.id, timer });
        this.changed();
        res.once("close", () => {
          clearInterval(timer);
          this.streams.delete(res);
          this.changed();
        });
        return;
      }
      if (path === "/api/history") {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0)
          return this.json(res, 400, { error: "Invalid history offset." });
        const state = this.engine.state(),
          project = url.searchParams.get("project"),
          query = (url.searchParams.get("query") ?? "")
            .slice(0, 200)
            .toLowerCase(),
          status = url.searchParams.get("status");
        const jobs = state.jobs.filter(
          (j) =>
            (!project || j.projectId === project) &&
            (!status || j.status === status) &&
            (!query ||
              [j.projectName, j.version, j.buildNumber, j.profile, j.platform]
                .join(" ")
                .toLowerCase()
                .includes(query)),
        );
        const roots = [
          this.engine.store.root,
          ...state.projects.flatMap((p) => [
            p.path,
            p.settings.buildDirectory ?? "",
          ]),
        ];
        return this.json(res, 200, {
          jobs: jobs
            .slice(offset, offset + 30)
            .map((j) => monitorJob(j, state.artifacts, roots)),
          total: jobs.length,
        });
      }
      const jobRoute = path.match(
        /^\/api\/jobs\/([A-Za-z0-9_-]{1,128})(?:\/(logs|captures)\/?(\d+)?)?$/,
      );
      if (jobRoute) {
        const id = jobRoute[1]!,
          state = this.engine.state(),
          job = state.jobs.find((j) => j.id === id);
        if (!job) return this.json(res, 404, { error: "Build not found." });
        if (jobRoute[2] === "logs") {
          const after = url.searchParams.has("after")
            ? Number(url.searchParams.get("after"))
            : undefined;
          if (
            after !== undefined &&
            (!Number.isSafeInteger(after) || after < 0)
          )
            return this.json(res, 400, { error: "Invalid log cursor." });
          return this.json(res, 200, await monitorLogs(this.engine, id, after));
        }
        if (jobRoute[2] === "captures" && !jobRoute[3])
          return this.json(res, 400, { error: "Choose a capture index." });
        if (jobRoute[2] === "captures")
          return this.image(
            res,
            await this.engine.screenshotPreview(id, Number(jobRoute[3])),
          );
        return this.json(
          res,
          200,
          monitorJob(job, state.artifacts, [
            this.engine.store.root,
            ...state.projects.flatMap((p) => [
              p.path,
              p.settings.buildDirectory ?? "",
            ]),
          ]),
        );
      }
      const releases = path.match(
        /^\/api\/projects\/([^/]+)\/releases(?:\/([^/]+))?$/,
      );
      if (releases) {
        const projectId = decodeURIComponent(releases[1]!);
        if (!this.engine.state().projects.some((p) => p.id === projectId))
          return this.json(res, 404, { error: "Project not found." });
        return this.json(
          res,
          200,
          releases[2]
            ? await this.engine.storeReleaseDetails(
                projectId,
                decodeURIComponent(releases[2]),
                url.searchParams.get("locale") ?? undefined,
              )
            : await this.engine.storeReleases(projectId),
        );
      }
      const image = path.match(
        /^\/api\/projects\/([^/]+)\/images\/([A-Za-z0-9-]+)$/,
      );
      if (image)
        return this.image(
          res,
          await this.engine.storeImagePreview(
            decodeURIComponent(image[1]!),
            image[2]!,
          ),
        );
      return this.json(res, 404, {
        error: "This monitoring endpoint does not exist.",
      });
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      return this.json(res, 405, { error: "Method not allowed." });
    if (!this.allowed(`static:${address}`, 180))
      return this.json(res, 429, { error: "Try again shortly." });
    if (path === "/manifest.webmanifest")
      return this.json(res, 200, {
        name: "Local Build Desk",
        short_name: "Build Desk",
        start_url: "/",
        display: "standalone",
        background_color: "#0e1217",
        theme_color: "#0e1217",
        icons: [
          {
            src: "/monitor-icon.png",
            sizes: "1024x1024",
            type: "image/png",
            purpose: "any",
          },
        ],
      });
    let file: string, type: string;
    if (path === "/" || path === "/index.html") {
      file = join(this.assetsRoot, "mobile.html");
      type = "text/html; charset=utf-8";
    } else if (path === "/monitor-icon.png") {
      file = join(this.assetsRoot, "monitor-icon.png");
      type = "image/png";
    } else if (
      /^\/assets\/[A-Za-z0-9_.-]{1,180}\.(?:js|css|woff2?|png|svg)$/.test(path)
    ) {
      file = join(this.assetsRoot, path.slice(1));
      const extension = path.split(".").pop();
      type = (
        {
          js: "text/javascript",
          css: "text/css",
          woff2: "font/woff2",
          woff: "font/woff",
          png: "image/png",
          svg: "image/svg+xml",
        } as Record<string, string>
      )[extension!]!;
    } else return this.json(res, 404, { error: "Page not found." });
    const root = await realpath(this.assetsRoot),
      actual = await realpath(file).catch(() => undefined);
    if (!actual || !actual.startsWith(root + sep))
      return this.json(res, 404, { error: "Page not found." });
    const bytes = await readFile(actual);
    res.writeHead(200, {
      ...baseHeaders,
      "Content-Type": type,
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "Cache-Control": path.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  }
  private image(res: ServerResponse, data: string) {
    const match = data.match(
      /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/,
    );
    if (!match) return this.json(res, 404, { error: "Preview unavailable." });
    res.writeHead(200, { ...baseHeaders, "Content-Type": `image/${match[1]}` });
    res.end(Buffer.from(match[2]!, "base64"));
  }
}

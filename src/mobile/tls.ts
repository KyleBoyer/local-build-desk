import { X509Certificate, createPrivateKey, randomBytes } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import type { Store } from "../core/database";
import { privateDirectory, type Encryption } from "../core/vault";
import { run } from "../core/process";
import { invariant } from "../core/errors";
import { monitorInterfaces } from "./config";
import type { MonitorConfig, MonitorStatus } from "./types";
interface Saved {
  cert: string;
  key: string;
}
export interface CertificateFiles {
  certificatePath: string;
  keyPath: string;
}
export class MonitorTLS {
  information?: MonitorStatus["certificate"];
  constructor(
    private store: Store,
    private encryption: Encryption,
  ) {}
  private async save(name: string, cert: string, key: string) {
    const certificate = new X509Certificate(cert);
    invariant(
      certificate.checkPrivateKey(createPrivateKey(key)),
      "MONITOR_TLS_KEY",
      "The certificate and private key do not match.",
    );
    this.store.setPreference(name, {
      cert,
      key: (await this.encryption.encrypt(key)).toString("base64"),
    });
  }
  async import(files: CertificateFiles) {
    const sizes = await Promise.all([
      stat(files.certificatePath),
      stat(files.keyPath),
    ]);
    invariant(
      sizes.every((s) => s.isFile() && s.size < 128 * 1024),
      "MONITOR_TLS_SIZE",
      "Choose PEM certificate and private-key files smaller than 128 KB.",
    );
    const [cert, key] = await Promise.all([
      readFile(files.certificatePath, "utf8"),
      readFile(files.keyPath, "utf8"),
    ]);
    invariant(
      cert.length < 128 * 1024 && key.length < 128 * 1024,
      "MONITOR_TLS_SIZE",
      "Choose PEM certificate and private-key files smaller than 128 KB.",
    );
    await this.save("monitor-custom-tls", cert, key);
  }
  async options(config: MonitorConfig) {
    this.information = undefined;
    if (config.tls === "off") return;
    const name =
      config.tls === "custom" ? "monitor-custom-tls" : "monitor-local-tls";
    let saved = this.store.preference<Saved | undefined>(name, undefined);
    if (config.tls === "self-signed") {
      const current = saved ? new X509Certificate(saved.cert) : undefined;
      if (
        !current ||
        !current.checkIP(config.host) ||
        Date.parse(current.validTo) < Date.now() + 24 * 60 * 60 * 1000
      ) {
        await privateDirectory(async (root) => {
          const addresses = [
            ...new Set([
              "127.0.0.1",
              config.host,
              ...monitorInterfaces().map((i) => i.address),
            ]),
          ];
          const host = hostname().replace(/[^A-Za-z0-9.-]/g, "");
          const dns = [
            "localhost",
            ...(host
              ? [host, ...(host.endsWith(".local") ? [] : [host + ".local"])]
              : []),
          ];
          const conf = `[req]\nprompt = no\ndistinguished_name = dn\nx509_extensions = extensions\n[dn]\nCN = Local Build Desk\n[extensions]\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature,keyEncipherment\nextendedKeyUsage = serverAuth\nsubjectAltName = @san\n[san]\n${addresses.map((a, i) => `IP.${i + 1} = ${a}`).join("\n")}\n${dns.map((a, i) => `DNS.${i + 1} = ${a}`).join("\n")}\n`;
          const path = join(root, "tls.cnf");
          await writeFile(path, conf, { mode: 0o600 });
          await run(
            "/usr/bin/openssl",
            [
              "req",
              "-x509",
              "-newkey",
              "rsa:2048",
              "-nodes",
              "-days",
              "365",
              "-sha256",
              "-set_serial",
              "0x" + randomBytes(16).toString("hex"),
              "-config",
              path,
              "-keyout",
              join(root, "server.key"),
              "-out",
              join(root, "server.crt"),
            ],
            { timeout: 30000 },
          );
          await this.save(
            name,
            await readFile(join(root, "server.crt"), "utf8"),
            await readFile(join(root, "server.key"), "utf8"),
          );
        });
        saved = this.store.preference<Saved | undefined>(name, undefined);
      }
    }
    invariant(
      saved,
      "MONITOR_TLS_MISSING",
      "Import a PEM certificate and matching private key for custom HTTPS.",
    );
    const cert = new X509Certificate(saved.cert);
    invariant(
      Date.parse(cert.validTo) > Date.now() &&
        Date.parse(cert.validFrom) <= Date.now(),
      "MONITOR_TLS_EXPIRED",
      "The HTTPS certificate is expired or not yet valid. Import a valid certificate.",
    );
    invariant(
      cert.checkIP(config.host),
      "MONITOR_TLS_ADDRESS",
      "The certificate does not include the selected listen IP in its subject alternative names. Choose a matching certificate or self-signed HTTPS.",
    );
    const key = await this.encryption.decrypt(Buffer.from(saved.key, "base64"));
    invariant(
      cert.checkPrivateKey(createPrivateKey(key)),
      "MONITOR_TLS_KEY",
      "The stored HTTPS certificate and private key do not match.",
    );
    this.information = {
      fingerprint: cert.fingerprint256,
      subject: cert.subject,
      issuer: cert.issuer,
      expiresAt: new Date(cert.validTo).toISOString(),
      selfSigned: config.tls === "self-signed",
    };
    return { cert: saved.cert, key, minVersion: "TLSv1.2" as const };
  }
}

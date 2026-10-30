import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { Store } from "../core/database";
import type { MonitorDevice } from "./types";
interface Device extends MonitorDevice {
  hash: string;
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class MonitorAuth {
  private pairing?: { hash: string; expires: number };
  constructor(
    private store: Store,
    private clock = () => Date.now(),
  ) {}
  devices(): MonitorDevice[] {
    return this.records().map(({ hash, ...device }) => device);
  }
  private records() {
    return this.store
      .preference<Device[]>("monitor-devices", [])
      .filter((d) => Date.parse(d.expiresAt) > this.clock());
  }
  private save(devices: Device[]) {
    this.store.setPreference("monitor-devices", devices);
  }
  pairingCode() {
    const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
    const raw = [...randomBytes(12)]
      .map((b) => alphabet[b % alphabet.length])
      .join("");
    const code = raw.match(/.{1,4}/g)!.join("-");
    const expires = this.clock() + 5 * 60 * 1000;
    this.pairing = { hash: digest(raw), expires };
    return { code, expiresAt: new Date(expires).toISOString() };
  }
  clearPairing() {
    this.pairing = undefined;
  }
  pair(code: string, name: string) {
    const normalized = code.toUpperCase().replace(/[\s-]/g, "");
    const hash = digest(normalized);
    if (
      !this.pairing ||
      this.pairing.expires <= this.clock() ||
      !timingSafeEqual(Buffer.from(hash), Buffer.from(this.pairing.hash))
    )
      return;
    this.pairing = undefined;
    const now = new Date(this.clock()).toISOString(),
      token = randomBytes(32).toString("base64url");
    const device: Device = {
      id: randomUUID(),
      name:
        name
          .replace(/[\x00-\x1f\x7f]/g, "")
          .trim()
          .slice(0, 80) || "Mobile browser",
      hash: digest(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(
        this.clock() + 30 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    };
    const records = this.records();
    if (records.length >= 20) return;
    this.save([...records, device]);
    return { token, device: { id: device.id, name: device.name } };
  }
  session(token: string | undefined) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const hash = digest(token),
      records = this.records();
    const device = records.find((d) =>
      timingSafeEqual(Buffer.from(d.hash), Buffer.from(hash)),
    );
    if (device && this.clock() - Date.parse(device.lastSeenAt) > 60000) {
      device.lastSeenAt = new Date(this.clock()).toISOString();
      this.save(records);
    }
    return device;
  }
  revoke(id?: string) {
    this.save(id ? this.records().filter((d) => d.id !== id) : []);
  }
}

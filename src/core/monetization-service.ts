import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AppleAPI, GoogleAPI } from "./stores";
import { invariant, messageOf } from "./errors";
import {
  MONETIZATION_FILE,
  itemKeys,
  loadMonetization,
  monetizationProblems,
  saveMonetization,
  type Monetization,
  type StoreItem,
} from "./monetization";
import {
  applyApple,
  compareApple,
  readApple,
  subscriptionReviewItems,
  type AppleLive,
} from "./monetization-apple";
import {
  applyGoogle,
  compareGoogle,
  readGoogle,
  type GoogleLive,
} from "./monetization-google";
import type { Project } from "./types";

export interface SavedCodes {
  key: string;
  batchId: string;
  file: string;
  count: number;
  createdAt: string;
}
export interface MonetizationView {
  /** The file, relative to the project. */
  file: string;
  exists: boolean;
  config: Monetization;
  problems: string[];
  items: StoreItem[];
  stores: {
    apple: { connected: boolean; error?: string };
    google: { connected: boolean; error?: string };
  };
  /** One-time offer codes generated so far, saved outside the repository. */
  codes: SavedCodes[];
  readAt: string;
}

/** The project's monetization file, which must stay inside the project. */
export function monetizationFile(project: Project) {
  const chosen = project.settings.monetizationFile ?? MONETIZATION_FILE;
  const path = resolve(project.path, chosen);
  invariant(
    path.startsWith(resolve(project.path) + sep) && path.endsWith(".json"),
    "MONETIZATION_PATH",
    "Choose a .json monetization file inside the project.",
  );
  return { path, relative: relative(project.path, path) };
}

/** Items that need Play Console rather than the API. */
const consoleOnly = (key: string) =>
  key === "google:appPrice" || key.startsWith("google:promo:");

export class MonetizationService {
  constructor(
    private project: Project,
    private connections: {
      apple?: () => Promise<AppleAPI>;
      google?: () => Promise<GoogleAPI>;
    },
    /** Where generated code values go: outside the repository, private to this Mac. */
    private codesRoot: string,
  ) {}

  private live: { apple?: AppleLive; google?: GoogleLive } = {};
  /** What the last `view` read from the stores. */
  liveSnapshot() {
    return this.live;
  }

  async view(): Promise<MonetizationView> {
    const file = monetizationFile(this.project);
    const config = await loadMonetization(file.path);
    const stores: MonetizationView["stores"] = {
      apple: { connected: !!this.connections.apple && !!this.project.bundleId },
      google: {
        connected: !!this.connections.google && !!this.project.packageName,
      },
    };
    const items: StoreItem[] = [];
    await Promise.all([
      (async () => {
        if (!stores.apple.connected) return;
        try {
          this.live.apple = await readApple(
            await this.connections.apple!(),
            this.project.bundleId!,
          );
          items.push(...compareApple(config, this.live.apple));
        } catch (error) {
          stores.apple.error = messageOf(error);
        }
      })(),
      (async () => {
        if (!stores.google.connected) return;
        try {
          this.live.google = await readGoogle(
            await this.connections.google!(),
            this.project.packageName!,
          );
          items.push(...compareGoogle(config, this.live.google));
        } catch (error) {
          stores.google.error = messageOf(error);
        }
      })(),
    ]);
    // Play Console items are tracked in the file, so they show without a read.
    if (!this.live.google)
      items.push(
        ...compareGoogle(config, {
          packageName: this.project.packageName ?? "",
          products: [],
          subscriptions: [],
          offers: {},
        }).filter((i) => i.kind === "promo" || i.kind === "appPrice"),
      );
    // Managed items whose store couldn't be read still show, unknown.
    for (const key of itemKeys(config))
      if (!items.some((i) => i.key === key)) {
        const store = key.startsWith("apple:") ? "apple" : "google";
        items.push({
          key,
          store,
          kind: key.split(":")[1] as StoreItem["kind"],
          label: key.split(":").slice(2).join(" "),
          managed: true,
          exists: false,
          changes: [],
          unknown: true,
          warnings: [],
        });
      }
    return {
      file: file.relative,
      exists: existsSync(file.path),
      config,
      problems: monetizationProblems(config),
      items,
      stores,
      codes: await this.savedCodes(),
      readAt: new Date().toISOString(),
    };
  }

  private codesFolder() {
    return join(this.codesRoot, this.project.id);
  }
  async savedCodes(): Promise<SavedCodes[]> {
    const folder = this.codesFolder();
    const names = await readdir(folder).catch(() => [] as string[]);
    const result: SavedCodes[] = [];
    for (const name of names.filter((n) => n.endsWith(".csv"))) {
      const match = /^(.+)--([A-Za-z0-9-]+)\.csv$/.exec(name);
      if (!match) continue;
      const info = await stat(join(folder, name));
      const { readFile } = await import("node:fs/promises");
      const lines = (await readFile(join(folder, name), "utf8"))
        .trim()
        .split("\n").length;
      result.push({
        key: decodeURIComponent(match[1]!),
        batchId: match[2]!,
        file: join(folder, name),
        count: Math.max(0, lines - 1),
        createdAt: info.mtime.toISOString(),
      });
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Applies items to the stores. "pending" means every managed item the store
   * doesn't match yet, as a release does. Batch ids the stores hand back are
   * written to the file; code values are saved privately.
   */
  async apply(keys: string[] | "pending", log: (line: string) => void) {
    const file = monetizationFile(this.project);
    const config = await loadMonetization(file.path);
    const problems = monetizationProblems(config);
    invariant(!problems.length, "MONETIZATION_INVALID", problems.join(" "));
    let wanted: Set<string>;
    if (keys === "pending") {
      const view = await this.view();
      wanted = new Set(
        view.items
          .filter((i) => i.managed && i.changes.length && !consoleOnly(i.key))
          .map((i) => i.key),
      );
    } else wanted = new Set(keys.filter((k) => !consoleOnly(k)));
    const applied: string[] = [];
    if ([...wanted].some((k) => k.startsWith("apple:"))) {
      invariant(
        this.connections.apple && this.project.bundleId,
        "APPLE_CONNECTION",
        "Connect App Store Connect to this project first.",
      );
      const api = await this.connections.apple();
      const live =
        this.live.apple ?? (await readApple(api, this.project.bundleId));
      const result = await applyApple(api, config, live, wanted, {
        baseDir: dirname(file.path),
        projectRoot: this.project.path,
        log,
      });
      for (const batch of result.batches) {
        const [, , productId, ...name] = batch.key.split(":");
        const offer = config.apple.offerCodes.find(
          (o) => o.productId === productId && o.name === name.join(":"),
        );
        const entry = offer?.batches[batch.index];
        if (entry)
          Object.assign(entry, {
            id: batch.id,
            generatedAt: batch.generatedAt,
          });
      }
      if (result.codes.length) {
        await mkdir(this.codesFolder(), { recursive: true, mode: 0o700 });
        for (const codes of result.codes)
          await writeFile(
            join(
              this.codesFolder(),
              `${encodeURIComponent(codes.key)}--${codes.batchId}.csv`,
            ),
            codes.csv,
            { mode: 0o600 },
          );
      }
      applied.push(...[...wanted].filter((k) => k.startsWith("apple:")));
      this.live.apple = undefined;
    }
    if ([...wanted].some((k) => k.startsWith("google:"))) {
      invariant(
        this.connections.google && this.project.packageName,
        "GOOGLE_CONNECTION",
        "Connect Google Play to this project first.",
      );
      const api = await this.connections.google();
      const live =
        this.live.google ?? (await readGoogle(api, this.project.packageName));
      await applyGoogle(api, config, live, wanted, log);
      applied.push(...[...wanted].filter((k) => k.startsWith("google:")));
      this.live.google = undefined;
    }
    await saveMonetization(file.path, config);
    return { applied };
  }

  /** What a version's review submission should carry: managed purchases and
   * subscriptions still waiting for their first review. */
  async reviewItems() {
    const file = monetizationFile(this.project);
    const config = await loadMonetization(file.path);
    invariant(
      this.connections.apple && this.project.bundleId,
      "APPLE_CONNECTION",
      "Connect App Store Connect to this project first.",
    );
    const api = await this.connections.apple();
    const live = await readApple(api, this.project.bundleId);
    const subscriptions = config.apple.subscriptionGroups.flatMap((g) =>
      g.subscriptions.map((s) => s.productId),
    );
    return {
      inAppPurchases: config.apple.inAppPurchases
        .map((p) => p.productId)
        .filter(
          (id) =>
            live.iaps.find((p) => p.productId === id)?.state ===
            "READY_TO_SUBMIT",
        ),
      subscriptionItems: await subscriptionReviewItems(
        api,
        live,
        subscriptions,
      ),
    };
  }
}

import { createHash, randomUUID } from "node:crypto";
import type { Store } from "./database";
import { invariant, messageOf } from "./errors";
import { withLock } from "./locks";
import { z } from "zod";
export const storeActionReceiptSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().min(1).max(128),
    scope: z.string().max(1000),
    title: z.string().max(300),
    state: z.enum([
      "running",
      "complete",
      "failed",
      "uncertain",
      "acknowledged",
    ]),
    updatedAt: z.string().max(100),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    recovery: z.record(z.string(), z.unknown()).optional(),
    completed: z.number().int().min(0).optional(),
    total: z.number().int().min(1).optional(),
  })
  .strict();

export interface StoreActionPreview {
  token: string;
  title: string;
  identity: string;
  changes: string[];
  warnings: string[];
  expiresAt: string;
}
export interface StoreActionPlan extends Omit<
  StoreActionPreview,
  "token" | "expiresAt"
> {
  recovery?: Record<string, unknown>;
  scope: string;
  snapshot: unknown;
  execute(progress?: (completed: number, total: number) => void): Promise<void>;
  satisfied(): Promise<boolean>;
}
export interface StoreActionReceipt {
  id: string;
  projectId: string;
  scope: string;
  title: string;
  state: "running" | "complete" | "failed" | "uncertain" | "acknowledged";
  updatedAt: string;
  /** Hashes and identifiers only; never credentials, emails or request bodies. */
  fingerprint: string;
  recovery?: Record<string, unknown>;
  completed?: number;
  total?: number;
}
export const actionHash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Preview once, re-read before writing, and never repeat an unanswered write.
 * Receipts survive a restart; expired previews and changed account bindings do not. */
export class StoreActions {
  private operations = new Set<Promise<unknown>>();
  get busy() {
    return this.operations.size > 0;
  }
  async wait() {
    await Promise.allSettled([...this.operations]);
  }
  private previews = new Map<
    string,
    {
      projectId: string;
      expires: number;
      hash: string;
      factory: () => Promise<StoreActionPlan>;
      binding: () => string;
      identity: string;
    }
  >();
  constructor(
    private store: Store,
    private onProgress?: (
      token: string,
      label: string,
      completed: number,
      total: number,
      startedAt: string,
    ) => void,
  ) {}
  receipts(projectId: string) {
    return this.store
      .preference<StoreActionReceipt[]>("store-actions", [])
      .filter((r) => r.projectId === projectId);
  }
  private save(receipt: StoreActionReceipt) {
    const all = this.store
      .preference<StoreActionReceipt[]>("store-actions", [])
      .filter((r) => r.id !== receipt.id);
    // Unresolved writes are never pruned by routine retention.
    const open = all.filter((r) => ["running", "uncertain"].includes(r.state));
    const closed = all
      .filter((r) => !["running", "uncertain"].includes(r.state))
      .slice(-200);
    this.store.setPreference("store-actions", [...open, ...closed, receipt]);
  }
  async prepare(
    projectId: string,
    binding: () => string,
    factory: () => Promise<StoreActionPlan>,
  ): Promise<StoreActionPreview> {
    const identity = binding(),
      plan = await factory();
    invariant(
      !this.store
        .preference<StoreActionReceipt[]>("store-actions", [])
        .some(
          (r) =>
            r.scope === plan.scope &&
            ["running", "uncertain"].includes(r.state),
        ),
      "STORE_ACTION_UNCERTAIN",
      "An earlier store change has an uncertain outcome. Refresh and reconcile it before another change; it will not be sent again automatically.",
    );
    for (const [key, value] of this.previews)
      if (value.expires <= Date.now()) this.previews.delete(key);
    invariant(
      this.previews.size < 100,
      "STORE_PREVIEWS",
      "Close old previews and try again in a few minutes.",
    );
    const token = randomUUID(),
      expires = Date.now() + 600000;
    this.previews.set(token, {
      projectId,
      expires,
      hash: actionHash(plan.snapshot),
      factory,
      binding,
      identity,
    });
    return {
      token,
      title: plan.title,
      identity: plan.identity,
      changes: plan.changes,
      warnings: plan.warnings,
      expiresAt: new Date(expires).toISOString(),
    };
  }
  apply(projectId: string, token: string) {
    const operation = this.applyOnce(projectId, token);
    this.operations.add(operation);
    void operation
      .finally(() => this.operations.delete(operation))
      .catch(() => {});
    return operation;
  }
  private async applyOnce(projectId: string, token: string) {
    const preview = this.previews.get(token);
    invariant(
      preview?.projectId === projectId && preview.expires > Date.now(),
      "STORE_PREVIEW_EXPIRED",
      "Prepare a fresh preview before applying this change.",
    );
    this.previews.delete(token);
    invariant(
      preview.binding() === preview.identity,
      "STORE_ACCOUNT_CHANGED",
      "The app identity or connection changed. Prepare a fresh preview.",
    );
    const plan = await preview.factory();
    return withLock(`store-action:${plan.scope}`, undefined, async () => {
      const current = await preview.factory();
      invariant(
        actionHash(current.snapshot) === preview.hash &&
          preview.binding() === preview.identity,
        "STORE_STATE_CHANGED",
        "The store changed since this preview. Review a fresh preview; nothing was written.",
      );
      invariant(
        !this.store
          .preference<StoreActionReceipt[]>("store-actions", [])
          .some(
            (r) =>
              r.scope === current.scope &&
              ["running", "uncertain"].includes(r.state),
          ),
        "STORE_ACTION_UNCERTAIN",
        "Reconcile the previous store change first.",
      );
      const receipt: StoreActionReceipt = {
        id: randomUUID(),
        projectId,
        scope: current.scope,
        title: current.title,
        fingerprint: preview.hash,
        recovery: current.recovery,
        state: "running",
        updatedAt: new Date().toISOString(),
      };
      this.save(receipt);
      try {
        const progress = (completed: number, total: number) => {
          receipt.completed = completed;
          receipt.total = total;
          this.save(receipt);
          this.onProgress?.(
            token,
            current.title,
            completed,
            total,
            receipt.updatedAt,
          );
        };
        progress(0, 1);
        await current.execute(progress);
        receipt.state = "complete";
        return {
          message: `${current.title}: accepted by the store. Refresh to follow processing.`,
          receiptId: receipt.id,
        };
      } catch (error) {
        // A definitive 4xx rejected the request. Unknown transport/5xx outcomes
        // need reconciliation even if this process is restarted.
        receipt.state = /^(APPLE|GOOGLE)_(400|401|403|404|409|422)$/.test(
          (error as any)?.code ?? "",
        )
          ? "failed"
          : "uncertain";
        if (receipt.state === "uncertain") {
          try {
            if (await current.satisfied()) receipt.state = "complete";
          } catch {}
          if (receipt.state === "complete")
            return {
              message: `${current.title}: confirmed by re-reading the store.`,
              receiptId: receipt.id,
            };
        }
        throw new Error(
          `${messageOf(error)}${receipt.state === "uncertain" ? " Outcome uncertain; refresh/reconcile before retrying. No automatic resend." : " Refresh and prepare a new preview before retrying."}`,
        );
      } finally {
        receipt.updatedAt = new Date().toISOString();
        this.save(receipt);
      }
    });
  }
  async reconcile(
    projectId: string,
    receiptId: string,
    check: () => Promise<boolean>,
  ) {
    const saved = this.receipts(projectId).find((r) => r.id === receiptId);
    invariant(saved, "STORE_RECEIPT", "Store change receipt not found.");
    return withLock(`store-action:${saved.scope}`, undefined, async () => {
      const receipt = this.receipts(projectId).find((r) => r.id === receiptId)!;
      if (receipt.state === "running" || receipt.state === "uncertain") {
        receipt.state = (await check()) ? "complete" : "uncertain";
        receipt.updatedAt = new Date().toISOString();
        this.save(receipt);
      }
      return receipt;
    });
  }
  clear() {
    this.previews.clear();
  }
  acknowledge(projectId: string, receiptId: string) {
    invariant(
      !this.busy,
      "STORE_ACTION_BUSY",
      "Wait for the active store change to finish before resolving its receipt.",
    );
    const receipt = this.receipts(projectId).find((r) => r.id === receiptId);
    invariant(
      receipt && ["uncertain", "running"].includes(receipt.state),
      "STORE_RECEIPT",
      "Choose an unresolved store change.",
    );
    receipt.state = "acknowledged";
    receipt.updatedAt = new Date().toISOString();
    this.save(receipt);
    return receipt;
  }
}

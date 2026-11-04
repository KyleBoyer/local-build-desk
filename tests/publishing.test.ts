import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/core/database";
import { StoreActions } from "../src/core/store-actions";
import { planPublishing } from "../src/core/publishing";
import { DeskError } from "../src/core/errors";

function apple(status = "PREPARE_FOR_SUBMISSION") {
  let releaseType = "MANUAL",
    buildId = "b1",
    reviews: any[] = [];
  const writes: any[] = [];
  const api = {
    request: async (path: string, method = "GET", body?: any): Promise<any> => {
      if (method !== "GET") {
        writes.push({ path, method, body });
        if (path === "/reviewSubmissions") {
          reviews = [
            {
              id: "r1",
              state: "READY_FOR_REVIEW",
              versionId: undefined,
              items: [],
            },
          ];
          return { data: { id: "r1" } };
        }
        if (path === "/reviewSubmissionItems") {
          reviews[0].versionId = "v1";
          reviews[0].items = ["i1"];
        }
        if (path === "/reviewSubmissions/r1")
          reviews[0].state = body.data.attributes.submitted
            ? "WAITING_FOR_REVIEW"
            : "CANCELING";
        if (path.includes("/relationships/build")) buildId = body.data.id;
        if (body?.data?.attributes?.releaseType)
          releaseType = body.data.attributes.releaseType;
        return {};
      }
      if (path.startsWith("/appStoreVersions/v1?"))
        return {
          data: {
            id: "v1",
            attributes: {
              versionString: "1.0",
              appStoreState: status,
              releaseType,
            },
            relationships: {
              app: { data: { id: "app" } },
              build: { data: { id: buildId } },
            },
          },
          included: [
            {
              id: buildId,
              type: "builds",
              attributes: { version: buildId, processingState: "VALID" },
            },
          ],
        };
      if (path.startsWith("/reviewSubmissions?"))
        return {
          data: reviews.map((r) => ({
            id: r.id,
            attributes: { state: r.state },
            relationships: {
              appStoreVersionForReview: {
                data: r.versionId ? { id: r.versionId } : null,
              },
              items: { data: r.items.map((id: string) => ({ id })) },
            },
          })),
        };
      if (path.startsWith("/builds/"))
        return {
          data: {
            id: path.split("/")[2].split("?")[0],
            attributes: { processingState: "VALID", version: "2" },
            relationships: {
              app: { data: { id: "app" } },
              preReleaseVersion: { data: { id: "pre" } },
            },
          },
          included: [
            {
              id: "pre",
              type: "preReleaseVersions",
              attributes: { version: "1.0" },
            },
          ],
        };
      throw Error(path);
    },
  };
  return {
    api: api as any,
    writes,
    setStatus: (v: string) => (status = v),
    setReviews: (v: any[]) => (reviews = v),
  };
}
it("previews a manual release without writes, then releases only the selected approved version", async () => {
  const { api, writes } = apple("PENDING_DEVELOPER_RELEASE");
  const plan = await planPublishing(api, "app", "com.example.app", "v1", {
    kind: "release",
  });
  expect(writes).toEqual([]);
  expect(plan.warnings.join(" ")).toContain("customers");
  await plan.execute();
  expect(writes[0].body.data.relationships.appStoreVersion.data.id).toBe("v1");
  await expect(
    planPublishing(apple().api, "app", "com.example.app", "v1", {
      kind: "release",
    }),
  ).rejects.toThrow(/approve/);
});
it("validates scheduling and app/build ownership, and preserves the listing when replacing builds", async () => {
  const { api, writes } = apple();
  await expect(
    planPublishing(api, "other", "com.other", "v1", {
      kind: "replaceBuild",
      buildId: "b2",
    }),
  ).rejects.toThrow(/different app/);
  await expect(
    planPublishing(api, "app", "com.app", "v1", {
      kind: "schedule",
      releaseType: "SCHEDULED",
      earliestReleaseDate: "2020-01-01T00:00:00Z",
    }),
  ).rejects.toThrow(/future/);
  await (
    await planPublishing(api, "app", "com.app", "v1", {
      kind: "replaceBuild",
      buildId: "b2",
    })
  ).execute();
  expect(writes).toEqual([
    {
      path: "/appStoreVersions/v1/relationships/build",
      method: "PATCH",
      body: { data: { type: "builds", id: "b2" } },
    },
  ]);
});
it("warns about all withdrawn submission items and reuses the prepared review draft", async () => {
  const a = apple("IN_REVIEW");
  a.setReviews([
    { id: "r1", state: "IN_REVIEW", versionId: "v1", items: ["app", "iap"] },
  ]);
  const withdraw = await planPublishing(a.api, "app", "com.app", "v1", {
    kind: "withdraw",
  });
  expect(withdraw.warnings.join(" ")).toContain("2 item");
  await withdraw.execute();
  expect(a.writes[0].body.data.attributes.canceled).toBe(true);
  a.setStatus("DEVELOPER_REJECTED");
  a.setReviews([
    {
      id: "r1",
      state: "READY_FOR_REVIEW",
      versionId: "v1",
      items: ["app", "iap"],
    },
  ]);
  await (
    await planPublishing(a.api, "app", "com.app", "v1", { kind: "submit" })
  ).execute();
  expect(
    a.writes.filter(
      (w) =>
        w.path === "/reviewSubmissions" || w.path === "/reviewSubmissionItems",
    ),
  ).toEqual([]);
});
it("rejects stale/consumed previews and persists uncertain outcomes across restart without resending", async () => {
  const root = await mkdtemp(join(tmpdir(), "lbd-store-actions-")),
    store = new Store(root);
  try {
    const a = apple("PENDING_DEVELOPER_RELEASE"),
      actions = new StoreActions(store);
    const factory = () =>
      planPublishing(a.api, "app", "com.app", "v1", { kind: "release" });
    const stale = await actions.prepare("p", () => "connection", factory);
    a.setStatus("IN_REVIEW");
    await expect(actions.apply("p", stale.token)).rejects.toThrow();
    expect(a.writes).toEqual([]);
    a.setStatus("PENDING_DEVELOPER_RELEASE");
    const fail = {
      ...(await factory()),
      execute: async () => {
        throw new TypeError("connection reset");
      },
      satisfied: async () => false,
    };
    const pending = await actions.prepare(
      "p",
      () => "connection",
      async () => fail,
    );
    await expect(actions.apply("p", pending.token)).rejects.toThrow(
      /uncertain/,
    );
    expect(actions.receipts("p")[0].state).toBe("uncertain");
    await expect(
      new StoreActions(store).prepare("p", () => "connection", factory),
    ).rejects.toThrow(/uncertain/);
    await expect(actions.apply("p", pending.token)).rejects.toThrow(
      /fresh preview/,
    );
    const record = actions.receipts("p")[0];
    expect(
      (await actions.reconcile("p", record.id, async () => true)).state,
    ).toBe("complete");
    const valid = await actions.prepare("p", () => "connection", factory);
    await actions.apply("p", valid.token);
    expect(a.writes).toHaveLength(1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("invalidates changed account bindings and retains confirmed progress after a partially rejected batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "lbd-store-batch-")),
    store = new Store(root);
  try {
    let binding = "account-one",
      writes = 0;
    const actions = new StoreActions(store);
    const factory = async () => ({
      scope: "apple-testers:app",
      title: "Resend invitations",
      identity: "com.example.app",
      changes: ["Two testers"],
      warnings: [],
      snapshot: { testers: ["t1", "t2"] },
      recovery: {
        kind: "testers",
        provider: "apple",
        actionKind: "appleReinvite",
        testerIds: ["t1", "t2"],
      },
      execute: async (progress?: (n: number, total: number) => void) => {
        writes++;
        progress?.(1, 2);
        throw new DeskError("APPLE_403", "Permission changed");
      },
      satisfied: async () => false,
    });
    const first = await actions.prepare("p", () => binding, factory);
    binding = "account-two";
    await expect(actions.apply("p", first.token)).rejects.toThrow(
      /connection changed/,
    );
    expect(writes).toBe(0);
    const second = await actions.prepare("p", () => binding, factory);
    await expect(actions.apply("p", second.token)).rejects.toThrow(
      /Permission changed/,
    );
    expect(new StoreActions(store).receipts("p")[0]).toMatchObject({
      state: "failed",
      completed: 1,
      total: 2,
    });
    expect(writes).toBe(1);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

import { it, expect } from "vitest";
import {
  appleTesters,
  planAppleTesters,
  playTesters,
  planPlayTesters,
} from "../src/core/testers";
function apple(alreadyMember = true) {
  const writes: any[] = [];
  const api = {
    request: async (path: string, method = "GET", body?: any): Promise<any> => {
      if (method !== "GET") {
        writes.push({ path, method, body });
        return {};
      }
      if (path.includes("betaGroups?"))
        return {
          data: [
            { id: "g1", attributes: { name: "QA", isInternalGroup: false } },
          ],
        };
      if (path.startsWith("/betaTesters?filter[apps]"))
        return {
          data: [
            {
              id: "t1",
              attributes: { email: "one@example.com", state: "INVITED" },
              relationships: {
                betaGroups: {
                  data: alreadyMember
                    ? [{ id: "g1" }, { id: "unrelated" }]
                    : [],
                },
              },
            },
            { id: "anon", attributes: { state: "INSTALLED" } },
          ],
        };
      if (path.startsWith("/betaTesters?filter[email]"))
        return {
          data: [{ id: "existing", attributes: { email: "one@example.com" } }],
        };
      if (path.includes("betaTesterUsages")) throw Error("metrics unavailable");
      if (path.startsWith("/builds?"))
        return {
          data: [
            {
              id: "b1",
              attributes: {
                version: "1",
                expirationDate: "2027-01-01",
                expired: false,
              },
            },
          ],
        };
      throw Error(path);
    },
  };
  return { api: api as any, writes };
}
it("keeps missing engagement metrics distinct from zero and scopes groups to this app", async () => {
  const v = await appleTesters(apple().api, "app");
  expect(v.testers[0].sessions).toBeUndefined();
  expect(v.metricsError).toContain("unavailable");
  expect(v.testers[0].groupIds).toEqual(["g1"]);
  expect(v.testers[1].email).toBeUndefined();
});
it("reuses testers when inviting, removes group access without globally deleting testers, and blocks foreign groups", async () => {
  const { api, writes } = apple(false);
  await (
    await planAppleTesters(api, "app", "com.app", {
      kind: "appleInvite",
      groupId: "g1",
      emails: ["one@example.com"],
    })
  ).execute();
  expect(writes[0].path).toBe("/betaGroups/g1/relationships/betaTesters");
  await (
    await planAppleTesters(api, "app", "com.app", {
      kind: "appleMembership",
      groupId: "g1",
      testerIds: ["t1"],
      add: false,
    })
  ).execute();
  expect(writes[1].method).toBe("DELETE");
  expect(writes[1].path).not.toBe("/betaTesters/t1");
  await expect(
    planAppleTesters(api, "app", "com.app", {
      kind: "appleMembership",
      groupId: "foreign",
      testerIds: ["t1"],
      add: true,
    }),
  ).rejects.toThrow(/belonging/);
  await expect(
    planAppleTesters(api, "app", "com.app", {
      kind: "appleReinvite",
      testerIds: ["anon"],
    }),
  ).rejects.toThrow(/named testers/);
});
it("reads Play groups without committing, and updates only the selected testing track", async () => {
  const calls: any[] = [],
    locked = <T>(f: () => Promise<T>) => f();
  let groups = ["old@googlegroups.com"];
  const api: any = {
    edit: async () => ({ id: "e" }),
    request: async (path: string, method = "GET", body?: any) => {
      calls.push({ path, method, body });
      if (path.endsWith("/tracks"))
        return { tracks: [{ track: "internal" }, { track: "production" }] };
      if (path.includes("/testers/")) {
        if (method === "PUT") groups = body.googleGroups;
        return { googleGroups: groups };
      }
      return {};
    },
  };
  const view = await playTesters(api, "com.app");
  expect(view.note).toContain("not reported");
  expect(calls.some((c) => c.path.endsWith(":commit"))).toBe(false);
  await (
    await planPlayTesters(
      api,
      "com.app",
      {
        kind: "playGroups",
        track: "internal",
        googleGroups: ["new@googlegroups.com"],
      },
      locked,
    )
  ).execute();
  expect(groups).toEqual(["new@googlegroups.com"]);
  expect(
    calls.some(
      (c) => c.method === "PUT" && c.path.endsWith("/tracks/production"),
    ),
  ).toBe(false);
});

it("keeps an invitation preview valid through unrelated installations, but rejects an already accepted tester", async () => {
  const { api } = apple(),
    request = api.request.bind(api);
  let changed = false,
    accepted = false;
  api.request = async (path: string, ...args: any[]) => {
    const response = await request(path, ...args);
    if (path.startsWith("/betaTesters?filter[apps]") && changed) {
      response.data[0].attributes.appDevices = [{ model: "New device" }];
      if (accepted) response.data[0].attributes.state = "INSTALLED";
      response.data.push({
        id: "new-tester",
        attributes: { state: "INSTALLED" },
      });
    }
    return response;
  };
  const action = { kind: "appleReinvite" as const, testerIds: ["t1"] };
  const first = await planAppleTesters(api, "app", "com.app", action);
  changed = true;
  expect(
    (await planAppleTesters(api, "app", "com.app", action)).snapshot,
  ).toEqual(first.snapshot);
  accepted = true;
  await expect(planAppleTesters(api, "app", "com.app", action)).rejects.toThrow(
    /not accepted/,
  );
});

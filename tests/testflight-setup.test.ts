import { it, expect } from "vitest";
import {
  configureInternalTesting,
  internalTeamUsers,
} from "../src/core/testflight-setup";
function fixture(uncertain = false) {
  const requests: { path: string; method: string; body: any }[] = [];
  let group: any;
  const testers: any[] = [];
  const members: any[] = [];
  const api = {
    request: async (path: string, method = "GET", body?: any) => {
      requests.push({ path, method, body });
      if (path === "/users?limit=200")
        return {
          data: [
            {
              id: "user",
              attributes: {
                username: "owner@example.com",
                allAppsVisible: true,
                roles: ["ADMIN"],
              },
            },
            {
              id: "other",
              attributes: {
                username: "other@example.com",
                allAppsVisible: false,
                roles: ["DEVELOPER"],
              },
            },
          ],
        };
      if (path.includes("/visibleApps")) return { data: [{ id: "unrelated" }] };
      if (path.startsWith("/betaGroups?"))
        return { data: group ? [group] : [] };
      if (path === "/betaGroups" && method === "POST") {
        if (uncertain) throw Error("network failed");
        group = { id: "group", attributes: body.data.attributes };
        return { data: group };
      }
      if (path.startsWith("/betaTesters?")) return { data: testers };
      if (path.includes("/betaTesters?")) return { data: members };
      if (path === "/betaTesters" && method === "POST") {
        const t = { id: "tester", attributes: body.data.attributes };
        testers.push(t);
        members.push(t);
        return { data: t };
      }
      throw Error("Unexpected API operation " + path);
    },
  } as any;
  return { api, requests };
}
it("offers only existing eligible teammates with access to the exact app", async () => {
  const h = fixture();
  expect(await internalTeamUsers(h.api, "app")).toEqual([
    { id: "user", email: "owner@example.com", name: "owner@example.com" },
  ]);
  await expect(
    configureInternalTesting(h.api, "app", "Internal", ["other"]),
  ).rejects.toThrow(/eligible/);
  expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(0);
});
it("creates internal groups and explicit invitations without public links or role changes", async () => {
  const h = fixture();
  await configureInternalTesting(h.api, "app", "Internal", ["user"]);
  await configureInternalTesting(h.api, "app", "Internal", ["user"]);
  const posts = h.requests.filter((r) => r.method === "POST");
  expect(posts).toHaveLength(2);
  expect(posts[0].body.data.attributes).toMatchObject({
    isInternalGroup: true,
    publicLinkEnabled: false,
    hasAccessToAllBuilds: false,
  });
  expect(posts[1].body.data.attributes.email).toBe("owner@example.com");
  expect(posts.some((r) => r.path.startsWith("/users"))).toBe(false);
});
it("does not repeat an uncertain creation after persistent journal recovery", async () => {
  const h = fixture(true);
  const submitted = new Set<string>();
  const journal = {
    has: (key: string) => submitted.has(key),
    mark: (key: string) => {
      submitted.add(key);
    },
  };
  await expect(
    configureInternalTesting(h.api, "app", "Internal", [], journal),
  ).rejects.toThrow(/network/);
  await expect(
    configureInternalTesting(h.api, "app", "Internal", [], journal),
  ).rejects.toThrow(/uncertain/);
  expect(h.requests.filter((r) => r.method === "POST")).toHaveLength(1);
});

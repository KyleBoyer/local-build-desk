import { AppleAPI } from "./stores";
import { invariant } from "./errors";

async function list(api: AppleAPI, path: string) {
  const items: any[] = [];
  let next: string | undefined = path;
  const seen = new Set<string>();
  while (next) {
    invariant(
      !seen.has(next),
      "APPLE_PAGINATION",
      "Apple returned a repeated results page.",
    );
    seen.add(next);
    const response = await api.request(next);
    items.push(...response.data);
    const link = response.links?.next;
    if (!link) break;
    const url = new URL(link, "https://api.appstoreconnect.apple.com");
    invariant(
      url.origin === "https://api.appstoreconnect.apple.com" &&
        url.pathname.startsWith("/v1/"),
      "APPLE_PAGINATION",
      "Unexpected Apple results page.",
    );
    next = url.pathname.slice(3) + url.search;
  }
  return items;
}
export async function internalTeamUsers(api: AppleAPI, appId: string) {
  const users = await list(api, "/users?limit=200");
  const eligible: { id: string; email: string; name: string }[] = [];
  for (const user of users) {
    const a = user.attributes;
    if (
      !a.roles?.some((role: string) =>
        [
          "ADMIN",
          "APP_MANAGER",
          "DEVELOPER",
          "MARKETING",
          "ACCOUNT_HOLDER",
        ].includes(role),
      )
    )
      continue;
    if (!a.allAppsVisible) {
      const apps = await list(
        api,
        `/users/${encodeURIComponent(user.id)}/visibleApps?limit=200`,
      );
      if (!apps.some((app: any) => app.id === appId)) continue;
    }
    if (a.username)
      eligible.push({
        id: user.id,
        email: a.username,
        name: [a.firstName, a.lastName].filter(Boolean).join(" ") || a.username,
      });
  }
  return eligible;
}
export async function configureInternalTesting(
  api: AppleAPI,
  appId: string,
  name: string,
  userIds: string[],
  journal?: { has: (key: string) => boolean; mark: (key: string) => void },
) {
  invariant(
    name.trim() && name.length <= 100,
    "TESTFLIGHT_NAME",
    "Enter a group name.",
  );
  const postOnce = async (
    key: string,
    path: string,
    body: unknown,
    reconcile: () => Promise<any>,
  ) => {
    if (journal?.has(key)) {
      const result = await reconcile();
      invariant(
        result,
        "TESTFLIGHT_UNCERTAIN",
        "A previous group/invitation request is uncertain. Inspect App Store Connect and retry reconciliation; it will not be sent again automatically.",
      );
      return result;
    }
    journal?.mark(key);
    try {
      return await api.request(path, "POST", body);
    } catch (error) {
      const result = await reconcile();
      if (result) return result;
      throw error;
    }
  };
  const users = await internalTeamUsers(api, appId);
  invariant(
    new Set(userIds).size === userIds.length &&
      userIds.every((id) => users.some((user) => user.id === id)),
    "TESTFLIGHT_ELIGIBILITY",
    "Selected testers must already be eligible teammates with access to this app. Refresh the list.",
  );
  const groups = () =>
    list(api, `/betaGroups?filter[app]=${encodeURIComponent(appId)}&limit=200`);
  const matching = (all: any[]) =>
    all.filter(
      (group) =>
        group.attributes.isInternalGroup &&
        group.attributes.name === name.trim(),
    );
  let matches = matching(await groups());
  invariant(
    matches.length < 2,
    "TESTFLIGHT_AMBIGUOUS",
    "Several internal groups have this name. Use a unique group name.",
  );
  let group = matches[0];
  if (!group) {
    const created = await postOnce(
      `group:${appId}:${name.trim()}`,
      "/betaGroups",
      {
        data: {
          type: "betaGroups",
          attributes: {
            name: name.trim(),
            isInternalGroup: true,
            publicLinkEnabled: false,
            hasAccessToAllBuilds: false,
          },
          relationships: { app: { data: { type: "apps", id: appId } } },
        },
      },
      async () => {
        const found = matching(await groups());
        return found.length === 1 ? { data: found[0] } : undefined;
      },
    );
    group = created.data;
  }
  for (const user of users.filter((user) => userIds.includes(user.id))) {
    const testers = await list(
      api,
      `/betaTesters?filter[email]=${encodeURIComponent(user.email)}&limit=200`,
    );
    invariant(
      testers.length < 2,
      "TESTFLIGHT_TESTER",
      "Apple returned ambiguous tester records.",
    );
    if (testers[0]) {
      const members = await list(
        api,
        `/betaGroups/${encodeURIComponent(group.id)}/betaTesters?limit=200`,
      );
      if (!members.some((tester) => tester.id === testers[0].id))
        await postOnce(
          `member:${group.id}:${user.id}`,
          `/betaGroups/${encodeURIComponent(group.id)}/relationships/betaTesters`,
          { data: [{ type: "betaTesters", id: testers[0].id }] },
          async () => {
            const now = await list(
              api,
              `/betaGroups/${encodeURIComponent(group.id)}/betaTesters?limit=200`,
            );
            return now.some((item) => item.id === testers[0].id)
              ? {}
              : undefined;
          },
        );
    } else {
      await postOnce(
        `tester:${group.id}:${user.id}`,
        "/betaTesters",
        {
          data: {
            type: "betaTesters",
            attributes: { email: user.email },
            relationships: {
              betaGroups: { data: [{ type: "betaGroups", id: group.id }] },
            },
          },
        },
        async () => {
          const now = await list(
            api,
            `/betaGroups/${encodeURIComponent(group.id)}/betaTesters?limit=200`,
          );
          return now.some(
            (item) =>
              item.attributes.email?.toLowerCase() === user.email.toLowerCase(),
          )
            ? {}
            : undefined;
        },
      );
    }
  }
  return { id: group.id as string, name: group.attributes.name as string };
}

import { z } from "zod";
import type { AppleAPI, GoogleAPI } from "./stores";
import { invariant } from "./errors";
import type { StoreActionPlan } from "./store-actions";
import { playTrackName } from "./promotion";
import { actionHash } from "./store-actions";

const id = z.string().min(1).max(200),
  emails = z.array(z.email().max(254)).min(1).max(50);
export const testerActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("appleInvite"), groupId: id, emails }).strict(),
  z
    .object({
      kind: z.literal("appleReinvite"),
      testerIds: z.array(id).min(1).max(50),
    })
    .strict(),
  z
    .object({
      kind: z.literal("appleMembership"),
      groupId: id,
      testerIds: z.array(id).min(1).max(50),
      add: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("appleGroup"),
      name: z.string().trim().min(1).max(100),
    })
    .strict(),
  z.object({ kind: z.literal("appleExpire"), buildId: id }).strict(),
  z
    .object({
      kind: z.literal("playGroups"),
      track: id,
      googleGroups: z.array(z.email().max(254)).max(100),
    })
    .strict(),
]);
export type TesterAction = z.infer<typeof testerActionSchema>;
export interface Tester {
  id: string;
  email?: string;
  name: string;
  state: string;
  groupIds: string[];
  devices: { model?: string; osVersion?: string; appBuildVersion?: string }[];
  sessions?: number;
  crashes?: number;
  feedback?: number;
}
export interface AppleTesterView {
  groups: {
    id: string;
    name: string;
    internal: boolean;
    publicLink?: string;
    publicLinkEnabled: boolean;
  }[];
  testers: Tester[];
  builds: {
    id: string;
    number: string;
    expiresAt?: string;
    expired: boolean;
    groupIds: string[];
  }[];
  metricsError?: string;
  checkedAt: string;
}
export interface PlayTesterView {
  tracks: {
    track: string;
    name: string;
    googleGroups: string[];
    error?: string;
  }[];
  optInUrl: string;
  checkedAt: string;
  note: string;
}
async function all(api: AppleAPI, initial: string) {
  let path = initial;
  const rows: any[] = [];
  let included: any[] = [];
  for (let page = 0; path && page < 100; page++) {
    const result = await api.request(path);
    rows.push(...(result.data ?? []));
    included.push(...(result.included ?? []));
    if (!result.links?.next) return { rows, included };
    const url = new URL(
      result.links.next,
      "https://api.appstoreconnect.apple.com",
    );
    invariant(
      url.origin === "https://api.appstoreconnect.apple.com" &&
        url.pathname.startsWith("/v1/"),
      "TESTER_PAGE",
      "Unexpected tester pagination link.",
    );
    path = url.pathname.slice(3) + url.search;
  }
  throw new Error(
    "Too many tester pages. Narrow the group in App Store Connect before making bulk changes.",
  );
}
export async function appleTesters(
  api: AppleAPI,
  appId: string,
): Promise<AppleTesterView> {
  const [groups, testers, builds, metrics] = await Promise.all([
    all(api, `/apps/${encodeURIComponent(appId)}/betaGroups?limit=200`),
    all(
      api,
      `/betaTesters?filter[apps]=${encodeURIComponent(appId)}&include=betaGroups&limit=200`,
    ),
    all(
      api,
      `/builds?filter[app]=${encodeURIComponent(appId)}&include=betaGroups&sort=-uploadedDate&limit=100`,
    ),
    all(
      api,
      `/apps/${encodeURIComponent(appId)}/metrics/betaTesterUsages?period=P7D&groupBy=betaTesters&limit=200`,
    ).then(
      (v) => ({ value: v.rows, error: undefined as string | undefined }),
      (e) => ({ value: [] as any[], error: String(e.message) }),
    ),
  ]);
  const groupIds = new Set(groups.rows.map((g) => g.id));
  return {
    groups: groups.rows.map((g) => ({
      id: g.id,
      name: g.attributes.name,
      internal: !!g.attributes.isInternalGroup,
      publicLink: g.attributes.publicLink,
      publicLinkEnabled: !!g.attributes.publicLinkEnabled,
    })),
    testers: testers.rows.map((t) => {
      const points = metrics.value
        .filter((m: any) => m.dimensions?.betaTesters?.data === t.id)
        .flatMap((m: any) => m.dataPoints ?? []);
      const total = (name: string) =>
        points.length
          ? points.reduce(
              (n: number, p: any) => n + Number(p.values?.[name] ?? 0),
              0,
            )
          : undefined;
      return {
        id: t.id,
        email: t.attributes.email,
        name:
          [t.attributes.firstName, t.attributes.lastName]
            .filter(Boolean)
            .join(" ") ||
          t.attributes.email ||
          "Anonymous public-link tester",
        state: t.attributes.state ?? "UNKNOWN",
        groupIds: (t.relationships?.betaGroups?.data ?? [])
          .map((g: any) => g.id)
          .filter((v: string) => groupIds.has(v)),
        devices: t.attributes.appDevices ?? [],
        sessions: total("sessionCount"),
        crashes: total("crashCount"),
        feedback: total("feedbackCount"),
      };
    }),
    builds: builds.rows.map((b) => ({
      id: b.id,
      number: String(b.attributes.version),
      expiresAt: b.attributes.expirationDate,
      expired: !!b.attributes.expired,
      groupIds: (b.relationships?.betaGroups?.data ?? [])
        .map((g: any) => g.id)
        .filter((v: string) => groupIds.has(v)),
    })),
    metricsError: metrics.error,
    checkedAt: new Date().toISOString(),
  };
}
export async function playTesters(
  api: GoogleAPI,
  packageName: string,
): Promise<PlayTesterView> {
  const edit = await api.edit(packageName),
    base = `/applications/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(edit.id)}`;
  try {
    const current = (await api.request(`${base}/tracks`)).tracks ?? [];
    const tracks = [
      ...new Set<string>([
        "internal",
        "alpha",
        ...current.map((r: any) => String(r.track)),
      ]),
    ].filter((t) => t !== "production" && t !== "beta");
    const results = await Promise.all(
      tracks.map(async (track) => {
        try {
          return {
            track,
            name: playTrackName(track),
            googleGroups:
              (
                await api.request(
                  `${base}/testers/${encodeURIComponent(track)}`,
                )
              ).googleGroups ?? [],
          };
        } catch (e) {
          return {
            track,
            name: playTrackName(track),
            googleGroups: [] as string[],
            error: (e as Error).message,
          };
        }
      }),
    );
    return {
      tracks: results,
      optInUrl: `https://play.google.com/apps/testing/${encodeURIComponent(packageName)}`,
      checkedAt: new Date().toISOString(),
      note: "The Play API exposes Google Groups assigned to tracks. Individual email lists, group membership, tester acceptance/install status, license testers and production-access eligibility are managed in Play Console; they are not reported by this API.",
    };
  } finally {
    await api.request(base, "DELETE").catch(() => {});
  }
}
export async function planAppleTesters(
  api: AppleAPI,
  appId: string,
  bundleId: string,
  input: TesterAction,
): Promise<StoreActionPlan> {
  const action = testerActionSchema.parse(input),
    view = await appleTesters(api, appId);
  invariant(
    action.kind !== "playGroups",
    "TESTER_PROVIDER",
    "Choose an Apple tester action.",
  );
  const group =
    "groupId" in action
      ? view.groups.find((g) => g.id === action.groupId && !g.internal)
      : undefined;
  if ("groupId" in action)
    invariant(
      group,
      "TESTER_GROUP",
      "Choose an external group belonging to this app. Internal teammates are managed in Guided setup.",
    );
  const selected =
    "testerIds" in action
      ? action.testerIds.map((id) => {
          const t = view.testers.find((t) => t.id === id);
          invariant(
            t,
            "TESTER_APP",
            "A selected tester no longer belongs to this app. Refresh first.",
          );
          return t;
        })
      : [];
  const scope = `apple-testers:${appId}`,
    warnings = [
      "Only this app’s groups/builds are changed. No tester is deleted from your developer account.",
    ],
    changes: string[] = [];
  let title: string, execute: StoreActionPlan["execute"];
  if (action.kind === "appleInvite") {
    const addresses = [...new Set(action.emails.map((e) => e.toLowerCase()))];
    title = "Invite external testers";
    changes.push(`Add ${addresses.join(", ")} to ${group!.name}.`);
    warnings.push(
      "Apple may email the selected testers. They receive access only to builds assigned to this group.",
    );
    execute = async (progress) => {
      progress?.(0, addresses.length);
      for (const [index, email] of addresses.entries()) {
        if (
          view.testers.some(
            (t) =>
              t.email?.toLowerCase() === email &&
              t.groupIds.includes(group!.id),
          )
        ) {
          progress?.(index + 1, addresses.length);
          continue;
        }
        const existing = (
          await all(
            api,
            `/betaTesters?filter[email]=${encodeURIComponent(email)}&limit=200`,
          )
        ).rows.find((t) => t.attributes.email?.toLowerCase() === email);
        if (existing)
          await api.request(
            `/betaGroups/${encodeURIComponent(group!.id)}/relationships/betaTesters`,
            "POST",
            { data: [{ type: "betaTesters", id: existing.id }] },
          );
        else
          await api.request("/betaTesters", "POST", {
            data: {
              type: "betaTesters",
              attributes: { email },
              relationships: {
                betaGroups: { data: [{ type: "betaGroups", id: group!.id }] },
              },
            },
          });
        progress?.(index + 1, addresses.length);
      }
    };
  } else if (action.kind === "appleReinvite") {
    invariant(
      selected.every(
        (t) => t.email && ["INVITED", "NOT_INVITED"].includes(t.state),
      ),
      "TESTER_INVITE",
      "Reinvite only named testers who have not accepted their invitation.",
    );
    title = "Resend TestFlight invitations";
    changes.push(`Email ${selected.map((t) => t.email).join(", ")}.`);
    execute = async (progress) => {
      progress?.(0, selected.length);
      for (const [index, tester] of selected.entries()) {
        await api.request("/betaTesterInvitations", "POST", {
          data: {
            type: "betaTesterInvitations",
            relationships: {
              app: { data: { type: "apps", id: appId } },
              betaTester: { data: { type: "betaTesters", id: tester.id } },
            },
          },
        });
        progress?.(index + 1, selected.length);
      }
    };
  } else if (action.kind === "appleMembership") {
    title = action.add ? "Add testers to group" : "Remove testers from group";
    changes.push(
      `${selected.map((t) => t.email ?? t.name).join(", ")} ${action.add ? "→" : "removed from"} ${group!.name}.`,
    );
    warnings.push(
      "Removing group access does not uninstall a beta already on a tester’s device. Expire the build explicitly if it must stop working.",
    );
    execute = async () => {
      await api.request(
        `/betaGroups/${encodeURIComponent(group!.id)}/relationships/betaTesters`,
        action.add ? "POST" : "DELETE",
        { data: selected.map((t) => ({ type: "betaTesters", id: t.id })) },
      );
    };
  } else if (action.kind === "appleGroup") {
    invariant(
      !view.groups.some(
        (g) => g.name.toLowerCase() === action.name.toLowerCase(),
      ),
      "TESTER_GROUP_EXISTS",
      "A group with this name already exists. Select it instead.",
    );
    title = "Create external testing group";
    changes.push(action.name);
    warnings.push(
      "Public-link enrollment stays off until you explicitly enable it in the release’s external-testing controls.",
    );
    execute = async () => {
      await api.request("/betaGroups", "POST", {
        data: {
          type: "betaGroups",
          attributes: {
            name: action.name,
            isInternalGroup: false,
            publicLinkEnabled: false,
          },
          relationships: { app: { data: { type: "apps", id: appId } } },
        },
      });
    };
  } else {
    const build = view.builds.find(
      (b) => b.id === action.buildId && !b.expired,
    );
    invariant(
      build,
      "TESTER_BUILD",
      "Choose an unexpired build belonging to this app.",
    );
    title = "Expire TestFlight build";
    changes.push(`Expire build ${build.number}.`);
    warnings.push(
      "This cannot be undone. Testers lose access to this build, including installed copies. Choose a replacement before expiring a build still in use.",
    );
    execute = async () => {
      await api.request(`/builds/${encodeURIComponent(build.id)}`, "PATCH", {
        data: { type: "builds", id: build.id, attributes: { expired: true } },
      });
    };
  }
  // Only access relevant to the reviewed action invalidates its preview.
  // Other testers installing a build must not interrupt this batch.
  const relevantTesters =
    "testerIds" in action
      ? selected
      : action.kind === "appleInvite"
        ? view.testers.filter(
            (t) =>
              t.email &&
              action.emails.some(
                (e) => e.toLowerCase() === t.email!.toLowerCase(),
              ),
          )
        : [];
  const snapshot = {
    action,
    groups:
      action.kind === "appleGroup"
        ? view.groups.map((g) => ({ id: g.id, name: g.name }))
        : group
          ? [{ id: group.id, name: group.name, internal: group.internal }]
          : [],
    testers: relevantTesters.map((t) => ({
      id: t.id,
      email: t.email,
      state: t.state,
      groupIds: t.groupIds,
    })),
    builds:
      action.kind === "appleExpire"
        ? view.builds.filter((b) => b.id === action.buildId)
        : [],
  };
  const recovery = {
    kind: "testers",
    provider: "apple",
    appId,
    bundleId,
    actionKind: action.kind,
    ...("groupId" in action ? { groupId: action.groupId } : {}),
    ...("testerIds" in action ? { testerIds: action.testerIds } : {}),
    ...(action.kind === "appleInvite"
      ? {
          emailHashes: [
            ...new Set(action.emails.map((e) => actionHash(e.toLowerCase()))),
          ],
        }
      : {}),
    ...(action.kind === "appleGroup"
      ? { nameHash: actionHash(action.name.toLowerCase()) }
      : {}),
    ...(action.kind === "appleExpire" ? { buildId: action.buildId } : {}),
    ...(action.kind === "appleMembership" ? { add: action.add } : {}),
  };
  return {
    title,
    scope,
    recovery,
    identity: bundleId,
    snapshot,
    changes,
    warnings,
    execute,
    satisfied: () => appleTesterSatisfied(api, appId, recovery),
  };
}

export async function planPlayTesters(
  api: GoogleAPI,
  packageName: string,
  input: TesterAction,
  locked: <T>(work: () => Promise<T>) => Promise<T>,
): Promise<StoreActionPlan> {
  const action = testerActionSchema.parse(input);
  invariant(
    action.kind === "playGroups",
    "TESTER_PROVIDER",
    "Choose Play Google Groups.",
  );
  const view = await locked(() => playTesters(api, packageName)),
    selected = view.tracks.find((t) => t.track === action.track);
  invariant(
    selected && !selected.error,
    "TESTER_TRACK",
    "Choose a readable internal or closed testing track. Production/open testing do not use this group editor.",
  );
  const desired = [
    ...new Set(action.googleGroups.map((e) => e.toLowerCase())),
  ].sort();
  return {
    scope: `play-testers:${packageName}`,
    recovery: {
      kind: "testers",
      provider: "google",
      packageName,
      track: action.track,
      desiredHash: actionHash(desired),
    },
    title: "Update Play testing groups",
    identity: `${packageName} · ${selected.name}`,
    snapshot: {
      track: action.track,
      current: [...selected.googleGroups].sort(),
      desired,
    },
    changes: [
      `${selected.googleGroups.join(", ") || "No Google Groups"} → ${desired.join(", ") || "No Google Groups"}`,
    ],
    warnings: [
      "This replaces the Google Groups assigned to this track. It does not edit their members, email lists, license-test accounts, or publish a build.",
    ],
    execute: () =>
      locked(async () => {
        const edit = await api.edit(packageName),
          base = `/applications/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(edit.id)}`;
        let committed = false;
        try {
          const current =
            (
              await api.request(
                `${base}/testers/${encodeURIComponent(action.track)}`,
              )
            ).googleGroups ?? [];
          invariant(
            JSON.stringify([...current].sort()) ===
              JSON.stringify([...selected.googleGroups].sort()),
            "TESTER_CHANGED",
            "Google Groups changed. Refresh and prepare another preview.",
          );
          await api.request(
            `${base}/testers/${encodeURIComponent(action.track)}`,
            "PUT",
            { googleGroups: desired },
          );
          try {
            await api.request(`${base}:commit`, "POST", {});
          } catch (e) {
            if (
              (e as any)?.code !== "GOOGLE_400" ||
              !/changesNotSentForReview.*true|cannot be sent for review automatically/i.test(
                (e as Error).message,
              )
            )
              throw e;
            await api.request(
              `${base}:commit?changesNotSentForReview=true`,
              "POST",
              {},
            );
          }
          committed = true;
        } finally {
          if (!committed) await api.request(base, "DELETE").catch(() => {});
        }
      }),
    satisfied: async () => false,
  };
}
export async function appleTesterSatisfied(
  api: AppleAPI,
  appId: string,
  recovery: Record<string, unknown>,
) {
  const view = await appleTesters(api, appId);
  if (recovery.actionKind === "appleReinvite") return false; // Apple does not expose mail delivery receipts.
  if (recovery.actionKind === "appleGroup")
    return view.groups.some(
      (g) =>
        actionHash(g.name.toLowerCase()) === recovery.nameHash && !g.internal,
    );
  if (recovery.actionKind === "appleExpire")
    return view.builds.some((b) => b.id === recovery.buildId && b.expired);
  if (recovery.actionKind === "appleInvite")
    return (recovery.emailHashes as string[]).every((hash) =>
      view.testers.some(
        (t) =>
          t.email &&
          actionHash(t.email.toLowerCase()) === hash &&
          t.groupIds.includes(String(recovery.groupId)),
      ),
    );
  if (recovery.actionKind === "appleMembership")
    return (recovery.testerIds as string[]).every((id) => {
      const t = view.testers.find((t) => t.id === id);
      return t
        ? t.groupIds.includes(String(recovery.groupId)) === recovery.add
        : recovery.add === false;
    });
  return false;
}

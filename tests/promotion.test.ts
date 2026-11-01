import { it, expect, describe } from "vitest";
import { DeskError } from "../src/core/errors";
import {
  changePlayRollout,
  playTracks,
  promotePlay,
  promoteTestFlight,
} from "../src/core/promotion";

/** A fake Play edits API holding tracks in memory. */
function play(
  tracks: Record<string, any[]>,
  options: { reviewRequired?: boolean } = {},
) {
  const calls: { method: string; path: string; body?: any }[] = [];
  let staged: Record<string, any[]> = structuredClone(tracks);
  const api = {
    edit: async () => ({ id: "e1" }),
    request: async (path: string, method = "GET", body?: any) => {
      calls.push({ method, path, body });
      const track = /\/tracks\/([^/?]+)$/.exec(path)?.[1];
      if (path.endsWith("/tracks") && method === "GET")
        return {
          tracks: Object.entries(staged).map(([t, releases]) => ({
            track: t,
            releases,
          })),
        };
      if (track && method === "GET")
        return { track, releases: staged[track] ?? [] };
      if (track && method === "PUT") {
        staged[decodeURIComponent(track)] = body.releases;
        return body;
      }
      if (path.endsWith(":commit") && options.reviewRequired)
        throw new DeskError(
          "GOOGLE_400",
          "Google Play 400: Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true.",
        );
      return {};
    },
  };
  return { api: api as any, calls, tracks: () => staged };
}
const internal = {
  name: "1.2 (42)",
  versionCodes: ["42"],
  status: "completed",
  releaseNotes: [{ language: "en-US", text: "Fixes" }],
};
const live = { name: "1.1 (40)", versionCodes: ["40"], status: "completed" };

describe("Google Play", () => {
  it("lists the standard tracks first, then custom closed tracks", async () => {
    const { api } = play({ internal: [internal], "qa-team": [] });
    const { tracks } = await playTracks(api, "com.app");
    expect(tracks.map((t) => t.track)).toEqual([
      "internal",
      "alpha",
      "beta",
      "production",
      "qa-team",
    ]);
    expect(tracks[4]!.name).toBe("Closed testing · qa-team");
  });

  it("promotes by version code with its notes, keeping production's current release beside a staged rollout", async () => {
    const { api, calls, tracks } = play({
      internal: [internal],
      production: [live],
    });
    const result = await promotePlay(api, "com.app", {
      versionCodes: ["42"],
      from: "internal",
      to: "production",
      fraction: 0.1,
    });
    expect(result.review).toBe(false);
    expect(tracks().production).toEqual([
      {
        name: "1.2 (42)",
        versionCodes: ["42"],
        status: "inProgress",
        userFraction: 0.1,
        releaseNotes: internal.releaseNotes,
      },
      live,
    ]);
    expect(calls.some((c) => c.path.includes("/bundles"))).toBe(false); // nothing uploaded
    expect(calls.at(-1)!.path).toMatch(/:commit$/);
  });

  it("replaces a testing track's release for a full promotion", async () => {
    const { api, tracks } = play({ internal: [internal], alpha: [live] });
    await promotePlay(api, "com.app", {
      versionCodes: ["42"],
      from: "internal",
      to: "alpha",
    });
    expect(tracks().alpha).toEqual([
      {
        name: "1.2 (42)",
        versionCodes: ["42"],
        status: "completed",
        releaseNotes: internal.releaseNotes,
      },
    ]);
  });

  it("commits without sending for review when the account requires it, and discards a failed edit", async () => {
    const held = play({ internal: [internal] }, { reviewRequired: true });
    expect(
      (
        await promotePlay(held.api, "com.app", {
          versionCodes: ["42"],
          from: "internal",
          to: "beta",
        })
      ).review,
    ).toBe(true);
    expect(held.calls.at(-1)!.path).toMatch(
      /:commit\?changesNotSentForReview=true$/,
    );
    const gone = play({ internal: [] });
    await expect(
      promotePlay(gone.api, "com.app", {
        versionCodes: ["42"],
        from: "internal",
        to: "beta",
      }),
    ).rejects.toThrow(/isn't on Internal testing/);
    expect(gone.calls.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("widens, halts, resumes and completes a staged rollout, and never narrows it", async () => {
    const rolling = { ...internal, status: "inProgress", userFraction: 0.1 };
    const { api, tracks } = play({ production: [rolling, live] });
    await changePlayRollout(api, "com.app", "production", ["42"], {
      action: "fraction",
      fraction: 0.5,
    });
    expect(tracks().production![0]).toMatchObject({
      status: "inProgress",
      userFraction: 0.5,
    });
    await expect(
      changePlayRollout(api, "com.app", "production", ["42"], {
        action: "fraction",
        fraction: 0.2,
      }),
    ).rejects.toThrow(/only widen/);
    await changePlayRollout(api, "com.app", "production", ["42"], {
      action: "halt",
    });
    expect(tracks().production![0]!.status).toBe("halted");
    expect(tracks().production![1]).toEqual(live);
    await changePlayRollout(api, "com.app", "production", ["42"], {
      action: "resume",
    });
    expect(tracks().production![0]!.status).toBe("inProgress");
    await changePlayRollout(api, "com.app", "production", ["42"], {
      action: "complete",
    });
    expect(tracks().production).toEqual([
      {
        name: "1.2 (42)",
        versionCodes: ["42"],
        status: "completed",
        releaseNotes: internal.releaseNotes,
      },
    ]);
  });
});

describe("TestFlight", () => {
  function apple(
    state: { external?: string; contact?: Record<string, string> } = {},
  ) {
    const calls: { method: string; path: string; body?: any }[] = [];
    const api = {
      app: async () => ({ id: "app1" }),
      request: async (path: string, method = "GET", body?: any) => {
        calls.push({ method, path, body });
        if (method === "POST" && path === "/betaGroups")
          return { data: { id: "g-new" } };
        if (path.startsWith("/apps/app1/betaGroups"))
          return {
            data: [
              {
                id: "g-int",
                attributes: {
                  name: "Team",
                  isInternalGroup: true,
                  hasAccessToAllBuilds: true,
                },
              },
              {
                id: "g-ext",
                attributes: {
                  name: "Beta",
                  isInternalGroup: false,
                  publicLinkEnabled: false,
                },
              },
            ],
          };
        if (path.startsWith("/betaGroups/") && path.includes("/builds"))
          return { data: [] };
        if (path === "/apps/app1/betaAppReviewDetail")
          return { data: { id: "d1", attributes: state.contact ?? {} } };
        if (path === "/builds/b1/buildBetaDetail")
          return {
            data: {
              attributes: {
                externalBuildState:
                  state.external ?? "READY_FOR_BETA_SUBMISSION",
              },
            },
          };
        if (path === "/builds/b1/betaAppReviewSubmission")
          return { data: null };
        return {};
      },
    };
    return { api: api as any, calls };
  }
  const contact = {
    contactFirstName: "Pat",
    contactLastName: "Example",
    contactEmail: "pat@example.com",
    contactPhone: "+1 555 0100",
  };

  it("adds the build to external groups and submits it for Beta App Review", async () => {
    const { api, calls } = apple({ contact });
    const log: string[] = [];
    const result = await promoteTestFlight(
      api,
      "com.app",
      { buildId: "b1", groupIds: ["g-ext"] },
      (l) => log.push(l),
    );
    expect(result.submitted).toBe(true);
    const writes = calls
      .filter((c) => c.method !== "GET")
      .map((c) => `${c.method} ${c.path}`);
    expect(writes).toEqual([
      "POST /builds/b1/relationships/betaGroups",
      "POST /betaAppReviewSubmissions",
    ]);
    expect(
      calls.find((c) => c.path === "/builds/b1/relationships/betaGroups")!.body
        .data,
    ).toEqual([{ type: "betaGroups", id: "g-ext" }]);
  });

  it("needs a review contact first, or saves one given with the promotion", async () => {
    await expect(
      promoteTestFlight(
        apple().api,
        "com.app",
        { buildId: "b1", groupIds: ["g-ext"] },
        () => undefined,
      ),
    ).rejects.toThrow(/contact/);
    const { api, calls } = apple();
    await promoteTestFlight(
      api,
      "com.app",
      { buildId: "b1", groupIds: ["g-ext"], contact },
      () => undefined,
    );
    expect(calls.find((c) => c.method === "PATCH")!.path).toBe(
      "/betaAppReviewDetails/d1",
    );
  });

  it("creates a group with a public link, and doesn't resubmit an approved build", async () => {
    const { api, calls } = apple({ external: "BETA_APPROVED", contact });
    const result = await promoteTestFlight(
      api,
      "com.app",
      {
        buildId: "b1",
        groupIds: [],
        newGroup: { name: "Public", publicLink: true, publicLinkLimit: 500 },
      },
      () => undefined,
    );
    expect(result.submitted).toBe(false);
    expect(
      calls.find((c) => c.path === "/betaGroups" && c.method === "POST")!.body
        .data.attributes,
    ).toMatchObject({
      name: "Public",
      publicLinkEnabled: true,
      publicLinkLimitEnabled: true,
      publicLinkLimit: 500,
    });
    expect(
      calls.find((c) => c.path === "/builds/b1/relationships/betaGroups")!.body
        .data,
    ).toEqual([{ type: "betaGroups", id: "g-new" }]);
  });

  it("refuses internal groups, which get builds on their own", async () => {
    await expect(
      promoteTestFlight(
        apple({ contact }).api,
        "com.app",
        { buildId: "b1", groupIds: ["g-int"] },
        () => undefined,
      ),
    ).rejects.toThrow(/external/);
  });
});

import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCompliance,
  attest,
  compliancePlan,
  complianceStatements,
  isAttested,
  privacyRows,
  readListingCompliance,
  saveListingCompliance,
  type AgeRating,
  type AppleWebSession,
  type Compliance,
} from "../src/core/app-store-compliance";
import type { AppleAPI } from "../src/core/stores";

const none: AgeRating = {
  violenceCartoonOrFantasy: "NONE",
  violenceRealistic: "NONE",
  violenceRealisticProlongedGraphicOrSadistic: "NONE",
  gunsOrOtherWeapons: "NONE",
  profanityOrCrudeHumor: "NONE",
  horrorOrFearThemes: "NONE",
  matureOrSuggestiveThemes: "NONE",
  sexualContentOrNudity: "NONE",
  sexualContentGraphicAndNudity: "NONE",
  alcoholTobaccoOrDrugUseOrReferences: "NONE",
  medicalOrTreatmentInformation: "NONE",
  gamblingSimulated: "NONE",
  contests: "NONE",
  gambling: false,
  lootBox: false,
  advertising: false,
  userGeneratedContent: false,
  messagingAndChat: false,
  socialMedia: false,
  unrestrictedWebAccess: false,
  healthOrWellnessTopics: false,
  parentalControls: false,
  ageAssurance: false,
};
const answers: Compliance = {
  ageRating: none,
  appPrivacy: { collected: false },
  pricing: { price: "0.00", territories: "ALL" },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compliance-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("attests exactly the answers given, and editing one undoes it", () => {
  const attested = attest(answers, "Kyle Boyer", "2026-10-29");
  expect(isAttested(attested)).toBe(true);
  // Key order doesn't matter, values do.
  expect(
    isAttested({ ...attested, pricing: { territories: "ALL", price: "0.00" } }),
  ).toBe(true);
  expect(
    isAttested({ ...attested, ageRating: { ...none, contests: "INFREQUENT" } }),
  ).toBe(false);
  expect(isAttested(answers)).toBe(false);
});

it("states the answers in plain language", () => {
  expect(complianceStatements(answers, "DuoDuo")).toEqual([
    expect.stringMatching(
      /^DuoDuo contains none of Apple's age-rating content types/,
    ),
    expect.stringMatching(
      /^DuoDuo has no real-money gambling, loot boxes, ads/,
    ),
    "Neither DuoDuo nor any third-party code in it collects data from it (App Privacy: Data Not Collected).",
    "Free, available in every territory.",
  ]);
  expect(
    complianceStatements(
      {
        ageRating: {
          ...none,
          violenceCartoonOrFantasy: "INFREQUENT",
          advertising: true,
        },
        appPrivacy: {
          collected: true,
          data: [
            {
              type: "CRASH_DATA",
              purposes: ["APP_FUNCTIONALITY"],
              linkedToUser: false,
              usedForTracking: false,
            },
          ],
        },
      },
      "Game",
    ),
  ).toEqual([
    "Game contains: cartoon or fantasy violence (infrequent).",
    "Game has: advertising.",
    "Game collects crash data for app functionality; not linked to the user; not used for tracking.",
  ]);
});

it("turns privacy answers into Apple's rows", () => {
  expect(privacyRows({ collected: false })).toEqual(["||DATA_NOT_COLLECTED"]);
  expect(
    privacyRows({
      collected: true,
      data: [
        {
          type: "USER_ID",
          purposes: ["ANALYTICS", "APP_FUNCTIONALITY"],
          linkedToUser: true,
          usedForTracking: true,
        },
      ],
    }),
  ).toEqual([
    "USER_ID|ANALYTICS|DATA_LINKED_TO_YOU",
    "USER_ID|ANALYTICS|DATA_USED_TO_TRACK_YOU",
    "USER_ID|APP_FUNCTIONALITY|DATA_LINKED_TO_YOU",
    "USER_ID|APP_FUNCTIONALITY|DATA_USED_TO_TRACK_YOU",
  ]);
});

it("saves answers into the listing file, keeping its other fields", async () => {
  const path = join(dir, "listing.json");
  writeFileSync(path, JSON.stringify({ name: "DuoDuo", keywords: "puzzle" }));
  const draft = await saveListingCompliance(path, answers);
  expect(draft.attested).toBe(false);
  const attested = await saveListingCompliance(path, answers, {
    name: "Kyle Boyer",
    date: "2026-10-29",
  });
  expect(attested.attested).toBe(true);
  const file = JSON.parse(readFileSync(path, "utf8"));
  expect(file).toMatchObject({
    name: "DuoDuo",
    keywords: "puzzle",
    attestation: { name: "Kyle Boyer" },
  });
  // Changing an answer without attesting drops the stale attestation.
  await saveListingCompliance(path, {
    ...answers,
    pricing: { price: "0.99", territories: "ALL" },
  });
  expect(JSON.parse(readFileSync(path, "utf8")).attestation).toBeUndefined();
  expect((await readListingCompliance(path)).attested).toBe(false);
});

it("rejects answers Apple wouldn't accept", async () => {
  const path = join(dir, "listing.json");
  writeFileSync(path, "{}");
  await expect(
    saveListingCompliance(path, {
      ageRating: { ...none, contests: "SOMETIMES" as any },
    }),
  ).rejects.toThrow();
  await expect(
    saveListingCompliance(path, {
      appPrivacy: {
        collected: true,
        data: [
          {
            type: "NOT_A_TYPE",
            purposes: ["ANALYTICS"],
            linkedToUser: false,
            usedForTracking: false,
          },
        ],
      },
    }),
  ).rejects.toThrow(/data types/);
});

/** Apple with nothing answered yet: no age rating, no price, no availability. */
function apple() {
  const writes: { method: string; path: string; body?: any }[] = [];
  const request = vi.fn(
    async (path: string, method = "GET", body?: any): Promise<any> => {
      if (method !== "GET") {
        writes.push({ method, path, body });
        return { data: { id: "created" } };
      }
      const route = path.split("?")[0];
      if (route === "/appInfos/info/ageRatingDeclaration")
        return {
          data: {
            id: "rating",
            attributes: { contests: "INFREQUENT_OR_MILD", gambling: null },
          },
        };
      if (route === "/appInfos/info")
        return { data: { id: "info", attributes: {} } };
      if (route === "/apps/app/appPriceSchedule")
        throw Object.assign(new Error("404"), { code: "APPLE_404" });
      if (route === "/apps/app/appAvailabilityV2")
        throw Object.assign(new Error("404"), { code: "APPLE_404" });
      if (route === "/territories")
        return { data: [{ id: "USA" }, { id: "CAN" }] };
      if (route === "/apps/app/appPricePoints")
        return {
          data: [
            { id: "free", attributes: { customerPrice: "0.0" } },
            { id: "p99", attributes: { customerPrice: "0.99" } },
          ],
        };
      throw new Error(`unexpected ${path}`);
    },
  );
  return { api: { request } as unknown as AppleAPI, writes };
}

/** App Store Connect's web API with App Privacy unanswered. */
function web(signedIn = true) {
  const calls: { method: string; path: string; body?: any }[] = [];
  let usages: any[] = [
    {
      id: "old",
      relationships: {
        category: { data: { id: "DEVICE_ID" } },
        purpose: { data: { id: "ANALYTICS" } },
        dataProtection: { data: { id: "DATA_NOT_LINKED_TO_YOU" } },
      },
    },
  ];
  const session: AppleWebSession = {
    request: vi.fn(
      async (
        path: string,
        { method = "GET", body, interactive = false } = {},
      ) => {
        if (!signedIn && !interactive)
          throw Object.assign(new Error("sign in"), {
            code: "APPLE_WEB_SIGN_IN",
          });
        calls.push({ method, path, body });
        if (path.startsWith("/apps/app/dataUsages")) return { data: usages };
        if (path === "/apps/app/dataUsagePublishState")
          return { data: { id: "state", attributes: { published: false } } };
        if (method === "DELETE")
          usages = usages.filter((u) => `/appDataUsages/${u.id}` !== path);
        return { data: {} };
      },
    ),
  };
  return { session, calls };
}

it("plans the age rating, price, availability and privacy changes", async () => {
  const { api } = apple();
  const plan = await compliancePlan(
    api,
    web().session,
    "app",
    "info",
    attest(answers, "K", "2026-10-29"),
    "DuoDuo",
  );
  expect(plan.attested).toBe(true);
  expect(plan.blockers).toEqual([]);
  expect(plan.ageRating!.changes).toHaveLength(23);
  expect(plan.pricing).toMatchObject({
    priceChange: true,
    unavailable: ["USA", "CAN"],
  });
  expect(plan.appPrivacy).toMatchObject({
    current: ["DEVICE_ID|ANALYTICS|DATA_NOT_LINKED_TO_YOU"],
    wanted: ["||DATA_NOT_COLLECTED"],
    published: false,
    change: true,
  });
});

it("blocks unattested answers and sends nothing", async () => {
  const { api, writes } = apple();
  const plan = await compliancePlan(
    api,
    web().session,
    "app",
    "info",
    answers,
    "DuoDuo",
  );
  expect(plan.blockers).toEqual([expect.stringMatching(/aren't attested/)]);
  await expect(
    applyCompliance(api, web().session, "app", plan, answers, () => undefined),
  ).rejects.toThrow(/attested/);
  expect(writes).toEqual([]);
});

it("plans without signing in, leaving the privacy state unknown", async () => {
  const { api } = apple();
  const plan = await compliancePlan(
    api,
    web(false).session,
    "app",
    "info",
    attest(answers, "K", "2026-10-29"),
    "DuoDuo",
  );
  expect(plan.appPrivacy).toMatchObject({ current: undefined, change: true });
});

it("applies the age rating, free price, availability and Data Not Collected", async () => {
  const { api, writes } = apple();
  const { session, calls } = web();
  const c = attest(answers, "K", "2026-10-29");
  const plan = await compliancePlan(api, session, "app", "info", c, "DuoDuo");
  const log = vi.fn();
  await applyCompliance(api, session, "app", plan, c, log);
  expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
    "PATCH /ageRatingDeclarations/rating",
    "POST /appPriceSchedules",
    "POST /v2/appAvailabilities",
  ]);
  expect(writes[0]!.body.data.attributes).toMatchObject({
    contests: "NONE",
    gambling: false,
    ageAssurance: false,
  });
  expect(writes[1]!.body.included[0].relationships.appPricePoint.data.id).toBe(
    "free",
  );
  expect(writes[2]!.body.data.attributes).toEqual({
    availableInNewTerritories: true,
  });
  expect(
    writes[2]!.body.included.map((t: any) => t.relationships.territory.data.id),
  ).toEqual(["USA", "CAN"]);
  const changes = calls
    .filter((x) => x.method !== "GET")
    .map((x) => `${x.method} ${x.path}`);
  expect(changes).toEqual([
    "DELETE /appDataUsages/old",
    "POST /appDataUsages",
    "PATCH /appDataUsagesPublishState/state",
  ]);
  const created = calls.find((x) => x.method === "POST")!.body.data
    .relationships;
  expect(created).toEqual({
    app: { data: { type: "apps", id: "app" } },
    dataProtection: {
      data: { type: "appDataUsageDataProtections", id: "DATA_NOT_COLLECTED" },
    },
  });
  expect(log).toHaveBeenCalledWith("App Privacy published");
});

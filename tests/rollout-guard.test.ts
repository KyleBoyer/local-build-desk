import { it, expect } from "vitest";
import {
  DEFAULT_GUARD,
  readVitals,
  setPhasedRelease,
  verdict,
} from "../src/core/rollout-guard";

function reporting(rows: Record<string, { users: number; rate: number }[]>) {
  const bodies: any[] = [];
  const api = {
    reporting: async (path: string, body?: any) => {
      if (!body)
        return {
          freshnessInfo: {
            freshnesses: [
              {
                aggregationPeriod: "DAILY",
                latestEndTime: { year: 2026, month: 10, day: 31 },
              },
              {
                aggregationPeriod: "HOURLY",
                latestEndTime: {
                  year: 2026,
                  month: 11,
                  day: 1,
                  hours: 6,
                  timeZone: { id: "UTC" },
                },
              },
            ],
          },
        };
      bodies.push({ path, body });
      const set = path.includes("crash") ? "crash" : "anr";
      const metric =
        set === "crash" ? "userPerceivedCrashRate" : "userPerceivedAnrRate";
      return {
        rows: (rows[set] ?? []).map((r) => ({
          metrics: [
            { metric, decimalValue: { value: String(r.rate) } },
            {
              metric: "distinctUsers",
              decimalValue: { value: String(r.users) },
            },
          ],
        })),
      };
    },
  };
  return { api: api as any, bodies };
}

it("weights hourly rates by users over the last 24 hours Play has", async () => {
  const { api, bodies } = reporting({
    crash: [
      { users: 100, rate: 0.01 },
      { users: 300, rate: 0.03 },
    ],
    anr: [{ users: 400, rate: 0.001 }],
  });
  const vitals = await readVitals(api, "com.app", "42");
  expect(vitals.crashRate).toBeCloseTo(2.5); // (1 + 9) / 400 users, as percent
  expect(vitals.anrRate).toBeCloseTo(0.1);
  expect(vitals.users).toBe(400);
  expect(bodies[0].body).toMatchObject({
    timelineSpec: {
      aggregationPeriod: "HOURLY",
      startTime: {
        year: 2026,
        month: 10,
        day: 31,
        hours: 6,
        timeZone: { id: "UTC" },
      },
      endTime: { year: 2026, month: 11, day: 1, hours: 6 },
    },
    dimensions: ["versionCode"],
    filter: "versionCode = 42",
  });
});

it("halts only past a limit, and only with enough users", () => {
  const base = { versionCode: "42", users: 500 };
  expect(
    verdict(DEFAULT_GUARD, { ...base, crashRate: 0.5, anrRate: 0.2 }),
  ).toBeUndefined();
  expect(
    verdict(DEFAULT_GUARD, { ...base, crashRate: 1.5, anrRate: 0.2 }),
  ).toMatch(/crash rate 1.5% is over 1.09%/);
  expect(
    verdict(DEFAULT_GUARD, { ...base, crashRate: 0.5, anrRate: 0.9 }),
  ).toMatch(/ANR rate/);
  expect(
    verdict(DEFAULT_GUARD, { ...base, users: 20, crashRate: 9 }),
  ).toBeUndefined();
  expect(
    verdict({ ...DEFAULT_GUARD, enabled: false }, { ...base, crashRate: 9 }),
  ).toBeUndefined();
  expect(
    verdict(DEFAULT_GUARD, {
      ...base,
      crashRate: undefined,
      anrRate: undefined,
    }),
  ).toBeUndefined();
});

it("starts, pauses and completes an App Store phased release", async () => {
  const calls: { method: string; path: string; body?: any }[] = [];
  let state: string | undefined;
  const api = {
    request: async (path: string, method = "GET", body?: any) => {
      calls.push({ method, path, body });
      if (method === "GET") {
        if (!state)
          throw Object.assign(new Error("Apple 404"), { code: "APPLE_404" });
        return {
          data: {
            id: "pr1",
            attributes: { phasedReleaseState: state, currentDayNumber: 3 },
          },
        };
      }
      if (method === "POST") {
        state = body.data.attributes.phasedReleaseState;
        return { data: { id: "pr1" } };
      }
      state = body.data.attributes.phasedReleaseState;
      return {};
    },
  } as any;
  await expect(setPhasedRelease(api, "v1", "PAUSED")).rejects.toThrow(
    /Turn on phased release/,
  );
  await setPhasedRelease(api, "v1", "INACTIVE");
  expect(
    calls.find((c) => c.method === "POST")!.body.data.relationships
      .appStoreVersion.data.id,
  ).toBe("v1");
  state = "ACTIVE"; // Apple starts it when the version is released.
  await setPhasedRelease(api, "v1", "PAUSED");
  await setPhasedRelease(api, "v1", "COMPLETE");
  expect(
    calls
      .filter((c) => c.method === "PATCH")
      .map((c) => c.body.data.attributes.phasedReleaseState),
  ).toEqual(["PAUSED", "COMPLETE"]);
});

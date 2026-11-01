import type { AppleAPI, GoogleAPI } from "./stores";
import { invariant } from "./errors";

/**
 * Watches staged Play rollouts and halts one whose Android vitals cross a
 * limit. Defaults are Google's own bad-behavior thresholds for user-perceived
 * crashes (1.09%) and ANRs (0.47%), checked only once enough people have the
 * release for the rate to mean something. The App Store has no live crash
 * API, so phased releases there are controlled by hand.
 */
export interface RolloutGuard {
  enabled: boolean;
  /** Percent of users with a user-perceived crash in the last 24 hours. */
  maxCrashRate: number;
  /** Percent of users with a user-perceived ANR in the last 24 hours. */
  maxAnrRate: number;
  /** Users (summed hourly) before a rate counts. */
  minUsers: number;
}
export const DEFAULT_GUARD: RolloutGuard = {
  enabled: true,
  maxCrashRate: 1.09,
  maxAnrRate: 0.47,
  minUsers: 100,
};

export interface Vitals {
  versionCode: string;
  /** Percent, or undefined when Play has no data yet. */
  crashRate?: number;
  anrRate?: number;
  users: number;
  /** End of the newest hour Play has data for. */
  through?: string;
}

type DateTime = {
  year: number;
  month: number;
  day: number;
  hours?: number;
  timeZone?: { id: string };
};
const toDate = (d: DateTime) =>
  new Date(Date.UTC(d.year, d.month - 1, d.day, d.hours ?? 0));
const fromDate = (d: Date): DateTime => ({
  year: d.getUTCFullYear(),
  month: d.getUTCMonth() + 1,
  day: d.getUTCDate(),
  hours: d.getUTCHours(),
  timeZone: { id: "UTC" },
});

/** User-weighted rate over the last 24 hours Play has, for one version. */
async function metric(
  api: GoogleAPI,
  packageName: string,
  set: "crashRateMetricSet" | "anrRateMetricSet",
  rate: "userPerceivedCrashRate" | "userPerceivedAnrRate",
  versionCode: string,
) {
  const app = `/apps/${encodeURIComponent(packageName)}/${set}`;
  const info = await api.reporting(app);
  const hourly = (info.freshnessInfo?.freshnesses ?? []).find(
    (f: any) => f.aggregationPeriod === "HOURLY",
  );
  invariant(
    hourly?.latestEndTime,
    "VITALS_FRESHNESS",
    "Android vitals has no hourly data for this app yet.",
  );
  const end = toDate(hourly.latestEndTime);
  const start = new Date(end.getTime() - 24 * 3600 * 1000);
  const response = await api.reporting(`${app}:query`, {
    timelineSpec: {
      aggregationPeriod: "HOURLY",
      startTime: fromDate(start),
      endTime: fromDate(end),
    },
    dimensions: ["versionCode"],
    metrics: [rate, "distinctUsers"],
    filter: `versionCode = ${Number(versionCode)}`,
    pageSize: 100,
  });
  let users = 0,
    weighted = 0;
  for (const row of response.rows ?? []) {
    const value = (name: string) =>
      Number(
        row.metrics?.find((m: any) => m.metric === name)?.decimalValue?.value ??
          NaN,
      );
    const n = value("distinctUsers"),
      r = value(rate);
    if (!Number.isFinite(n) || !Number.isFinite(r)) continue;
    users += n;
    weighted += n * r;
  }
  return {
    // Play reports rates as fractions of users; the guard works in percent.
    rate: users ? (weighted / users) * 100 : undefined,
    users,
    through: end.toISOString(),
  };
}

export async function readVitals(
  api: GoogleAPI,
  packageName: string,
  versionCode: string,
): Promise<Vitals> {
  const [crash, anr] = await Promise.all([
    metric(
      api,
      packageName,
      "crashRateMetricSet",
      "userPerceivedCrashRate",
      versionCode,
    ),
    metric(
      api,
      packageName,
      "anrRateMetricSet",
      "userPerceivedAnrRate",
      versionCode,
    ),
  ]);
  return {
    versionCode,
    crashRate: crash.rate,
    anrRate: anr.rate,
    users: Math.max(crash.users, anr.users),
    through: crash.through,
  };
}

/** Why a rollout should halt, or undefined while it's healthy or too early to tell. */
export function verdict(guard: RolloutGuard, vitals: Vitals) {
  if (!guard.enabled || vitals.users < guard.minUsers) return undefined;
  const fmt = (n: number) => `${Math.round(n * 100) / 100}%`;
  if (vitals.crashRate !== undefined && vitals.crashRate > guard.maxCrashRate)
    return `user-perceived crash rate ${fmt(vitals.crashRate)} is over ${fmt(guard.maxCrashRate)}`;
  if (vitals.anrRate !== undefined && vitals.anrRate > guard.maxAnrRate)
    return `user-perceived ANR rate ${fmt(vitals.anrRate)} is over ${fmt(guard.maxAnrRate)}`;
  return undefined;
}

// ---------- App Store phased release ----------

export type PhasedState = "INACTIVE" | "ACTIVE" | "PAUSED" | "COMPLETE";
export interface PhasedRelease {
  id?: string;
  state?: PhasedState;
  day?: number;
  startDate?: string;
}

export async function readPhasedRelease(
  api: AppleAPI,
  versionId: string,
): Promise<PhasedRelease> {
  const data = await api
    .request(`/appStoreVersions/${versionId}/appStoreVersionPhasedRelease`)
    .then((r) => r.data)
    .catch((error) => {
      if (/APPLE_404/.test(error?.code ?? "")) return undefined;
      throw error;
    });
  if (!data) return {};
  return {
    id: data.id,
    state: data.attributes?.phasedReleaseState,
    day: data.attributes?.currentDayNumber ?? undefined,
    startDate: data.attributes?.startDate ?? undefined,
  };
}

/**
 * Starts (on a version not yet released, it begins when the version does),
 * pauses, resumes or completes a 7-day phased release.
 */
export async function setPhasedRelease(
  api: AppleAPI,
  versionId: string,
  state: PhasedState,
) {
  const current = await readPhasedRelease(api, versionId);
  if (!current.id) {
    invariant(
      state === "INACTIVE" || state === "ACTIVE",
      "PHASED_RELEASE",
      "Turn on phased release before pausing or completing it.",
    );
    const created = (
      await api.request("/appStoreVersionPhasedReleases", "POST", {
        data: {
          type: "appStoreVersionPhasedReleases",
          attributes: { phasedReleaseState: state },
          relationships: {
            appStoreVersion: {
              data: { type: "appStoreVersions", id: versionId },
            },
          },
        },
      })
    ).data;
    return { id: created.id, state };
  }
  if (current.state === state) return current;
  await api.request(`/appStoreVersionPhasedReleases/${current.id}`, "PATCH", {
    data: {
      type: "appStoreVersionPhasedReleases",
      id: current.id,
      attributes: { phasedReleaseState: state },
    },
  });
  return { ...current, state };
}

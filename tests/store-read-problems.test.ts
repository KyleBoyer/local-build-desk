import { it, expect } from "vitest";
import { DeskError } from "../src/core/errors";
import { storeReadProblem } from "../src/core/store-read-problems";
it.each([
  [
    "Apple 403: The relationship betaGroups does not allow GET_RELATED",
    "apple",
    "request",
    "signing in again will not fix",
  ],
  [
    "Apple 401: Authentication credentials are missing or invalid",
    "apple",
    "credentials",
    "API key",
  ],
  ["Apple 403: permission denied", "apple", "permission", "role"],
  [
    "Google Play 401: invalid_grant",
    "google",
    "credentials",
    "service-account key",
  ],
  [
    "Google Play 403: permission denied",
    "google",
    "permission",
    "Play Console",
  ],
  ["Apple 429: too many requests", "apple", "temporary", "Wait a minute"],
  ["Apple 503: unavailable", "apple", "temporary", "internet connection"],
  ["fetch failed", "apple", "temporary", "internet connection"],
  ["Unexpected payload", "apple", "request", "technical details"],
] as const)(
  "classifies %s without treating all store errors as expired logins",
  (message, provider, kind, remedy) => {
    const issue = storeReadProblem(Error(message), provider, "Testing groups");
    expect(issue).toMatchObject({
      area: "Testing groups",
      kind,
      diagnostic: message,
    });
    expect(issue.action).toContain(remedy);
  },
);
it("recognizes a removed credential before contacting either provider", () => {
  expect(
    storeReadProblem(
      new DeskError(
        "CREDENTIAL_MISSING",
        "The selected credential no longer exists.",
      ),
    ),
  ).toMatchObject({ kind: "credentials" });
});

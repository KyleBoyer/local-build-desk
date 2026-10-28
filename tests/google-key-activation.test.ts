import { it, expect } from "vitest";
import { shouldRetryGoogleKeyActivation } from "../src/main/google-key-activation";
it("retries only temporary failures during a bounded new-key activation window", () => {
  const now = 1000000;
  expect(
    shouldRetryGoogleKeyActivation(
      Error("Google authentication failed: Invalid JWT Signature."),
      now - 60000,
      now,
    ),
  ).toBe(true);
  expect(
    shouldRetryGoogleKeyActivation(Error("fetch failed"), now - 120000, now),
  ).toBe(true);
  for (const at of [undefined, now - 180000, now + 1])
    expect(
      shouldRetryGoogleKeyActivation(Error("Invalid JWT Signature"), at, now),
    ).toBe(false);
  expect(
    shouldRetryGoogleKeyActivation(Error("account disabled"), now - 1, now),
  ).toBe(false);
  expect(
    shouldRetryGoogleKeyActivation(
      Error("Google Play 403: permissions required"),
      now - 1,
      now,
    ),
  ).toBe(false);
});

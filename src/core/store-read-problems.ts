import type { StoreReadProblem } from "./store-release-types";
/** Read failures need different remedies: web login never repairs an API-key role. */
export function storeReadProblem(
  error: unknown,
  provider: "apple" | "google" = "apple",
  area = "Store data",
): StoreReadProblem {
  const diagnostic = error instanceof Error ? error.message : String(error),
    code = (error as { code?: string } | null)?.code ?? "",
    name = provider === "apple" ? "Apple" : "Google Play";
  const result = (
    kind: StoreReadProblem["kind"],
    message: string,
    action: string,
  ): StoreReadProblem => ({ area, kind, message, action, diagnostic });
  if (
    /GET_RELATED|does not allow|unsupported (?:operation|relationship)|not a valid relationship/i.test(
      diagnostic,
    )
  )
    return result(
      "request",
      `${name} does not support this data request.`,
      "Update Local Build Desk on your Mac and retry. If it persists, report the technical details below; signing in again will not fix this request.",
    );
  if (
    /CREDENTIAL_(?:REQUIRED|MISSING|TYPE)|selected credential no longer exists|select a .*credential/i.test(
      code + " " + diagnostic,
    )
  )
    return result(
      "credentials",
      `The ${name} connection needs credentials.`,
      `On your Mac, open Connections and connect ${provider === "apple" ? "an App Store Connect team API key" : "a Google Play service account"} for this project, then refresh here.`,
    );
  if (
    /(?:Apple|Google Play|HTTP)\s*401\b|invalid_grant|invalid_client|invalid_jwt|unauthenticated|expired.*(?:key|token|credential)/i.test(
      diagnostic,
    )
  )
    return result(
      "credentials",
      `${name} rejected the saved API credentials.`,
      provider === "apple"
        ? "On your Mac, open Connections → Apple and reconnect or replace the App Store Connect API key. Signing into Apple's website alone does not repair this API connection."
        : "On your Mac, open Connections → Google Play and reconnect or replace the service-account key. Check that the key is still active; signing into Google in a browser alone does not repair it.",
    );
  if (
    /(?:Apple|Google Play|HTTP)\s*403\b|permission.denied|insufficient.*permission/i.test(
      diagnostic,
    )
  )
    return result(
      "permission",
      `The ${name} connection does not have permission to read this data.`,
      provider === "apple"
        ? "Check this API key’s role and access to the app in App Store Connect, then reconnect it in Connections on your Mac if needed. This is an API permission issue, not an expired website sign-in."
        : "Check the service account’s app access in Play Console and that the Google Play Developer API is enabled, then refresh. Signing into Google again does not grant the service account access.",
    );
  if (/429\b|rate.limit|too many requests/i.test(diagnostic))
    return result(
      "temporary",
      `${name} is limiting requests.`,
      "Wait a minute, then refresh. Your credentials do not need to change.",
    );
  if (
    /\b5\d\d\b|fetch failed|network|timed? ?out|ECONN|ENOTFOUND|abort/i.test(
      diagnostic,
    )
  )
    return result(
      "temporary",
      `${name} could not be reached or returned a temporary error.`,
      "Check your Mac’s internet connection and retry. Saved data, if shown, may be out of date.",
    );
  return result(
    "request",
    `${area} could not be read.`,
    "Refresh to retry. If this continues, open the store console or check the technical details below on your Mac.",
  );
}

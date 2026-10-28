import { messageOf } from "../core/errors";

// Google documents a propagation delay after creating service-account keys.
// Only retry fresh-key activation failures, never regenerate a key on failure.
export function shouldRetryGoogleKeyActivation(
  error: unknown,
  importedAt?: number,
  now = Date.now(),
) {
  if (!importedAt || now < importedAt || now - importedAt >= 180000)
    return false;
  return /Invalid JWT Signature|temporarily unavailable|fetch failed|network|timed? ?out|timeout/i.test(
    messageOf(error),
  );
}

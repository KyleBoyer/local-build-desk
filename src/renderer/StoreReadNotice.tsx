import { storeReadProblem } from "../core/store-read-problems";
import type { StoreReadProblem } from "../core/store-release-types";
export function StoreReadNotice({
  issue,
  error,
  provider = "apple",
  area,
  mobile = false,
}: {
  issue?: StoreReadProblem;
  error?: string;
  provider?: "apple" | "google";
  area?: string;
  mobile?: boolean;
}) {
  const problem =
    issue ?? storeReadProblem(error ?? "Unknown error", provider, area);
  return (
    <section
      role="alert"
      className={mobile ? "m-read-notice" : "store-read-notice"}
    >
      <strong>
        {problem.area}:{" "}
        {problem.kind === "credentials"
          ? "connection needed"
          : problem.kind === "permission"
            ? "permission needed"
            : problem.kind === "temporary"
              ? "temporarily unavailable"
              : "could not load"}
      </strong>
      <p>{problem.message}</p>
      <p>{problem.action}</p>
      {problem.diagnostic && (
        <details>
          <summary>Technical details</summary>
          <pre>{problem.diagnostic}</pre>
        </details>
      )}
    </section>
  );
}

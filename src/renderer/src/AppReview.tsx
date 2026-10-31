import { useState } from "react";
import { ExternalLink, LogIn, MessageSquareWarning } from "lucide-react";
import type { AppReviewInfo } from "../../core/store-release-types";
import {
  reviewReasonText,
  reviewThreadIsRejection,
  reviewThreadTitle,
} from "../../core/app-review-labels";

const date = (value?: string) =>
  value ? new Date(value).toLocaleString() : undefined;

/** App Review's Resolution Center messages for one App Store version. */
export function AppReview({
  review,
  onSignedIn,
  onOpenConsole,
}: {
  review: AppReviewInfo;
  /** Reload the release once the App Store Connect sign-in finishes. */
  onSignedIn: () => void;
  onOpenConsole: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const signIn = async () => {
    setBusy(true);
    setError("");
    try {
      await window.desk.signInAppStoreConnect();
      onSignedIn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="app-review" aria-labelledby="app-review-heading">
      <div className="app-review-heading">
        <h4 id="app-review-heading">
          <MessageSquareWarning size={14} />
          App Review
        </h4>
        <button className="button" onClick={onOpenConsole}>
          <ExternalLink size={13} />
          Reply in App Store Connect
        </button>
      </div>
      {!review.signedIn ? (
        <div className="app-review-signin">
          <p>
            Apple only shows App Review's messages to a signed-in App Store
            Connect session. Sign in once and they'll appear here and in the
            mobile monitor.
          </p>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void signIn()}
          >
            <LogIn size={13} />
            {busy ? "Waiting for sign-in…" : "Sign in to App Store Connect"}
          </button>
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
        </div>
      ) : review.error ? (
        <p role="alert" className="inline-error">
          {review.error}
        </p>
      ) : !review.threads.length ? (
        <p className="muted">No App Review messages for this version.</p>
      ) : (
        review.threads.map((thread) => (
          <article
            key={thread.id}
            className={`app-review-thread${reviewThreadIsRejection(thread) ? " rejection" : ""}`}
          >
            <header>
              <strong>{reviewThreadTitle(thread)}</strong>
              <small>
                {date(thread.lastActivityAt ?? thread.createdAt)}
                {thread.state
                  ? ` · ${thread.state.replaceAll("_", " ").toLowerCase()}`
                  : ""}
              </small>
            </header>
            {thread.reasons.length > 0 && (
              <ul className="app-review-reasons">
                {thread.reasons.map((reason, i) => (
                  <li key={i}>{reviewReasonText(reason)}</li>
                ))}
              </ul>
            )}
            {thread.messages.map((message) => (
              <div
                key={message.id}
                className={`app-review-message${message.fromApple ? " apple" : ""}`}
              >
                <small>
                  {message.from ?? "Message"}
                  {message.createdAt ? ` · ${date(message.createdAt)}` : ""}
                </small>
                <p>{message.body || "(No text)"}</p>
                {message.attachments > 0 && (
                  <small className="muted">
                    {message.attachments === 1
                      ? "1 attachment"
                      : `${message.attachments} attachments`}{" "}
                    — open App Store Connect to view.
                  </small>
                )}
              </div>
            ))}
            {thread.error && <p className="inline-error">{thread.error}</p>}
          </article>
        ))
      )}
      <p className="muted app-review-checked">
        Read from App Store Connect · {date(review.checkedAt)}
      </p>
    </section>
  );
}

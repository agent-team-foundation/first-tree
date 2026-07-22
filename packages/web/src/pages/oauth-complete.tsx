import { safeRedirectPath } from "@first-tree/shared";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  authProviderForCallbackPath,
  finishAuthAttempt,
  normalizeAuthFailureReason,
  normalizeAuthJoinPath,
} from "../auth/auth-analytics.js";
import { useAuth } from "../auth/auth-context.js";
import { consumeBootstrapAuthFragment } from "../auth/bootstrap-fragment.js";
import { markOnboardingResume } from "../utils/onboarding-flags.js";

/**
 * Friendly copy for the `#error=<code>` fragment the server's GitHub
 * callback redirects to on failure (it is a full-page browser navigation,
 * so a raw JSON error would strand the user on the API URL). Codes are
 * minted in `packages/server/src/api/auth/github.ts` — keep in sync.
 */
const CALLBACK_ERROR_COPY: Record<string, string> = {
  "state-expired": "This authentication request took too long or was already used. Head back and start again.",
  "provider-denied": "GitHub authorization was canceled. Head back and start again when you're ready.",
  "provider-not-configured": "This sign-in provider is not configured on this First Tree deployment.",
  "provider-exchange-failed": "The sign-in provider did not accept the authentication handshake. Try again.",
  "identity-conflict": "That external account already belongs to another First Tree user.",
  "identity-mismatch": "You selected a different external account. Start again with the connected account.",
  "last-provider": "Connect another sign-in method before disconnecting this one.",
  "github-exchange-failed": "GitHub didn't accept the sign-in handshake. Head back and try again in a moment.",
  "install-not-admin":
    "The GitHub App was installed, but connecting it needs an admin of the First Tree team it was started from. Ask a team admin to finish the connection from Settings → GitHub.",
  "install-not-verified":
    "The GitHub App install couldn't be verified, so nothing was connected to your team. Start the install again from the app.",
  "install-bind-failed":
    "The GitHub App was installed, but it couldn't be connected to your team — it may already be connected to a different team. Try again from Settings → GitHub.",
  "invite-invalid": "This invitation link is no longer valid. Ask your team for a fresh invite.",
  "invite-not-allowed": "This invitation isn't allowed on this server.",
  "invite-required": "This server requires an invitation link to join. Ask your team for an invite.",
  "membership-unresolved": "Sign-in did not complete. Please try again.",
};

/**
 * Consumes the `#access=…&refresh=…&next=…` fragment that the server
 * appends after a successful GitHub callback — or the `#error=<code>`
 * fragment it appends on failure. The fragment is ideal here:
 *   - browsers do NOT include it in the Referer header
 *   - it never enters server-side request logs
 *   - SPA can `replaceState` to wipe it from the URL bar
 *
 * Redirect targets are filtered through the same `safeRedirectPath` regex
 * the server uses, defense-in-depth against a tampered fragment.
 */
export function OAuthCompletePage() {
  const navigate = useNavigate();
  const { adoptTokens, selectOrganization } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [errorNext, setErrorNext] = useState<string>("/");
  const processedRef = useRef(false);

  useEffect(() => {
    // React StrictMode intentionally re-runs effects in development. OAuth
    // completion mutates auth state and emits conversion events, so consume
    // this callback exactly once per page mount.
    if (processedRef.current) return;
    processedRef.current = true;

    // Production captured and removed this fragment before evaluating the
    // App/Sentry/analytics import graph. The location fallback keeps isolated
    // component tests and old embedded shells recoverable, and is scrubbed
    // before any value is parsed or adopted.
    const captured = consumeBootstrapAuthFragment() ?? window.location.hash;
    if (window.location.hash) {
      const search = typeof window.location.search === "string" ? window.location.search : "";
      window.history.replaceState(null, "", `${window.location.pathname}${search}`);
    }
    const hash = captured.startsWith("#") ? captured.slice(1) : captured;
    const params = new URLSearchParams(hash);
    const accessToken = params.get("access");
    const refreshToken = params.get("refresh");
    const next = safeRedirectPath(params.get("next"));
    const joinPath = params.get("joinPath");
    // The org this callback resolved to. We activate it only when the server
    // flags it as a *deliberate* destination via `orgPinned=1` — an invite
    // link, a fresh solo signup, or an App-install target. A plain returning
    // sign-in carries no pin: fetchMe restores the org the user last used.
    // (We can't key off `joinPath` here — an install-return keeps
    // joinPath="returning" yet still pins a specific org.)
    const org = params.get("org");
    const orgPinned = params.get("orgPinned") === "1";
    const errorCode = params.get("error");
    const provider = authProviderForCallbackPath(window.location.pathname);
    const accountCreatedRaw = params.get("accountCreated");
    const accountCreated = accountCreatedRaw === "1" ? true : accountCreatedRaw === "0" ? false : null;
    const callbackIntent = params.get("callbackIntent");
    // Legacy sign-in callbacks have no explicit intent. New callbacks name
    // it; authenticated App-install and identity-management completions must
    // not consume or fabricate acquisition attempts.
    const shouldReportAuth = callbackIntent === null || callbackIntent === "sign-in";

    if (errorCode) {
      if (shouldReportAuth)
        finishAuthAttempt({
          provider,
          result: "failed",
          next,
          joinPath: normalizeAuthJoinPath(joinPath),
          reasonCode: normalizeAuthFailureReason(errorCode),
          accountCreated,
        });
      setError(CALLBACK_ERROR_COPY[errorCode] ?? "Sign-in did not complete. Please try again.");
      setErrorNext(next);
      return;
    }

    if (!accessToken || !refreshToken) {
      if (shouldReportAuth)
        finishAuthAttempt({
          provider,
          result: "failed",
          next,
          joinPath: normalizeAuthJoinPath(joinPath),
          reasonCode: "missing_tokens",
          accountCreated,
        });
      setError("Sign-in did not complete. Please try again.");
      return;
    }

    // Stash the join path so the onboarding modal can pick context-aware copy
    // ("solo" vs "invite") on its first render. sessionStorage scope is
    // intentional — onboarding is a one-shot, and the flag is consumed and
    // cleared by the provider once it has used it.
    if (joinPath === "solo" || joinPath === "invite") {
      markOnboardingResume(joinPath);
    }

    void (async () => {
      try {
        await adoptTokens({ accessToken, refreshToken });
        // Activate the resolved org BEFORE navigating only when the server pinned
        // it (deliberate join / install-return), so the workspace/onboarding gate
        // evaluates against the just-joined org. For a plain returning sign-in we
        // skip it: adoptTokens → fetchMe already restored the user's last-used org
        // (falling back to the server default when there's no valid one), and
        // selecting here would clobber it.
        if (org && orgPinned) await selectOrganization(org);
        if (shouldReportAuth)
          finishAuthAttempt({
            provider,
            result: "success",
            next,
            joinPath: normalizeAuthJoinPath(joinPath),
            accountCreated,
          });
        navigate(next, { replace: true });
      } catch {
        if (shouldReportAuth)
          finishAuthAttempt({
            provider,
            result: "failed",
            next,
            joinPath: normalizeAuthJoinPath(joinPath),
            reasonCode: "session_bootstrap_failed",
            accountCreated,
          });
        setError("Sign-in completed, but First Tree couldn't open your workspace. Please try again.");
        setErrorNext(next);
      }
    })();
  }, [adoptTokens, selectOrganization, navigate]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex max-w-md flex-col items-center gap-4 px-6 text-center">
          <p className="text-body text-muted-foreground">{error}</p>
          <a className="text-body text-primary underline underline-offset-4" href={errorNext}>
            Back to First Tree
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-body text-muted-foreground">
      Signing you in…
    </div>
  );
}

import type { CapabilityEntry, RuntimeAuthLastError, RuntimeProvider } from "@first-tree/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { startRuntimeAuth } from "../../../../api/activity.js";
import { Button } from "../../../../components/ui/button.js";
import { PROVIDER_LABEL } from "./providers.js";
import { deriveRuntimeAuthView, runtimeAuthIsPending } from "./runtime-auth-view.js";

/** While a login is in flight, re-poll capabilities this often. */
const AUTH_POLL_MS = 3000;

/**
 * Backstop for the local "starting" latch: if neither a pending marker nor a
 * terminal failure ever arrives after a click (e.g. the daemon went silent
 * mid-flight), release the latch so the Connect button doesn't stay disabled
 * forever. In the common path the latch clears far sooner — as soon as the
 * daemon publishes `pendingAuth` or records a failure.
 */
const STARTING_LATCH_MS = 30_000;

/**
 * In-product runtime-auth controls for a provider card: a "Connect" button that
 * starts the daemon-side login, then a progress panel while one is in flight —
 * "finish in your browser" for the browser-OAuth path, with a fallback link if
 * the host browser does not auto-open. Probe-driven: the in-flight login rides
 * `entry.pendingAuth` and a terminal failure rides `entry.lastAuthError`, so the
 * panel reflects polled capabilities.
 *
 * A local "starting" latch bridges the gap between the start POST settling and
 * the daemon publishing `pendingAuth`: without it the button flips straight back
 * to a live "Connect" with no feedback, and a second click re-fires the login.
 * The latch also kicks off the fast poll immediately, instead of waiting for a
 * pending marker to first appear via the slower background refresh.
 *
 * `onStarted` lets a host that does NOT use the `["clients"]` react-query cache
 * (the new-agent dialog polls capabilities into local state) refresh on the same
 * cadence; card surfaces omit it and rely on the query invalidation.
 */
export function RuntimeAuthControls({
  clientId,
  provider,
  entry,
  onStarted,
}: {
  clientId: string;
  provider: RuntimeProvider;
  entry: CapabilityEntry | null;
  onStarted?: () => void;
}) {
  const queryClient = useQueryClient();
  const view = deriveRuntimeAuthView(provider, entry, Date.now());

  // Stable handle to the latest `onStarted` so the poll effect doesn't resubscribe
  // when a host passes a fresh inline callback each render.
  const onStartedRef = useRef(onStarted);
  onStartedRef.current = onStarted;

  // Local latch: the wall-clock instant of the last successful start.
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const start = useMutation({
    mutationFn: () => startRuntimeAuth(clientId, { provider }),
    onSuccess: () => setStartedAt(Date.now()),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["clients"] });
      onStartedRef.current?.();
    },
  });

  const pending = runtimeAuthIsPending(view); // browser-pending observed in caps
  const lastError = view.kind === "connectable" ? view.lastError : undefined;
  const failureAt = lastError ? Date.parse(lastError.at) : null;
  // A failure recorded at/after our click is the terminal signal for this attempt.
  const failedSinceStart = startedAt !== null && failureAt !== null && failureAt >= startedAt;
  // Hold the latch until a terminal signal lands (pending observed, this attempt
  // failed) or the backstop elapses.
  const latched = startedAt !== null && !pending && !failedSinceStart && Date.now() - startedAt < STARTING_LATCH_MS;

  // Drop the latch as soon as a terminal signal lands, so the common path never
  // waits on the backstop timer.
  useEffect(() => {
    if (startedAt === null) return;
    if (pending || failedSinceStart) setStartedAt(null);
  }, [startedAt, pending, failedSinceStart]);

  // Poll while a login is in flight — start immediately on the latch, not only
  // once `pendingAuth` is observed (which would otherwise depend on a slower
  // background refresh to ever appear in the first place).
  const polling = latched || pending;
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ["clients"] });
      onStartedRef.current?.();
    }, AUTH_POLL_MS);
    return () => clearInterval(id);
  }, [polling, queryClient]);

  if (view.kind === "none") return null;
  const label = PROVIDER_LABEL[provider];

  // In flight: either the daemon published `pendingAuth` (observed) or we just
  // started and are bridging the gap (latched). Same "finish in your browser"
  // state; the fallback link only exists once the URL has been parsed.
  if (pending || latched) {
    const authUrl = view.kind === "browser-pending" ? view.authUrl : undefined;
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
        <div className="text-body font-medium">{label}</div>
        <p className="text-caption" style={{ color: "var(--fg-3)", margin: 0 }}>
          A sign-in page is opening in your browser on this computer. Finish there — this updates automatically.
        </p>
        {authUrl && (
          <a
            href={authUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-caption font-medium"
            style={{ color: "var(--primary)", wordBreak: "break-all" }}
          >
            Didn't open? Open the sign-in page →
          </a>
        )}
        <p className="text-caption" style={{ color: "var(--fg-3)", margin: 0 }}>
          Waiting for you to authorize…
        </p>
      </div>
    );
  }

  // Connectable: offer Connect, plus a notice when the previous attempt failed.
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
      <div className="text-body font-medium">{label}</div>
      <p className="text-caption" style={{ color: "var(--fg-3)", margin: 0 }}>
        Sign in with your subscription in your browser — no separate CLI install. A sign-in page opens on this computer.
      </p>
      {lastError && (
        <p className="text-caption" style={{ color: "var(--state-error)", margin: 0 }}>
          {runtimeAuthErrorCopy(lastError)}
        </p>
      )}
      <div>
        <Button variant="outline" size="sm" disabled={start.isPending} onClick={() => start.mutate()}>
          {start.isPending ? "Starting…" : lastError ? `Try ${label} again` : `Connect ${label}`}
        </Button>
      </div>
      {start.isError && (
        <p className="text-caption" style={{ color: "var(--state-error)", margin: 0 }}>
          Could not start sign-in. Make sure this computer is online, then retry.
        </p>
      )}
    </div>
  );
}

/**
 * One-line, user-facing copy for a terminal in-product login failure. The
 * provider's raw message is appended (truncated) for the actionable cases since
 * it often names the real cause ("account not authorized", a callback error).
 */
function runtimeAuthErrorCopy(e: RuntimeAuthLastError): string {
  const base =
    e.reason === "timeout"
      ? "Last sign-in timed out before it finished in the browser."
      : e.reason === "spawn-error"
        ? "Couldn't launch the sign-in on this computer."
        : e.reason === "aborted"
          ? "Last sign-in was canceled."
          : "Last sign-in didn't complete.";
  if (!e.message) return `${base} Try again.`;
  const detail = e.message.length > 140 ? `${e.message.slice(0, 139)}…` : e.message;
  return `${base} ${detail}`;
}

import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { startRuntimeAuth } from "../../../../api/activity.js";
import { Button } from "../../../../components/ui/button.js";
import { PROVIDER_LABEL } from "./providers.js";
import { deriveRuntimeAuthView, runtimeAuthIsPending } from "./runtime-auth-view.js";

/** While a login is in flight, re-poll capabilities this often. */
const AUTH_POLL_MS = 3000;

/**
 * In-product runtime-auth controls for a provider card: a "Connect" button that
 * starts the daemon-side login, then a progress panel while one is in flight —
 * "finish in your browser" for the browser-OAuth path, with a fallback link if
 * the host browser does not auto-open. Everything is probe-driven: the in-flight
 * login rides `entry.pendingAuth`, so the panel appears/clears purely from
 * polled capabilities, not local state.
 */
export function RuntimeAuthControls({
  clientId,
  provider,
  entry,
}: {
  clientId: string;
  provider: RuntimeProvider;
  entry: CapabilityEntry | null;
}) {
  const queryClient = useQueryClient();
  const view = deriveRuntimeAuthView(provider, entry, Date.now());

  const start = useMutation({
    mutationFn: () => startRuntimeAuth(clientId, { provider }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["clients"] });
    },
  });

  // Poll capabilities while a login is in flight so the card flips to connected
  // once the daemon completes login and re-probes.
  const pending = runtimeAuthIsPending(view);
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ["clients"] });
    }, AUTH_POLL_MS);
    return () => clearInterval(id);
  }, [pending, queryClient]);

  if (view.kind === "none") return null;
  const label = PROVIDER_LABEL[provider];

  if (view.kind === "connectable") {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
        <div className="text-body font-medium">{label}</div>
        <p className="text-caption" style={{ color: "var(--fg-3)", margin: 0 }}>
          Sign in with your subscription in your browser — no separate CLI install. A sign-in page opens on this
          computer.
        </p>
        <div>
          <Button variant="outline" size="sm" disabled={start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? "Starting…" : `Connect ${label}`}
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

  // browser OAuth in flight — the sign-in page opened on the host.
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
      <div className="text-body font-medium">{label}</div>
      <p className="text-caption" style={{ color: "var(--fg-3)", margin: 0 }}>
        A sign-in page opened in your browser on this computer. Finish there — this updates automatically.
      </p>
      {view.authUrl && (
        <a
          href={view.authUrl}
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

import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { startRuntimeAuth } from "../../../../api/activity.js";
import { Button } from "../../../../components/ui/button.js";
import { PROVIDER_LABEL } from "./providers.js";
import { deriveRuntimeAuthView, runtimeAuthIsPending } from "./runtime-auth-view.js";

/** While a device-code login is in flight, re-poll capabilities this often. */
const DEVICE_AUTH_POLL_MS = 3000;

/**
 * In-product runtime-auth controls for a provider card: a "Connect" button that
 * starts the daemon-side login, and a device-code panel while one is in flight.
 * Everything is probe-driven — the device code rides `entry.pendingDeviceAuth`,
 * so the panel appears/clears purely from polled capabilities, not local state.
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

  // Poll capabilities while a device-code login is in flight so the card flips
  // to connected once the daemon completes login and re-probes.
  const pending = runtimeAuthIsPending(view);
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ["clients"] });
    }, DEVICE_AUTH_POLL_MS);
    return () => clearInterval(id);
  }, [pending, queryClient]);

  if (view.kind === "none") return null;
  const label = PROVIDER_LABEL[provider];

  if (view.kind === "connectable") {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
        <div className="text-body font-medium">{label}</div>
        <p className="text-caption" style={{ color: "var(--fg-3)", margin: 0 }}>
          Sign in with your subscription — no separate CLI install. A one-time code appears here; finish on any device.
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

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
      <div className="text-body font-medium">{label}</div>
      <p className="text-caption" style={{ color: "var(--fg-3)", margin: 0 }}>
        Open this link on any device and enter the code:
      </p>
      <a
        href={view.verificationUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-label font-medium"
        style={{ color: "var(--primary)", wordBreak: "break-all" }}
      >
        {view.verificationUrl}
      </a>
      <div
        className="mono text-subtitle font-semibold"
        style={{
          letterSpacing: "0.18em",
          textAlign: "center",
          color: "var(--fg)",
          padding: "var(--sp-2_5)",
          background: "var(--bg-sunken)",
          border: "var(--hairline) solid var(--border-faint)",
          borderRadius: "var(--radius-input)",
        }}
      >
        {view.userCode}
      </div>
      <p className="text-caption" style={{ color: "var(--fg-3)", margin: 0 }}>
        Waiting for you to authorize…
      </p>
    </div>
  );
}

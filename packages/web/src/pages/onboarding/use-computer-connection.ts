import type { ClientCapabilities } from "@first-tree/shared";
import { useEffect, useRef, useState } from "react";
import { getClientCapabilities, type HubClient, listClients } from "../../api/activity.js";
import { api } from "../../api/client.js";
import { runVisibilityAwareInterval } from "../../lib/visibility-interval.js";

const CLIENT_DETECT_POLL_MS = 5_000;

/**
 * Watches for the user's computer coming online and figures out whether it
 * can host an AI teammate.
 *
 * Lifecycle (mirrors the proven logic from the legacy Step2Body):
 *   1. Mint a short-lived connect token + bootstrap command (the one-liner
 *      the user pastes into their terminal).
 *   2. Poll `listClients()`; the most-recently-seen connected client wins.
 *   3. Once a client is connected, fetch its capabilities to learn which AI
 *      runtimes are ready, and auto-pick the best one (Claude Code → Codex).
 *
 * Pure presentation state is returned; the React step renders it. Polling
 * pauses while the tab is hidden (`runVisibilityAwareInterval`) and stops
 * entirely when `enabled` is false.
 */
export type ComputerConnection = {
  connectedClient: HubClient | null;
  capabilitiesLoaded: boolean;
  okRuntimes: string[];
  selectedRuntime: string | null;
  setSelectedRuntime: (next: string | null) => void;
  /** The full multi-line command the user pastes into their terminal. */
  cliCommand: string | null;
  /** Non-null when minting the connect token failed. */
  tokenError: string | null;
};

function pickPreferredRuntime(caps: ClientCapabilities): string | null {
  const ok = (provider: string) => caps[provider]?.state === "ok";
  if (ok("claude-code")) return "claude-code";
  if (ok("codex")) return "codex";
  const first = Object.entries(caps).find(([, entry]) => entry.state === "ok");
  return first ? first[0] : null;
}

export function useComputerConnection(enabled: boolean): ComputerConnection {
  const [connectedClient, setConnectedClient] = useState<HubClient | null>(null);
  const [capabilities, setCapabilities] = useState<ClientCapabilities | null>(null);
  const [capabilitiesClientId, setCapabilitiesClientId] = useState<string | null>(null);
  const [selectedRuntime, setSelectedRuntime] = useState<string | null>(null);
  const [connectToken, setConnectToken] = useState<string | null>(null);
  const [connectTokenExpiresAt, setConnectTokenExpiresAt] = useState<number | null>(null);
  const [bootstrapCommand, setBootstrapCommand] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const capabilitiesClientIdRef = useRef<string | null>(null);
  const detectSeqRef = useRef(0);

  // Detect the connected computer + its capabilities.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const detect = async (): Promise<void> => {
      const seq = ++detectSeqRef.current;
      try {
        const clients = await listClients();
        if (cancelled || seq !== detectSeqRef.current) return;
        const connected = clients
          .filter((c) => c.status === "connected")
          .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
        const latest = connected[0] ?? null;
        setConnectedClient((prev) => (prev?.id === latest?.id ? prev : latest));
        if (latest) {
          if (capabilitiesClientIdRef.current !== latest.id) {
            capabilitiesClientIdRef.current = null;
            setCapabilitiesClientId(null);
            setCapabilities(null);
          }
          try {
            const withCaps = await getClientCapabilities(latest.id);
            if (cancelled || seq !== detectSeqRef.current) return;
            capabilitiesClientIdRef.current = latest.id;
            setCapabilitiesClientId(latest.id);
            setCapabilities(withCaps.capabilities);
          } catch {
            // transient — try again next tick
          }
        } else {
          capabilitiesClientIdRef.current = null;
          setCapabilitiesClientId(null);
          setCapabilities(null);
        }
      } catch {
        // best-effort
      }
    };
    const dispose = runVisibilityAwareInterval(detect, CLIENT_DETECT_POLL_MS);
    return () => {
      cancelled = true;
      dispose();
    };
  }, [enabled]);

  // Mint / refresh the connect token while no computer is connected yet.
  useEffect(() => {
    if (!enabled) return;
    if (connectedClient) return;
    if (connectToken && connectTokenExpiresAt && connectTokenExpiresAt > Date.now()) {
      const refreshAt = Math.max(connectTokenExpiresAt - Date.now(), 0);
      const handle = window.setTimeout(() => {
        setConnectToken(null);
        setConnectTokenExpiresAt(null);
      }, refreshAt);
      return () => window.clearTimeout(handle);
    }
    if (connectToken) {
      setConnectToken(null);
      setConnectTokenExpiresAt(null);
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.post<{ token: string; expiresIn: number; bootstrapCommand: string }>(
          "/me/connect-tokens",
          {},
        );
        if (!cancelled) {
          setConnectToken(r.token);
          setConnectTokenExpiresAt(Date.now() + r.expiresIn * 1000);
          setBootstrapCommand(r.bootstrapCommand);
          setTokenError(null);
        }
      } catch (err) {
        if (!cancelled) setTokenError(err instanceof Error ? err.message : "Failed to generate connect command");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, connectedClient, connectToken, connectTokenExpiresAt]);

  const activeCapabilities = connectedClient && capabilitiesClientId === connectedClient.id ? capabilities : null;

  // Auto-pick the preferred ready runtime; keep a still-valid prior choice.
  useEffect(() => {
    setSelectedRuntime((prev) => {
      if (!activeCapabilities) return prev;
      if (prev && activeCapabilities[prev]?.state === "ok") return prev;
      return pickPreferredRuntime(activeCapabilities);
    });
  }, [activeCapabilities]);

  const okRuntimes = activeCapabilities
    ? Object.entries(activeCapabilities)
        .filter(([, entry]) => entry.state === "ok")
        .map(([provider]) => provider)
    : [];

  const cliCommand =
    bootstrapCommand ?? (connectToken ? `npm install -g first-tree\nfirst-tree login ${connectToken}` : null);

  return {
    connectedClient,
    capabilitiesLoaded: activeCapabilities !== null,
    okRuntimes,
    selectedRuntime,
    setSelectedRuntime,
    cliCommand,
    tokenError,
  };
}

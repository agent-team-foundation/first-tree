import type { AgentVisibility } from "@first-tree/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { getAgentClientStatus } from "../../api/agent-config.js";
import { api, withOrg } from "../../api/client.js";
import { slugify } from "../../utils/agent-naming.js";

// Wait the full server-side offline window before surfacing the "still starting"
// state: a cold runtime (first claude-code/codex spawn, proxy-slow TLS) can take
// well past 30s to publish its first heartbeat, and the server itself doesn't
// consider an agent offline until 60s without one (presence reaper). Timing out
// at 30s told healthy-but-slow users their agent had failed; 60s matches the
// server's own liveness threshold so we only surface "taking longer" once the
// agent is genuinely late, not merely cold-starting.
const RUNTIME_READY_TIMEOUT_MS = 60_000;
const RUNTIME_READY_POLL_MS = 1_000;

export type AgentCreationPhase = "idle" | "creating" | "online" | "timeout";

export type CreateAgentArgs = {
  displayName: string;
  clientId: string;
  runtimeProvider: string;
  visibility: AgentVisibility;
  organizationId: string | null;
};

export type CreatedAgentInfo = {
  agentUuid: string;
  args: CreateAgentArgs;
};

export type AgentCreationFailure = {
  reasonCode: "agent_create_failed" | "agent_runtime_timeout";
  retryable: true;
};

export type UseAgentCreationOptions = {
  onCreated?: (info: CreatedAgentInfo) => void | Promise<void>;
  onOnline?: (uuid: string) => void;
  onFailure?: (failure: AgentCreationFailure) => void;
};

/**
 * Creates an agent (an unbound `agent` with caller-supplied
 * `visibility`) and waits for it to come online on the connected computer.
 *
 * Same two-phase shape the legacy Step2Body used: POST `/agents`, then poll
 * `client-status` until the runtime reports online (or a 60s timeout). The
 * hook is intentionally flow-agnostic: callers decide whether this is formal
 * onboarding, campaign quickstart, or another first-agent flow by wiring their
 * own side effects through `onCreated` and `onOnline`.
 */
export function useAgentCreation(options: UseAgentCreationOptions = {}) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<AgentCreationPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const createdRef = useRef<string | null>(null);
  const pollCancelRef = useRef<{ cancelled: boolean } | null>(null);
  const onCreatedRef = useRef(options.onCreated);
  const onOnlineRef = useRef(options.onOnline);
  const onFailureRef = useRef(options.onFailure);
  onCreatedRef.current = options.onCreated;
  onOnlineRef.current = options.onOnline;
  onFailureRef.current = options.onFailure;

  useEffect(
    () => () => {
      if (pollCancelRef.current) pollCancelRef.current.cancelled = true;
    },
    [],
  );

  const pollUntilReady = useCallback(async (agentUuid: string): Promise<void> => {
    if (pollCancelRef.current) pollCancelRef.current.cancelled = true;
    const token: { cancelled: boolean } = { cancelled: false };
    pollCancelRef.current = token;

    const startedAt = Date.now();
    while (!token.cancelled) {
      let online = false;
      try {
        const status = await getAgentClientStatus(agentUuid);
        if (token.cancelled) return;
        online = status.online === true;
      } catch {
        if (token.cancelled) return;
      }
      if (online) {
        setPhase("online");
        onOnlineRef.current?.(agentUuid);
        return;
      }
      if (Date.now() - startedAt > RUNTIME_READY_TIMEOUT_MS) {
        if (!token.cancelled) {
          setPhase("timeout");
          onFailureRef.current?.({ reasonCode: "agent_runtime_timeout", retryable: true });
        }
        return;
      }
      await new Promise((r) => setTimeout(r, RUNTIME_READY_POLL_MS));
    }
  }, []);

  const create = useCallback(
    async (args: CreateAgentArgs): Promise<void> => {
      const displayName = args.displayName.trim();
      if (!displayName) return;
      setError(null);
      setPhase("creating");
      const slug = slugify(displayName);
      let agentUuid: string;
      try {
        const res = await api.post<{ uuid: string }>(withOrg("/agents"), {
          type: "agent",
          displayName,
          ...(slug ? { name: slug } : {}),
          clientId: args.clientId,
          runtimeProvider: args.runtimeProvider,
          visibility: args.visibility,
          ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        });
        agentUuid = res.uuid;
        createdRef.current = agentUuid;
        await onCreatedRef.current?.({ agentUuid, args });
        await queryClient.invalidateQueries({ queryKey: ["agents"] });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add your agent to the team");
        setPhase("idle");
        onFailureRef.current?.({ reasonCode: "agent_create_failed", retryable: true });
        return;
      }
      await pollUntilReady(agentUuid);
    },
    [pollUntilReady, queryClient],
  );

  const retry = useCallback(async (): Promise<void> => {
    const agentUuid = createdRef.current;
    if (!agentUuid) return;
    setError(null);
    setPhase("creating");
    await pollUntilReady(agentUuid);
  }, [pollUntilReady]);

  return { phase, error, create, retry, createdUuid: createdRef.current };
}

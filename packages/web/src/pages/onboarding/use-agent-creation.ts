import type { AgentVisibility } from "@first-tree/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getAgentClientStatus } from "../../api/agent-config.js";
import { api, withOrg } from "../../api/client.js";
import { reportOnboardingEvent } from "../../api/onboarding-events.js";
import { slugify } from "../../utils/agent-naming.js";
import { writeOnboardingAgentUuid } from "../../utils/onboarding-flags.js";

const RUNTIME_READY_TIMEOUT_MS = 30_000;
const RUNTIME_READY_POLL_MS = 1_000;

export type AgentCreationPhase = "idle" | "creating" | "online" | "timeout";

export type CreateAgentArgs = {
  displayName: string;
  clientId: string;
  runtimeProvider: string;
  visibility: AgentVisibility;
  organizationId: string | null;
};

/**
 * Creates the first agent (an unbound `agent` with caller-supplied
 * `visibility`) and waits for it to come online on the connected computer.
 *
 * Same two-phase shape the legacy Step2Body used: POST `/agents`, then poll
 * `client-status` until the runtime reports online (or a 30s timeout). The
 * agent is created without any project binding — the kickoff step attaches
 * the source repo later, so a slow GitHub call can never block teammate
 * creation. On success, `onOnline(uuid)` fires once.
 */
export function useAgentCreation(onOnline: (uuid: string) => void) {
  const [phase, setPhase] = useState<AgentCreationPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const createdRef = useRef<string | null>(null);
  const pollCancelRef = useRef<{ cancelled: boolean } | null>(null);
  const onOnlineRef = useRef(onOnline);
  onOnlineRef.current = onOnline;

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
        onOnlineRef.current(agentUuid);
        return;
      }
      if (Date.now() - startedAt > RUNTIME_READY_TIMEOUT_MS) {
        if (!token.cancelled) setPhase("timeout");
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
        writeOnboardingAgentUuid(agentUuid);
        void reportOnboardingEvent("agent_created", { runtimeProvider: args.runtimeProvider });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create your agent");
        setPhase("idle");
        return;
      }
      await pollUntilReady(agentUuid);
    },
    [pollUntilReady],
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

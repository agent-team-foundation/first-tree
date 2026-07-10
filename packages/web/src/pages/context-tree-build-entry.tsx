import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { listManagedAgents, type ManagedAgent } from "../api/agents.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Select } from "../components/ui/select.js";
import { startChatErrorMessage } from "./onboarding/provision-tree.js";
import { startTreeSetupChat } from "./onboarding/tree-setup-chat.js";

type ContextTreeChatIntent = "build" | "recover";

/**
 * Opens the team's Context Tree setup chat. Source discovery belongs in that
 * chat: the Context tab does not require a GitHub App installation, enumerate
 * an installation's repositories, or write team repo resources before the
 * agent can inspect the real workspace and tree state.
 */
export function ContextTreeBuildEntry({ intent = "build" }: { intent?: ContextTreeChatIntent }) {
  const { organizationId } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedAgentUuid, setSelectedAgentUuid] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "opening">("idle");
  const [error, setError] = useState<string | null>(null);

  const agentsQuery = useQuery({
    queryKey: ["context-build", "managed-agents", organizationId],
    queryFn: listManagedAgents,
    enabled: !!organizationId,
  });

  const agents = useMemo<ManagedAgent[]>(
    () =>
      (agentsQuery.data ?? [])
        .filter(
          (agent) => agent.type !== "human" && agent.status === "active" && agent.organizationId === organizationId,
        )
        .sort((a, b) => b.uuid.localeCompare(a.uuid)),
    [agentsQuery.data, organizationId],
  );
  const chosenAgent = agents.find((agent) => agent.uuid === selectedAgentUuid) ?? agents[0];
  const actionLabel = intent === "build" ? "Build your Context Tree" : "Work on this in chat";

  const handleOpenChat = async (): Promise<void> => {
    if (!organizationId || !chosenAgent) return;
    setError(null);
    setPhase("opening");
    try {
      const chatId = await startTreeSetupChat({
        agent: chosenAgent,
        organizationId,
        queryClient,
      });
      navigate(`/?c=${encodeURIComponent(chatId)}`);
    } catch (err) {
      setError(startChatErrorMessage(err, "Couldn't open the Context Tree chat. Try again."));
      setPhase("idle");
    }
  };

  if (agentsQuery.isLoading) {
    return (
      <div className="text-label" style={{ color: "var(--fg-4)" }}>
        Loading…
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        <span className="text-body" style={{ color: "var(--fg-2)" }}>
          Create an agent for your team first, then continue in chat.
        </span>
        <div className="flex">
          <Button type="button" variant="cta" onClick={() => navigate("/onboarding")}>
            <span>Create an agent</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
      {agents.length > 1 ? (
        <div className="flex flex-col" style={{ gap: "var(--sp-1_5)" }}>
          <span className="text-label font-medium" style={{ color: "var(--fg-2)" }}>
            Which agent should help?
          </span>
          <Select
            aria-label="Agent for the Context Tree chat"
            value={chosenAgent?.uuid ?? ""}
            onChange={(value) => setSelectedAgentUuid(value || null)}
            options={agents.map((agent) => ({ value: agent.uuid, label: agentLabel(agent) }))}
          />
        </div>
      ) : null}
      {error ? (
        <div className="text-label" style={{ color: "var(--state-error)" }} role="alert">
          {error}
        </div>
      ) : null}
      <div className="flex">
        <Button type="button" variant="cta" disabled={phase === "opening"} onClick={() => void handleOpenChat()}>
          {phase === "opening" ? (
            <>
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span>Opening chat…</span>
            </>
          ) : (
            <>
              <span>{actionLabel}</span>
              <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function agentLabel(agent: ManagedAgent): string {
  return agent.displayName.trim() || agent.name?.trim() || agent.uuid;
}

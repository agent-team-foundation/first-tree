import type { Agent, AgentRuntimeConfig, RuntimeProvider, UpdateAgent } from "@first-tree/shared";
import { useOutletContext } from "react-router";
import type { ClientStatusInfo } from "../../api/agent-config.js";
import type { AgentConfigSaveController } from "./use-agent-config-save.js";

/**
 * Shared state passed from the agent-detail layout shell down to each tab via
 * `<Outlet context={...} />`. Tabs read it through `useAgentDetailContext()`.
 *
 * Lifecycle / bind / dialog state is owned by the layout (it survives tab
 * switches and feeds dialogs that overlay the whole page). Tabs only call
 * the imperatively-exposed handlers when they need to trigger one.
 */
export type AgentDetailContext = {
  uuid: string;
  agent: Agent;
  isHuman: boolean;
  canManageAgent: boolean;
  canEditConfig: boolean;

  // Plain navigate away from this agent's detail page. Every setting now saves
  // immediately, so there is no unsaved-draft leave guard — this is just
  // `navigate` exposed to controls that LEAVE the current agent (the switcher,
  // Usage deep links, "Manage in Settings", "Open Computers", Chat).
  navigateAway: (to: string) => void;

  // Config (shared across Runtime / Prompt) + its immediate-save controller.
  config: AgentRuntimeConfig | undefined;
  configLoading: boolean;
  configError: unknown;
  configSave: AgentConfigSaveController;

  // Computer binding (Runtime tab "Computer" panel)
  clientStatus: ClientStatusInfo | undefined;
  clientStatusLoading: boolean;
  clientStatusError: string | null;
  isUnclaimed: boolean;
  isOffline: boolean;
  boundClientLabel: string | null;
  /** The bound computer's own connection state (connected client row), distinct
   *  from agent presence; null when no computer is bound or it's unknown. */
  boundComputerOnline: boolean | null;
  setupRuntimeProvider: RuntimeProvider;
  onOpenBindDialog: () => void;
  bindClientPending: boolean;

  // Identity / Appearance (PATCH /agents/:uuid via dialog — saves immediately)
  saveIdentity: (patch: UpdateAgent) => Promise<void>;
  refreshAgent: () => Promise<void>;

  // Lifecycle (Profile tab bottom — suspend / reactivate / delete)
  suspendPending: boolean;
  reactivatePending: boolean;
  deletePending: boolean;
  dangerError: string | null;
  onSuspend: () => void;
  onReactivate: () => void;
  onDelete: () => void;
};

export function useAgentDetailContext(): AgentDetailContext {
  return useOutletContext<AgentDetailContext>();
}

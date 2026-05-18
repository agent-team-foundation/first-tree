import type {
  Agent,
  AgentRuntimeConfig,
  RuntimeProvider,
  UpdateAgent,
} from "@agent-team-foundation/first-tree-hub-shared";
import { useOutletContext } from "react-router";
import type { ClientStatusInfo } from "../../api/agent-config.js";
import type { UseConfigDraftResult } from "./use-config-draft.js";

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

  // Config + draft (shared across Setup / Prompt / Tools / Resources)
  draft: UseConfigDraftResult;
  config: AgentRuntimeConfig | undefined;
  configLoading: boolean;
  configError: unknown;

  // Computer binding (Setup tab "Bound computer" panel)
  clientStatus: ClientStatusInfo | undefined;
  clientStatusLoading: boolean;
  clientStatusError: string | null;
  isUnclaimed: boolean;
  isOffline: boolean;
  boundClientLabel: string | null;
  setupRuntimeProvider: RuntimeProvider;
  onOpenBindDialog: () => void;
  onOpenRebindDialog: () => void;
  bindClientPending: boolean;

  // Identity / Appearance (PATCH /agents/:uuid via dialog — bypasses SaveBar)
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

  // DryRun preview (Resources tab footer)
  dryRunText: string | null;
  dryRunPending: boolean;
  onRunDryRun: () => void;
};

export function useAgentDetailContext(): AgentDetailContext {
  return useOutletContext<AgentDetailContext>();
}

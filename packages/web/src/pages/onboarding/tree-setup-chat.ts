import type { LandingCampaignActionContext } from "@first-tree/shared";
import type { QueryClient } from "@tanstack/react-query";
import type { ManagedAgent } from "../../api/agents.js";
import { postOnboardingStartChat, postTreeSetupStartChat, reportOnboardingEvent } from "../../api/onboarding-events.js";
import type { TreeBindingPlan } from "./onboarding-flow.js";
import { ensureSourceReposRegistered } from "./provision-tree.js";

/**
 * Shared Context Tree setup-chat plumbing. Extracted from the onboarding
 * start-chat step so the build entry on the Context tab can reuse the
 * exact same "register repos → provision the binding → start the tree setup
 * chat" sequence — there is one build path, not a wizard-page copy of it.
 */

export type StartChatAgent = ManagedAgent;

export async function ensureStartChatRepos(
  organizationId: string | null,
  sourceRepos: readonly string[],
): Promise<void> {
  if (!organizationId || sourceRepos.length === 0) return;
  await ensureSourceReposRegistered(organizationId, sourceRepos);
}

export async function startOnboardingChat(args: {
  /** Only the uuid is sent; the narrow Pick lets the team-agent quick start
   *  pass a roster `Agent` (a teammate's org-visible agent) as well as the
   *  member's own `ManagedAgent`. */
  agent: Pick<StartChatAgent, "uuid">;
  bootstrap: string;
  /** The selected org — scopes the membership completion stamped by the server. */
  organizationId: string | null;
  /** Display title for the created chat. */
  topic: string;
  treeBindingPlan: TreeBindingPlan | "none";
  joinPath?: "invite";
  complete?: boolean;
  /**
   * Onboarding stamp written once the chat exists — supersedes `complete`
   * server-side. The team-agent quick start passes `"invitee_skip"`: suppress
   * auto-open only, never completion.
   */
  stamp?: "completed" | "invitee_skip" | "none";
  /** Funnel-event label override; defaults to the joinPath-derived type. */
  startChatType?: string;
  /** Campaign + repo pair used by both action entry paths for dedup. */
  campaignAction?: LandingCampaignActionContext;
}): Promise<string> {
  // Create-or-reuse the start-chat target and send the bootstrap in one idempotent
  // server call. First-chat paths can let the server stamp completion after the
  // user-facing chat exists.
  // A failure here surfaces to the caller rather than being swallowed.
  const { chatId } = await postOnboardingStartChat({
    ...(args.organizationId ? { organizationId: args.organizationId } : {}),
    agentUuid: args.agent.uuid,
    bootstrap: args.bootstrap,
    topic: args.topic,
    complete: args.complete,
    ...(args.stamp ? { stamp: args.stamp } : {}),
    ...(args.campaignAction ? { campaignAction: args.campaignAction } : {}),
  });
  void reportOnboardingEvent("kickoff_chat_started", {
    agentUuid: args.agent.uuid,
    chatId,
    treeBindingPlan: args.treeBindingPlan,
    startChatType: args.startChatType ?? (args.joinPath === "invite" ? "team-onboarding" : "onboarding"),
    ...(args.joinPath ? { joinPath: args.joinPath } : {}),
  });
  return chatId;
}

export async function startTreeSetupChat(args: {
  agent: StartChatAgent;
  organizationId: string;
  queryClient: QueryClient;
}): Promise<string> {
  args.queryClient.removeQueries({ queryKey: ["org-setting", args.organizationId, "context_tree"] });
  args.queryClient.removeQueries({ queryKey: ["onboarding", "context-tree", args.organizationId] });
  args.queryClient.removeQueries({ queryKey: ["me", "onboarding", "tree-setup-status", args.organizationId] });
  const { chatId } = await postTreeSetupStartChat({
    organizationId: args.organizationId,
    agentUuid: args.agent.uuid,
  });
  void reportOnboardingEvent("kickoff_chat_started", {
    agentUuid: args.agent.uuid,
    chatId,
    treeBindingPlan: "agentSeed",
    startChatType: "tree-setup",
  });
  args.queryClient.removeQueries({ queryKey: ["me", "onboarding", "tree-setup-status", args.organizationId] });
  return chatId;
}

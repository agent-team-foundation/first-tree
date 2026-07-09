import type { QueryClient } from "@tanstack/react-query";
import type { ManagedAgent } from "../../api/agents.js";
import { postOnboardingStartChat, postTreeSetupStartChat, reportOnboardingEvent } from "../../api/onboarding-events.js";
import { getContextTreeSetting } from "../../api/org-settings.js";
import { buildTreeSetupBootstrap } from "../workspace/center/onboarding/bootstrap-prose.js";
import type { TreeBindingPlan } from "./onboarding-flow.js";
import { ensureSourceReposRegistered, provisionNewTree } from "./provision-tree.js";

/**
 * Shared Context Tree setup-chat plumbing. Extracted from the onboarding
 * start-chat step so the standalone build entry on the Context tab can reuse the
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

async function ensureTreeBindingForSetup(args: {
  organizationId: string;
  treeBindingPlan: TreeBindingPlan;
  detectedTreeUrl: string | null;
}): Promise<string | null> {
  // Only `createBinding` provisions the tree server-side (Cloud one-click).
  // `agentSeed` (the build CTA default) and `useBoundTree` skip provisioning —
  // the agent sets the tree up — and here just resolve any existing binding URL
  // to pass as a hint; the agent (first-tree-seed) re-checks the real state.
  if (args.treeBindingPlan === "createBinding") {
    await provisionNewTree(args.organizationId);
  }
  const setting = await getContextTreeSetting(args.organizationId).catch(() => null);
  return setting?.repo ?? args.detectedTreeUrl;
}

export async function startOnboardingChat(args: {
  agent: StartChatAgent;
  bootstrap: string;
  /** The selected org — scopes the membership completion stamped by the server. */
  organizationId: string | null;
  /** Display title for the created chat. */
  topic: string;
  treeBindingPlan: TreeBindingPlan | "none";
  joinPath?: "invite";
  complete?: boolean;
  /** Production-scan fix conversion `owner/repo` — keys the launcher for dedup. */
  scanFixRepoSlug?: string;
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
    ...(args.scanFixRepoSlug ? { scanFixRepoSlug: args.scanFixRepoSlug } : {}),
  });
  void reportOnboardingEvent("kickoff_chat_started", {
    agentUuid: args.agent.uuid,
    chatId,
    treeBindingPlan: args.treeBindingPlan,
    startChatType: args.joinPath === "invite" ? "team-onboarding" : "onboarding",
    ...(args.joinPath ? { joinPath: args.joinPath } : {}),
  });
  return chatId;
}

export async function startTreeSetupChat(args: {
  agent: StartChatAgent;
  organizationId: string;
  sourceRepos: readonly string[];
  treeBindingPlan: TreeBindingPlan;
  detectedTreeUrl: string | null;
  queryClient: QueryClient;
  complete?: boolean;
}): Promise<string> {
  const treeUrl = await ensureTreeBindingForSetup({
    organizationId: args.organizationId,
    treeBindingPlan: args.treeBindingPlan,
    detectedTreeUrl: args.detectedTreeUrl,
  });
  args.queryClient.removeQueries({ queryKey: ["org-setting", args.organizationId, "context_tree"] });
  args.queryClient.removeQueries({ queryKey: ["onboarding", "context-tree", args.organizationId] });
  args.queryClient.removeQueries({ queryKey: ["me", "onboarding", "tree-setup-status", args.organizationId] });
  const { chatId } = await postTreeSetupStartChat({
    organizationId: args.organizationId,
    agentUuid: args.agent.uuid,
    bootstrap: buildTreeSetupBootstrap(args.sourceRepos, {
      treeBindingPlan: args.treeBindingPlan,
      treeUrl,
    }),
    topic: "Set up shared context",
    complete: args.complete,
  });
  void reportOnboardingEvent("kickoff_chat_started", {
    agentUuid: args.agent.uuid,
    chatId,
    treeBindingPlan: args.treeBindingPlan,
    startChatType: "tree-setup",
  });
  args.queryClient.removeQueries({ queryKey: ["me", "onboarding", "tree-setup-status", args.organizationId] });
  return chatId;
}

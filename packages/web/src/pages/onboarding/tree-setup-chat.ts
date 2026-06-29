import type { QueryClient } from "@tanstack/react-query";
import type { ManagedAgent } from "../../api/agents.js";
import { postOnboardingStartChat, reportOnboardingEvent, type StartChatKind } from "../../api/onboarding-events.js";
import { getContextTreeSetting } from "../../api/org-settings.js";
import { buildTreeSetupBootstrap } from "../workspace/center/onboarding/bootstrap-prose.js";
import type { TreeBindingPlan } from "./onboarding-flow.js";
import { ensureSourceReposRegistered, provisionNewTree } from "./provision-tree.js";

/**
 * Shared Context Tree setup-chat plumbing. Extracted from the onboarding
 * start-chat step so the standalone build entry on the Context tab can reuse the
 * exact same "register repos → provision the binding → start the `tree` setup
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
  /** "intro" = meet-only; "work" = value-first first chat; "tree" = Context Tree setup/update chat. */
  kind: StartChatKind;
  treeBindingPlan: TreeBindingPlan | "none";
  joinPath?: "invite";
  complete?: boolean;
}): Promise<string> {
  // Create-or-reuse the start-chat target and send the bootstrap in one idempotent
  // server call. Value-first work/intro paths can let the server stamp
  // completion after the user-facing chat exists; background tree setup passes
  // `complete: false` because it should not control the user's first-chat entry.
  // A failure here surfaces to the caller rather than being swallowed.
  const { chatId } = await postOnboardingStartChat({
    ...(args.organizationId ? { organizationId: args.organizationId } : {}),
    agentUuid: args.agent.uuid,
    bootstrap: args.bootstrap,
    kind: args.kind,
    complete: args.complete,
  });
  void reportOnboardingEvent("kickoff_chat_started", {
    agentUuid: args.agent.uuid,
    chatId,
    treeBindingPlan: args.treeBindingPlan,
    kind: args.kind,
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
  const chatId = await startOnboardingChat({
    agent: args.agent,
    bootstrap: buildTreeSetupBootstrap(args.sourceRepos, {
      treeBindingPlan: args.treeBindingPlan,
      treeUrl,
    }),
    organizationId: args.organizationId,
    kind: "tree",
    treeBindingPlan: args.treeBindingPlan,
    complete: args.complete,
  });
  args.queryClient.removeQueries({ queryKey: ["me", "onboarding", "tree-setup-status", args.organizationId] });
  return chatId;
}

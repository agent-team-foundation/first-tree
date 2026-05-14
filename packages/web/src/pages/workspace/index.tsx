import {
  type ChatEngagementView,
  type ChatSource,
  chatEngagementViewSchema,
  chatSourceSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router";
import { DocPreviewDrawer } from "../../components/doc-preview-drawer.js";
import { useAdminWs } from "../../hooks/use-admin-ws.js";
import { CenterPanel } from "./center/index.js";
import { OnboardingStepper } from "./center/onboarding-stepper.js";
import { ConversationList, DRAFT_CHAT_ID } from "./conversations/index.js";

/**
 * Workspace shell — chat-first. The left rail is `ConversationList`; the
 * center routes by `?c=<chatId>` (or the special `?c=draft` marker for
 * an inline new-chat draft). The conversation-list engagement tab is
 * also URL-backed via `?engagement=active|archived|all` (default `active`).
 *
 * Legacy URL compat:
 *   - `?a=<agentId>&c=<chatId>` redirects to `?c=<chatId>` (a is ignored).
 *   - `?a=<agentId>` (no chat) clears to `/` — agents are no longer the
 *     primary navigation key.
 */
const engagementViewParser = chatEngagementViewSchema.catch("active");
const sourceParser = chatSourceSchema.catch("manual");

export function WorkspacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedChatId = searchParams.get("c");
  const legacyAgentId = searchParams.get("a");
  const engagement: ChatEngagementView = engagementViewParser.parse(searchParams.get("engagement"));
  const source: ChatSource = sourceParser.parse(searchParams.get("source"));

  useAdminWs();

  // Legacy redirects: chat-first workspace navigates by `?c=` only.
  useEffect(() => {
    if (legacyAgentId && selectedChatId) {
      // `?a=&c=` → `?c=` — drop the agent hint, keep the chat.
      const next = new URLSearchParams(searchParams);
      next.delete("a");
      next.set("c", selectedChatId);
      setSearchParams(next, { replace: true });
      return;
    }
    if (legacyAgentId && !selectedChatId) {
      // `?a=` alone → `/` — agents aren't navigation targets.
      const next = new URLSearchParams(searchParams);
      next.delete("a");
      next.delete("c");
      setSearchParams(next, { replace: true });
    }
  }, [legacyAgentId, searchParams, selectedChatId, setSearchParams]);

  const selectChat = useCallback(
    (chatId: string) => {
      // Preserve the current `?engagement=` (and any other) param so
      // switching chats doesn't reset the user's filter context.
      const next = new URLSearchParams(searchParams);
      next.set("c", chatId);
      clearDocPreviewParams(next);
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const openDraft = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.set("c", DRAFT_CHAT_ID);
    clearDocPreviewParams(next);
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  const setEngagement = useCallback(
    (view: ChatEngagementView) => {
      const next = new URLSearchParams(searchParams);
      // Default value omitted from URL so the canonical home page stays `/`.
      if (view === "active") next.delete("engagement");
      else next.set("engagement", view);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const setSource = useCallback(
    (next: ChatSource) => {
      const params = new URLSearchParams(searchParams);
      // Default `manual` is the implicit value — keep it out of the URL so
      // `/` stays the canonical workspace entrypoint.
      if (next === "manual") params.delete("source");
      else params.set("source", next);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  return (
    <div className="flex flex-1 overflow-hidden">
      <ConversationList
        selectedChatId={selectedChatId}
        onSelectChat={selectChat}
        onNewChat={openDraft}
        engagement={engagement}
        onEngagementChange={setEngagement}
        source={source}
        onSourceChange={setSource}
      />

      <main className="flex-1 flex flex-col overflow-hidden min-w-0" style={{ background: "var(--bg)" }}>
        {/* Stepper sits above CenterPanel only, not above the rail
            (docs/new-user-onboarding-design.md §4.1). It self-renders
            nothing when the user has dismissed onboarding. */}
        <OnboardingStepper />
        <CenterPanel selectedChatId={selectedChatId} onSelectChat={selectChat} />
      </main>
      <DocPreviewDrawer />
    </div>
  );
}

function clearDocPreviewParams(params: URLSearchParams): void {
  params.delete("doc");
  params.delete("docChat");
  params.delete("docAgent");
  params.delete("docPath");
  params.delete("docBase");
}

import { type ChatEngagementView, chatEngagementViewSchema } from "@agent-team-foundation/first-tree-hub-shared";
import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router";
import { DocPreviewDrawer } from "../../components/doc-preview-drawer.js";
import { useAdminWs } from "../../hooks/use-admin-ws.js";
import { CenterPanel } from "./center/index.js";
import { OnboardingStepper } from "./center/onboarding-stepper.js";
import type { GroupMode } from "./conversations/group-rows.js";
import { ConversationList, DRAFT_CHAT_ID } from "./conversations/index.js";

/**
 * Workspace shell — chat-first. The left rail is `ConversationList`; the
 * center routes by `?c=<chatId>` (or the special `?c=draft` marker for
 * an inline new-chat draft). All rail UI state is URL-backed:
 *
 *   - `?engagement=active|archived|all` (default `active`)
 *   - `?unread=1` (default off) — filter to chats with unread mentions
 *   - `?watching=1` (default off) — filter to chats where user is watching
 *   - `?group=recency|source|none` (default `recency`) — list grouping
 *
 * Phase A does not consume the `?source=` URL param (the rail-header
 * source tab row was removed pending the Phase B filter popover);
 * a stray `?source=foo` in the URL is benign and ignored.
 *
 * Legacy URL compat:
 *   - `?a=<agentId>&c=<chatId>` redirects to `?c=<chatId>` (a is ignored).
 *   - `?a=<agentId>` (no chat) clears to `/` — agents are no longer the
 *     primary navigation key.
 */
const engagementViewParser = chatEngagementViewSchema.catch("active");

function parseGroup(raw: string | null): GroupMode {
  if (raw === "source" || raw === "none") return raw;
  return "recency";
}

/**
 * Canonicalised parse of the mutually-exclusive `?unread=` / `?watching=`
 * pair. Exported for unit tests. The server `filter` enum can hold only
 * one of these at a time; if a hand-typed or shared URL arrives with
 * both flags set, `unread` wins and `watching` collapses to `false`.
 * Every downstream consumer (chip row, request payload, Clear handler)
 * thus reads from a single consistent state.
 */
export function parseUnreadWatching(params: URLSearchParams): { unread: boolean; watching: boolean } {
  const unread = params.get("unread") === "1";
  const watching = !unread && params.get("watching") === "1";
  return { unread, watching };
}

export function WorkspacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedChatId = searchParams.get("c");
  const legacyAgentId = searchParams.get("a");
  const engagement: ChatEngagementView = engagementViewParser.parse(searchParams.get("engagement"));
  const { unread, watching } = parseUnreadWatching(searchParams);
  const group = parseGroup(searchParams.get("group"));

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
      setSearchParams(nextParamsForEngagement(searchParams, view), { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const setUnread = useCallback(
    (next: boolean) => {
      setSearchParams(nextParamsForUnread(searchParams, next), { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const setWatching = useCallback(
    (next: boolean) => {
      setSearchParams(nextParamsForWatching(searchParams, next), { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const setGroup = useCallback(
    (next: GroupMode) => {
      setSearchParams(nextParamsForGroup(searchParams, next), { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const clearFilters = useCallback(() => {
    // Single URLSearchParams mutation + single setSearchParams call.
    // Calling `setUnread(false)` and `setWatching(false)` back to back
    // would each build off the same render-stale `searchParams`, so the
    // second `setSearchParams` would overwrite the first's `unread`
    // deletion. Bundling the deletes here keeps Clear deterministic.
    setSearchParams(nextParamsForClearFilters(searchParams), { replace: true });
  }, [searchParams, setSearchParams]);

  return (
    <div className="flex flex-1 overflow-hidden">
      <ConversationList
        selectedChatId={selectedChatId}
        onSelectChat={selectChat}
        onNewChat={openDraft}
        engagement={engagement}
        onEngagementChange={setEngagement}
        unread={unread}
        onUnreadChange={setUnread}
        watching={watching}
        onWatchingChange={setWatching}
        onClearFilters={clearFilters}
        group={group}
        onGroupChange={setGroup}
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
  params.delete("docChat");
  params.delete("docAgent");
  params.delete("docPath");
  params.delete("docBase");
}

/**
 * Pure URL transition for the engagement tab. Exported for unit tests.
 *
 * Switching engagement can hide the currently-selected chat (e.g. flipping
 * Active → Archived while viewing an active chat). Leaving `?c=` set would
 * keep the previously-selected chat on the right pane and invite misrouted
 * input, so we drop the selection (and any doc-preview overlay) here.
 */
export function nextParamsForEngagement(current: URLSearchParams, view: ChatEngagementView): URLSearchParams {
  const next = new URLSearchParams(current);
  // Default value omitted from URL so the canonical home page stays `/`.
  if (view === "active") next.delete("engagement");
  else next.set("engagement", view);
  next.delete("c");
  clearDocPreviewParams(next);
  return next;
}

/**
 * Pure URL transition for the `unread` toggle. Exported for unit tests.
 *
 * Mutually exclusive with `watching` because the underlying server filter
 * is a single enum (`all` | `unread` | `watching`); turning one on flips
 * the other off so the URL never encodes an impossible state.
 *
 * Selection is preserved here — toggling unread doesn't shift the user
 * out of the chat they're reading (unlike scope which does hide
 * the selection).
 */
export function nextParamsForUnread(current: URLSearchParams, on: boolean): URLSearchParams {
  const next = new URLSearchParams(current);
  if (on) {
    next.set("unread", "1");
    next.delete("watching");
  } else {
    next.delete("unread");
  }
  return next;
}

/**
 * Pure URL transition for the `watching` toggle. Exported for unit tests.
 * Mutually exclusive with `unread` — see `nextParamsForUnread`.
 */
export function nextParamsForWatching(current: URLSearchParams, on: boolean): URLSearchParams {
  const next = new URLSearchParams(current);
  if (on) {
    next.set("watching", "1");
    next.delete("unread");
  } else {
    next.delete("watching");
  }
  return next;
}

/**
 * Pure URL transition for the `group by` dropdown. Exported for unit tests.
 * Grouping is purely a visual concern, so the selection is preserved.
 */
export function nextParamsForGroup(current: URLSearchParams, mode: GroupMode): URLSearchParams {
  const next = new URLSearchParams(current);
  if (mode === "recency") next.delete("group");
  else next.set("group", mode);
  return next;
}

/**
 * Pure URL transition that strips every Phase A filter dimension in one
 * shot. Used by the rail's "Clear" affordance. Exported for unit tests.
 *
 * Done in a single mutation because the rail filters that the user can
 * Clear (`?unread=`, `?watching=`) live on independent URL keys; running
 * the per-key setters back-to-back would re-derive each call from the
 * same stale `searchParams` snapshot, so only the last write would win.
 */
export function nextParamsForClearFilters(current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete("unread");
  next.delete("watching");
  return next;
}

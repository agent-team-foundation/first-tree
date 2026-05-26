import { CHAT_SOURCES, type ChatEngagementView, type ChatSource, chatEngagementViewSchema } from "@first-tree/shared";
import { useCallback, useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { DocPreviewDrawer } from "../../components/doc-preview-drawer.js";
import { useAdminWs } from "../../hooks/use-admin-ws.js";
import { useWorkspaceViewport } from "../../hooks/use-viewport.js";
import { shouldEnterOnboarding } from "../onboarding/steps.js";
import { CenterPanel } from "./center/index.js";
import { type GroupMode, parseGroupMode } from "./conversations/group-rows.js";
import { ConversationList, DRAFT_CHAT_ID } from "./conversations/index.js";

/**
 * Workspace shell — chat-first. The left rail is `ConversationList`; the
 * center routes by `?c=<chatId>` (or the special `?c=draft` marker for
 * an inline new-chat draft). All rail UI state is URL-backed:
 *
 *   - `?engagement=active|archived|all` (default `active`)
 *   - `?unread=1` (default off) — chats with unread mentions for the caller
 *   - `?watching=1` (default off) — chats where the caller is a watcher
 *   - `?origin=manual,pr,issue,…` (default empty = unfiltered) — multi-select
 *   - `?with=agent-x,agent-y` (default empty = unfiltered) — participants
 *   - `?group=recency|source|type|none` (default `source`) — list grouping
 *
 * Phase B replaces the Phase A single-value `?source=` with the multi-select
 * `?origin=`; the legacy key is still accepted on first load and upgraded
 * in-place so shared links / bookmarks keep working without expanding the
 * wire surface.
 *
 * Legacy URL compat:
 *   - `?a=<agentId>&c=<chatId>` redirects to `?c=<chatId>` (a is ignored).
 *   - `?a=<agentId>` (no chat) clears to `/` — agents are no longer the
 *     primary navigation key.
 *   - `?source=<value>` upgrades to `?origin=<value>` (single-value to
 *     multi-select wire). Skipped if `?origin=` is already present.
 */
const engagementViewParser = chatEngagementViewSchema.catch("active");

// `CHAT_SOURCES.includes(x)` is rejected on a literal-typed tuple, so go
// through a `Set<string>` and narrow with a user-defined type guard.
const CHAT_SOURCE_SET: ReadonlySet<string> = new Set(CHAT_SOURCES);
function isChatSource(value: string): value is ChatSource {
  return CHAT_SOURCE_SET.has(value);
}

/**
 * Parse the mutually-independent `?unread=` / `?watching=` flags. Phase B
 * removes the Phase A mutex (the server's `filter` enum no longer carries
 * "watching", so the two dimensions compose freely on the wire).
 */
export function parseUnreadWatching(params: URLSearchParams): { unread: boolean; watching: boolean } {
  return {
    unread: params.get("unread") === "1",
    watching: params.get("watching") === "1",
  };
}

/**
 * Parse the comma-joined `?origin=` URL value into a deduplicated, valid
 * `ChatSource[]`. Unknown tokens are silently dropped — a hand-typed or
 * future-rolled-back URL with an unfamiliar source string shouldn't break
 * the rail. Returns `[]` when the key is absent so callers can treat
 * "no filter" and "filter to empty" identically.
 */
export function parseOriginList(params: URLSearchParams): ChatSource[] {
  const raw = params.get("origin");
  if (!raw) return [];
  const seen = new Set<ChatSource>();
  const out: ChatSource[] = [];
  for (const token of raw.split(",")) {
    const t = token.trim();
    if (!t || !isChatSource(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Parse the comma-joined `?with=` URL value into a deduplicated agent-id
 * list. No further validation here — agent ids are server-side validated.
 */
export function parseParticipantList(params: URLSearchParams): string[] {
  const raw = params.get("with");
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(",")) {
    const t = token.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function WorkspacePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { meLoaded, onboardingStep, onboardingDismissedAt, onboardingCompletedAt } = useAuth();
  const selectedChatId = searchParams.get("c");
  const legacyAgentId = searchParams.get("a");
  const legacySource = searchParams.get("source");
  const engagement: ChatEngagementView = engagementViewParser.parse(searchParams.get("engagement"));
  const { unread, watching } = parseUnreadWatching(searchParams);
  const origin = parseOriginList(searchParams);
  const participants = parseParticipantList(searchParams);
  const group = parseGroupMode(searchParams.get("group"));

  useAdminWs();

  // Viewport-driven layout: at `narrow` (<768) the conversation list
  // collapses out of the inline three-pane shell and becomes a summon-able
  // overlay anchored to the workspace's left edge. State is plain React
  // (not URL) so the back button still navigates chats, not drawer state.
  const viewport = useWorkspaceViewport();
  const isNarrow = viewport === "narrow";
  const [convOverlayOpen, setConvOverlayOpen] = useState(false);
  // When the viewport widens back out, drop the overlay flag so we don't
  // re-show the rail in two places once it returns to inline rendering.
  useEffect(() => {
    if (!isNarrow) setConvOverlayOpen(false);
  }, [isNarrow]);

  // One-shot legacy redirects, all batched into a single setSearchParams so
  // they don't race on stale `searchParams` snapshots. Each branch returns
  // after staging its mutation; the effect re-runs once the URL settles.
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
      return;
    }
    if (legacySource && !searchParams.has("origin")) {
      // `?source=foo` → `?origin=foo`. The Phase B wire dropped the
      // single-value name; this upgrade keeps Phase A bookmarks /
      // shared links working without resurrecting the legacy key.
      // Skipped if `?origin=` is already present — never overwrite a
      // multi-select that the user (or an upstream redirect) has set.
      const next = new URLSearchParams(searchParams);
      next.delete("source");
      next.set("origin", legacySource);
      setSearchParams(next, { replace: true });
    }
  }, [legacyAgentId, legacySource, searchParams, selectedChatId, setSearchParams]);

  const selectChat = useCallback(
    (chatId: string) => {
      // Preserve the current `?engagement=` (and any other) param so
      // switching chats doesn't reset the user's filter context.
      const next = new URLSearchParams(searchParams);
      next.set("c", chatId);
      clearDocPreviewParams(next);
      setSearchParams(next);
      // Auto-dismiss the conversation-list overlay on narrow viewports —
      // the user picked a chat, they want the chat view, not the rail.
      // No-op on `md`/`xl` where the rail renders inline.
      setConvOverlayOpen(false);
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

  const setOrigin = useCallback(
    (next: ReadonlyArray<ChatSource>) => {
      setSearchParams(nextParamsForOrigin(searchParams, next), { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const setParticipants = useCallback(
    (next: ReadonlyArray<string>) => {
      setSearchParams(nextParamsForParticipants(searchParams, next), { replace: true });
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
    // Calling the per-flag setters in sequence would each build off the
    // same render-stale `searchParams`, so only the last write would
    // win and leave the URL in a half-cleared state.
    setSearchParams(nextParamsForClearFilters(searchParams), { replace: true });
  }, [searchParams, setSearchParams]);

  // Users who haven't finished setup go through the standalone /onboarding
  // flow — including the server-`completed`-but-no-kickoff case. Only
  // terminally completed or dismissed users fall through to the normal
  // workspace; the old inline center-panel onboarding has been retired.
  if (shouldEnterOnboarding({ meLoaded, onboardingStep, onboardingDismissedAt, onboardingCompletedAt })) {
    return <Navigate to="/onboarding" replace />;
  }

  const conversationList = (
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
      origin={origin}
      onOriginChange={setOrigin}
      participants={participants}
      onParticipantsChange={setParticipants}
      onClearFilters={clearFilters}
      group={group}
      onGroupChange={setGroup}
    />
  );

  // Narrow + no selection: the conversation list IS the main view, not an
  // overlay. Avoids trapping the user on NoChatView with no way back to
  // their chats (the inline rail is hidden, the hamburger only renders
  // inside ChatView). Same component reused, just stretched full-bleed.
  if (isNarrow && !selectedChatId) {
    return (
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 flex">{conversationList}</div>
        <DocPreviewDrawer />
      </div>
    );
  }

  return (
    <div className="flex flex-1 overflow-hidden relative">
      {/* Inline rail at `md`/`xl`. On `narrow` the rail collapses out
          of the row and gets summoned as an overlay (below). */}
      {isNarrow ? null : conversationList}

      <main className="flex-1 flex flex-col overflow-hidden min-w-0" style={{ background: "var(--bg)" }}>
        <CenterPanel
          selectedChatId={selectedChatId}
          onSelectChat={selectChat}
          narrow={isNarrow}
          onShowConversations={isNarrow ? () => setConvOverlayOpen(true) : null}
        />
      </main>
      <DocPreviewDrawer />

      {/* Conversation-list overlay (narrow viewports only). Same
          component rendered above for inline mode — just wrapped in an
          absolute-positioned shell with a scrim. The rail itself is a
          shrink-0 20rem-wide aside; we cap to `min(88vw, 20rem)` so it
          doesn't bleed past the screen edge on phones narrower than
          ~23rem logical. Scrim click closes; selecting a chat also
          closes (see `selectChat` above). */}
      {isNarrow && convOverlayOpen ? (
        <>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setConvOverlayOpen(false)}
            className="absolute inset-0 z-20"
            style={{ background: "var(--overlay-scrim)", border: 0, cursor: "default" }}
          />
          <div
            className="absolute top-0 bottom-0 left-0 z-30 flex"
            style={{
              maxWidth: "min(88vw, 20rem)",
              boxShadow: "var(--shadow-md)",
            }}
          >
            {conversationList}
          </div>
        </>
      ) : null}
    </div>
  );
}

function clearDocPreviewParams(params: URLSearchParams): void {
  params.delete("docChat");
  params.delete("docAgent");
  params.delete("docPath");
  params.delete("docBase");
  params.delete("docMsg");
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
 * Phase B: `unread` and `watching` are now independent boolean dimensions
 * (the server filter enum no longer overloads both onto one slot), so
 * toggling one no longer clears the other.
 *
 * Selection is preserved here — toggling unread doesn't shift the user
 * out of the chat they're reading (unlike scope which does hide
 * the selection).
 */
export function nextParamsForUnread(current: URLSearchParams, on: boolean): URLSearchParams {
  const next = new URLSearchParams(current);
  if (on) next.set("unread", "1");
  else next.delete("unread");
  return next;
}

/**
 * Pure URL transition for the `watching` toggle. Exported for unit tests.
 * Independent of `unread` (Phase B — the two compose freely).
 */
export function nextParamsForWatching(current: URLSearchParams, on: boolean): URLSearchParams {
  const next = new URLSearchParams(current);
  if (on) next.set("watching", "1");
  else next.delete("watching");
  return next;
}

/**
 * Pure URL transition for the multi-select `?origin=` facet. Exported for
 * unit tests. Empty array clears the key from the URL so the canonical
 * "unfiltered" state stays as the bare home URL (no `?origin=` at all).
 *
 * The set is deduplicated and emitted in caller order; the workspace
 * popover walks `CHAT_SOURCES` in its declared order so the resulting
 * URL is stable across user actions even though the parameter is
 * conceptually a set.
 */
export function nextParamsForOrigin(current: URLSearchParams, origins: ReadonlyArray<ChatSource>): URLSearchParams {
  const next = new URLSearchParams(current);
  const unique = Array.from(new Set(origins));
  if (unique.length === 0) next.delete("origin");
  else next.set("origin", unique.join(","));
  // Origin narrowing can hide the currently-selected chat from the rail
  // (e.g. flipping off PR origin while a PR chat is selected). Drop the
  // selection so the right pane mirrors the new view — same rationale
  // as the engagement transition.
  next.delete("c");
  clearDocPreviewParams(next);
  return next;
}

/**
 * Pure URL transition for the multi-select `?with=` participants filter.
 * Same shape as `nextParamsForOrigin`. Exported for unit tests.
 */
export function nextParamsForParticipants(current: URLSearchParams, agents: ReadonlyArray<string>): URLSearchParams {
  const next = new URLSearchParams(current);
  const unique = Array.from(new Set(agents.filter((a) => a.length > 0)));
  if (unique.length === 0) next.delete("with");
  else next.set("with", unique.join(","));
  // Participants narrowing can hide the currently-selected chat from
  // the rail — drop the selection so the right pane stays consistent.
  next.delete("c");
  clearDocPreviewParams(next);
  return next;
}

/**
 * Pure URL transition for the `group by` dropdown. Exported for unit tests.
 * Grouping is purely a visual concern, so the selection is preserved.
 */
export function nextParamsForGroup(current: URLSearchParams, mode: GroupMode): URLSearchParams {
  const next = new URLSearchParams(current);
  if (mode === "source") next.delete("group");
  else next.set("group", mode);
  return next;
}

/**
 * Pure URL transition that strips every rail filter dimension in one
 * shot. Used by the rail's "Clear" affordance. Exported for unit tests.
 *
 * Done in a single mutation because the rail filters live on independent
 * URL keys (`?unread=`, `?watching=`, `?origin=`, `?with=`); running the
 * per-key setters back-to-back would re-derive each call from the same
 * stale `searchParams` snapshot, so only the last write would win.
 *
 * Scope (`?engagement=`), grouping (`?group=`), and the selected chat
 * (`?c=`) are deliberately preserved — they're not "filters" in the
 * Clear sense; the user expects them to survive a Clear.
 */
export function nextParamsForClearFilters(current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete("unread");
  next.delete("watching");
  next.delete("origin");
  next.delete("with");
  return next;
}

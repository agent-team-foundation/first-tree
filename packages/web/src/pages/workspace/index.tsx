import { CHAT_SOURCES, type ChatEngagementView, type ChatSource, chatEngagementViewSchema } from "@first-tree/shared";
import { useCallback, useEffect, useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { DocPreviewDrawer } from "../../components/doc-preview-drawer.js";
import { useAdminWs } from "../../hooks/use-admin-ws.js";
import { useWorkspaceViewport } from "../../hooks/use-viewport.js";
import { shouldEnterOnboarding } from "../onboarding/steps.js";
import { isLandingTrialSurface } from "../quickstart/route.js";
import { CenterPanel } from "./center/index.js";
import {
  DEFAULT_GROUP_MODE,
  type GroupMode,
  parseGroupMode,
  readStoredGroupMode,
  storeGroupMode,
} from "./conversations/group-rows.js";
import { ConversationList, DRAFT_CHAT_ID, type RailFilter } from "./conversations/index.js";

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
 *   - `?group=recency|source` — list grouping; when absent, falls back to
 *     the remembered per-device choice (`localStorage`), then `recency`
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
 * Parse the `?unread=` / `?watching=` flags into the single-select triad
 * state (All / Unread / Watching). The header triad is single-select, so a
 * URL that still carries BOTH flags — a link saved before this redesign, or
 * one hand-typed — is canonicalized to one mode: **unread wins**. Without
 * this, `listMeChats` would silently filter by unread *and* watching while
 * the triad only highlights Unread, leaving a hidden active filter the user
 * can't see or clear. `nextParamsForRailFilter` only ever writes one flag,
 * so a freshly-driven URL never carries both.
 */
export function parseUnreadWatching(params: URLSearchParams): { unread: boolean; watching: boolean } {
  const unread = params.get("unread") === "1";
  const watching = params.get("watching") === "1";
  return { unread, watching: unread ? false : watching };
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
  // The full valid set is the "unrestricted" wire — identical to no `?origin=`.
  // Canonicalize a legacy/shared URL that lists every source (e.g. one produced
  // by the pre-redesign checkbox UI) to [] so the rail doesn't render a chip per
  // source + a badge for a result the server treats as unfiltered.
  return out.length === CHAT_SOURCES.length ? [] : out;
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
  const { meLoaded, onboardingStep, onboardingDismissedAt, onboardingCompletedAt, currentOrgHasPersonalAgent } =
    useAuth();

  // Users who haven't finished setup go through the standalone /onboarding
  // flow — including the server-`completed`-but-no-start-chat case. Only
  // terminally completed or dismissed users fall through to the normal
  // workspace; the old inline center-panel onboarding has been retired.
  //
  // The gate lives HERE (the `/` index route), not inside `shouldEnterOnboarding`
  // or `WorkspaceBody`: the landing-campaign quickstart funnel renders the same
  // `WorkspaceBody` at `/quickstart?c=<id>` WITHOUT this gate, so an un-onboarded
  // trial user is not bounced to /onboarding. Keeping the skip at the route/caller
  // level leaves `shouldEnterOnboarding` a pure, campaign-agnostic function.
  if (
    shouldEnterOnboarding({
      meLoaded,
      onboardingStep,
      onboardingSuppressedAt: onboardingDismissedAt,
      currentOrgHasPersonalAgent,
      // Not read by the entry gate (auto-entry keys off connect + org
      // personal-agent readiness only); supplied because both gates share
      // OnboardingGateFacts.
      onboardingCompletedAt,
    })
  ) {
    return <Navigate to="/onboarding" replace />;
  }

  return <WorkspaceBody />;
}

/**
 * Workspace body — the chat-first three-pane shell (conversation rail +
 * center chat + doc-preview drawer) plus all the URL-backed rail state.
 *
 * Split out of `WorkspacePage` so the SAME shell renders in two places:
 *   - `/` — behind the onboarding gate (via `WorkspacePage`).
 *   - `/quickstart?c=<id>` — gate-free, inside the landing-campaign trial
 *     funnel, so the trial chat shows the real workspace instead of a
 *     bespoke standalone page.
 */
export function WorkspaceBody() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  // Trial surface (`/quickstart`): the single-run trial chat is the only
  // supported surface, so drop the conversation rail (and its new-chat /
  // filter affordances) and show the chat full-bleed.
  const isTrial = isLandingTrialSurface(location.pathname);
  const selectedChatId = searchParams.get("c");
  const legacyAgentId = searchParams.get("a");
  const legacySource = searchParams.get("source");
  const engagement: ChatEngagementView = engagementViewParser.parse(searchParams.get("engagement"));
  const { unread, watching } = parseUnreadWatching(searchParams);
  const origin = parseOriginList(searchParams);
  const participants = parseParticipantList(searchParams);
  // Explicit URL value wins (shareable links); otherwise restore the
  // remembered per-device choice, which itself defaults to `recency`.
  const group = parseGroupMode(searchParams.get("group")) ?? readStoredGroupMode();

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
  // Esc closes the conversation-list overlay — parallels the existing
  // Esc handler ChatView uses for its right-rail overlay, so both
  // overlays behave the same for keyboard users.
  useEffect(() => {
    if (!convOverlayOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConvOverlayOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [convOverlayOpen]);

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

  const clearSelectedChat = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("c");
    clearDocPreviewParams(next);
    setSearchParams(next, { replace: true });
    setConvOverlayOpen(false);
  }, [searchParams, setSearchParams]);

  const setEngagement = useCallback(
    (view: ChatEngagementView) => {
      setSearchParams(nextParamsForEngagement(searchParams, view), { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // Primary triad — sets the `?unread=` / `?watching=` flags
  // mutually-exclusively in one atomic write (the two are independent URL
  // keys, so two back-to-back setters would race on the stale snapshot).
  const setRailFilter = useCallback(
    (view: RailFilter) => {
      setSearchParams(nextParamsForRailFilter(searchParams, view), { replace: true });
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
      // Remember the choice for future visits, then mirror it in the URL.
      storeGroupMode(next);
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

  // Trial surface: no conversation rail (and no narrow overlay) — the trial
  // chat renders full-bleed. Escape-hatch affordances (new chat, filters) live
  // in the rail, so dropping it is what keeps the trial a controlled surface.
  if (isTrial) {
    return (
      <div className="flex flex-1 overflow-hidden relative">
        <main className="flex-1 flex flex-col overflow-hidden min-w-0" style={{ background: "var(--bg)" }}>
          <CenterPanel
            selectedChatId={selectedChatId}
            onSelectChat={selectChat}
            onClearChat={clearSelectedChat}
            narrow={isNarrow}
            onShowConversations={null}
            initialParticipantIds={participants}
            isTrial
          />
        </main>
        <DocPreviewDrawer />
      </div>
    );
  }

  // Pick the width prop based on what role the rail is playing:
  //   - narrow + no chat → full-bleed (100% of the wrapper) so the list
  //     covers the whole screen as the main view.
  //   - narrow + overlay → fluid cap so the inner aside doesn't overflow
  //     the wrapper on phones narrower than ~23rem logical (same pattern
  //     ChatRightSidebar uses for its overlay variant).
  //   - otherwise (inline rail on md/xl) → leave undefined, default 20rem.
  const conversationListWidth = !isNarrow
    ? undefined
    : !selectedChatId
      ? "100%"
      : convOverlayOpen
        ? "min(88vw, 20rem)"
        : undefined;
  const conversationList = (
    <ConversationList
      selectedChatId={selectedChatId}
      onSelectChat={selectChat}
      onNewChat={openDraft}
      engagement={engagement}
      onEngagementChange={setEngagement}
      unread={unread}
      watching={watching}
      onRailFilterChange={setRailFilter}
      origin={origin}
      onOriginChange={setOrigin}
      participants={participants}
      onParticipantsChange={setParticipants}
      onClearFilters={clearFilters}
      group={group}
      onGroupChange={setGroup}
      width={conversationListWidth}
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
          onClearChat={clearSelectedChat}
          narrow={isNarrow}
          onShowConversations={isNarrow ? () => setConvOverlayOpen(true) : null}
          initialParticipantIds={participants}
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
  params.delete("docMsg");
  // Current owner of which doc is open (attachment-ref model).
  params.delete("docAttachment");
  // Legacy params from the pre-convergence `docPath` model — still cleared so
  // an in-flight URL minted before the migration also clears cleanly.
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
 * Pure URL transition for the header's primary triad (All / Unread /
 * Watching). Exported for unit tests. The triad is single-select, so it
 * sets the two independent `?unread=` / `?watching=` flags
 * mutually-exclusively in one mutation: `all` clears both, `unread` sets
 * only unread, `watching` sets only watching. Doing it in a single
 * `URLSearchParams` write avoids the stale-snapshot race that two
 * back-to-back per-flag writes would hit.
 *
 * Selection (`?c=`) is preserved — switching the triad doesn't shift the
 * user out of the chat they're reading.
 */
export function nextParamsForRailFilter(current: URLSearchParams, view: RailFilter): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete("unread");
  next.delete("watching");
  if (view === "unread") next.set("unread", "1");
  else if (view === "watching") next.set("watching", "1");
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
  // Full valid set == unrestricted (mirror `parseOriginList`): drop the key so
  // the canonical "unfiltered" state stays the bare URL even if a caller passes
  // the complete set explicitly.
  const canonical = unique.length === CHAT_SOURCES.length ? [] : unique;
  if (canonical.length === 0) next.delete("origin");
  else next.set("origin", canonical.join(","));
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
  if (mode === DEFAULT_GROUP_MODE) next.delete("group");
  else next.set("group", mode);
  return next;
}

/**
 * Pure URL transition for the `⚙` popover's "Reset" (and the filter-chip
 * "Clear"). Exported for unit tests. Resets exactly the popover's OWN
 * dimensions — Source (`?origin=`), Participants (`?with=`), and Status
 * (`?engagement=` → default `active`) — which are the three dimensions the
 * popover surfaces and the badge counts.
 *
 * Done in a single mutation because those keys are independent; running the
 * per-key setters back-to-back would re-derive each call from the same stale
 * `searchParams` snapshot, so only the last write would win.
 *
 * The header triad (`?unread=` / `?watching=`) is deliberately NOT cleared:
 * All / Unread / Watching is a separate, always-visible control that lives
 * outside the popover and isn't counted by its badge, so resetting it here
 * would be an invisible side effect of a button that reads as "reset the
 * filters I can see". Grouping (`?group=`, a view-mode) and the selected chat
 * (`?c=`) are likewise preserved — the user expects them to survive.
 */
export function nextParamsForClearFilters(current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  next.delete("origin");
  next.delete("with");
  next.delete("engagement");
  return next;
}

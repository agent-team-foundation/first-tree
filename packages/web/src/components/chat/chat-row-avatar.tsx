/**
 * ChatRowAvatar — left-side avatar slot for the conversation list row.
 *
 * Renders three orthogonal signals in one 36x36 unit:
 *
 *   1. Identity. Direct chats show a single initial; group chats use a
 *      Telegram-style split-disc composite (vertical bisection for 2,
 *      T-split for 3, 2x2 grid + "+N" for >=4).
 *   2. Working state. ONLY for direct chats: when the peer's agent_id
 *      is present in `workingAgentIds`, an accent ring breathes around
 *      the avatar. Group rings are intentionally skipped — the source
 *      data (`agent_presence.runtime_state`) is agent-global, not
 *      per-chat, so showing a ring on every chat a working agent
 *      participates in would be noisy. Per-chat precision is deferred
 *      (see chat-status-icons spec §⑦.② / §⑦.⑦, Option A).
 *   3. Unread. A `--state-error` badge at the bottom-right corner
 *      replaces the legacy small text-row dot. Numeric up to 99, then
 *      "99+". When count = 0 the badge is omitted entirely.
 *
 * The component owns its z-index ladder: badge (3) > working ring (1)
 * > avatar (0). All overlays carry a hairline-bold `var(--bg-raised)`
 * border so they read clearly against the underlying avatar without
 * bleeding into adjacent rows.
 */

import type { MeChatRow } from "@agent-team-foundation/first-tree-hub-shared";

type Participant = MeChatRow["participants"][number];

function initial(s: string): string {
  return s.trim()[0]?.toUpperCase() ?? "?";
}

function buildAriaLabel(opts: { type: string; title: string; peerWorking: boolean; unread: number }): string {
  const parts: string[] = [opts.title];
  if (opts.peerWorking) parts.push("working");
  if (opts.unread > 0) parts.push(`${opts.unread} unread`);
  return parts.join(", ");
}

export function ChatRowAvatar({
  title,
  type,
  participants,
  selfAgentId,
  workingAgentIds,
  unreadCount,
  size = 36,
}: {
  /** Resolved chat title — used for the avatar's aria-label. */
  title: string;
  /** `direct` | `group`. */
  type: string;
  /** Speakers only (watchers are filtered by `listMeChats`). */
  participants: ReadonlyArray<Participant>;
  /** Caller's own agent_id, so we can identify the peer in a direct chat. */
  selfAgentId: string;
  /** Speakers whose `agent_presence.runtime_state === 'working'`. */
  workingAgentIds: ReadonlyArray<string>;
  /** `chat_user_state.unread_mention_count`. */
  unreadCount: number;
  /** Pixel diameter of the avatar disc. Default 36 fits the narrow rail. */
  size?: number;
}) {
  const isDirect = type === "direct";
  const peers = participants.filter((p) => p.agentId !== selfAgentId);

  // Working ring fires only for direct chats — see component header for the
  // rationale on dropping the group case under Option A.
  const peer = peers[0];
  const peerWorking = isDirect && peer !== undefined && workingAgentIds.includes(peer.agentId);

  const ariaLabel = buildAriaLabel({ type, title, peerWorking, unread: unreadCount });

  return (
    <span
      role="img"
      aria-label={ariaLabel}
      style={{
        position: "relative",
        width: size,
        height: size,
        flexShrink: 0,
        display: "inline-block",
      }}
    >
      {isDirect || peers.length <= 1 ? (
        <SingleAvatar size={size} name={peer?.displayName ?? title} />
      ) : (
        <CompositeAvatar size={size} peers={peers} />
      )}
      {peerWorking && <WorkingRing size={size} />}
      {unreadCount > 0 && <UnreadBadge count={unreadCount} />}
    </span>
  );
}

function SingleAvatar({ size, name }: { size: number; name: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--accent)",
        color: "var(--bg-raised)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.42),
        fontWeight: 700,
        lineHeight: 1,
        letterSpacing: "-0.02em",
        userSelect: "none",
      }}
    >
      {initial(name)}
    </span>
  );
}

function CompositeAvatar({ size, peers }: { size: number; peers: ReadonlyArray<Participant> }) {
  // Layout decisions, mirroring the chat-status-icons design preview:
  //   2 visible → vertical bisection
  //   3 visible → T-split (top spans full width, bottom is 2 cells)
  //   >=4 total → 2x2 grid where the last slot becomes a `+N` overflow tile
  //
  // The split is rendered via CSS grid with a hairline gap that lets the
  // parent `--bg-raised` background show through as hairline separators —
  // crisper than borders at this size and consistent with the rest of
  // the design system's hairline tokens.
  const n = peers.length;
  const visibleCount = n <= 3 ? n : 3;
  const overflow = n - visibleCount;

  const fontSize = Math.round(size * (n === 2 ? 0.36 : 0.28));
  const fontSizeTop = Math.round(size * 0.32);
  const fontSizeMore = Math.round(size * 0.26);

  const gridTemplate =
    n === 2 ? { gridTemplateColumns: "1fr 1fr" } : { gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr" };

  return (
    <div
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        overflow: "hidden",
        display: "grid",
        gap: "var(--hairline)",
        background: "var(--bg-raised)",
        userSelect: "none",
        ...gridTemplate,
      }}
    >
      {n === 2 && (
        <>
          <Seg name={peers[0]?.displayName ?? "?"} fontSize={fontSize} />
          <Seg name={peers[1]?.displayName ?? "?"} fontSize={fontSize} />
        </>
      )}
      {n === 3 && (
        <>
          <Seg name={peers[0]?.displayName ?? "?"} fontSize={fontSizeTop} fullWidth />
          <Seg name={peers[1]?.displayName ?? "?"} fontSize={fontSize} />
          <Seg name={peers[2]?.displayName ?? "?"} fontSize={fontSize} />
        </>
      )}
      {n >= 4 && (
        <>
          <Seg name={peers[0]?.displayName ?? "?"} fontSize={fontSize} />
          <Seg name={peers[1]?.displayName ?? "?"} fontSize={fontSize} />
          <Seg name={peers[2]?.displayName ?? "?"} fontSize={fontSize} />
          <SegMore count={overflow + 1} fontSize={fontSizeMore} />
        </>
      )}
    </div>
  );
}

function Seg({ name, fontSize, fullWidth }: { name: string; fontSize: number; fullWidth?: boolean }) {
  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--accent)",
        color: "var(--bg-raised)",
        fontSize,
        fontWeight: 700,
        lineHeight: 1,
        letterSpacing: "-0.02em",
        ...(fullWidth ? { gridColumn: "1 / -1" } : null),
      }}
    >
      {initial(name)}
    </span>
  );
}

function SegMore({ count, fontSize }: { count: number; fontSize: number }) {
  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-sunken)",
        color: "var(--fg-3)",
        fontSize,
        fontWeight: 600,
        lineHeight: 1,
        userSelect: "none",
      }}
    >
      {`+${count}`}
    </span>
  );
}

function WorkingRing({ size }: { size: number }) {
  // Hairline-bold border, offset 3 outside the avatar. The breathe
  // keyframes + `prefers-reduced-motion` fallback live in index.css.
  return (
    <span
      aria-hidden="true"
      className="chat-row-avatar__working-ring"
      style={{
        position: "absolute",
        inset: -3,
        width: size + 6,
        height: size + 6,
        borderRadius: "50%",
        border: "var(--hairline-bold) solid var(--state-working)",
        pointerEvents: "none",
        zIndex: 1,
      }}
    />
  );
}

function UnreadBadge({ count }: { count: number }) {
  const label = count > 99 ? "99+" : String(count);
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute",
        bottom: -3,
        right: -3,
        minWidth: 16,
        height: 16,
        padding: "0 var(--sp-1)",
        borderRadius: 8,
        background: "var(--state-error)",
        color: "var(--bg-raised)",
        fontSize: 10,
        fontWeight: 700,
        lineHeight: "var(--sp-4)",
        textAlign: "center",
        border: "var(--hairline-bold) solid var(--bg-raised)",
        boxSizing: "content-box",
        zIndex: 3,
        userSelect: "none",
      }}
    >
      {label}
    </span>
  );
}

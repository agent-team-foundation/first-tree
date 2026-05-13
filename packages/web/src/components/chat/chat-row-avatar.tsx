/**
 * ChatRowAvatar — left-side avatar slot for the conversation list row.
 *
 * Renders three orthogonal signals in one 36x36 unit:
 *
 *   1. Identity. Direct chats show a single initial; group chats use a
 *      Telegram-style split-disc composite (vertical bisection for 2,
 *      T-split for 3, 2x2 for exactly 4, 3 + "+N" tile for >=5).
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
 *
 * A11y: this span's `aria-label` carries the dynamic *state* only
 * (`"working"`, `"3 unread"`). The enclosing chat-row button already
 * renders the chat title as visible text — repeating it here would
 * make screen readers announce the title twice. When the avatar has
 * no state to surface, it goes fully `aria-hidden` so the row's
 * accessible name is unchanged.
 */

import type { MeChatRow } from "@agent-team-foundation/first-tree-hub-shared";

type Participant = MeChatRow["participants"][number];

function initial(s: string): string {
  return s.trim()[0]?.toUpperCase() ?? "?";
}

/**
 * Per-agent fill colors. Eight perceptually-distinct hues at the same
 * OkLCH lightness/chroma so every avatar reads with the same visual
 * weight. White-ish text (handled by the rendering site via
 * `var(--bg-raised)` in light mode) carries enough contrast against
 * every entry; same palette works light + dark because OkLCH stays
 * perceptually stable across themes.
 */
const AVATAR_HUES: ReadonlyArray<string> = [
  "oklch(0.66 0.16 150)", // green (kept first so the default-fallback hash collision still looks neutral)
  "oklch(0.62 0.17 250)", // blue
  "oklch(0.6 0.18 295)", // purple
  "oklch(0.65 0.2 0)", // pink
  "oklch(0.68 0.16 50)", // orange
  "oklch(0.65 0.13 200)", // teal
  "oklch(0.72 0.15 90)", // amber
  "oklch(0.55 0.17 270)", // indigo
];

/**
 * Hash a stable seed (usually an agent's UUID; falls back to display
 * name if the UUID isn't around) into a fixed entry from `AVATAR_HUES`.
 * Same agent → same hue across direct chats, group composites, and
 * page reloads. Cheap djb2 variant; no allocations.
 *
 * Exported for unit testing the deterministic-mapping contract.
 */
export function pickAvatarHue(seed: string): string {
  if (seed.length === 0) return AVATAR_HUES[0] ?? "oklch(0.66 0.16 150)";
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 33) ^ seed.charCodeAt(i);
  }
  const idx = Math.abs(hash) % AVATAR_HUES.length;
  return AVATAR_HUES[idx] ?? AVATAR_HUES[0] ?? "oklch(0.66 0.16 150)";
}

/**
 * Composite-avatar layout key, exported for unit testing the branch
 * decisions without rendering to a DOM. `"single"` is reserved for the
 * non-composite path (1 peer or direct chats); `"n2"` / `"n3"` / `"n4"`
 * / `"n5+"` map 1:1 to the composite's grid templates.
 */
export function pickCompositeShape(peerCount: number): "single" | "n2" | "n3" | "n4" | "n5+" {
  if (peerCount <= 1) return "single";
  if (peerCount === 2) return "n2";
  if (peerCount === 3) return "n3";
  if (peerCount === 4) return "n4";
  return "n5+";
}

/**
 * Unread badge label. Returns `null` to signal the badge should be
 * omitted entirely (clearer than asking callers to also gate on
 * `count > 0`). `>= 100` rolls over to `"99+"` so the badge stays
 * single-digit width-stable.
 */
export function formatUnreadLabel(count: number): string | null {
  if (count <= 0) return null;
  if (count > 99) return "99+";
  return String(count);
}

/**
 * State-only aria-label. Returns `null` when the avatar should be
 * fully `aria-hidden` (no dynamic state worth surfacing — title is
 * already on the row button). When there is state, it's joined as
 * `"working, N unread"`.
 */
export function buildAvatarAriaLabel(opts: { peerWorking: boolean; unread: number }): string | null {
  const parts: string[] = [];
  if (opts.peerWorking) parts.push("working");
  if (opts.unread > 0) parts.push(`${opts.unread} unread`);
  return parts.length > 0 ? parts.join(", ") : null;
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
  /** Resolved chat title — used as a fallback initial when no peer exists. */
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

  const ariaLabel = buildAvatarAriaLabel({ peerWorking, unread: unreadCount });
  const a11yProps: { role?: string; "aria-label"?: string; "aria-hidden"?: boolean } =
    ariaLabel === null ? { "aria-hidden": true } : { role: "img", "aria-label": ariaLabel };

  return (
    <span
      {...a11yProps}
      style={{
        position: "relative",
        width: size,
        height: size,
        flexShrink: 0,
        display: "inline-block",
      }}
    >
      {isDirect || peers.length <= 1 ? (
        <SingleAvatar size={size} name={peer?.displayName ?? title} hueSeed={peer?.agentId ?? title} />
      ) : (
        <CompositeAvatar size={size} peers={peers} />
      )}
      {peerWorking && <WorkingRing size={size} />}
      {unreadCount > 0 && <UnreadBadge count={unreadCount} />}
    </span>
  );
}

function SingleAvatar({ size, name, hueSeed }: { size: number; name: string; hueSeed: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: pickAvatarHue(hueSeed),
        color: "oklch(0.985 0 0)",
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
  // Layout decision keyed off `pickCompositeShape` (see header docstring):
  //   n2  → vertical bisection
  //   n3  → T-split (top spans full width, bottom is 2 cells)
  //   n4  → 2x2 grid, all four visible (matches conventional group UX)
  //   n5+ → 2x2 grid, first three peers + "+N" overflow tile where N = n - 3
  const n = peers.length;
  const shape = pickCompositeShape(n);

  const fontSize = Math.round(size * (n === 2 ? 0.36 : 0.28));
  const fontSizeTop = Math.round(size * 0.32);
  const fontSizeMore = Math.round(size * 0.26);

  const gridTemplate =
    shape === "n2"
      ? { gridTemplateColumns: "1fr 1fr" }
      : { gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr" };

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
      {shape === "n2" && (
        <>
          <Seg name={peers[0]?.displayName ?? "?"} hueSeed={peers[0]?.agentId ?? "0"} fontSize={fontSize} />
          <Seg name={peers[1]?.displayName ?? "?"} hueSeed={peers[1]?.agentId ?? "1"} fontSize={fontSize} />
        </>
      )}
      {shape === "n3" && (
        <>
          <Seg
            name={peers[0]?.displayName ?? "?"}
            hueSeed={peers[0]?.agentId ?? "0"}
            fontSize={fontSizeTop}
            fullWidth
          />
          <Seg name={peers[1]?.displayName ?? "?"} hueSeed={peers[1]?.agentId ?? "1"} fontSize={fontSize} />
          <Seg name={peers[2]?.displayName ?? "?"} hueSeed={peers[2]?.agentId ?? "2"} fontSize={fontSize} />
        </>
      )}
      {shape === "n4" && (
        <>
          <Seg name={peers[0]?.displayName ?? "?"} hueSeed={peers[0]?.agentId ?? "0"} fontSize={fontSize} />
          <Seg name={peers[1]?.displayName ?? "?"} hueSeed={peers[1]?.agentId ?? "1"} fontSize={fontSize} />
          <Seg name={peers[2]?.displayName ?? "?"} hueSeed={peers[2]?.agentId ?? "2"} fontSize={fontSize} />
          <Seg name={peers[3]?.displayName ?? "?"} hueSeed={peers[3]?.agentId ?? "3"} fontSize={fontSize} />
        </>
      )}
      {shape === "n5+" && (
        <>
          <Seg name={peers[0]?.displayName ?? "?"} hueSeed={peers[0]?.agentId ?? "0"} fontSize={fontSize} />
          <Seg name={peers[1]?.displayName ?? "?"} hueSeed={peers[1]?.agentId ?? "1"} fontSize={fontSize} />
          <Seg name={peers[2]?.displayName ?? "?"} hueSeed={peers[2]?.agentId ?? "2"} fontSize={fontSize} />
          <SegMore count={n - 3} fontSize={fontSizeMore} />
        </>
      )}
    </div>
  );
}

function Seg({
  name,
  hueSeed,
  fontSize,
  fullWidth,
}: {
  name: string;
  hueSeed: string;
  fontSize: number;
  fullWidth?: boolean;
}) {
  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: pickAvatarHue(hueSeed),
        color: "oklch(0.985 0 0)",
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
  const label = formatUnreadLabel(count);
  if (label === null) return null;
  // Pinned at --sp-4 (16) x --sp-4 (16), --sp-2 (8) corner radius — the
  // badge is a self-contained capsule and intentionally tighter than the
  // generic content padding scale, so it reads as a discrete signal
  // rather than a control. Offset by 3 outside the avatar so the
  // hairline-bold border cuts cleanly through the working ring.
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute",
        bottom: -3,
        right: -3,
        minWidth: "var(--sp-4)",
        height: "var(--sp-4)",
        padding: "0 var(--sp-1)",
        borderRadius: "var(--sp-2)",
        background: "var(--state-error)",
        color: "oklch(0.985 0 0)",
        fontSize: "var(--text-caption)",
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

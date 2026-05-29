/**
 * ChatRowAvatar — left-side avatar slot for the conversation list row.
 *
 * Renders two orthogonal signals in one 36x36 unit:
 *
 *   1. Identity. Direct chats show a single initial; group chats use a
 *      Telegram-style split-disc composite (vertical bisection for 2,
 *      T-split for 3, 2x2 for exactly 4, 3 + "+N" tile for >=5).
 *   2. Attention. A single corner badge encodes the highest-priority
 *      "do I need to look here" signal: failed (an agent errored, red `!`)
 *      outranks needs-you (a pending AskUserQuestion, amber `?`) outranks an
 *      unread-mention count (red N, numeric up to 99 then "99+"). Omitted when
 *      none apply. The activity axis ("an agent is producing output now")
 *      lives in the row's time slot (the scrolling `•••`), not here.
 *
 * The avatar no longer carries the engaged breathe ring — "engaged but
 * idle" was low-value at list-scan distance and is expressed per-agent
 * in the right sidebar instead.
 *
 * A11y: this span's `aria-label` carries the dynamic *state* only
 * (`"needs you"`, `"3 unread"`). The enclosing chat-row button already
 * renders the chat title as visible text — repeating it here would
 * make screen readers announce the title twice. When the avatar has
 * no state to surface, it goes fully `aria-hidden` so the row's
 * accessible name is unchanged.
 */

import type { MeChatRow } from "@first-tree/shared";
import type { ReactNode } from "react";

type Participant = MeChatRow["participants"][number];

function initial(s: string): string {
  return s.trim()[0]?.toUpperCase() ?? "?";
}

/**
 * Per-agent fill colors. References to the `--avatar-hue-0..7` tokens
 * defined in `index.css`; this file holds the *selection* logic, not
 * the colors themselves. Add or restyle hues in index.css.
 *
 * Initials are painted on top in `--fg-on-vivid` (a near-white token,
 * also in index.css) so contrast holds in both themes without relying
 * on `--bg-raised`, which inverts under `.dark`.
 */
const AVATAR_HUE_COUNT = 8;

const FALLBACK_HUE = "var(--avatar-hue-0)";

/**
 * Hash a stable seed (usually an agent's UUID; falls back to display
 * name if the UUID isn't around) into a fixed entry from the
 * `--avatar-hue-*` palette. Same agent → same hue across direct chats,
 * group composites, and page reloads. Cheap djb2 variant; no
 * allocations.
 *
 * Empty seed lands on `--avatar-hue-0` deterministically. Exported
 * for unit testing the deterministic-mapping contract.
 */
export function pickAvatarHue(seed: string): string {
  if (seed.length === 0) return FALLBACK_HUE;
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 33) ^ seed.charCodeAt(i);
  }
  const idx = Math.abs(hash) % AVATAR_HUE_COUNT;
  return `var(--avatar-hue-${idx})`;
}

/**
 * Manager override → hue. Accepts the loose `string | null` shape that
 * flows in from the API so unrecognised values quietly fall back to the
 * deterministic hash on `seed`. Valid tokens are "hue-0".."hue-7".
 */
export function resolveAvatarHue(colorToken: string | null | undefined, seed: string): string {
  if (typeof colorToken === "string" && /^hue-[0-7]$/.test(colorToken)) {
    return `var(--avatar-${colorToken})`;
  }
  return pickAvatarHue(seed);
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
 * `"engaged, N unread"`.
 */
export function buildAvatarAriaLabel(opts: { failed: boolean; needsYou: boolean; unread: number }): string | null {
  const parts: string[] = [];
  if (opts.failed) parts.push("failed");
  if (opts.needsYou) parts.push("needs you");
  if (opts.unread > 0) parts.push(`${opts.unread} unread`);
  return parts.length > 0 ? parts.join(", ") : null;
}

export function ChatRowAvatar({
  title,
  type,
  participants,
  selfAgentId,
  unreadCount,
  needsYou = false,
  failed = false,
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
  /** `chat_user_state.unread_mention_count`. */
  unreadCount: number;
  /** Any speaker in this chat has a pending AskUserQuestion (needs-you). */
  needsYou?: boolean;
  /** Any speaker in this chat is in the composite `failed` state. Outranks
   *  needs-you and unread for the corner badge. */
  failed?: boolean;
  /** Pixel diameter of the avatar disc. Default 36 fits the narrow rail. */
  size?: number;
}) {
  const isDirect = type === "direct";
  // Defensive: older server builds may omit `participants` from the me/chats
  // payload. Schema marks it required, but a version-skewed backend (or a
  // partial cache) should not crash the conversation list — fall back to [].
  const safeParticipants = participants ?? [];
  const peers = safeParticipants.filter((p) => p.agentId !== selfAgentId);
  const peer = peers[0];

  const ariaLabel = buildAvatarAriaLabel({ failed, needsYou, unread: unreadCount });
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
        <SingleAvatar
          size={size}
          name={peer?.displayName ?? title}
          hueSeed={peer?.agentId ?? title}
          colorToken={peer?.avatarColorToken ?? null}
          imageUrl={peer?.avatarImageUrl ?? null}
        />
      ) : (
        <CompositeAvatar size={size} peers={peers} />
      )}
      <AttentionBadge failed={failed} needsYou={needsYou} unread={unreadCount} />
    </span>
  );
}

function SingleAvatar({
  size,
  name,
  hueSeed,
  colorToken,
  imageUrl,
}: {
  size: number;
  name: string;
  hueSeed: string;
  colorToken?: string | null;
  imageUrl?: string | null;
}) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={name}
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", display: "block" }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: resolveAvatarHue(colorToken, hueSeed),
        color: "var(--fg-on-vivid)",
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
          <Seg
            name={peers[0]?.displayName ?? "?"}
            hueSeed={peers[0]?.agentId ?? "0"}
            colorToken={peers[0]?.avatarColorToken ?? null}
            fontSize={fontSize}
          />
          <Seg
            name={peers[1]?.displayName ?? "?"}
            hueSeed={peers[1]?.agentId ?? "1"}
            colorToken={peers[1]?.avatarColorToken ?? null}
            fontSize={fontSize}
          />
        </>
      )}
      {shape === "n3" && (
        <>
          <Seg
            name={peers[0]?.displayName ?? "?"}
            hueSeed={peers[0]?.agentId ?? "0"}
            colorToken={peers[0]?.avatarColorToken ?? null}
            fontSize={fontSizeTop}
            fullWidth
          />
          <Seg
            name={peers[1]?.displayName ?? "?"}
            hueSeed={peers[1]?.agentId ?? "1"}
            colorToken={peers[1]?.avatarColorToken ?? null}
            fontSize={fontSize}
          />
          <Seg
            name={peers[2]?.displayName ?? "?"}
            hueSeed={peers[2]?.agentId ?? "2"}
            colorToken={peers[2]?.avatarColorToken ?? null}
            fontSize={fontSize}
          />
        </>
      )}
      {shape === "n4" && (
        <>
          <Seg
            name={peers[0]?.displayName ?? "?"}
            hueSeed={peers[0]?.agentId ?? "0"}
            colorToken={peers[0]?.avatarColorToken ?? null}
            fontSize={fontSize}
          />
          <Seg
            name={peers[1]?.displayName ?? "?"}
            hueSeed={peers[1]?.agentId ?? "1"}
            colorToken={peers[1]?.avatarColorToken ?? null}
            fontSize={fontSize}
          />
          <Seg
            name={peers[2]?.displayName ?? "?"}
            hueSeed={peers[2]?.agentId ?? "2"}
            colorToken={peers[2]?.avatarColorToken ?? null}
            fontSize={fontSize}
          />
          <Seg
            name={peers[3]?.displayName ?? "?"}
            hueSeed={peers[3]?.agentId ?? "3"}
            colorToken={peers[3]?.avatarColorToken ?? null}
            fontSize={fontSize}
          />
        </>
      )}
      {shape === "n5+" && (
        <>
          <Seg
            name={peers[0]?.displayName ?? "?"}
            hueSeed={peers[0]?.agentId ?? "0"}
            colorToken={peers[0]?.avatarColorToken ?? null}
            fontSize={fontSize}
          />
          <Seg
            name={peers[1]?.displayName ?? "?"}
            hueSeed={peers[1]?.agentId ?? "1"}
            colorToken={peers[1]?.avatarColorToken ?? null}
            fontSize={fontSize}
          />
          <Seg
            name={peers[2]?.displayName ?? "?"}
            hueSeed={peers[2]?.agentId ?? "2"}
            colorToken={peers[2]?.avatarColorToken ?? null}
            fontSize={fontSize}
          />
          <SegMore count={n - 3} fontSize={fontSizeMore} />
        </>
      )}
    </div>
  );
}

function Seg({
  name,
  hueSeed,
  colorToken,
  fontSize,
  fullWidth,
}: {
  name: string;
  hueSeed: string;
  colorToken?: string | null;
  fontSize: number;
  fullWidth?: boolean;
}) {
  return (
    <span
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: resolveAvatarHue(colorToken, hueSeed),
        color: "var(--fg-on-vivid)",
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

/**
 * Attention badge on the whole avatar unit (single or group composite) —
 * one small corner circle encoding the highest-priority "do I need to look
 * here" signal. failed (an agent errored, red `!`) outranks needs-you (a
 * pending AskUserQuestion, amber `?`) outranks an unread-mention count (red N).
 * Renders nothing when none apply. All three share one circle; only the colour
 * and glyph differ — failed's `!` and unread's number are both red but never
 * co-occur (failed wins), and the glyph keeps them legible.
 *
 * A tight circle (not a horizontal pill) so it reads as an avatar badge, not a
 * standalone tag stealing the title's attention. Only the rare ≥3-char unread
 * ("99+") flexes to a small capsule; `!` / `?` / 1–2 digits stay circular.
 */
function AttentionBadge({ failed, needsYou, unread }: { failed: boolean; needsYou: boolean; unread: number }) {
  if (failed) return <CornerBadge background="var(--state-error)">!</CornerBadge>;
  // Dark glyph on the light amber fill — white-on-amber (L≈0.82) is too low-contrast.
  if (needsYou)
    return (
      <CornerBadge background="var(--state-needs-you)" fg="oklch(0.28 0.07 75)">
        ?
      </CornerBadge>
    );
  const label = formatUnreadLabel(unread);
  if (label === null) return null;
  return (
    <CornerBadge background="var(--state-error)" wide={label.length >= 3}>
      {label}
    </CornerBadge>
  );
}

/** Diameter of the avatar corner badge. Small enough to read as a badge, not a
 *  tag; the bold theme-bg stroke around it adds a touch more. */
const CORNER_BADGE_SIZE = 18;

/**
 * Shared geometry for the avatar corner badge (see AttentionBadge): a solid
 * colour circle with a white glyph and a theme-background stroke that lifts it
 * off the (vivid) avatar. Static — no animation. `wide` lets the overflow
 * unread ("99+") flex to a small capsule; everything else is a fixed circle.
 */
function CornerBadge({
  background,
  children,
  wide = false,
  fg = "var(--fg-on-vivid)",
}: {
  background: string;
  children: ReactNode;
  wide?: boolean;
  fg?: string;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute",
        bottom: -2,
        right: -2,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: CORNER_BADGE_SIZE,
        height: CORNER_BADGE_SIZE,
        padding: wide ? "0 var(--sp-1)" : 0,
        borderRadius: wide ? CORNER_BADGE_SIZE / 2 : "50%",
        background,
        color: fg,
        fontSize: "var(--text-caption)",
        fontWeight: 700,
        lineHeight: 1,
        border: "var(--hairline-bold) solid var(--bg-raised)",
        boxSizing: "content-box",
        zIndex: 3,
        userSelect: "none",
      }}
    >
      {children}
    </span>
  );
}

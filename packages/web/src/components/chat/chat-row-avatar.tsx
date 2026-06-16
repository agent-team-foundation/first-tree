/**
 * ChatRowAvatar — left-side avatar slot for the conversation list row.
 *
 * Renders two orthogonal signals in one 36x36 unit:
 *
 *   1. Identity. Direct chats show one avatar; group chats use a
 *      Telegram-style split-disc composite (vertical bisection for 2,
 *      T-split for 3, 2x2 for exactly 4, 3 + "+N" tile for >=5). Each face
 *      is the peer's uploaded image, else a generated identicon.
 *   2. Attention. A single corner badge encodes the highest-priority
 *      "do I need to look here" signal: failed (an agent errored, red `!`)
 *      outranks an unread-mention count (red N, numeric up to 99 then "99+").
 *      Omitted when none apply. The activity axis ("an agent is producing
 *      output now") lives in the row's time slot (the scrolling `•••`), not here.
 *
 * The avatar no longer carries the engaged breathe ring — "engaged but
 * idle" was low-value at list-scan distance and is expressed per-agent
 * in the right sidebar instead.
 *
 * A11y: this span's `aria-label` carries the dynamic *state* only
 * (`"failed"`, `"3 unread"`). The enclosing chat-row button already
 * renders the chat title as visible text — repeating it here would
 * make screen readers announce the title twice. When the avatar has
 * no state to surface, it goes fully `aria-hidden` so the row's
 * accessible name is unchanged.
 */

import type { MeChatRow } from "@first-tree/shared";
import type { CSSProperties, ReactNode } from "react";
import { Identicon, IdenticonBlocks } from "../identicon.js";

type Participant = MeChatRow["participants"][number];

/**
 * Per-agent fill colors. References to the `--avatar-hue-0..7` tokens
 * defined in `index.css`; this file holds the *selection* logic, not
 * the colors themselves. Add or restyle hues in index.css.
 *
 * Identicon blocks (and the `+N` overflow glyph) sit on top in
 * `--fg-on-vivid` (a near-white token, also in index.css) so contrast holds
 * in both themes without relying on `--bg-raised`, which inverts under `.dark`.
 */
const AVATAR_HUE_COUNT = 8;

/** Suffix appended to a hue token when the muted (low-chroma) companion
 *  is wanted — see the `--avatar-hue-*-muted` block in `index.css`. The
 *  conversation list passes `muted` so a dense rail stays near-monochrome;
 *  every other surface keeps the vivid hue. */
function hueSuffix(muted: boolean): string {
  return muted ? "-muted" : "";
}

/**
 * Hash a stable seed (usually an agent's UUID; falls back to display
 * name if the UUID isn't around) into a fixed entry from the
 * `--avatar-hue-*` palette. Same agent → same hue across direct chats,
 * group composites, and page reloads. Cheap djb2 variant; no
 * allocations.
 *
 * `muted` selects the low-chroma companion token (same hue family,
 * desaturated) for dense contexts like the conversation list.
 *
 * Empty seed lands on `--avatar-hue-0` deterministically. Exported
 * for unit testing the deterministic-mapping contract.
 */
export function pickAvatarHue(seed: string, muted = false): string {
  if (seed.length === 0) return `var(--avatar-hue-0${hueSuffix(muted)})`;
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 33) ^ seed.charCodeAt(i);
  }
  const idx = Math.abs(hash) % AVATAR_HUE_COUNT;
  return `var(--avatar-hue-${idx}${hueSuffix(muted)})`;
}

/**
 * Manager override → hue. Accepts the loose `string | null` shape that
 * flows in from the API so unrecognised values quietly fall back to the
 * deterministic hash on `seed`. Valid tokens are "hue-0".."hue-7".
 * `muted` selects the desaturated companion (see `pickAvatarHue`).
 */
export function resolveAvatarHue(colorToken: string | null | undefined, seed: string, muted = false): string {
  if (typeof colorToken === "string" && /^hue-[0-7]$/.test(colorToken)) {
    return `var(--avatar-${colorToken}${hueSuffix(muted)})`;
  }
  return pickAvatarHue(seed, muted);
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
export function buildAvatarAriaLabel(opts: { failed: boolean; needsYou?: boolean; unread: number }): string | null {
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
  failed = false,
  needsYou = false,
  size = 36,
  muted = false,
  badge = true,
  statusDot = false,
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
  /** Any speaker in this chat is in the composite `failed` state. Outranks
   *  unread for the corner badge. */
  failed?: boolean;
  /** Caller has an unanswered open question (`format=request`) directed at
   *  them here (`openRequestCount > 0`). Red `?` corner mark (same attention
   *  red as failed/unread, told apart by glyph); ranks between failed and
   *  unread. */
  needsYou?: boolean;
  /** Pixel diameter of the avatar disc. Default 36 fits the narrow rail. */
  size?: number;
  /** Use the desaturated companion hues — set by the conversation list so a
   *  dense rail of avatars stays near-monochrome (identity by hue family,
   *  not saturation). Defaults to the vivid hues everywhere else. */
  muted?: boolean;
  /** Render the corner attention badge (`!` / unread count). The
   *  conversation list disables it (`badge={false}`) because attention and
   *  unread are carried by the avatar status dot instead; the avatar stays a
   *  clean identity disc. The state still feeds
   *  the avatar's `aria-label` regardless, so screen readers are unaffected. */
  badge?: boolean;
  /** Mainstream-IM status marker: a plain coloured dot on the avatar's
   *  TOP-right corner (no count). Failed uses a red `!`; unread uses a red
   *  dot. Used by the conversation list (with `badge={false}`) so the avatar
   *  carries the WeChat / iMessage / Telegram corner mark. */
  statusDot?: boolean;
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
          muted={muted}
        />
      ) : (
        <CompositeAvatar size={size} peers={peers} muted={muted} />
      )}
      {badge && <AttentionBadge failed={failed} unread={unreadCount} />}
      {statusDot && <ListCornerMark failed={failed} needsYou={needsYou} unread={unreadCount > 0} />}
    </span>
  );
}

/** Avatar top-right corner marker geometry (no design token covers a one-off
 *  badge; named here for self-documentation, matching `CORNER_BADGE_SIZE`).
 *  `DOT` = plain unread dot; `MARK` = the slightly larger failed glyph badge. */
const CORNER_DOT_SIZE = 9;
const CORNER_MARK_SIZE = 13;
const CORNER_OFFSET = -2;

/**
 * Conversation-list corner marker (mainstream-IM placement: avatar top-right).
 *
 * One single attention colour (red) for all three states — they are told
 * apart by *form*, not hue (DESIGN.md pillar 3: "told apart by form, not
 * hue"; §13: signals stay colour-independent). The glyph encodes which:
 *   - failed    → `!` (an agent errored)
 *   - needs_you → `?` (an unanswered open question directed at you)
 *   - unread    → a plain dot (no glyph)
 * Glyph-vs-plain-dot also mirrors the priority order failed > needs_you >
 * unread; renders nothing otherwise.
 */
function ListCornerMark({ failed, needsYou, unread }: { failed: boolean; needsYou: boolean; unread: boolean }) {
  if (failed) return <CornerMark background="var(--state-error)" fg="var(--fg-on-vivid)" glyph="!" />;
  if (needsYou) return <CornerMark background="var(--state-error)" fg="var(--fg-on-vivid)" glyph="?" />;
  if (unread) return <CornerMark background="var(--state-unread)" />;
  return null;
}

function CornerMark({ background, fg, glyph }: { background: string; fg?: string; glyph?: string }) {
  const size = glyph ? CORNER_MARK_SIZE : CORNER_DOT_SIZE;
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute",
        top: CORNER_OFFSET,
        right: CORNER_OFFSET,
        minWidth: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "50%",
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
      {glyph}
    </span>
  );
}

function SingleAvatar({
  size,
  name,
  hueSeed,
  colorToken,
  imageUrl,
  muted = false,
}: {
  size: number;
  name: string;
  hueSeed: string;
  colorToken?: string | null;
  imageUrl?: string | null;
  muted?: boolean;
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
  return <Identicon seed={hueSeed} size={size} color={resolveAvatarHue(colorToken, hueSeed, muted)} />;
}

function CompositeAvatar({
  size,
  peers,
  muted = false,
}: {
  size: number;
  peers: ReadonlyArray<Participant>;
  muted?: boolean;
}) {
  // Layout decision keyed off `pickCompositeShape` (see header docstring):
  //   n2  → vertical bisection
  //   n3  → T-split (top spans full width, bottom is 2 cells)
  //   n4  → 2x2 grid, all four visible (matches conventional group UX)
  //   n5+ → 2x2 grid, first three peers + "+N" overflow tile where N = n - 3
  const n = peers.length;
  const shape = pickCompositeShape(n);
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
          <Seg peer={peers[0]} idx={0} muted={muted} />
          <Seg peer={peers[1]} idx={1} muted={muted} />
        </>
      )}
      {shape === "n3" && (
        <>
          <Seg peer={peers[0]} idx={0} fullWidth muted={muted} />
          <Seg peer={peers[1]} idx={1} muted={muted} />
          <Seg peer={peers[2]} idx={2} muted={muted} />
        </>
      )}
      {shape === "n4" && (
        <>
          <Seg peer={peers[0]} idx={0} muted={muted} />
          <Seg peer={peers[1]} idx={1} muted={muted} />
          <Seg peer={peers[2]} idx={2} muted={muted} />
          <Seg peer={peers[3]} idx={3} muted={muted} />
        </>
      )}
      {shape === "n5+" && (
        <>
          <Seg peer={peers[0]} idx={0} muted={muted} />
          <Seg peer={peers[1]} idx={1} muted={muted} />
          <Seg peer={peers[2]} idx={2} muted={muted} />
          <SegMore count={n - 3} fontSize={fontSizeMore} />
        </>
      )}
    </div>
  );
}

function Seg({
  peer,
  idx,
  fullWidth,
  muted = false,
}: {
  /** The peer in this slot, or `undefined` for a defensive empty cell. */
  peer: Participant | undefined;
  /** Slot index — fallback seed so an empty cell still gets a distinct hue. */
  idx: number;
  fullWidth?: boolean;
  muted?: boolean;
}) {
  const seed = peer?.agentId ?? String(idx);
  const base: CSSProperties = {
    display: "block",
    width: "100%",
    height: "100%",
    overflow: "hidden",
    ...(fullWidth ? { gridColumn: "1 / -1" } : null),
  };
  // Mirror SingleAvatar's fallback chain: uploaded image first, else the
  // deterministic identicon. `slice` cover-crops the square grid into the
  // (often non-square) composite cell without distorting the pixels.
  if (peer?.avatarImageUrl) {
    return <img src={peer.avatarImageUrl} alt="" style={{ ...base, objectFit: "cover" }} />;
  }
  return (
    <span
      style={{
        ...base,
        background: resolveAvatarHue(peer?.avatarColorToken ?? null, seed, muted),
        color: "var(--fg-on-vivid)",
      }}
    >
      <IdenticonBlocks seed={seed} preserveAspectRatio="xMidYMid slice" />
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
 * here" signal. failed (an agent errored, red `!`) outranks an unread-mention
 * count (red N). Renders nothing when none apply. Both share one circle; only
 * the colour and glyph differ — failed's `!` and unread's number are both red
 * but never co-occur (failed wins), and the glyph keeps them legible.
 *
 * A tight circle (not a horizontal pill) so it reads as an avatar badge, not a
 * standalone tag stealing the title's attention. Only the rare ≥3-char unread
 * ("99+") flexes to a small capsule; `!` / `?` / 1–2 digits stay circular.
 */
function AttentionBadge({ failed, unread }: { failed: boolean; unread: number }) {
  if (failed) return <CornerBadge background="var(--state-error)">!</CornerBadge>;
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

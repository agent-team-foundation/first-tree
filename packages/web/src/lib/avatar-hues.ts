/**
 * Canvas-baking colours for pixel avatars, read from the LIVE CSS custom
 * properties so index.css stays the single source of truth for the avatar
 * palette (DESIGN.md: the --avatar-hue-* block is canonical). The picker
 * preview already renders candidates straight from those tokens; baking to a
 * canvas needs a concrete colour, so we let the browser resolve the token to a
 * concrete sRGB string via a throwaway probe element. No palette values are
 * duplicated in TypeScript, so the previewed candidate and the baked image can
 * never drift from each other or from the CSS tokens.
 */

/** Number of --avatar-hue-* tokens defined in index.css. Structural, not a
 *  colour value — kept in step with the palette length there (and with
 *  `pickAvatarHue`'s modulus in chat-row-avatar). */
export const AVATAR_HUE_COUNT = 8;

/**
 * Resolve a CSS colour expression (including a custom-property reference) to a
 * concrete sRGB string the canvas can paint. Browser-only — uses the DOM and
 * the computed-style engine, which serialises any colour (oklch, token, …) to a
 * concrete sRGB value.
 */
function resolveCssColor(expression: string): string {
  const probe = document.createElement("span");
  probe.style.color = expression;
  probe.style.position = "absolute";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved || expression;
}

/** The vivid avatar-hue token at `idx`, resolved to a concrete colour for baking. */
export function avatarHueColor(idx: number): string {
  return resolveCssColor(`var(--avatar-hue-${idx})`);
}

/** The near-white --fg-on-vivid token (the identicon block colour), resolved. */
export function fgOnVividColor(): string {
  return resolveCssColor("var(--fg-on-vivid)");
}

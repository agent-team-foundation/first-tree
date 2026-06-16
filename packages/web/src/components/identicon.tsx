/**
 * Identicon — deterministic GitHub-style block avatar.
 *
 * Renders the symmetric on/off grid from `@first-tree/shared`'s
 * `identiconCells` as inline `<rect>`s. The pattern comes from `seed`; the
 * colour is the caller's concern — pass a resolved `color` (typically a themed
 * `--avatar-hue-*` token via `resolveAvatarHue`) so the avatar shares the
 * subject's hue everywhere else in the UI.
 *
 * Palette is inverted GitHub-style: the hue fills the tile and the blocks are
 * near-white (`--fg-on-vivid`, painted via `currentColor`). This is the exact
 * pairing the app already guarantees WCAG AA for — the same near-white-on-hue
 * used for initials (see index.css) — and it's theme-invariant, so the avatar
 * looks identical in light and dark. It also unifies the identicon with the
 * existing vivid-disc avatars: "the disc, with a pattern instead of an initial".
 *
 * Circular, to match every other avatar surface (uploaded images, group
 * composites, baked pixel avatars). The inverted palette makes the circular
 * clip harmless — it only trims hue-coloured corners, never a block.
 *
 * Presentational by default (`aria-hidden`); pass `label` to give it an
 * `aria-label` when it stands alone without a labelled wrapper.
 */

import { identiconCells } from "@first-tree/shared";
import type { CSSProperties, ReactNode } from "react";

const VIEWBOX = 100;

export function Identicon({
  seed,
  size,
  color,
  gridSize = 5,
  className,
  label,
}: {
  /** Stable seed (typically an agent uuid; display name is an acceptable fallback). */
  seed: string;
  /** Pixel width/height of the round tile. */
  size: number;
  /** Resolved tile/hue colour (e.g. `resolveAvatarHue(token, seed)` → `var(--avatar-hue-2)`). */
  color: string;
  /** Grid resolution. 5 reads well at small sizes; larger grids blur when tiny. */
  gridSize?: number;
  className?: string;
  /** When set, exposes the tile as `role="img"` with this label; otherwise `aria-hidden`. */
  label?: string;
}) {
  const cells = identiconCells(seed, gridSize);
  const block = VIEWBOX / (gridSize + 1);
  const margin = block / 2;

  const rects: ReactNode[] = [];
  for (let y = 0; y < gridSize; y++) {
    const row = cells[y];
    if (!row) continue;
    for (let x = 0; x < gridSize; x++) {
      if (!row[x]) continue;
      rects.push(<rect key={`${x}-${y}`} x={margin + x * block} y={margin + y * block} width={block} height={block} />);
    }
  }

  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    background: color,
    color: "var(--fg-on-vivid)",
    display: "block",
    overflow: "hidden",
    flexShrink: 0,
    userSelect: "none",
  };
  const a11y = label === undefined ? { "aria-hidden": true as const } : { role: "img", "aria-label": label };

  return (
    <span className={className} style={style} {...a11y}>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
        width={size}
        height={size}
        fill="currentColor"
        style={{ display: "block" }}
      >
        {rects}
      </svg>
    </span>
  );
}

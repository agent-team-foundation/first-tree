/**
 * Concrete sRGB values for the avatar palette, for baking pixel avatars onto a
 * `<canvas>` (which cannot read CSS custom properties).
 *
 * These mirror the `--avatar-hue-0..7` and `--fg-on-vivid` tokens in
 * `index.css`. The tokens are theme-invariant (defined once; the `.dark` block
 * only re-skins the neutral `--bg-*` surfaces), so a single sRGB conversion is
 * faithful in both light and dark mode. Keep this list in sync with index.css.
 */

/** `[L, C, Hdeg]` for `--avatar-hue-0..7`, in source order. */
const AVATAR_HUE_OKLCH: ReadonlyArray<readonly [number, number, number]> = [
  [0.66, 0.16, 150], // green (empty-seed fallback)
  [0.62, 0.17, 250], // blue
  [0.6, 0.18, 295], // purple
  [0.65, 0.2, 0], // pink
  [0.68, 0.16, 50], // orange
  [0.65, 0.13, 200], // teal
  [0.72, 0.15, 90], // amber
  [0.55, 0.17, 270], // indigo
];

export const AVATAR_HUE_COUNT = AVATAR_HUE_OKLCH.length;

function clamp8(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

function hex2(value: number): string {
  return clamp8(value).toString(16).padStart(2, "0");
}

/** OKLCH → sRGB hex (`#rrggbb`). Standard OKLab → linear sRGB → gamma encode. */
export function oklchToHex(l: number, c: number, hDeg: number): string {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const lr = l_ * l_ * l_;
  const mr = m_ * m_ * m_;
  const sr = s_ * s_ * s_;
  const rLin = 4.0767416621 * lr - 3.3077115913 * mr + 0.2309699292 * sr;
  const gLin = -1.2684380046 * lr + 2.6097574011 * mr - 0.3413193965 * sr;
  const bLin = -0.0041960863 * lr - 0.7034186147 * mr + 1.707614701 * sr;
  const enc = (x: number): number => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
  return `#${hex2(enc(rLin))}${hex2(enc(gLin))}${hex2(enc(bLin))}`;
}

/** `--avatar-hue-0..7` as sRGB hex strings, index-aligned with the CSS tokens. */
export const AVATAR_HUE_HEX: readonly string[] = AVATAR_HUE_OKLCH.map(([l, c, h]) => oklchToHex(l, c, h));

/** `--fg-on-vivid` (near-white) as sRGB hex — the identicon block colour. */
export const FG_ON_VIVID_HEX: string = oklchToHex(0.985, 0, 0);

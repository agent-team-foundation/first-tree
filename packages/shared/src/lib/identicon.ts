/**
 * GitHub-style identicon generator: a pure, zero-dependency function that
 * turns a stable seed (an agent's uuid, a user/org id, …) into a deterministic
 * "block face" — a symmetric pixel grid, like the default avatars on GitHub.
 *
 * Runs identically in Node and the browser: hashing is a tiny inline JS hash
 * (no `node:crypto`, no Web Crypto), so the same seed yields the same pattern
 * on the server, in the web bundle, and in tests.
 *
 * Pattern: `cyrb128(seed)` → seeds an `sfc32` PRNG (warmed a few iterations to
 * de-correlate its first outputs, otherwise nearby seeds cluster) → fills the
 * left half + center column of an N×N grid, then mirrors horizontally for the
 * symmetric look.
 *
 * Colour is intentionally the caller's concern. `identiconCells` returns
 * geometry only; `identiconSvg` paints the blocks with whatever `color` you
 * pass and defaults to `"currentColor"` so that, when the SVG is inlined in
 * the DOM, the surrounding element's CSS `color` (e.g. a themed
 * `--avatar-hue-*` token) flows through and adapts to light/dark mode. This is
 * what lets an identicon share a subject's avatar hue everywhere else in the UI
 * rather than inventing its own.
 */

const DEFAULT_GRID_SIZE = 5;
/** Fraction of left-half cells turned on. ~0.5 reads like GitHub's parity fill:
 *  dense enough to feel like a face, sparse enough to stay distinct. */
const FILL_RATE = 0.5;
/** Discard the PRNG's first outputs; without this, similar seeds produce
 *  visibly similar patterns and the colour hue clusters. */
const PRNG_WARMUP = 12;
/** Normalised SVG coordinate space; `size` only sets the rendered width/height. */
const VIEWBOX = 100;

/** Hash a string into four 32-bit unsigned integers (128 bits of entropy). */
function cyrb128(seed: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** Small fast counter PRNG seeded from four 32-bit ints → values in [0, 1). */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return (): number => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * The on/off grid for `seed`: a `gridSize × gridSize` matrix, left/right
 * mirror-symmetric. Deterministic — the same `(seed, gridSize)` always yields
 * the same matrix. `cells[y][x]` is `true` where a block is painted.
 */
export function identiconCells(seed: string, gridSize: number = DEFAULT_GRID_SIZE): boolean[][] {
  const [a, b, c, d] = cyrb128(seed);
  const rand = sfc32(a, b, c, d);
  for (let i = 0; i < PRNG_WARMUP; i++) rand();

  const cells: boolean[][] = Array.from({ length: gridSize }, () => new Array<boolean>(gridSize).fill(false));
  const half = Math.ceil(gridSize / 2);
  for (let y = 0; y < gridSize; y++) {
    // `cells` is dense: one row per y in `0..gridSize-1`.
    const row = cells[y] as boolean[];
    for (let x = 0; x < half; x++) {
      const on = rand() < FILL_RATE;
      row[x] = on;
      row[gridSize - 1 - x] = on;
    }
  }
  return cells;
}

export type IdenticonSvgOptions = {
  /** Grid resolution. 5 (default) reads well at small avatar sizes; larger
   *  grids look more intricate but blur below ~32px. */
  gridSize?: number;
  /** Rendered pixel width/height. Omit to leave the SVG fluid (viewBox only). */
  size?: number;
  /** Block fill. Defaults to `"currentColor"` so an inlined SVG inherits the
   *  surrounding element's themed colour. */
  color?: string;
  /** Background rect fill. Omit for a transparent background. */
  background?: string;
};

/** Trim trailing-zero float noise from coordinates (e.g. `16.67`, not `16.670000…`). */
function coord(value: number): string {
  return Number(value.toFixed(3)).toString();
}

/**
 * A complete, self-contained SVG string for `seed`. Inline it in the DOM (not
 * as an `<img src>` data URI) when you want `"currentColor"` / CSS variables to
 * resolve against the page; rendered as an image it is isolated and only
 * literal colours show.
 */
export function identiconSvg(seed: string, options: IdenticonSvgOptions = {}): string {
  const { gridSize = DEFAULT_GRID_SIZE, size, color = "currentColor", background } = options;
  const cells = identiconCells(seed, gridSize);
  const block = VIEWBOX / (gridSize + 1);
  const margin = block / 2;

  let rects = "";
  for (let y = 0; y < gridSize; y++) {
    const row = cells[y] as boolean[];
    for (let x = 0; x < gridSize; x++) {
      if (!row[x]) continue;
      rects += `<rect x="${coord(margin + x * block)}" y="${coord(margin + y * block)}" width="${coord(block)}" height="${coord(block)}"/>`;
    }
  }

  const dims = size === undefined ? "" : ` width="${size}" height="${size}"`;
  const bg = background === undefined ? "" : `<rect width="${VIEWBOX}" height="${VIEWBOX}" fill="${background}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}"${dims} fill="${color}">${bg}${rects}</svg>`;
}

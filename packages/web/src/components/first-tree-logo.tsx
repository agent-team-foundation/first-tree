import type { SVGProps } from "react";

/**
 * Official First Tree brand logo — pixel-art tree from https://first-tree.ai/.
 *
 * Native aspect ratio is 9:10 (viewBox 0 0 9 10). Pass matching `width` and
 * `height` (e.g. 9×10, 14×16, 18×20) to avoid distortion. `shape-rendering`
 * keeps the pixel rectangles crisp at any size; `currentColor` lets callers
 * drive the color via the surrounding `color` / `--fg` / `--brand`.
 */
export function FirstTreeLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 9 10"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
      {...props}
    >
      <rect x="4" y="0" width="1" height="1" />
      <rect x="3" y="1" width="3" height="1" />
      <rect x="2" y="2" width="5" height="1" />
      <rect x="3" y="3" width="3" height="1" />
      <rect x="2" y="4" width="5" height="1" />
      <rect x="1" y="5" width="7" height="1" />
      <rect x="2" y="6" width="5" height="1" />
      <rect x="1" y="7" width="7" height="1" />
      <rect x="0" y="8" width="9" height="1" />
      <rect x="3" y="9" width="3" height="1" />
    </svg>
  );
}

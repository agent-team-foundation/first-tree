import { isNavigableWebHref } from "../lib/safe-href.js";

/**
 * Minimal local hast shapes for the fields this transform reads and rewrites.
 * This mirrors `rehype-mentions.ts` and avoids making a transitive hast type a
 * direct package dependency.
 */
type HastText = { type: "text"; value: string };
type HastElement = {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
};
type HastRoot = { type: "root"; children: HastNode[] };
type HastNode = HastText | HastElement | HastRoot | { type: string; children?: HastNode[]; tagName?: string };

function text(value: string): HastText {
  return { type: "text", value };
}

function stringProperty(element: HastElement, name: string): string {
  const value = element.properties?.[name];
  return typeof value === "string" ? value : "";
}

/**
 * A removed image may leave behind a navigation link, but never a resource
 * fetch. Limit that link to an HTTP(S) web target; image-shaped `data:`,
 * `blob:`, `javascript:`, attachment, filesystem, and other schemes remain
 * inert text.
 */
function safeImageHref(value: string): string | null {
  const href = value.trim();
  if (!/^(?:https?:)?\/\//i.test(href) || !isNavigableWebHref(href)) return null;
  return href;
}

function replacementForImage(image: HastElement, insideLink: boolean): HastNode[] {
  const alt = stringProperty(image, "alt") || "Image";
  if (insideLink) return [text(alt)];

  const href = safeImageHref(stringProperty(image, "src"));
  if (!href) return [text(alt)];

  return [
    text(`${alt} (`),
    {
      type: "element",
      tagName: "a",
      properties: { href },
      children: [text("View image")],
    },
    text(")"),
  ];
}

function rewriteChildren(parent: HastRoot | HastElement, insideLink: boolean): void {
  const rewritten: HastNode[] = [];

  for (const child of parent.children) {
    if (child.type !== "element") {
      rewritten.push(child);
      continue;
    }

    // The fallback member of HastNode overlaps the `element` discriminator, so
    // this assertion follows the runtime type check and exposes the fields the
    // transform needs without weakening the public types.
    const element = child as HastElement;
    if (element.tagName === "img") {
      rewritten.push(...replacementForImage(element, insideLink));
      continue;
    }

    const childInsideLink = insideLink || element.tagName === "a";
    rewriteChildren(element, childInsideLink);
    rewritten.push(element);
  }

  parent.children = rewritten;
}

/**
 * Remove every image resource node from rendered Markdown. Standalone images
 * become alt text plus a safe, explicit navigation link to the source. Images
 * already inside a link become alt text only, preserving the sanitized outer
 * link without creating invalid nested anchors.
 */
export function rehypeNonFetchingImages(): (tree: HastRoot) => void {
  return (tree) => rewriteChildren(tree, false);
}

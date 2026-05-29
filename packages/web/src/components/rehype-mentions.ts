import { MENTION_REGEX, type MentionParticipant } from "@first-tree/shared";

/**
 * Rehype plugin: walks the hast tree, finds `@<participant>` tokens
 * inside `text` nodes, and rewrites them to `span.mention-chip` elements.
 * Code regions (`<code>`, `<pre>`) and existing `<a>` link text are
 * skipped — chips inside a code fence would clash with the editor's
 * formatting and a chip inside a link would double-style.
 *
 * The participant list is captured by closure and resolved
 * case-insensitively, matching the server's `extractMentions` resolver
 * so the chip appears for exactly the same tokens the router would
 * fan out to.
 *
 * Returns a function compatible with react-markdown's `rehypePlugins`
 * prop. Local minimal hast types avoid pulling in `@types/hast` and
 * `unist-util-visit` as direct deps — the shape is stable across
 * mdast-util-to-hast versions and the plugin only reads two fields
 * (`type`, `tagName`) plus children, so a local declaration is safer
 * than a transitive dep edge.
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

const SKIP_TAGS = new Set(["code", "pre", "a"]);

function makeMentionElement(value: string, name: string, agentId: string, isSelf: boolean): HastElement {
  return {
    type: "element",
    tagName: "span",
    properties: {
      // Self-mentions get an extra class so the css can paint them in the
      // attention/unread tone — the viewer needs to spot "this one's about
      // me" before the brand-green chips around it.
      className: isSelf ? ["mention-chip", "mention-chip-self"] : ["mention-chip"],
      "data-mention-agent-id": agentId,
      "data-mention-name": name,
    },
    children: [{ type: "text", value }],
  };
}

function splitTextNode(
  node: HastText,
  nameMap: Map<string, { name: string; agentId: string }>,
  selfAgentId: string | null,
): HastNode[] | null {
  const content = node.value;
  if (!content) return null;
  const out: HastNode[] = [];
  let cursor = 0;
  for (const m of content.matchAll(MENTION_REGEX)) {
    const token = m[1];
    if (token === undefined || m.index === undefined) continue;
    const resolved = nameMap.get(token.toLowerCase());
    if (!resolved) continue;
    if (m.index > cursor) {
      out.push({ type: "text", value: content.slice(cursor, m.index) });
    }
    out.push(makeMentionElement(m[0], resolved.name, resolved.agentId, resolved.agentId === selfAgentId));
    cursor = m.index + m[0].length;
  }
  if (out.length === 0) return null; // no rewrites — leave node intact
  if (cursor < content.length) {
    out.push({ type: "text", value: content.slice(cursor) });
  }
  return out;
}

function walk(
  node: HastNode,
  nameMap: Map<string, { name: string; agentId: string }>,
  selfAgentId: string | null,
): void {
  if (!("children" in node) || !node.children) return;
  const next: HastNode[] = [];
  for (const child of node.children) {
    // `as` is needed because the union's fallback (`{ type: string; ... }`)
    // overlaps with the discriminator literal `"element"`, so TS can't
    // auto-narrow to HastElement from `type === "element"` alone. The
    // runtime check above is the actual guarantee.
    if (child.type === "element") {
      const el = child as HastElement;
      if (SKIP_TAGS.has(el.tagName)) {
        next.push(el);
        continue;
      }
      walk(el, nameMap, selfAgentId);
      next.push(el);
    } else if (child.type === "text") {
      // Same `as` rationale as above — fallback overlap on string discriminator.
      const split = splitTextNode(child as HastText, nameMap, selfAgentId);
      if (split) next.push(...split);
      else next.push(child);
    } else {
      next.push(child);
    }
  }
  node.children = next;
}

export function rehypeMentions(
  participants: MentionParticipant[],
  options?: { selfAgentId?: string | null },
): () => (tree: HastRoot) => void {
  const selfAgentId = options?.selfAgentId ?? null;
  const nameMap = new Map<string, { name: string; agentId: string }>();
  for (const p of participants) {
    if (p.name) nameMap.set(p.name.toLowerCase(), { name: p.name, agentId: p.agentId });
  }
  return () => (tree: HastRoot) => {
    if (nameMap.size === 0) return;
    walk(tree, nameMap, selfAgentId);
  };
}

import { MENTION_REGEX, type MentionParticipant } from "@first-tree/shared";

/**
 * Chat-scoped identity shape used only by the sent-message renderer.
 *
 * Routing and composer parsing deliberately keep using the narrower
 * {@link MentionParticipant} (`agentId` + immutable `name`). `displayName` is
 * presentation-only: it may contain spaces, non-ASCII characters, collide
 * with another participant, or change after the message was sent.
 */
export type RenderedMentionParticipant = MentionParticipant & {
  displayName: string;
};

/**
 * Rehype plugin: walks the hast tree, finds `@<participant>` tokens
 * inside `text` nodes, and rewrites them to `span.mention-chip` elements.
 * Code regions (`<code>`, `<pre>`) and existing `<a>` link text are
 * skipped — chips inside a code fence would clash with the editor's
 * formatting and a chip inside a link would double-style.
 *
 * The participant list is captured by closure and resolved
 * case-insensitively, matching the server's `extractMentions` resolver.
 * Historical callers can additionally restrict resolution to persisted
 * recipient IDs without shrinking the full-roster collision universe used to
 * disambiguate duplicate display names.
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

type RenderedMentionIdentity = {
  name: string;
  displayName: string;
  agentId: string;
  disambiguate: boolean;
};

function makeMentionElement(identity: RenderedMentionIdentity, isSelf: boolean): HastElement {
  const displayName = identity.displayName.trim() || identity.name;
  const displayLabel = `@${displayName}`;
  const identityLabel = displayName === identity.name ? displayLabel : `${displayLabel} (@${identity.name})`;

  return {
    type: "element",
    tagName: "span",
    properties: {
      // Self-mentions get an extra `is-self` state class so the css can
      // paint them in the attention/unread tone — the viewer needs to
      // spot "this one's about me" before the brand-green chips around
      // it. `is-x` matches the repo's existing state-modifier convention
      // (`.context-network-card.is-live`, `.context-usage-feed-row.is-fresh`).
      className: isSelf ? ["mention-chip", "is-self"] : ["mention-chip"],
      "data-mention-agent-id": identity.agentId,
      "data-mention-name": identity.name,
      "data-mention-display-name": displayName,
      title: identityLabel,
      ariaLabel: identityLabel,
    },
    children: [
      {
        type: "element",
        tagName: "span",
        properties: { className: ["mention-chip-display"] },
        children: [{ type: "text", value: displayLabel }],
      },
      ...(identity.disambiguate
        ? [
            {
              type: "element" as const,
              tagName: "span",
              properties: { className: ["mention-chip-handle"] },
              children: [{ type: "text" as const, value: `(@${identity.name})` }],
            },
          ]
        : []),
    ],
  };
}

function splitTextNode(
  node: HastText,
  nameMap: Map<string, RenderedMentionIdentity>,
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
    out.push(makeMentionElement(resolved, resolved.agentId === selfAgentId));
    cursor = m.index + m[0].length;
  }
  if (out.length === 0) return null; // no rewrites — leave node intact
  if (cursor < content.length) {
    out.push({ type: "text", value: content.slice(cursor) });
  }
  return out;
}

function walk(node: HastNode, nameMap: Map<string, RenderedMentionIdentity>, selfAgentId: string | null): void {
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
  participants: RenderedMentionParticipant[],
  options?: { selfAgentId?: string | null; allowedAgentIds?: ReadonlySet<string> },
): () => (tree: HastRoot) => void {
  const selfAgentId = options?.selfAgentId ?? null;
  const allowedAgentIds = options?.allowedAgentIds;
  const nameMap = new Map<string, RenderedMentionIdentity>();
  const displayNameCounts = new Map<string, number>();

  // Count across the full visible speaker roster. A message that mentions only
  // one of two people called "Sam" still needs to expose that person's handle.
  for (const participant of participants) {
    if (!participant.name) continue;
    const displayName = participant.displayName.trim() || participant.name;
    const key = displayName.toLowerCase();
    displayNameCounts.set(key, (displayNameCounts.get(key) ?? 0) + 1);
  }

  for (const p of participants) {
    // Resolution is a separate identity decision. Historical callers allow
    // only the IDs persisted for this message, so handle reuse cannot relabel
    // an old token even though the new owner remains in the collision roster.
    if (p.name && (!allowedAgentIds || allowedAgentIds.has(p.agentId))) {
      const displayName = p.displayName.trim() || p.name;
      nameMap.set(p.name.toLowerCase(), {
        name: p.name,
        displayName,
        agentId: p.agentId,
        // displayName is mutable and non-unique. Keep the common case terse,
        // but make collisions distinguishable on touch devices where a title
        // tooltip is not discoverable. If the label is already this person's
        // canonical handle, adding the same handle again would be redundant.
        disambiguate: (displayNameCounts.get(displayName.toLowerCase()) ?? 0) > 1 && displayName !== p.name,
      });
    }
  }
  return () => (tree: HastRoot) => {
    if (nameMap.size === 0) return;
    walk(tree, nameMap, selfAgentId);
  };
}

/**
 * Reconstruct the selected plain text with canonical `@name` handles.
 *
 * Sent messages render the friendlier `@displayName`, but copied text needs to
 * remain pasteable into the composer and CLI. Returning `null` means the
 * selection contains no complete rendered mention and native copy behaviour
 * should proceed unchanged.
 */
type SelectedMention = {
  name: string;
  visibleText: string;
  chip: HTMLElement;
};

function selectedMentions(root: HTMLElement, selection: Selection | null): SelectedMention[] | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!range.intersectsNode(root)) return null;

  const mentions: SelectedMention[] = [];
  const chips = root.querySelectorAll<HTMLElement>(".mention-chip[data-mention-name]");

  for (const chip of chips) {
    if (!range.intersectsNode(chip)) continue;
    const visibleText = chip.textContent;
    const name = chip.dataset.mentionName;
    if (!visibleText || !name) continue;

    // Only rewrite a fully selected chip. A selection that begins or ends
    // inside the visible label should retain the browser's native partial text.
    // Compare the selection against the chip's textual boundaries, not the
    // surrounding element boundaries. A user can drag from text offset 0 to
    // the final offset and visibly select the whole label without selecting
    // the span node itself.
    const textWalker = root.ownerDocument.createTreeWalker(chip, 4); // NodeFilter.SHOW_TEXT
    const firstText = textWalker.nextNode();
    let lastText = firstText;
    for (let node = textWalker.nextNode(); node; node = textWalker.nextNode()) lastText = node;
    if (firstText?.nodeType !== 3 || lastText?.nodeType !== 3) continue;

    const chipRange = root.ownerDocument.createRange();
    chipRange.setStart(firstText, 0);
    chipRange.setEnd(lastText, lastText.textContent?.length ?? 0);
    if (
      range.compareBoundaryPoints(range.START_TO_START, chipRange) > 0 ||
      range.compareBoundaryPoints(range.END_TO_END, chipRange) < 0
    ) {
      continue;
    }

    mentions.push({ name, visibleText, chip });
  }

  return mentions.length > 0 ? mentions : null;
}

type CanonicalSelectionFragment = {
  fragment: DocumentFragment;
  mentions: SelectedMention[];
  pending: SelectedMention[];
};

/**
 * Clone the selected DOM once, then replace every complete mention chip in
 * document order. Plain and rich clipboard payloads are both derived from this
 * same clone, so rendered line breaks never become offsets into a different
 * string representation.
 */
function selectionFragmentWithMentionHandles(
  root: HTMLElement,
  selection: Selection | null,
): CanonicalSelectionFragment | null {
  const mentions = selectedMentions(root, selection);
  if (!mentions || !selection) return null;

  const markerAttribute = "data-mention-copy-index";
  const previousMarkers = mentions.map(({ chip }) => chip.getAttribute(markerAttribute));
  for (const [index, mention] of mentions.entries()) {
    mention.chip.setAttribute(markerAttribute, String(index));
  }

  let fragment: DocumentFragment;
  try {
    fragment = selection.getRangeAt(0).cloneContents();
  } finally {
    for (const [index, mention] of mentions.entries()) {
      const previous = previousMarkers[index];
      if (previous === null || previous === undefined) mention.chip.removeAttribute(markerAttribute);
      else mention.chip.setAttribute(markerAttribute, previous);
    }
  }

  const pending = [...mentions];
  for (const chip of fragment.querySelectorAll<HTMLElement>(`[${markerAttribute}]`)) {
    const index = Number(chip.getAttribute(markerAttribute));
    const mention = mentions[index];
    if (!mention) continue;
    chip.replaceWith(root.ownerDocument.createTextNode(`@${mention.name}`));
    const pendingIndex = pending.indexOf(mention);
    if (pendingIndex >= 0) pending.splice(pendingIndex, 1);
  }

  return { fragment, mentions, pending };
}

/** Read a detached selection fragment through the browser's rendered-text
 * algorithm. The temporary node stays off-screen (rather than display:none)
 * because `innerText` deliberately ignores layout for non-rendered content. */
function renderedTextFromFragment(root: HTMLElement, fragment: DocumentFragment): string {
  const container = root.ownerDocument.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-200vw";
  container.style.top = "0";
  container.style.width = "100vw";
  container.style.whiteSpace = "pre-wrap";
  container.append(fragment);

  const body = root.ownerDocument.body;
  if (!body) return container.textContent ?? "";
  body.append(container);
  try {
    return container.innerText;
  } finally {
    container.remove();
  }
}

export function copyTextWithMentionHandles(root: HTMLElement, selection: Selection | null): string | null {
  const rewritten = selectionFragmentWithMentionHandles(root, selection);
  if (!rewritten || !selection) return null;

  // A range whose common ancestor is the chip's text node clones only that
  // text, not its wrapping span/data attributes. This is the sole useful
  // pending shape: the user selected exactly one complete chip.
  if (
    rewritten.pending.length === 1 &&
    rewritten.mentions.length === 1 &&
    selection.toString() === rewritten.pending[0]?.visibleText
  ) {
    return `@${rewritten.pending[0].name}`;
  }
  if (rewritten.pending.length > 0) return null;

  return renderedTextFromFragment(root, rewritten.fragment);
}

/**
 * Preserve native rich-text copy while rewriting complete mention chips to
 * canonical handles. Consumers should set this alongside the plain-text
 * payload so pasting into Docs/Notion retains links and emphasis.
 */
export function copyHtmlWithMentionHandles(root: HTMLElement, selection: Selection | null): string | null {
  const rewritten = selectionFragmentWithMentionHandles(root, selection);
  if (!rewritten || !selection) return null;
  const container = root.ownerDocument.createElement("div");
  // When the selection starts and ends directly inside a chip's text node,
  // cloneContents() has no ancestor span to rewrite. Fall back to escaped
  // canonical plain text for that boundary-only case instead of leaking the
  // presentation label back into a rich paste.
  if (rewritten.pending.length > 0) {
    container.textContent = copyTextWithMentionHandles(root, selection) ?? selection.toString();
    return container.innerHTML;
  }
  container.append(rewritten.fragment);
  return container.innerHTML;
}

/**
 * Observe copy at the document boundary, where the Clipboard API dispatches
 * non-editable timeline copies (the focused node may be body, the composer, or
 * another control). The selection itself is the scope boundary: helpers return
 * null unless a complete mention inside this timeline is selected.
 */
export function installTimelineMentionCopy(ownerDocument: Document, timeline: () => HTMLElement | null): () => void {
  const handleCopy = (event: ClipboardEvent) => {
    if (event.defaultPrevented || !event.clipboardData) return;
    const root = timeline();
    if (!root) return;
    const selection = ownerDocument.getSelection();
    const copiedText = copyTextWithMentionHandles(root, selection);
    if (copiedText === null) return;
    const copiedHtml = copyHtmlWithMentionHandles(root, selection);

    event.preventDefault();
    event.clipboardData.setData("text/plain", copiedText);
    if (copiedHtml !== null) event.clipboardData.setData("text/html", copiedHtml);
  };

  ownerDocument.addEventListener("copy", handleCopy);
  return () => ownerDocument.removeEventListener("copy", handleCopy);
}

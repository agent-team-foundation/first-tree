// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import {
  copyHtmlWithMentionHandles,
  copyTextWithMentionHandles,
  type RenderedMentionParticipant,
  rehypeMentions,
} from "../rehype-mentions.js";

type TestNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: TestNode[];
};

function makeRoot(...children: TestNode[]): TestNode {
  return { type: "root", children };
}

function paragraph(...children: TestNode[]): TestNode {
  return { type: "element", tagName: "p", properties: {}, children };
}

function text(value: string): TestNode {
  return { type: "text", value };
}

function visibleChipText(node: TestNode | undefined): string {
  return (node?.children ?? [])
    .flatMap((child) => child.children ?? [child])
    .map((child) => child.value ?? "")
    .join("");
}

function inlineCode(value: string): TestNode {
  return { type: "element", tagName: "code", properties: {}, children: [text(value)] };
}

const PARTICIPANTS: RenderedMentionParticipant[] = [
  { agentId: "agent-self", name: "me", displayName: "Me" },
  { agentId: "agent-other", name: "alice", displayName: "Alice Chen" },
];

function runPlugin(tree: TestNode, options?: { selfAgentId?: string | null }): TestNode {
  // rehypeMentions is a factory-of-factory: outer call captures the
  // participant list, inner call returns the transform that mutates the
  // hast tree in place. The plugin's `HastRoot` type is module-private;
  // `TestNode` is shape-compatible (same `type` / `tagName` / `children`
  // fields the plugin actually reads), so the unknown-bounce keeps the
  // cast honest without re-declaring the private hast types here.
  const transform = rehypeMentions(PARTICIPANTS, options)();
  transform(tree as unknown as Parameters<typeof transform>[0]);
  return tree;
}

describe("rehypeMentions", () => {
  it("leaves text without mentions unchanged", () => {
    const tree = makeRoot(paragraph(text("just a regular sentence")));
    runPlugin(tree, { selfAgentId: "agent-self" });
    expect(tree.children?.[0]?.children).toEqual([text("just a regular sentence")]);
  });

  it("rewrites a mention of another participant to a plain `.mention-chip`", () => {
    const tree = makeRoot(paragraph(text("hi @alice!")));
    runPlugin(tree, { selfAgentId: "agent-self" });
    const para = tree.children?.[0];
    expect(para?.children).toHaveLength(3);
    expect(para?.children?.[0]).toEqual(text("hi "));
    const chip = para?.children?.[1];
    expect(chip?.tagName).toBe("span");
    expect(chip?.properties?.className).toEqual(["mention-chip"]);
    expect(chip?.properties?.["data-mention-agent-id"]).toBe("agent-other");
    expect(chip?.properties?.["data-mention-name"]).toBe("alice");
    expect(chip?.properties?.["data-mention-display-name"]).toBe("Alice Chen");
    expect(chip?.properties?.title).toBe("@Alice Chen (@alice)");
    expect(chip?.properties?.ariaLabel).toBe("@Alice Chen (@alice)");
    expect(visibleChipText(chip)).toBe("@Alice Chen");
    expect(chip?.children?.[0]?.properties?.className).toEqual(["mention-chip-display"]);
    expect(para?.children?.[2]).toEqual(text("!"));
  });

  it("renders a numeric handle as its human-readable display name", () => {
    const participant: RenderedMentionParticipant = {
      agentId: "agent-human",
      name: "1736192959",
      displayName: "李坤阳",
    };
    const tree = makeRoot(paragraph(text("请 @1736192959 处理")));
    const transform = rehypeMentions([participant])();
    transform(tree as unknown as Parameters<typeof transform>[0]);

    const chip = tree.children?.[0]?.children?.[1];
    expect(visibleChipText(chip)).toBe("@李坤阳");
    expect(chip?.properties?.title).toBe("@李坤阳 (@1736192959)");
  });

  it("falls back to the canonical handle when displayName is blank", () => {
    const participant: RenderedMentionParticipant = {
      agentId: "agent-blank",
      name: "fallback",
      displayName: "   ",
    };
    const tree = makeRoot(paragraph(text("hi @fallback")));
    const transform = rehypeMentions([participant])();
    transform(tree as unknown as Parameters<typeof transform>[0]);

    const chip = tree.children?.[0]?.children?.[1];
    expect(visibleChipText(chip)).toBe("@fallback");
    expect(chip?.properties?.title).toBe("@fallback");
  });

  it("shows handles only when duplicate display names need disambiguation", () => {
    const participants: RenderedMentionParticipant[] = [
      { agentId: "agent-alice", name: "alice", displayName: "Sam" },
      { agentId: "agent-bob", name: "bob", displayName: "Sam" },
      { agentId: "agent-unique", name: "carol", displayName: "Carol" },
    ];
    const tree = makeRoot(paragraph(text("hi @alice, @bob, and @carol")));
    const transform = rehypeMentions(participants)();
    transform(tree as unknown as Parameters<typeof transform>[0]);

    const children = tree.children?.[0]?.children;
    expect(visibleChipText(children?.[1])).toBe("@Sam(@alice)");
    expect(children?.[1]?.children?.[0]?.properties?.className).toEqual(["mention-chip-display"]);
    expect(children?.[1]?.children?.[1]?.properties?.className).toEqual(["mention-chip-handle"]);
    expect(visibleChipText(children?.[3])).toBe("@Sam(@bob)");
    expect(children?.[3]?.children?.[1]?.properties?.className).toEqual(["mention-chip-handle"]);
    expect(visibleChipText(children?.[5])).toBe("@Carol");
    expect(children?.[5]?.children).toHaveLength(1);
  });

  it("counts collisions across the roster while allowing only persisted mention identities to resolve", () => {
    const participants: RenderedMentionParticipant[] = [
      { agentId: "agent-alice", name: "alice", displayName: "Sam" },
      { agentId: "agent-bob", name: "bob", displayName: "Sam" },
    ];
    const tree = makeRoot(paragraph(text("hi @alice and @bob")));
    const transform = rehypeMentions(participants, { allowedAgentIds: new Set(["agent-alice"]) })();
    transform(tree as unknown as Parameters<typeof transform>[0]);

    const children = tree.children?.[0]?.children;
    expect(visibleChipText(children?.[1])).toBe("@Sam(@alice)");
    expect(children?.[1]?.children?.[1]?.properties?.className).toEqual(["mention-chip-handle"]);
    expect(children?.[2]).toEqual(text(" and @bob"));
  });

  it("adds the `is-self` class when the mention resolves to the viewer", () => {
    // Regression: the fix only works if the resolvable participant set
    // passed to the plugin actually includes self. The view layer is
    // responsible for that — this test pins the plugin's promise that,
    // *given* a participant list with self, it will mark the chip.
    const tree = makeRoot(paragraph(text("hey @me")));
    runPlugin(tree, { selfAgentId: "agent-self" });
    const chip = tree.children?.[0]?.children?.[1];
    expect(chip?.properties?.className).toEqual(["mention-chip", "is-self"]);
    expect(chip?.properties?.["data-mention-agent-id"]).toBe("agent-self");
  });

  it("does not add `is-self` when no `selfAgentId` is provided", () => {
    const tree = makeRoot(paragraph(text("hey @me")));
    runPlugin(tree);
    const chip = tree.children?.[0]?.children?.[1];
    expect(chip?.properties?.className).toEqual(["mention-chip"]);
  });

  it("skips mentions inside <code> so handles in code samples stay verbatim", () => {
    const tree = makeRoot(paragraph(text("call "), inlineCode("@me"), text(" later")));
    runPlugin(tree, { selfAgentId: "agent-self" });
    const para = tree.children?.[0];
    expect(para?.children?.[1]?.tagName).toBe("code");
    expect(para?.children?.[1]?.children).toEqual([text("@me")]);
  });

  it("ignores unknown handles (npm package names, typos, outsiders)", () => {
    const tree = makeRoot(paragraph(text("see @nobody for details")));
    runPlugin(tree, { selfAgentId: "agent-self" });
    expect(tree.children?.[0]?.children).toEqual([text("see @nobody for details")]);
  });
});

describe("copyTextWithMentionHandles", () => {
  it("copies rendered display names as canonical pasteable handles", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '请 <span class="mention-chip" data-mention-name="1736192959">@李坤阳</span> 处理，然后通知 ' +
      '<span class="mention-chip" data-mention-name="alice">@Alice Chen</span>';
    document.body.append(root);

    const range = document.createRange();
    range.selectNodeContents(root);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(copyTextWithMentionHandles(root, selection)).toBe("请 @1736192959 处理，然后通知 @alice");

    selection?.removeAllRanges();
    root.remove();
  });

  it("preserves rich HTML while rewriting mention chips to handles", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<strong>请</strong> <span class="mention-chip" data-mention-name="1736192959">@李坤阳</span> ' +
      '<a href="https://example.com">查看详情</a>';
    document.body.append(root);

    const range = document.createRange();
    range.selectNodeContents(root);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(copyHtmlWithMentionHandles(root, selection)).toBe(
      '<strong>请</strong> @1736192959 <a href="https://example.com">查看详情</a>',
    );

    selection?.removeAllRanges();
    root.remove();
  });

  it("derives multiline plain and rich copy from the same cloned DOM", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<p>line one<br>line two <span class="mention-chip" data-mention-name="alice"><span class="mention-chip-display">@Alice Chen</span></span></p>' +
      '<p>next paragraph <span class="mention-chip" data-mention-name="me"><span class="mention-chip-display">@Me</span></span></p>';
    document.body.append(root);

    const range = document.createRange();
    range.selectNodeContents(root);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const plain = copyTextWithMentionHandles(root, selection);
    const rich = copyHtmlWithMentionHandles(root, selection);
    expect(plain).toContain("line one");
    expect(plain).toContain("line two @alice");
    expect(plain).toContain("next paragraph @me");
    expect(plain).not.toContain("Alice Chen");
    expect(rich).toBe("<p>line one<br>line two @alice</p><p>next paragraph @me</p>");

    selection?.removeAllRanges();
    root.remove();
  });

  it("preserves the live whitespace semantics around rewritten mentions", () => {
    const root = document.createElement("div");
    root.style.whiteSpace = "normal";
    root.innerHTML =
      'Please   ask\t<span class="mention-chip" data-mention-name="alice"><span class="mention-chip-display">@Alice Chen</span></span>   today';
    document.body.append(root);

    const range = document.createRange();
    range.selectNodeContents(root);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const appendSpy = vi.spyOn(document.body, "append");
    expect(copyTextWithMentionHandles(root, selection)).toBe(root.innerText.replace("@Alice Chen", "@alice"));
    const detachedRenderRoot = appendSpy.mock.calls.at(-1)?.[0];
    expect(detachedRenderRoot).toBeInstanceOf(HTMLElement);
    expect((detachedRenderRoot as HTMLElement).style.whiteSpace).toBe("normal");
    appendSpy.mockRestore();

    selection?.removeAllRanges();
    root.remove();
  });

  it("leaves native copy untouched when no rendered mention is selected", () => {
    const root = document.createElement("div");
    root.textContent = "plain text";
    document.body.append(root);

    const range = document.createRange();
    range.selectNodeContents(root);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(copyTextWithMentionHandles(root, selection)).toBeNull();

    selection?.removeAllRanges();
    root.remove();
  });

  it("rewrites the selected chip rather than identical ordinary text", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '普通文本 @李坤阳；mention <span class="mention-chip" data-mention-name="1736192959">@李坤阳</span>';
    document.body.append(root);

    const range = document.createRange();
    range.selectNodeContents(root);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(copyTextWithMentionHandles(root, selection)).toBe("普通文本 @李坤阳；mention @1736192959");

    selection?.removeAllRanges();
    root.remove();
  });

  it("keeps native copy behaviour for a partially selected chip", () => {
    const root = document.createElement("div");
    root.innerHTML = '<span class="mention-chip" data-mention-name="1736192959">@李坤阳</span> 后续';
    document.body.append(root);

    const chipText = root.querySelector("span")?.firstChild;
    const trailingText = root.lastChild;
    if (!chipText || !trailingText) throw new Error("expected mention and trailing text nodes");
    const range = document.createRange();
    range.setStart(chipText, 1);
    range.setEndAfter(trailingText);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(copyTextWithMentionHandles(root, selection)).toBeNull();

    selection?.removeAllRanges();
    root.remove();
  });

  it("rewrites a chip when its complete text is selected exactly", () => {
    const root = document.createElement("div");
    root.innerHTML = '<span class="mention-chip" data-mention-name="1736192959">@李坤阳</span>';
    document.body.append(root);

    const chipText = root.querySelector("span")?.firstChild;
    if (!(chipText instanceof Text)) throw new Error("expected mention text node");
    const range = document.createRange();
    range.setStart(chipText, 0);
    range.setEnd(chipText, chipText.data.length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(copyTextWithMentionHandles(root, selection)).toBe("@1736192959");
    expect(copyHtmlWithMentionHandles(root, selection)).toBe("@1736192959");

    selection?.removeAllRanges();
    root.remove();
  });
});

import type { MentionParticipant } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { rehypeMentions } from "../rehype-mentions.js";

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

function inlineCode(value: string): TestNode {
  return { type: "element", tagName: "code", properties: {}, children: [text(value)] };
}

const PARTICIPANTS: MentionParticipant[] = [
  { agentId: "agent-self", name: "me" },
  { agentId: "agent-other", name: "alice" },
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
    expect(chip?.children).toEqual([text("@alice")]);
    expect(para?.children?.[2]).toEqual(text("!"));
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

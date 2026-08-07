// @vitest-environment happy-dom

import type { ContextDecision } from "@first-tree/shared";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { ContextDecisionReceipt, contextDecisionSourceHref } from "../context-decision-receipt.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function receipt(overrides: Partial<ContextDecision> = {}): ContextDecision {
  return {
    version: 1,
    effect: "constrained",
    summary: "Team rollout policy caps Web at 20%; CLI stays at 5% until the migration guard clears.",
    evidence: [
      {
        repoUrl: "https://github.com/example/context-tree",
        commit: COMMIT,
        nodePath: "product/release/rollout-policy.md",
        heading: "Expansion gates",
      },
    ],
    ...overrides,
  };
}

let h: DomHarness;

beforeEach(() => {
  h = createDomHarness();
});
afterEach(() => h.cleanup());

const text = (): string => h.container.textContent ?? "";
const toggle = (): HTMLButtonElement => {
  const button = h.container.querySelector("button");
  if (!button) throw new Error("sources toggle not rendered");
  return button as HTMLButtonElement;
};

describe("ContextDecisionReceipt", () => {
  it("leads with the Context Tree effect and the agent's concrete summary", () => {
    h.render(<ContextDecisionReceipt receipt={receipt()} />);
    expect(text()).toContain("Context Tree in action");
    expect(text()).toContain("Options narrowed");
    expect(text()).toContain("Team rollout policy caps Web at 20%");
    expect(text()).toContain("1 team decision");
  });

  it("names each effect in user language, never the raw enum", () => {
    const labels: Array<[ContextDecision["effect"], string]> = [
      ["conflicted", "Conflict surfaced"],
      ["redirected", "Approach changed"],
      ["constrained", "Options narrowed"],
      ["confirmed", "Direction supported"],
    ];
    for (const [effect, label] of labels) {
      h.render(<ContextDecisionReceipt receipt={receipt({ effect })} />);
      expect(text()).toContain(label);
      expect(text()).not.toContain(effect);
    }
  });

  it("keeps sources collapsed until asked, then shows the exact cited source", () => {
    h.render(<ContextDecisionReceipt receipt={receipt()} />);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(text()).not.toContain("product/release/rollout-policy.md");

    act(() => toggle().click());

    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(text()).toContain("Expansion gates");
    expect(text()).toContain("product/release/rollout-policy.md");
    expect(text()).toContain("example/context-tree · 0123456");
    expect(text()).not.toContain(COMMIT);
  });

  it("discloses agent attribution only inside the expanded sources", () => {
    h.render(<ContextDecisionReceipt receipt={receipt()} />);
    expect(text()).not.toContain("Added by the agent");

    act(() => toggle().click());

    expect(text()).toContain("Added by the agent");
    expect(text()).toContain("does not independently verify causality");
  });

  it("makes no verification claim about the confirmed effect", () => {
    h.render(<ContextDecisionReceipt receipt={receipt({ effect: "confirmed" })} />);
    act(() => toggle().click());
    expect(text().toLowerCase()).not.toContain("verified");
  });

  it("links a GitHub source to the exact commit", () => {
    h.render(<ContextDecisionReceipt receipt={receipt()} />);
    act(() => toggle().click());
    const link = h.container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(
      `https://github.com/example/context-tree/blob/${COMMIT}/product/release/rollout-policy.md`,
    );
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("shows an unidentifiable forge as plain text rather than a guessed link", () => {
    const evidence = [{ repoUrl: "https://git.example.com/team/tree", commit: COMMIT, nodePath: "a.md" }];
    h.render(<ContextDecisionReceipt receipt={receipt({ evidence })} />);
    act(() => toggle().click());
    expect(h.container.querySelector("a")).toBeNull();
    expect(text()).toContain("a.md");
    expect(text()).toContain("team/tree · 0123456");
  });
});

describe("contextDecisionSourceHref", () => {
  const evidence = (repoUrl: string, nodePath = "a/b.md") => ({ repoUrl, commit: COMMIT, nodePath });

  it("builds a GitLab blob link only when the repo matches the connected instance", () => {
    const repo = "https://gitlab.example.com/group/sub/tree";
    expect(contextDecisionSourceHref(evidence(repo), "https://gitlab.example.com")).toBe(
      `https://gitlab.example.com/group/sub/tree/-/blob/${COMMIT}/a/b.md`,
    );
    expect(contextDecisionSourceHref(evidence(repo), "https://gitlab.other.com")).toBeNull();
    expect(contextDecisionSourceHref(evidence(repo), null)).toBeNull();
  });

  // SSH bindings are valid receipt sources, so their links must resolve too.
  it("links an SSH-form GitHub source to the same web blob URL", () => {
    for (const repoUrl of ["git@github.com:example/tree.git", "ssh://git@github.com/example/tree.git"]) {
      expect(contextDecisionSourceHref(evidence(repoUrl), null), repoUrl).toBe(
        `https://github.com/example/tree/blob/${COMMIT}/a/b.md`,
      );
    }
  });

  it("escapes path segments so a source link cannot be broken by the path", () => {
    const href = contextDecisionSourceHref(evidence("https://github.com/example/tree", "a b/c?d.md"), null);
    expect(href).toBe(`https://github.com/example/tree/blob/${COMMIT}/a%20b/c%3Fd.md`);
  });
});

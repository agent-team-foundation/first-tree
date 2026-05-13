import { describe, expect, it } from "vitest";
import { buildAvatarAriaLabel, formatUnreadLabel, pickCompositeShape } from "../chat-row-avatar.js";

/**
 * Pin the pure decision helpers exported by `ChatRowAvatar`. The
 * rendering wrapper itself is exercised by visual / Playwright in CI;
 * these tests cover the branches that drive layout and a11y so a
 * future refactor can't silently shift the conversation-list contract.
 */

describe("pickCompositeShape — group avatar layout key", () => {
  it("zero or one peer collapses to the single-avatar path", () => {
    expect(pickCompositeShape(0)).toBe("single");
    expect(pickCompositeShape(1)).toBe("single");
  });

  it("2 peers → vertical bisection", () => {
    expect(pickCompositeShape(2)).toBe("n2");
  });

  it("3 peers → T-split", () => {
    expect(pickCompositeShape(3)).toBe("n3");
  });

  it("exactly 4 peers → 2x2, all faces visible (no overflow)", () => {
    // Pins the UX decision: at n=4 the 4th peer gets a real seg, not a
    // `+1` overflow tile. Reverting to "3 + overflow" for n=4 would
    // bring back the off-by-one bug fixed in this PR.
    expect(pickCompositeShape(4)).toBe("n4");
  });

  it("5+ peers → 2x2 with last slot as overflow tile", () => {
    expect(pickCompositeShape(5)).toBe("n5+");
    expect(pickCompositeShape(10)).toBe("n5+");
    expect(pickCompositeShape(100)).toBe("n5+");
  });
});

describe("formatUnreadLabel — badge text", () => {
  it("0 (or negative) returns null so callers omit the badge", () => {
    expect(formatUnreadLabel(0)).toBeNull();
    expect(formatUnreadLabel(-1)).toBeNull();
  });

  it("1..99 returns the literal count", () => {
    expect(formatUnreadLabel(1)).toBe("1");
    expect(formatUnreadLabel(7)).toBe("7");
    expect(formatUnreadLabel(99)).toBe("99");
  });

  it(">=100 rolls over to '99+' so the badge stays width-stable", () => {
    expect(formatUnreadLabel(100)).toBe("99+");
    expect(formatUnreadLabel(9999)).toBe("99+");
  });
});

describe("buildAvatarAriaLabel — state-only screen-reader text", () => {
  it("returns null when nothing is happening (avatar goes aria-hidden)", () => {
    // Title is announced by the enclosing chat-row button; an avatar
    // with no dynamic state shouldn't double-announce anything.
    expect(buildAvatarAriaLabel({ peerWorking: false, unread: 0 })).toBeNull();
  });

  it("'working' only when peer is working and there's no unread", () => {
    expect(buildAvatarAriaLabel({ peerWorking: true, unread: 0 })).toBe("working");
  });

  it("'N unread' only when there's unread but no working signal", () => {
    expect(buildAvatarAriaLabel({ peerWorking: false, unread: 3 })).toBe("3 unread");
    expect(buildAvatarAriaLabel({ peerWorking: false, unread: 1 })).toBe("1 unread");
  });

  it("composes both into one comma-joined label", () => {
    expect(buildAvatarAriaLabel({ peerWorking: true, unread: 5 })).toBe("working, 5 unread");
  });
});

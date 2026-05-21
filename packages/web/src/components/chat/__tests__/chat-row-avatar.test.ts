import { describe, expect, it } from "vitest";
import { buildAvatarAriaLabel, formatUnreadLabel, pickAvatarHue, pickCompositeShape } from "../chat-row-avatar.js";

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

describe("pickAvatarHue — deterministic per-agent fill color", () => {
  it("returns a `var(--avatar-hue-N)` token reference", () => {
    // Pins the contract that the helper hands back a CSS-token
    // reference rather than a raw `oklch(...)` literal — index.css is
    // the single source of palette truth.
    expect(pickAvatarHue("agent-1")).toMatch(/^var\(--avatar-hue-[0-7]\)$/);
  });

  it("same seed yields the same hue across calls (stable per agent)", () => {
    // Pins the contract that powers consistent agent identity across
    // direct chats, group composites, and page reloads.
    const a = pickAvatarHue("019e20a6-287b-71f7-b9ba-cb954e7fa144");
    const b = pickAvatarHue("019e20a6-287b-71f7-b9ba-cb954e7fa144");
    expect(a).toBe(b);
  });

  it("spreads 8 realistic UUIDv7 seeds across at least 4 different hues", () => {
    // Tighter than "more than one" — a regression that collapses
    // 8 sample seeds onto 2 hues would pass the looser check. The
    // seeds below are realistic-shape UUIDv7s (high-entropy random
    // tail) rather than agent slugs with a common prefix; this
    // matches production data, which is what the hash actually has
    // to spread.
    const seeds = [
      "019e20a6-287b-71f7-b9ba-cb954e7fa144",
      "019e3f12-91ac-7891-92e1-d2b3f5a8c192",
      "019e5b78-12cd-7456-a7d4-e6f2c91b3856",
      "019e7d92-45f1-7c23-8b9e-f1a4d5e89321",
      "019ea1b3-78de-7e45-9c12-3b6d2f7a4c98",
      "019ec5d4-aabb-7f67-bd34-5e8a9c1b2d65",
      "019ee9f5-ccdd-7090-cf45-7a9b8d2c3e76",
      "019f0d16-eeff-7211-e056-8c9bad3e4f87",
    ];
    const hues = new Set(seeds.map(pickAvatarHue));
    expect(hues.size).toBeGreaterThanOrEqual(4);
  });

  it("empty seed falls back to `--avatar-hue-0` without throwing", () => {
    expect(() => pickAvatarHue("")).not.toThrow();
    expect(pickAvatarHue("")).toBe("var(--avatar-hue-0)");
  });
});

describe("buildAvatarAriaLabel — state-only screen-reader text", () => {
  it("returns null when nothing is happening (avatar goes aria-hidden)", () => {
    // Title is announced by the enclosing chat-row button; an avatar
    // with no dynamic state shouldn't double-announce anything.
    expect(buildAvatarAriaLabel({ needsYou: false, unread: 0 })).toBeNull();
  });

  it("'needs you' when the chat has a pending question and there's no unread", () => {
    expect(buildAvatarAriaLabel({ needsYou: true, unread: 0 })).toBe("needs you");
  });

  it("'N unread' only when there's unread but no needs-you signal", () => {
    expect(buildAvatarAriaLabel({ needsYou: false, unread: 3 })).toBe("3 unread");
    expect(buildAvatarAriaLabel({ needsYou: false, unread: 1 })).toBe("1 unread");
  });

  it("composes both into one comma-joined label", () => {
    expect(buildAvatarAriaLabel({ needsYou: true, unread: 5 })).toBe("needs you, 5 unread");
  });
});

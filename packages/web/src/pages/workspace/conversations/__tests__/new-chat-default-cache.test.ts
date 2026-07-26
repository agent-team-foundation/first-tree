import { describe, expect, it } from "vitest";
import {
  firstCacheableStarterAgentId,
  newChatDefaultAgentCacheKey,
  participantPickerPlacement,
  type StarterAgentCacheCandidate,
} from "../new-chat-draft.js";

function candidate(partial: Partial<StarterAgentCacheCandidate> & Pick<StarterAgentCacheCandidate, "uuid">) {
  return {
    type: "agent",
    status: "active",
    ...partial,
  } satisfies StarterAgentCacheCandidate;
}

describe("new chat default cache helpers", () => {
  it("scopes the cached starter agent by user and organization", () => {
    expect(newChatDefaultAgentCacheKey("user-1", "org-1")).toBe("first-tree:new-chat-default-agent:user-1:org-1");
    expect(newChatDefaultAgentCacheKey(null, "org-1")).toBeNull();
    expect(newChatDefaultAgentCacheKey("user-1", null)).toBeNull();
  });

  it("caches the first active agent chip from the successful manual New Chat participant order", () => {
    const agents = new Map([
      ["human-peer", candidate({ uuid: "human-peer", type: "human" })],
      ["suspended-agent", candidate({ uuid: "suspended-agent", status: "suspended" })],
      ["starter-agent", candidate({ uuid: "starter-agent" })],
      ["later-agent", candidate({ uuid: "later-agent" })],
    ]);

    expect(
      firstCacheableStarterAgentId(["human-peer", "suspended-agent", "starter-agent", "later-agent"], agents),
    ).toBe("starter-agent");
  });

  it("returns null when the successful New Chat has no cacheable agent chip", () => {
    const agents = new Map([
      ["human-peer", candidate({ uuid: "human-peer", type: "human" })],
      ["suspended-agent", candidate({ uuid: "suspended-agent", status: "suspended" })],
    ]);

    expect(firstCacheableStarterAgentId(["human-peer", "suspended-agent"], agents)).toBeNull();
  });
});

describe("participantPickerPlacement", () => {
  const viewport = { left: 0, top: 0, width: 390, height: 844 };
  const panel = { width: 360, height: 280 };

  it("clamps a panel after existing chips against the viewport right edge", () => {
    const placed = participantPickerPlacement({
      anchor: { left: 236, top: 120, bottom: 148 },
      panel,
      viewport,
    });

    expect(placed.left).toBe(22);
    expect(placed.left + placed.width).toBe(382);
  });

  it("keeps both edges reachable at the narrowest mobile baseline", () => {
    const narrowViewport = { left: 0, top: 0, width: 320, height: 568 };
    const placed = participantPickerPlacement({
      anchor: { left: 180, top: 80, bottom: 108 },
      panel,
      viewport: narrowViewport,
    });

    expect(placed.left).toBe(8);
    expect(placed.width).toBe(304);
    expect(placed.left + placed.width).toBe(312);
  });

  it("honors a shifted visual viewport and flips above when below does not fit", () => {
    const placed = participantPickerPlacement({
      anchor: { left: 210, top: 620, bottom: 648 },
      panel,
      viewport: { left: 40, top: 20, width: 390, height: 700 },
    });

    expect(placed.left).toBe(62);
    expect(placed.top).toBe(336);
  });
});

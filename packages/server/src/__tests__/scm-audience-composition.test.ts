import { describe, expect, it } from "vitest";
import { composeScmAudience, type ScmProviderTaskTarget } from "../services/scm-audience-composition.js";

function existing(humanAgentId: string, wakeAgentId: string, chatId: string) {
  return {
    kind: "existing_line" as const,
    line: {
      kind: "attention_line" as const,
      humanAgentId,
      wakeAgentId,
      chatId,
      provenance: "explicit" as const,
    },
  };
}

function personnel(
  humanAgentId: string,
  wakeAgentId: string,
  reason: "review_requested" | "mentioned" | "assigned" = "review_requested",
) {
  return {
    kind: "personnel_target" as const,
    humanAgentId,
    wakeAgentId,
    reason,
    requiresPersistentLine: reason === "mentioned" || reason === "assigned",
    externalUsername: humanAgentId,
  };
}

describe("composeScmAudience", () => {
  it("matches personnel context only to the exact human/wake pair", () => {
    const composed = composeScmAudience({
      existingEntries: [existing("human-h", "agent-a", "chat-a"), existing("human-h", "agent-b", "chat-b")],
      personnelTargets: [personnel("human-h", "agent-b")],
    });

    expect(composed).toHaveLength(2);
    expect(composed[0]).toEqual({ entry: existing("human-h", "agent-a", "chat-a") });
    expect(composed[1]).toEqual({
      entry: existing("human-h", "agent-b", "chat-b"),
      directedContext: {
        reason: "review_requested",
        requiresPersistentLine: false,
        externalUsername: "human-h",
      },
    });
  });

  it("preserves a carrier line and appends a same-human different-wake personnel target", () => {
    const composed = composeScmAudience({
      existingEntries: [existing("human-h", "agent-a", "chat-a")],
      personnelTargets: [personnel("human-h", "agent-b")],
    });

    expect(composed).toEqual([
      { entry: existing("human-h", "agent-a", "chat-a") },
      { entry: personnel("human-h", "agent-b") },
    ]);
  });

  it("keeps distinct chats and never treats a legacy route as personnel authority", () => {
    const legacy = {
      kind: "legacy_route" as const,
      route: {
        kind: "legacy_route_only" as const,
        chatId: "legacy-chat",
        senderAgentId: "legacy-sender",
        wakeAgentId: null,
        provenance: "legacy_explicit" as const,
      },
    };
    const composed = composeScmAudience({
      existingEntries: [existing("human-h", "agent-b", "chat-a"), existing("human-h", "agent-b", "chat-b"), legacy],
      personnelTargets: [personnel("human-h", "agent-c")],
    });

    expect(composed).toHaveLength(4);
    expect(composed.map((target) => target.entry.kind)).toEqual([
      "existing_line",
      "existing_line",
      "legacy_route",
      "personnel_target",
    ]);
  });

  it("selects directed reason by stable priority rather than input order", () => {
    const first = composeScmAudience({
      existingEntries: [existing("human-h", "agent-b", "chat-a")],
      personnelTargets: [
        personnel("human-h", "agent-b", "assigned"),
        personnel("human-h", "agent-b", "review_requested"),
      ],
    });
    const second = composeScmAudience({
      existingEntries: [existing("human-h", "agent-b", "chat-a")],
      personnelTargets: [
        personnel("human-h", "agent-b", "review_requested"),
        personnel("human-h", "agent-b", "assigned"),
      ],
    });

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      directedContext: { reason: "review_requested", requiresPersistentLine: true },
    });
  });

  it("keeps provider tasks discriminated and outside personnel dedupe", () => {
    const providerTask: ScmProviderTaskTarget<{ capability: string }> = {
      kind: "provider_task_target",
      humanAgentId: "human-h",
      wakeAgentId: "agent-b",
      providerContext: { capability: "reply-run" },
    };
    const composed = composeScmAudience({
      existingEntries: [existing("human-h", "agent-b", "chat-a")],
      personnelTargets: [],
      providerTaskTargets: [providerTask],
    });

    expect(composed).toEqual([{ entry: existing("human-h", "agent-b", "chat-a") }, { entry: providerTask }]);
  });
});

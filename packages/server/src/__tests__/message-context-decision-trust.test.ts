import { CONTEXT_DECISION_METADATA_KEY } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { preflightMessageSendIntent, type SendIntentParticipant } from "../services/chat/message.js";

const HUMAN: SendIntentParticipant = {
  agentId: "human-1",
  name: "gandy",
  displayName: "Gandy",
  status: "active",
  type: "human",
};
const AGENT: SendIntentParticipant = {
  agentId: "agent-1",
  name: "assistant",
  displayName: "Assistant",
  status: "active",
  type: "agent",
};

const RECEIPT = {
  version: 1,
  effect: "constrained",
  summary: "The organization-isolation constraint ruled out a global shared index.",
  evidence: [
    {
      repoUrl: "https://github.com/example/context-tree",
      commit: "0123456789abcdef0123456789abcdef01234567",
      nodePath: "system/cloud/team/tenancy-and-identity.md",
      heading: "Organization isolation",
    },
  ],
};

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NOTE_SOURCE = `[Organization isolation](https://github.com/example/context-tree/blob/${COMMIT}/system/cloud/team/tenancy-and-identity.md)`;

function bodyWithNote(
  options: { effectLine?: string; sourceLine?: string; answer?: string; repeat?: number } = {},
): string {
  const note = [
    "> How Context Tree affected this work\\",
    `> ${options.effectLine ?? "**Options narrowed:** The organization-isolation rule ruled out a global shared index."}\\`,
    `> ${options.sourceLine ?? `Context Tree source: ${NOTE_SOURCE}`}`,
  ].join("\n");
  return [
    options.answer ?? "Keeping the index per organization.",
    ...Array(options.repeat ?? 1).fill(`\n${note}`),
  ].join("\n");
}

function preflight(sender: SendIntentParticipant, receipt: unknown) {
  return preflightMessageSendIntent({
    chatId: "chat-1",
    senderId: sender.agentId,
    senderType: sender.type,
    data: {
      format: "markdown",
      content: "Keeping the index per organization.",
      source: "cli",
      metadata: {
        [CONTEXT_DECISION_METADATA_KEY]: receipt,
        mentions: [sender.agentId === HUMAN.agentId ? AGENT.agentId : HUMAN.agentId],
      },
    },
    participants: [HUMAN, AGENT],
  });
}

function preflightBody(sender: SendIntentParticipant, content: string, metadata: Record<string, unknown> = {}) {
  return preflightMessageSendIntent({
    chatId: "chat-1",
    senderId: sender.agentId,
    senderType: sender.type,
    data: {
      format: "markdown",
      content,
      source: "cli",
      metadata: { ...metadata, mentions: [sender.agentId === HUMAN.agentId ? AGENT.agentId : HUMAN.agentId] },
    },
    participants: [HUMAN, AGENT],
  });
}

describe("contextDecision receipt trust boundary", () => {
  it("keeps a well-formed receipt from an agent sender", () => {
    expect(preflight(AGENT, RECEIPT).metadata[CONTEXT_DECISION_METADATA_KEY]).toEqual(RECEIPT);
  });

  it("strips the receipt from a human sender so it cannot be spoofed", () => {
    expect(preflight(HUMAN, RECEIPT).metadata[CONTEXT_DECISION_METADATA_KEY]).toBeUndefined();
  });

  it("rejects a malformed receipt from an agent sender instead of storing it", () => {
    expect(() => preflight(AGENT, { ...RECEIPT, effect: "none" })).toThrow(/metadata.contextDecision/);
    expect(() => preflight(AGENT, { ...RECEIPT, evidence: [] })).toThrow(/metadata.contextDecision/);
    expect(() => preflight(AGENT, "constrained")).toThrow(/metadata.contextDecision/);
  });

  // Validation is not normalization: the schema strips unknown keys and trims
  // `summary`, so persisting the caller's object would durably keep an extra
  // credential-bearing field and an over-long summary that no reader surfaces.
  it("persists the parsed receipt, not the caller's raw object", () => {
    const stored = preflight(AGENT, {
      ...RECEIPT,
      summary: `  ${"x".repeat(398)}   `,
      secretToken: "top-level-extra",
      evidence: [{ ...RECEIPT.evidence[0], accessToken: "nested-extra-secret" }],
    }).metadata[CONTEXT_DECISION_METADATA_KEY] as Record<string, unknown>;

    expect(Object.keys(stored).sort()).toEqual(["effect", "evidence", "summary", "version"]);
    expect(stored.summary).toBe("x".repeat(398));
    const rows = stored.evidence as Array<Record<string, unknown>>;
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["commit", "heading", "nodePath", "repoUrl"]);
  });

  it("derives the receipt from an agent's visible impact note", () => {
    expect(preflightBody(AGENT, bodyWithNote()).metadata[CONTEXT_DECISION_METADATA_KEY]).toEqual({
      version: 1,
      effect: "constrained",
      summary: "The organization-isolation rule ruled out a global shared index.",
      evidence: [
        {
          repoUrl: "https://github.com/example/context-tree",
          commit: COMMIT,
          nodePath: "system/cloud/team/tenancy-and-identity.md",
          heading: "Organization isolation",
        },
      ],
    });
  });

  // The whole reason the Server derives instead of accepting a parallel payload:
  // a hand-maintained copy can disagree with the sentence the reader sees.
  it("lets the note override a caller-supplied receipt that contradicts it", () => {
    const stored = preflightBody(AGENT, bodyWithNote(), {
      [CONTEXT_DECISION_METADATA_KEY]: { ...RECEIPT, effect: "conflicted", summary: "Something else entirely." },
    }).metadata[CONTEXT_DECISION_METADATA_KEY] as Record<string, unknown>;

    expect(stored.effect).toBe("constrained");
    expect(stored.summary).toBe("The organization-isolation rule ruled out a global shared index.");
  });

  it("never derives a receipt from a human sender's body", () => {
    expect(preflightBody(HUMAN, bodyWithNote()).metadata[CONTEXT_DECISION_METADATA_KEY]).toBeUndefined();
  });

  it("stores nothing when the note cannot be converted", () => {
    const unknownEffect = preflightBody(AGENT, bodyWithNote({ effectLine: "**Mostly helpful:** It went fine." }));
    expect(unknownEffect.metadata[CONTEXT_DECISION_METADATA_KEY]).toBeUndefined();

    const branchLink = preflightBody(
      AGENT,
      bodyWithNote({
        sourceLine: "Context Tree source: [Isolation](https://github.com/example/context-tree/blob/main/a.md)",
      }),
    );
    expect(branchLink.metadata[CONTEXT_DECISION_METADATA_KEY]).toBeUndefined();
  });

  // Two notes mean two attributions and no way to tell which governed the
  // message; picking either would be a guess.
  it("stores nothing when a body carries more than one note", () => {
    expect(preflightBody(AGENT, bodyWithNote({ repeat: 2 })).metadata[CONTEXT_DECISION_METADATA_KEY]).toBeUndefined();
  });

  // Legacy agents predate the note and send only metadata.
  it("still accepts a caller-supplied receipt when the body carries no note", () => {
    expect(
      preflightBody(AGENT, "No note here.", { [CONTEXT_DECISION_METADATA_KEY]: RECEIPT }).metadata[
        CONTEXT_DECISION_METADATA_KEY
      ],
    ).toEqual(RECEIPT);
  });

  it("leaves an ordinary send untouched", () => {
    const result = preflightMessageSendIntent({
      chatId: "chat-1",
      senderId: AGENT.agentId,
      senderType: AGENT.type,
      data: { format: "text", content: "No receipt here.", source: "cli", metadata: { mentions: [HUMAN.agentId] } },
      participants: [HUMAN, AGENT],
    });
    expect(result.metadata[CONTEXT_DECISION_METADATA_KEY]).toBeUndefined();
  });
});

import { MESSAGE_FORMATS } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { BadRequestError, ForbiddenError } from "../errors.js";
import { parseEntityReference } from "../services/github-entity-follow.js";
import { githubEntityDedupKey, githubEntityKeyCandidates } from "../services/github-entity-key.js";
import { extractMentions } from "../services/github-normalize.js";
import {
  assertMetadataDoesNotClaimLandingCampaignTrial,
  assertMutableAgentIsNotLandingCampaignTrial,
  isLandingCampaignServiceMembership,
  isLandingCampaignServiceOrg,
} from "../services/landing-campaigns/guards.js";
import {
  buildLandingCampaignAgentMetadata,
  buildLandingCampaignChatMetadata,
  getLandingCampaignTrialChat,
  withLandingCampaignChatState,
} from "../services/landing-campaigns/metadata.js";
import { preflightMessageSendIntent } from "../services/message.js";

const trialConfig = {
  growth: {
    landingCampaigns: {
      serviceOrgId: "service_org",
      serviceUserId: "service_user",
    },
  },
} as Config;

const repo = {
  url: "https://github.com/acme/site",
  canonicalKey: "github.com/acme/site",
  owner: "acme",
  name: "site",
};

const participants = [
  { agentId: "sender", name: "sender", displayName: "Sender", status: "active", type: "agent" },
  { agentId: "bot", name: "bot", displayName: "Bot", status: "active", type: "agent" },
  { agentId: "human", name: "alice", displayName: "Alice", status: "active", type: "human" },
  { agentId: "suspended", name: "sleepy", displayName: "Sleepy", status: "suspended", type: "agent" },
] as const;

describe("service branch contracts", () => {
  it("normalizes GitHub mentions and entity keys without notifying teams as agents", () => {
    expect(extractMentions("Ping @Alice, @org/team, @bob-2, @alice and email test@example.com")).toEqual([
      "alice",
      "bob-2",
    ]);

    expect(parseEntityReference("https://github.com/Acme/Repo/pull/42?diff=split")).toEqual({
      kind: "numeric",
      owner: "Acme",
      repo: "Repo",
      number: 42,
      explicitType: "pull_request",
    });
    expect(parseEntityReference("acme/repo@ABCDEF123456")).toEqual({
      kind: "commit",
      owner: "acme",
      repo: "repo",
      sha: "abcdef123456",
    });
    expect(parseEntityReference("not an entity")).toBeNull();

    expect(githubEntityKeyCandidates("discussion", "acme/repo#discussion-7")).toEqual([
      "acme/repo#discussion-7",
      "acme/repo#7",
    ]);
    expect(githubEntityDedupKey("discussion", "acme/repo#discussion-7")).toBe("discussion::acme/repo#7");
    expect(githubEntityKeyCandidates("issue", "acme/repo#7")).toEqual(["acme/repo#7"]);
  });

  it("keeps landing-campaign trial metadata state transitions explicit", () => {
    const metadata = buildLandingCampaignChatMetadata({
      campaign: "portfolio",
      agentId: "agent_1",
      skillSetId: "portfolio",
      skillSetVersion: "v1",
      repo,
      state: "completed",
      inputLocked: true,
      awaitingUserKind: "request",
      maxAgentTurns: 2,
      completedAgentTurns: 2,
      completedAgentTurnIds: ["turn_1", "turn_2"],
      maxEstimatedTokens: 1_000,
      estimatedTokensUsed: 900,
      lastObservedEstimatedTokens: 900,
      lastObservedTokenUsageEventId: "event_1",
      limitReason: "turns",
    });

    expect(getLandingCampaignTrialChat({ metadata })).toMatchObject({
      campaign: "portfolio",
      state: "completed",
      inputLocked: true,
      limitReason: "turns",
      completedAgentTurnIds: ["turn_1", "turn_2"],
    });

    const running = withLandingCampaignChatState(metadata, "running", false, {
      completedAgentTurns: 1,
      completedAgentTurnIds: ["turn_1"],
      limitReason: "tokens",
    });

    expect(getLandingCampaignTrialChat({ metadata: running })).toMatchObject({
      state: "running",
      inputLocked: false,
      completedAgentTurns: 1,
      completedAgentTurnIds: ["turn_1"],
    });
    expect(getLandingCampaignTrialChat({ metadata: running })).not.toHaveProperty("awaitingUserKind");
    expect(getLandingCampaignTrialChat({ metadata: running })).not.toHaveProperty("limitReason");

    const awaiting = withLandingCampaignChatState(running, "awaiting_user", true, {
      awaitingUserKind: "follow_up",
    });
    expect(getLandingCampaignTrialChat({ metadata: awaiting })).toMatchObject({
      state: "awaiting_user",
      inputLocked: true,
      awaitingUserKind: "follow_up",
    });
  });

  it("rejects user-supplied landing-campaign service identities", () => {
    expect(isLandingCampaignServiceOrg(trialConfig, "service_org")).toBe(true);
    expect(isLandingCampaignServiceOrg(trialConfig, "customer_org")).toBe(false);
    expect(
      isLandingCampaignServiceMembership(trialConfig, {
        userId: "service_user",
        organizationId: "customer_org",
      }),
    ).toBe(true);
    expect(
      isLandingCampaignServiceMembership(trialConfig, {
        userId: "service_user",
        organizationId: "service_org",
      }),
    ).toBe(false);

    expect(() => assertMetadataDoesNotClaimLandingCampaignTrial({ landingCampaignTrial: true })).toThrow(
      ForbiddenError,
    );
    expect(() =>
      assertMutableAgentIsNotLandingCampaignTrial({
        metadata: buildLandingCampaignAgentMetadata({
          campaign: "portfolio",
          skillSetId: "portfolio",
          skillSetVersion: "v1",
        }),
      }),
    ).toThrow("Landing campaign trial agents are managed by First Tree.");
  });

  it("enforces explicit message routing and strips untrusted sender metadata", () => {
    const routed = preflightMessageSendIntent({
      chatId: "chat_1",
      senderId: "sender",
      senderType: "agent",
      data: {
        format: MESSAGE_FORMATS.TEXT,
        content: "ready",
        receiverNames: ["bot"],
        metadata: { systemSender: "github", addressedAgentIds: ["human"] },
        source: "api",
      },
      options: { normalizeMentionsInContent: true },
      participants,
    });

    expect(routed.content).toBe("@bot ready");
    expect(routed.mentionedAgentIds).toEqual(["bot"]);
    expect(routed.metadata).toEqual({ mentions: ["bot"], addressedAgentIds: ["bot"] });

    expect(() =>
      preflightMessageSendIntent({
        chatId: "chat_1",
        senderId: "sender",
        senderType: "agent",
        data: { format: MESSAGE_FORMATS.TEXT, content: "hello", metadata: {}, source: "api" },
        participants,
      }),
    ).toThrow(BadRequestError);

    expect(() =>
      preflightMessageSendIntent({
        chatId: "chat_1",
        senderId: "sender",
        senderType: "agent",
        data: {
          format: MESSAGE_FORMATS.REQUEST,
          content: "can you decide?",
          metadata: { mentions: ["bot"] },
          source: "api",
        },
        participants,
      }),
    ).toThrow("must be directed at a human");

    expect(() =>
      preflightMessageSendIntent({
        chatId: "chat_1",
        senderId: "sender",
        senderType: "agent",
        data: {
          format: MESSAGE_FORMATS.TEXT,
          content: "wake up",
          metadata: { mentions: ["suspended"] },
          source: "api",
        },
        participants,
      }),
    ).toThrow("because the agent is suspended");
  });
});

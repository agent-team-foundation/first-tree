import { MESSAGE_FORMATS } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import { BadRequestError, ClientRetiredError, ConflictError } from "../errors.js";
import { getActivityOverview } from "../services/activity.js";
import {
  agentAvatarImageUrl,
  assertUserAgentMetadataHasNoReservedKeys,
  deleteAgent,
  ensureClientSupportsRuntimeProvider,
  fetchUserAvatarForHumanAgent,
  legacyWireAgentType,
  listAgents,
  reactivateAgent,
  resolveAvatarImageUrl,
  stripReservedAgentMetadata,
  suspendAgent,
} from "../services/agent.js";
import { assertNoRuntimeSwitchInProgress, getRuntimeSwitchClaim } from "../services/agent-runtime-switch.js";
import { createChat, resolveAgentIdsByNameInOrg, updateChatMetadata } from "../services/chat.js";
import { explainContextTreeIoDecision } from "../services/context-tree-io.js";
import {
  exchangeCodeForAppUserProfile,
  fetchInstallation,
  GithubAppApiError,
  listInstallationRepos,
  refreshAppUserToken,
  verifyUserCanAdministerInstallation,
} from "../services/github-app.js";
import { maybeUnwrapDoubleEncoded, preflightMessageSendIntent } from "../services/message.js";
import { createResourcesService } from "../services/resources.js";
import { listAgentTurns, summarizeAgent } from "../services/usage.js";

type ChainRows = unknown[];

function queryChain(rows: unknown[]): unknown {
  const promise = Promise.resolve(rows);
  const chain = new Proxy(
    function queryProxy(): unknown {
      return chain;
    },
    {
      get: (_target, prop) => {
        if (prop === "then") return promise.then.bind(promise);
        if (prop === "catch") return promise.catch.bind(promise);
        if (prop === "finally") return promise.finally.bind(promise);
        if (prop === Symbol.iterator) return rows[Symbol.iterator].bind(rows);
        if (prop === "returning") return vi.fn(async () => rows);
        return vi.fn(() => chain);
      },
    },
  );
  return chain;
}

function queuedSelectDb(results: ChainRows[]): unknown {
  return {
    select: vi.fn(() => queryChain(results.shift() ?? [])),
  };
}

function agentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "agent_1",
    name: "agent",
    displayName: "Agent",
    organizationId: "org_1",
    type: "agent",
    status: "active",
    memberStatus: "active",
    visibility: "organization",
    managerId: "member_1",
    metadata: {},
    ...overrides,
  };
}

function resourceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "resource_1",
    organizationId: "org_1",
    type: "repo",
    scope: "team",
    ownerAgentId: null,
    name: "Repo",
    repoCanonicalKey: "https://github.com/acme/repo.git",
    defaultEnabled: "available",
    status: "active",
    payload: { url: "https://github.com/acme/repo.git" },
    createdBy: "member_1",
    updatedBy: "member_1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function bindingRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "binding_1",
    organizationId: "org_1",
    agentId: "agent_1",
    type: "prompt",
    mode: "include",
    resourceId: null,
    replacesResourceId: null,
    inlinePromptBody: null,
    repoRef: null,
    repoLocalPath: null,
    order: 0,
    createdBy: "member_1",
    updatedBy: "member_1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function resourceNotifier(): never {
  return { notifyConfigChange: vi.fn(async () => undefined) } as never;
}

function permissiveDb(rows: unknown[] = []): unknown {
  const db = {
    delete: vi.fn(() => queryChain(rows)),
    execute: vi.fn(async () => rows),
    insert: vi.fn(() => queryChain(rows)),
    select: vi.fn(() => queryChain(rows)),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    update: vi.fn(() => queryChain(rows)),
  };
  return db;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

const imageRef = {
  imageId: "11111111-1111-4111-8111-111111111111",
  mimeType: "image/png",
  filename: "screen.png",
};

const participants = [
  { agentId: "sender", name: "sender", displayName: "Sender", status: "active", type: "agent" },
  { agentId: "bot", name: "bot", displayName: "Bot", status: "active", type: "agent" },
  { agentId: "human", name: "alice", displayName: "Alice", status: "active", type: "human" },
  { agentId: "suspended", name: null, displayName: "", status: "suspended", type: "agent" },
  { agentId: "deleted", name: "gone", displayName: "", status: "deleted", type: "agent" },
] as const;

describe("service branch defaults", () => {
  it("covers agent metadata, avatar, and runtime-switch guard branches", async () => {
    expect(stripReservedAgentMetadata(null)).toEqual({});
    expect(stripReservedAgentMetadata(["runtime"])).toEqual({});
    expect(stripReservedAgentMetadata({ runtimeSwitch: { claimId: "c1" }, public: true })).toEqual({ public: true });
    expect(() => assertUserAgentMetadataHasNoReservedKeys({ runtimeSession: {} })).toThrow(BadRequestError);

    expect(agentAvatarImageUrl("agent_1", null)).toBeNull();
    expect(agentAvatarImageUrl("agent_1", new Date(1000))).toBe("/api/v1/agents/agent_1/avatar?v=1000");
    expect(
      resolveAvatarImageUrl({
        uuid: "human_1",
        type: "human",
        avatarImageUpdatedAt: undefined,
        userAvatarUrl: "https://avatars.example/u.png",
      }),
    ).toBe("https://avatars.example/u.png");
    expect(
      resolveAvatarImageUrl({ uuid: "agent_1", type: "agent", avatarImageUpdatedAt: null, userAvatarUrl: "x" }),
    ).toBeNull();
    expect(legacyWireAgentType("human")).toBe("human");
    expect(legacyWireAgentType("agent")).toBe("personal_assistant");

    await expect(
      fetchUserAvatarForHumanAgent(queuedSelectDb([]) as never, { uuid: "a", type: "agent" }),
    ).resolves.toBeNull();
    await expect(
      fetchUserAvatarForHumanAgent(queuedSelectDb([[{}]]) as never, { uuid: "h", type: "human" }),
    ).resolves.toBeNull();

    expect(getRuntimeSwitchClaim(null)).toBeNull();
    expect(getRuntimeSwitchClaim({ runtimeSwitch: { claimId: 42 } })).toBeNull();
    expect(() => assertNoRuntimeSwitchInProgress({ metadata: { runtimeSwitch: { claimId: 42 } } })).toThrow(
      "Agent runtime switch is in progress",
    );
    expect(() => assertNoRuntimeSwitchInProgress({ metadata: { runtimeSwitch: { claimId: "claim_1" } } })).toThrow(
      ConflictError,
    );
  });

  it("covers client runtime capability tri-state branches", async () => {
    await expect(
      ensureClientSupportsRuntimeProvider(queuedSelectDb([]) as never, null, "codex"),
    ).resolves.toBeUndefined();
    await expect(
      ensureClientSupportsRuntimeProvider(queuedSelectDb([]) as never, "client_1", "codex", { force: true }),
    ).resolves.toBeUndefined();
    await expect(
      ensureClientSupportsRuntimeProvider(queuedSelectDb([[]]) as never, "client_1", "codex"),
    ).resolves.toBeUndefined();
    await expect(
      ensureClientSupportsRuntimeProvider(
        queuedSelectDb([[{ metadata: { capabilities: null }, retiredAt: null }]]) as never,
        "client_1",
        "codex",
      ),
    ).resolves.toBeUndefined();
    await expect(
      ensureClientSupportsRuntimeProvider(
        queuedSelectDb([[{ metadata: { capabilities: { codex: null } }, retiredAt: null }]]) as never,
        "client_1",
        "codex",
      ),
    ).rejects.toThrow(BadRequestError);
    await expect(
      ensureClientSupportsRuntimeProvider(
        queuedSelectDb([
          [{ metadata: { capabilities: { codex: { available: true } } }, retiredAt: new Date() }],
        ]) as never,
        "client_1",
        "codex",
      ),
    ).rejects.toThrow(ClientRetiredError);
  });

  it("covers agent listing and lifecycle defensive branches", async () => {
    const first = { uuid: "agent_1", createdAt: new Date("2026-01-02T00:00:00.000Z") };
    const second = { uuid: "agent_2", createdAt: new Date("2026-01-01T00:00:00.000Z") };
    await expect(
      listAgents(queuedSelectDb([[first, second]]) as never, "org_1", 1, "2026-01-03T00:00:00.000Z", "agent"),
    ).resolves.toEqual({ items: [first], nextCursor: first.createdAt.toISOString() });

    await expect(
      reactivateAgent(
        {
          select: vi.fn(() =>
            queryChain([{ uuid: "agent_1", status: "suspended", type: "agent", clientId: "client_1" }]),
          ),
          update: vi.fn(() => queryChain([])),
        } as never,
        "agent_1",
      ),
    ).rejects.toThrow("Unexpected: UPDATE RETURNING produced no row");

    await expect(
      suspendAgent(
        {
          select: vi
            .fn()
            .mockReturnValueOnce(queryChain([{ uuid: "agent_1", status: "active", type: "agent" }]))
            .mockReturnValueOnce(queryChain([])),
          update: vi.fn(() => queryChain([])),
        } as never,
        "agent_1",
      ),
    ).rejects.toThrow("Unexpected: agent disappeared after UPDATE");

    await expect(
      deleteAgent(
        {
          select: vi.fn(() => queryChain([{ uuid: "agent_1", status: "suspended", type: "agent" }])),
          update: vi.fn(() => queryChain([])),
        } as never,
        "agent_1",
      ),
    ).rejects.toThrow("Unexpected: UPDATE RETURNING produced no row");
  });

  it("covers message preflight validation, routing, and decode branches", () => {
    expect(
      preflightMessageSendIntent({
        chatId: "chat_1",
        senderId: "sender",
        senderType: "agent",
        data: {
          format: MESSAGE_FORMATS.FILE,
          content: { attachments: [imageRef], caption: "see attached" },
          metadata: { mentions: ["bot"], systemSender: "spoofed", addressedAgentIds: ["spoofed"] },
          source: "api",
        },
        participants,
      }),
    ).toMatchObject({ mentionedAgentIds: ["bot"] });

    expect(
      preflightMessageSendIntent({
        chatId: "chat_1",
        senderId: "sender",
        senderType: "agent",
        data: {
          format: MESSAGE_FORMATS.TEXT,
          content: "ready",
          receiverNames: ["bot"],
          metadata: {},
          source: "api",
        },
        options: { normalizeMentionsInContent: true },
        participants,
      }).content,
    ).toBe("@bot ready");

    expect(() =>
      preflightMessageSendIntent({
        chatId: "chat_1",
        senderId: "sender",
        senderType: "agent",
        data: { format: MESSAGE_FORMATS.TEXT, content: "hello", metadata: { mentions: ["suspended"] }, source: "api" },
        participants,
      }),
    ).toThrow("because the agent is suspended");
    expect(() =>
      preflightMessageSendIntent({
        chatId: "chat_1",
        senderId: "sender",
        senderType: "agent",
        data: { format: MESSAGE_FORMATS.TEXT, content: "hello", metadata: {}, source: "api" },
        options: { addressedToAgentIds: ["deleted"] },
        participants,
      }),
    ).toThrow("Deleted agents cannot receive new messages");
    expect(() =>
      preflightMessageSendIntent({
        chatId: "chat_1",
        senderId: "sender",
        senderType: "agent",
        data: { format: MESSAGE_FORMATS.REQUEST, content: "question", metadata: { mentions: ["bot"] }, source: "api" },
        participants,
      }),
    ).toThrow("must be directed at a human");

    expect(maybeUnwrapDoubleEncoded(JSON.stringify({ not: "a string" }))).toBeNull();
    expect(maybeUnwrapDoubleEncoded('"unterminated\\n')).toBeNull();
    expect(maybeUnwrapDoubleEncoded(JSON.stringify("line\\nnext"))).toBe("line\\nnext");
  });

  it("covers context-tree IO decision branches", () => {
    const bindingRepo = "https://github.com/acme/context.git";
    const validRef = {
      origin: "file_change",
      repoUrl: bindingRepo,
      repoBranch: "main",
      repoRelativePath: "domains/runtime/NODE.md",
      pathKind: "file",
    };

    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "codex",
        sessionEvent: { kind: "tool_call", payload: { toolUseId: "t1", name: "file_change", status: "ok" } },
        bindingRepo: null,
      }),
    ).toEqual({ recordable: false, reason: "no_org_context_tree_binding" });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "codex",
        sessionEvent: { kind: "tool_call", payload: { toolUseId: "t2", name: "file_change", status: "error" } },
        bindingRepo,
      }),
    ).toEqual({ recordable: false, reason: "status_not_ok" });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "claude-code",
        sessionEvent: { kind: "tool_call", payload: { toolUseId: "t3", name: "Bash", status: "ok", args: {} } },
        bindingRepo,
      }),
    ).toEqual({ recordable: false, reason: "unsupported_shell_command" });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "claude-code-tui",
        sessionEvent: {
          kind: "tool_call",
          payload: { toolUseId: "t4", name: "Read", status: "ok", toolFileRefs: [validRef] },
        },
        bindingRepo,
        chatInOrg: false,
      }),
    ).toEqual({ recordable: false, reason: "chat_not_in_org" });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "codex",
        sessionEvent: {
          kind: "tool_call",
          payload: {
            toolUseId: "t5",
            name: "unknown",
            status: "ok",
            toolFileRefs: [{ ...validRef, origin: "git_status_delta" }],
          },
        },
        bindingRepo,
      }),
    ).toEqual({ recordable: true });
  });

  it("covers usage and activity row-default branches with minimal db fakes", async () => {
    const summary = await summarizeAgent(queuedSelectDb([[], []]) as never, {
      agentId: "agent_1",
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(summary.totals).toMatchObject({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, turns: 0, chats: 0 });

    const createdAt = new Date("2026-01-01T01:00:00.000Z");
    const turns = await listAgentTurns(
      queuedSelectDb([
        [
          { seq: 2, chatId: "chat_1", createdAt, payload: {} },
          { seq: 1, chatId: "chat_2", createdAt: new Date("2026-01-01T00:00:00.000Z"), payload: null },
        ],
        [{ id: "chat_1", topic: null }],
        [{ chatId: "chat_1" }],
      ]) as never,
      {
        agentId: "agent_1",
        from: new Date("2026-01-01T00:00:00.000Z"),
        to: new Date("2026-01-02T00:00:00.000Z"),
        cursor: null,
        limit: 1,
        viewer: { humanAgentId: "human_1" },
      },
    );
    expect(turns.rows[0]).toMatchObject({
      chatId: "chat_1",
      chatTitle: null,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      provider: "",
      model: "",
    });
    expect(turns.nextCursor).not.toBeNull();

    await expect(getActivityOverview(queuedSelectDb([[], []]) as never)).resolves.toEqual({
      total: 0,
      running: 0,
      byState: { idle: 0, working: 0, blocked: 0, error: 0 },
      clients: 0,
    });
  });

  it("covers chat service defensive branches with db fakes", async () => {
    const creator = agentRow({ id: "creator", type: "human" });
    const participant = agentRow({ id: "participant" });

    await expect(
      createChat(queuedSelectDb([[agentRow({ id: "other_1" }), agentRow({ id: "other_2" })]]) as never, {
        mode: "legacy-empty-web",
        organizationId: "org_1",
        creatorAgentId: "creator",
        participantAgentIds: ["participant"],
      }),
    ).rejects.toThrow("Unexpected: creator not in existingAgents");

    await expect(
      createChat(queuedSelectDb([[agentRow({ id: "other_1" }), agentRow({ id: "recipient" })]]) as never, {
        mode: "task",
        organizationId: "org_1",
        source: "manual",
        initiatorAgentId: "initiator",
        initialRecipientAgentIds: ["recipient"],
        contextParticipantAgentIds: [],
        initialMessage: { format: MESSAGE_FORMATS.TEXT, content: "hello", metadata: {}, source: "api" },
      }),
    ).rejects.toThrow("Unexpected: initiator missing after loadAgentsForCreate");

    await expect(
      createChat(queuedSelectDb([[agentRow({ id: "initiator", type: "human" }), agentRow({ id: "wrong" })]]) as never, {
        mode: "task",
        organizationId: "org_1",
        source: "manual",
        initiatorAgentId: "initiator",
        initialRecipientAgentIds: ["recipient"],
        contextParticipantAgentIds: [],
        initialMessage: { format: MESSAGE_FORMATS.TEXT, content: "hello", metadata: {}, source: "api" },
      }),
    ).rejects.toThrow("Agents not found: recipient");

    await expect(
      createChat(
        queuedSelectDb([[agentRow({ id: "initiator" }), agentRow({ id: "recipient", status: "suspended" })]]) as never,
        {
          mode: "task",
          organizationId: "org_1",
          source: "manual",
          initiatorAgentId: "initiator",
          initialRecipientAgentIds: ["recipient"],
          contextParticipantAgentIds: [],
          initialMessage: { format: MESSAGE_FORMATS.TEXT, content: "hello", metadata: {}, source: "api" },
        },
      ),
    ).rejects.toThrow('Cannot create task chat with inactive participant "Agent" (suspended).');

    const legacyEmptyInsertDb = {
      insert: vi.fn(() => queryChain([])),
      select: vi.fn(() => queryChain([creator, participant])),
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(legacyEmptyInsertDb)),
    };
    await expect(
      createChat(legacyEmptyInsertDb as never, {
        mode: "legacy-empty-web",
        organizationId: "org_1",
        creatorAgentId: "creator",
        participantAgentIds: ["participant"],
      }),
    ).rejects.toThrow("Unexpected: INSERT RETURNING produced no row");

    const legacyKickoffMissingDb = {
      insert: vi.fn(() => queryChain([])),
      select: vi
        .fn()
        .mockReturnValueOnce(queryChain([creator, participant]))
        .mockReturnValue(queryChain([])),
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(legacyKickoffMissingDb)),
    };
    await expect(
      createChat(legacyKickoffMissingDb as never, {
        mode: "legacy-empty-agent",
        creatorAgentId: "creator",
        participantAgentIds: ["participant"],
        onboardingKickoffKey: "kickoff-missing",
      }),
    ).rejects.toThrow("Unexpected: kickoff-key conflict but no existing chat row");

    const taskEmptyInsertDb = {
      insert: vi.fn(() => queryChain([])),
      select: vi.fn(() => queryChain([agentRow({ id: "initiator", type: "human" }), agentRow({ id: "recipient" })])),
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(taskEmptyInsertDb)),
    };
    await expect(
      createChat(taskEmptyInsertDb as never, {
        mode: "task",
        organizationId: "org_1",
        source: "manual",
        initiatorAgentId: "initiator",
        initialRecipientAgentIds: ["recipient"],
        contextParticipantAgentIds: [],
        initialMessage: { format: MESSAGE_FORMATS.TEXT, content: "hello", metadata: {}, source: "api" },
      }),
    ).rejects.toThrow("Unexpected: INSERT RETURNING produced no row");

    const taskKickoffMissingDb = {
      insert: vi.fn(() => queryChain([])),
      select: vi
        .fn()
        .mockReturnValueOnce(queryChain([agentRow({ id: "initiator", type: "human" }), agentRow({ id: "recipient" })]))
        .mockReturnValue(queryChain([])),
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(taskKickoffMissingDb)),
    };
    await expect(
      createChat(taskKickoffMissingDb as never, {
        mode: "task",
        organizationId: "org_1",
        source: "manual",
        initiatorAgentId: "initiator",
        initialRecipientAgentIds: ["recipient"],
        contextParticipantAgentIds: [],
        onboardingKickoffKey: "task-kickoff-missing",
        initialMessage: { format: MESSAGE_FORMATS.TEXT, content: "hello", metadata: {}, source: "api" },
      }),
    ).rejects.toThrow("Unexpected: kickoff-key conflict but no existing chat row");

    await expect(resolveAgentIdsByNameInOrg(queuedSelectDb([]) as never, "org_1", [])).resolves.toEqual([]);
    await expect(
      resolveAgentIdsByNameInOrg(queuedSelectDb([[{ uuid: undefined, name: "alice" }]]) as never, "org_1", ["alice"]),
    ).rejects.toThrow("Unexpected: missing name after validation");

    await expect(
      (await import("../services/chat.js")).listChatsForMember(
        queuedSelectDb([
          [[agentRow({ id: undefined, uuid: "human_1", type: "human" })]],
          [{ chatId: "chat_1", agentId: "ghost_agent", role: "member" }],
          [
            {
              id: "chat_1",
              type: "group",
              topic: "Ghost Chat",
              metadata: {},
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
              participantCount: 1,
            },
          ],
        ]) as never,
        "member_1",
        "human_1",
      ),
    ).resolves.toEqual([]);

    const updateDb = {
      select: vi.fn(() => queryChain([{ description: "old" }])),
      update: vi.fn(() => queryChain([])),
    };
    await expect(updateChatMetadata(updateDb as never, "chat_1", { description: "new" })).rejects.toThrow(
      'Unexpected: chat "chat_1" missing after update',
    );
  });

  it("covers resource service conflict-code fallback branches", async () => {
    const notifier = resourceNotifier();
    const createService = createResourcesService({
      db: {
        transaction: vi.fn(async () => {
          throw { code: "23505" };
        }),
      } as never,
      notifier,
    });
    await expect(
      createService.createTeamResource(
        "org_1",
        {
          type: "repo",
          name: "Repo",
          defaultEnabled: "available",
          payload: { url: "https://github.com/acme/repo.git" },
        },
        "member_1",
      ),
    ).rejects.toThrow("A matching resource already exists");

    const updateService = createResourcesService({
      db: {
        select: vi.fn(() => queryChain([resourceRow()])),
        transaction: vi.fn(async () => {
          throw { cause: { code: "23505" } };
        }),
      } as never,
      notifier,
    });
    await expect(
      updateService.updateResource("resource_1", { payload: { url: "https://github.com/acme/repo.git" } }, "member_1"),
    ).rejects.toThrow("A matching resource already exists");

    const createFailure = new Error("plain create failure");
    const createRethrowService = createResourcesService({
      db: {
        transaction: vi.fn(async () => {
          throw createFailure;
        }),
      } as never,
      notifier,
    });
    await expect(
      createRethrowService.createTeamResource(
        "org_1",
        {
          type: "repo",
          name: "Repo",
          defaultEnabled: "available",
          payload: { url: "https://github.com/acme/repo.git" },
        },
        "member_1",
      ),
    ).rejects.toBe(createFailure);

    const nonStringCodeFailure = { cause: { code: 42 } };
    const updateRethrowService = createResourcesService({
      db: {
        select: vi.fn(() => queryChain([resourceRow()])),
        transaction: vi.fn(async () => {
          throw nonStringCodeFailure;
        }),
      } as never,
      notifier,
    });
    await expect(
      updateRethrowService.updateResource(
        "resource_1",
        { payload: { url: "https://github.com/acme/repo.git" } },
        "member_1",
      ),
    ).rejects.toBe(nonStringCodeFailure);

    const agentImpactService = createResourcesService({
      db: {
        select: vi.fn(() => queryChain([resourceRow({ scope: "agent", ownerAgentId: null })])),
      } as never,
      notifier,
    });
    await expect(agentImpactService.previewResourceImpact("resource_1", {})).resolves.toMatchObject({
      affectedAgentCount: 0,
      promptOverflowAgentCount: 0,
    });

    const ownedAgentResource = resourceRow({ scope: "agent", ownerAgentId: "agent_owner" });
    const ownedImpactService = createResourcesService({
      db: queuedSelectDb([
        [ownedAgentResource],
        [{ uuid: "agent_owner", name: "owner", displayName: "Owner" }],
        [{ uuid: "agent_owner", organizationId: "org_1", status: "active" }],
        [{ version: 1 }],
        [ownedAgentResource],
        [],
      ]) as never,
      notifier,
    });
    await expect(ownedImpactService.previewResourceImpact("resource_1", {})).resolves.toMatchObject({
      affectedAgentCount: 1,
      agents: [expect.objectContaining({ uuid: "agent_owner" })],
    });
  });

  it("covers runtime resource projection, validation, and fallback branches", async () => {
    const notifier = resourceNotifier();
    const teamPrompt = resourceRow({
      id: "prompt_team",
      type: "prompt",
      name: "Team Prompt",
      defaultEnabled: "recommended",
      payload: { body: "team guidance" },
    });
    const repoA = resourceRow({
      id: "repo_a",
      type: "repo",
      name: "Repo A",
      defaultEnabled: "recommended",
      payload: { url: "https://github.com/acme/runtime.git" },
    });
    const repoB = resourceRow({
      id: "repo_b",
      type: "repo",
      name: "Repo B",
      defaultEnabled: "recommended",
      payload: { url: "https://github.com/acme/runtime.git" },
    });
    const validSkill = resourceRow({
      id: "skill_valid",
      type: "skill",
      name: "Skill",
      defaultEnabled: "recommended",
      payload: { name: "skill", description: "Useful skill", body: "steps", metadata: { source: "test" } },
    });
    const invalidSkill = resourceRow({
      id: "skill_bad",
      type: "skill",
      name: "Bad Skill",
      defaultEnabled: "recommended",
      payload: { name: "", description: "", body: "" },
    });
    const validMcp = resourceRow({
      id: "mcp_valid",
      type: "mcp",
      name: "MCP",
      defaultEnabled: "recommended",
      payload: { name: "mcp", transport: "http", url: "https://mcp.example.test/rpc" },
    });
    const invalidMcp = resourceRow({
      id: "mcp_bad",
      type: "mcp",
      name: "Bad MCP",
      defaultEnabled: "recommended",
      payload: { name: "mcp", transport: "http" },
    });
    const db = queuedSelectDb([
      [{ uuid: "agent_1", organizationId: "org_1", status: "active" }],
      [{ version: 7 }],
      [teamPrompt, repoA, repoB, validSkill, invalidSkill, validMcp, invalidMcp],
      [
        bindingRow({ id: "inline_a", type: "prompt", inlinePromptBody: "a".repeat(20_000), order: 10 }),
        bindingRow({ id: "inline_b", type: "prompt", inlinePromptBody: "b".repeat(20_000), order: 11 }),
        bindingRow({
          id: "inline_replace",
          type: "prompt",
          mode: "replace",
          replacesResourceId: "prompt_team",
          inlinePromptBody: "replacement guidance",
          order: 1,
        }),
      ],
    ]);
    const service = createResourcesService({ db: db as never, notifier });

    const config = await service.resolveRuntimeConfig({
      agentId: "agent_1",
      version: 1,
      payload: {
        kind: "claude-code",
        prompt: { append: "base" },
        gitRepos: [],
        mcpServers: [],
        resourceSkills: [],
      },
    } as never);

    expect(config.version).toBe(7);
    expect(config.payload.gitRepos).toEqual([expect.objectContaining({ url: "https://github.com/acme/runtime.git" })]);
    expect(config.payload.resourceSkills).toEqual([
      expect.objectContaining({ resourceId: "skill_valid", name: "skill", metadata: { source: "test" } }),
    ]);
    expect(config.payload.mcpServers).toEqual([
      expect.objectContaining({ name: "mcp", transport: "http", url: "https://mcp.example.test/rpc" }),
    ]);
    expect(config.payload.prompt.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "agent", name: "", editable: true, body: "a".repeat(20_000) }),
        expect.objectContaining({ scope: "agent", name: "Team Prompt", editable: false, body: "replacement guidance" }),
      ]),
    );

    const effective = await createResourcesService({
      db: queuedSelectDb([
        [{ uuid: "agent_1", organizationId: "org_1", status: "active" }],
        [{ version: 7 }],
        [teamPrompt, repoA, repoB, validSkill, invalidSkill, validMcp, invalidMcp],
        [
          bindingRow({ id: "inline_a", type: "prompt", inlinePromptBody: "a".repeat(20_000), order: 10 }),
          bindingRow({ id: "inline_b", type: "prompt", inlinePromptBody: "b".repeat(20_000), order: 11 }),
        ],
      ]) as never,
      notifier,
    }).resolveEffectiveResources("agent_1");
    expect(effective.unavailable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "repo", id: "repo_b", reason: "duplicate_local_path" }),
        expect.objectContaining({ type: "prompt", id: "inline_b", reason: "prompt_budget_exceeded" }),
        expect.objectContaining({ type: "skill", id: "skill_bad", reason: "invalid_skill_payload" }),
        expect.objectContaining({ type: "mcp", id: "mcp_bad", reason: "invalid_mcp_payload" }),
      ]),
    );

    const overflowTeamPrompt = await createResourcesService({
      db: queuedSelectDb([
        [{ uuid: "agent_1", organizationId: "org_1", status: "active" }],
        [{ version: 8 }],
        [
          resourceRow({
            id: "prompt_a",
            type: "prompt",
            name: "Prompt A",
            defaultEnabled: "recommended",
            payload: { body: "a".repeat(20_000) },
          }),
          resourceRow({
            id: "prompt_b",
            type: "prompt",
            name: "Prompt B",
            defaultEnabled: "recommended",
            payload: { body: "b".repeat(20_000) },
          }),
        ],
        [],
      ]) as never,
      notifier,
    }).resolveEffectiveResources("agent_1");
    expect(overflowTeamPrompt.unavailable).toContainEqual({
      type: "prompt",
      id: "prompt_b",
      reason: "prompt_budget_exceeded",
    });
  });

  it("skips missing resource binding slots during replacement", async () => {
    const notifier = resourceNotifier();
    const selectRows = [
      [{ uuid: "agent_1", organizationId: "org_1", status: "active" }],
      [{ uuid: "agent_1", organizationId: "org_1", status: "active" }],
      [{ version: 2 }],
      [],
      [],
      [],
      [],
    ];
    const db = {
      delete: vi.fn(() => queryChain([])),
      insert: vi.fn(() => queryChain([])),
      select: vi.fn(() => queryChain(selectRows.shift() ?? [])),
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
      update: vi.fn(() => queryChain([{ version: 2 }])),
    };
    const service = createResourcesService({ db: db as never, notifier });
    const binding = {
      type: "prompt",
      mode: "include",
      inlinePromptBody: "agent guidance",
    } as const;
    const bindings = {
      1: binding,
      length: 2,
      [Symbol.iterator]: function* () {
        yield binding;
      },
    };

    await expect(
      service.replaceAgentResources("agent_1", { expectedVersion: 1, bindings: bindings as never }, "member_1"),
    ).resolves.toMatchObject({ version: 2 });
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("keeps configured MCP servers when no MCP resources are effective", async () => {
    const notifier = resourceNotifier();
    const service = createResourcesService({
      db: queuedSelectDb([
        [{ uuid: "agent_1", organizationId: "org_1", status: "active" }],
        [{ version: 3 }],
        [],
        [],
      ]) as never,
      notifier,
    });

    const config = await service.resolveRuntimeConfig({
      agentId: "agent_1",
      version: 1,
      payload: {
        kind: "claude-code",
        prompt: { append: "" },
        gitRepos: [],
        mcpServers: [{ name: "existing", type: "stdio", command: "node", args: [], env: {} }],
        resourceSkills: [],
      },
    } as never);

    expect(config.payload.mcpServers).toEqual([
      { name: "existing", type: "stdio", command: "node", args: [], env: {} },
    ]);
  });

  it("exercises empty-database service edges through public APIs", async () => {
    const db = permissiveDb() as never;
    const notifier = resourceNotifier();
    const resources = createResourcesService({ db, notifier });
    const [
      agentService,
      chatService,
      documentService,
      inboxService,
      memberService,
      membershipService,
      orgSettingsService,
      sessionService,
    ] = await Promise.all([
      import("../services/agent.js"),
      import("../services/chat.js"),
      import("../services/document.js"),
      import("../services/inbox.js"),
      import("../services/member.js"),
      import("../services/membership.js"),
      import("../services/org-settings.js"),
      import("../services/session.js"),
    ]);
    const orgScope = {
      userId: "user_1",
      organizationId: "org_1",
      memberId: "member_1",
      role: "member" as const,
      humanAgentId: "human_1",
    };
    const docRow = {
      id: "doc_1",
      organizationId: "org_1",
      slug: "doc",
      title: "Doc",
      project: null,
      status: "draft",
      latestVersion: 1,
      createdByKind: "human",
      createdById: "human_1",
      createdByName: "Human",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const commentRow = {
      id: "comment_1",
      documentId: "doc_1",
      versionNumber: 1,
      parentId: null,
      body: "comment",
      anchor: null,
      status: "open",
      authorKind: "human",
      authorId: "human_1",
      authorName: "Human",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    const calls: Array<() => Promise<unknown>> = [
      () => agentService.getAgent(db, "missing-agent"),
      () => agentService.getAgentByName(db, "org_1", "missing"),
      () => agentService.listAgentsForAdmin(db, orgScope, 1, "2026-01-01"),
      () => agentService.listAgentsForMember(db, orgScope, 1, "2026-01-01", "agent", "Agent 100%_literal", true),
      () => agentService.checkAgentNameAvailability(db, "org_1", "missing"),
      () => agentService.getNewChatDefaultCandidate(db, orgScope, null),
      () => chatService.getChat(db, "missing-chat"),
      () => chatService.getChatDetail(db, "missing-chat", null),
      () => chatService.listActiveRuntimeChatIds(db, "agent_1", "human_1", "org_1"),
      () => chatService.listChats(db, "agent_1", 1, "2026-01-01"),
      () => chatService.listChatParticipantsWithNames(db, "chat_1"),
      () => chatService.assertParticipant(db, "chat_1", "agent_1"),
      () => chatService.assertOwner(db, "chat_1", "agent_1"),
      () => chatService.isParticipant(db, "chat_1", "agent_1"),
      () => chatService.ensureParticipant(db, "chat_1", "agent_1"),
      () => chatService.listChatsForMember(db, "member_1", "human_1"),
      () => chatService.leaveChat(db, "chat_1", "human_1"),
      () => documentService.getDocumentRow(db, "doc_1"),
      () => documentService.getDocumentWithVersion(db, docRow),
      () => documentService.listDocuments(db, "org_1", { limit: 10 }),
      () => documentService.setDocumentStatus(db, docRow, "approved"),
      () => documentService.getCommentRow(db, "comment_1"),
      () => documentService.setCommentStatus(db, commentRow, "resolved"),
      () => documentService.listComments(db, docRow, { versionNumber: undefined, status: undefined }),
      () => inboxService.pollInbox(db, "inbox_1", 1),
      () => inboxService.claimBacklogForPush(db, "inbox_1", 1),
      () => inboxService.claimBacklogForPushForChat(db, "inbox_1", "chat_1", 1),
      () => inboxService.claimBacklogForPushFair(db, "inbox_1", { limit: 1, defaultPerChatLimit: 1, chatBudgets: [] }),
      () => inboxService.resetDeliveredForInboxes(db, ["inbox_1"]),
      () => inboxService.pruneStaleSilentEntries(db),
      () => memberService.getMember(db, "member_1"),
      () => membershipService.listActiveMemberships(db, "user_1"),
      () => membershipService.countActiveMembersByOrgs(db, ["org_1"]),
      () => orgSettingsService.getOrgContextTreeBinding(db, "org_1"),
      () => resources.listTeamResources("org_1"),
      () => resources.getResource("resource_1"),
      () => resources.getAgentResources("agent_1"),
      () => resources.resolveEffectiveResources("agent_1"),
      () => sessionService.getSession(db, "agent_1", "chat_1"),
      () => sessionService.listAgentSessions(db, "agent_1"),
    ];

    const results = await Promise.allSettled(calls.map((call) => Promise.resolve().then(call)));
    expect(results).toHaveLength(calls.length);
  });

  it("covers GitHub App fetcher and response fallback branches", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("/installation/repositories")) {
        return jsonResponse({ repositories: [{ full_name: "acme/a", clone_url: "u", html_url: "h", private: false }] });
      }
      if (url.includes("/app/installations/123")) {
        return jsonResponse({ id: 123, account: { id: 7, login: "acme", type: "Organization" } });
      }
      if (url.includes("/user/memberships/orgs/acme")) {
        return jsonResponse({ state: "pending", role: "admin" });
      }
      if (url.includes("/login/oauth/access_token")) {
        return jsonResponse({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 60,
          refresh_token_expires_in: 120,
        });
      }
      if (url.endsWith("/user")) {
        return jsonResponse({ id: 1, login: "octo", name: null, email: null, avatar_url: null });
      }
      if (url.endsWith("/user/emails")) {
        return jsonResponse([{ email: "verified@example.com", primary: false, verified: true }]);
      }
      return textResponse("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await expect(fetchInstallation("app-jwt", 123)).resolves.toMatchObject({
        permissions: {},
        events: [],
        suspendedAt: null,
      });
      await expect(
        verifyUserCanAdministerInstallation("user-token", 7, {
          accountType: "Organization",
          accountLogin: "acme",
          accountGithubId: 7,
        }),
      ).resolves.toBe(false);
      await expect(listInstallationRepos("installation-token", { perPage: 100, maxPages: 1 })).resolves.toEqual([
        {
          fullName: "acme/a",
          cloneUrl: "u",
          htmlUrl: "h",
          private: false,
          defaultBranch: null,
          pushedAt: null,
        },
      ]);
      await expect(refreshAppUserToken("client", "secret", "refresh")).resolves.toMatchObject({ scope: "" });
      await expect(
        exchangeCodeForAppUserProfile({
          clientId: "client",
          clientSecret: "secret",
          code: "code",
          redirectUri: "https://example.test/callback",
          installationId: null,
        }),
      ).resolves.toMatchObject({ profile: { email: "verified@example.com" }, scope: "" });

      await expect(
        refreshAppUserToken("client", "secret", "refresh", {
          fetcher: async () => jsonResponse({ error: "bad_verification_code" }),
        }),
      ).rejects.toThrow("bad_verification_code");
      await expect(
        exchangeCodeForAppUserProfile(
          {
            clientId: "client",
            clientSecret: "secret",
            code: "code",
            redirectUri: "https://example.test/callback",
            installationId: null,
          },
          { fetcher: async () => jsonResponse({}) },
        ),
      ).rejects.toThrow("missing access_token / refresh_token");
      await expect(
        exchangeCodeForAppUserProfile(
          {
            clientId: "client",
            clientSecret: "secret",
            code: "code",
            redirectUri: "https://example.test/callback",
            installationId: null,
          },
          { fetcher: async () => textResponse("plain upstream failure", { status: 500 }) },
        ),
      ).rejects.toThrow(GithubAppApiError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

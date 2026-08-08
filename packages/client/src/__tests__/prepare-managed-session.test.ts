import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionContext } from "../runtime/contracts.js";
import type { PrepareManagedSessionParams } from "../runtime/provider-support/preparation.js";
import { INIT_COMPLETE_SENTINEL_REL } from "../runtime/workspace.js";
import { mockCtxPlumbing } from "./test-helpers.js";

const acquireAgentHome = vi.fn((root: string) => root);
const markWorkspaceInitComplete = vi.fn();
const fetchChatContext = vi.fn();
const declaredSourceRepos = vi.fn();
const currentSourceRepoNamesFromPayload = vi.fn();
const reconcileManagedSkillsForConfig = vi.fn();
const teamSkillBundleResolverFromSdk = vi.fn(() => vi.fn());
const buildAgentBriefing = vi.fn();
const ensureAgentBootstrap = vi.fn();

vi.mock("../runtime/workspace.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime/workspace.js")>("../runtime/workspace.js");
  return {
    ...actual,
    acquireAgentHome: (root: string) => acquireAgentHome(root),
    markWorkspaceInitComplete: (workspace: string) => markWorkspaceInitComplete(workspace),
  };
});

vi.mock("../runtime/chat-context.js", () => ({
  fetchChatContext: (sdk: unknown, chatId: unknown, agent: unknown) => fetchChatContext(sdk, chatId, agent),
}));

vi.mock("../runtime/source-repos.js", () => ({
  declaredSourceRepos: (workspace: unknown, payload: unknown) => declaredSourceRepos(workspace, payload),
  currentSourceRepoNamesFromPayload: (payload: unknown, resolved: unknown) =>
    currentSourceRepoNamesFromPayload(payload, resolved),
}));

vi.mock("../runtime/managed-skills.js", () => ({
  reconcileManagedSkillsForConfig: (
    workspace: unknown,
    provider: unknown,
    runtimeConfig: unknown,
    log: unknown,
    resolver: unknown,
  ) => reconcileManagedSkillsForConfig(workspace, provider, runtimeConfig, log, resolver),
  reconcileManagedSkills: vi.fn(),
  isManagedSkillsUnsafeDiscoveryError: () => false,
}));

vi.mock("../runtime/team-skill-bundle-resolver.js", () => ({
  teamSkillBundleResolverFromSdk: (_sdk: unknown) => teamSkillBundleResolverFromSdk(),
}));

vi.mock("../runtime/agent-briefing.js", () => ({
  buildAgentBriefing: (opts: unknown) => buildAgentBriefing(opts),
}));

vi.mock("../runtime/agent-bootstrap.js", () => ({
  ensureAgentBootstrap: (params: unknown) => ensureAgentBootstrap(params),
}));

describe("prepareManagedSession", () => {
  let workspaceRoot: string;
  const callOrder: string[] = [];

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "prepare-managed-session-"));
    callOrder.length = 0;
    vi.clearAllMocks();

    acquireAgentHome.mockImplementation((root: string) => {
      callOrder.push("acquire");
      return root;
    });
    fetchChatContext.mockImplementation(async () => {
      callOrder.push("chatContext");
      return { chatId: "chat-1", title: "t", topic: null, description: null, participants: [] };
    });
    declaredSourceRepos.mockImplementation((workspace: string) => {
      callOrder.push("sourceRepos");
      return [{ absolutePath: join(workspace, "source-repos", "widget"), url: "https://example.test/widget" }];
    });
    reconcileManagedSkillsForConfig.mockImplementation(async () => {
      callOrder.push("skills");
      return {
        ok: true,
        resourceConfigVersion: 3,
        installed: [],
        skipped: [],
        removed: [],
        teamSkills: [
          {
            key: "resource:skill",
            name: "team-skill",
            description: "desc",
            revision: "r1",
            installedDigest: "sha256:abc",
            target: "/tmp/skill-target",
          },
        ],
        failures: [],
        staleTeamSnapshot: false,
      };
    });
    buildAgentBriefing.mockImplementation((opts: { teamSkills: Array<{ name: string; target: string }> }) => {
      callOrder.push("briefing");
      expect(opts.teamSkills[0]?.name).toBe("team-skill");
      expect(opts.teamSkills[0]?.target).toBe("/tmp/skill-target");
      return "BRIEFING_BODY";
    });
    ensureAgentBootstrap.mockImplementation(() => {
      callOrder.push("bootstrap");
    });
    markWorkspaceInitComplete.mockImplementation(() => {
      callOrder.push("sentinel");
    });
    currentSourceRepoNamesFromPayload.mockImplementation((_payload: unknown, resolved: boolean) => {
      callOrder.push(resolved ? "sourceNames:set" : "sourceNames:null");
      return resolved ? new Set(["widget"]) : null;
    });
    teamSkillBundleResolverFromSdk.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function sessionCtx(logs: string[] = []): SessionContext {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    return {
      agent: {
        agentId: "019d9a97-90b0-716b-8317-a8c0be8430d7",
        inboxId: "inbox-1",
        displayName: "prep-agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: {
        serverUrl: "https://first-tree.example.test",
        sendMessage,
      } as unknown as SessionContext["sdk"],
      chatId: "chat-1",
      log: (message: string) => {
        logs.push(message);
      },
      recordProviderActivity: () => {},
      emitEvent: () => {},
      ...mockCtxPlumbing({ sendMessage }, "chat-1"),
    } as SessionContext;
  }

  async function loadPrepare() {
    const mod = await import("../runtime/provider-support/preparation.js");
    return mod.prepareManagedSession;
  }

  it("runs the admission sequence in order and returns stable consumer values", async () => {
    const prepareManagedSession = await loadPrepare();
    const payload = {
      kind: "cursor" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [{ url: "https://example.test/widget", localPath: "widget" }],
      resourceSkills: [],
    };
    const runtimeConfig = {
      agentId: "019d9a97-90b0-716b-8317-a8c0be8430d7",
      version: 3,
      payload,
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    };

    const result = await prepareManagedSession({
      sessionCtx: sessionCtx(),
      workspaceRoot,
      runtimeProvider: "cursor",
      runtimeConfig: runtimeConfig as never,
      payload,
      payloadResolved: true,
      contextTree: {
        path: join(workspaceRoot, "context-tree"),
        repoUrl: "https://example.test/tree",
        branch: "main",
      },
    });

    expect(callOrder).toEqual([
      "acquire",
      "chatContext",
      "sourceRepos",
      "skills",
      "briefing",
      "sourceNames:set",
      "bootstrap",
      "sentinel",
    ]);
    expect(result.workspace).toBe(workspaceRoot);
    expect(result.briefing).toBe("BRIEFING_BODY");
    expect(result.chatContext).toEqual({
      chatId: "chat-1",
      title: "t",
      topic: null,
      description: null,
      participants: [],
    });
    expect(result.sourceRepos).toEqual([
      { absolutePath: join(workspaceRoot, "source-repos", "widget"), url: "https://example.test/widget" },
    ]);
    expect(result.teamSkills).toEqual([
      {
        key: "resource:skill",
        name: "team-skill",
        description: "desc",
        revision: "r1",
        installedDigest: "sha256:abc",
        target: "/tmp/skill-target",
      },
    ]);
    expect(result.resourceConfigVersion).toBe(3);
    expect(ensureAgentBootstrap).toHaveBeenCalledTimes(1);
    expect(markWorkspaceInitComplete).toHaveBeenCalledTimes(1);
    expect(markWorkspaceInitComplete).toHaveBeenCalledWith(workspaceRoot);
    expect(teamSkillBundleResolverFromSdk).toHaveBeenCalledTimes(1);
    expect(buildAgentBriefing).toHaveBeenCalledWith(
      expect.objectContaining({
        contextTreePath: join(workspaceRoot, "context-tree"),
        contextTreeRepoUrl: "https://example.test/tree",
        contextTreeBranch: "main",
        teamSkills: result.teamSkills,
      }),
    );
    expect(ensureAgentBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: workspaceRoot,
        briefing: "BRIEFING_BODY",
        contextTreePath: join(workspaceRoot, "context-tree"),
        currentSourceRepoNames: expect.any(Set),
      }),
    );
    expect(INIT_COMPLETE_SENTINEL_REL).toMatch(/init-complete/);
  });

  it("continues when chat context fetch fails and logs the failure", async () => {
    const prepareManagedSession = await loadPrepare();
    const logs: string[] = [];
    fetchChatContext.mockImplementation(async () => {
      callOrder.push("chatContext");
      throw new Error("chat detail unavailable");
    });

    const result = await prepareManagedSession({
      sessionCtx: sessionCtx(logs),
      workspaceRoot,
      runtimeProvider: "cursor",
      runtimeConfig: null,
      payload: {
        kind: "cursor",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
    });

    expect(result.chatContext).toBeUndefined();
    expect(logs.some((line) => line.includes("fetchChatContext failed"))).toBe(true);
    expect(callOrder).toEqual([
      "acquire",
      "chatContext",
      "sourceRepos",
      "skills",
      "briefing",
      "sourceNames:null",
      "bootstrap",
      "sentinel",
    ]);
  });

  it("stops before sentinel when Managed Skills reconcile throws", async () => {
    const prepareManagedSession = await loadPrepare();
    reconcileManagedSkillsForConfig.mockImplementation(async () => {
      callOrder.push("skills");
      throw new Error("managed skills unsafe");
    });

    await expect(
      prepareManagedSession({
        sessionCtx: sessionCtx(),
        workspaceRoot,
        runtimeProvider: "cursor",
        runtimeConfig: null,
        payload: {
          kind: "cursor",
          prompt: { append: "" },
          model: "",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
        },
        payloadResolved: false,
        contextTree: { path: null, repoUrl: null, branch: null },
      }),
    ).rejects.toThrow(/managed skills unsafe/);

    expect(callOrder).toEqual(["acquire", "chatContext", "sourceRepos", "skills"]);
    expect(ensureAgentBootstrap).not.toHaveBeenCalled();
    expect(markWorkspaceInitComplete).not.toHaveBeenCalled();
  });

  it("stops before sentinel when bootstrap throws", async () => {
    const prepareManagedSession = await loadPrepare();
    ensureAgentBootstrap.mockImplementation(() => {
      callOrder.push("bootstrap");
      throw new Error("bootstrap failed");
    });

    await expect(
      prepareManagedSession({
        sessionCtx: sessionCtx(),
        workspaceRoot,
        runtimeProvider: "grok",
        runtimeConfig: null,
        payload: {
          kind: "grok",
          prompt: { append: "" },
          model: "",
          reasoningEffort: "",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
        },
        payloadResolved: false,
        contextTree: { path: null, repoUrl: null, branch: null },
      }),
    ).rejects.toThrow(/bootstrap failed/);

    expect(callOrder).toContain("bootstrap");
    expect(markWorkspaceInitComplete).not.toHaveBeenCalled();
  });

  it("passes null source-name set for unresolved fallback payloads", async () => {
    const prepareManagedSession = await loadPrepare();
    await prepareManagedSession({
      sessionCtx: sessionCtx(),
      workspaceRoot,
      runtimeProvider: "cursor",
      runtimeConfig: null,
      payload: {
        kind: "cursor",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
    });

    expect(currentSourceRepoNamesFromPayload).toHaveBeenCalledWith(expect.anything(), false);
    expect(ensureAgentBootstrap).toHaveBeenCalledWith(expect.objectContaining({ currentSourceRepoNames: null }));
  });

  it("does not double-call bootstrap or sentinel on success", async () => {
    const prepareManagedSession = await loadPrepare();
    await prepareManagedSession({
      sessionCtx: sessionCtx(),
      workspaceRoot,
      runtimeProvider: "cursor",
      runtimeConfig: null,
      payload: {
        kind: "cursor",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: true,
      contextTree: { path: null, repoUrl: null, branch: null },
    });
    expect(ensureAgentBootstrap).toHaveBeenCalledTimes(1);
    expect(markWorkspaceInitComplete).toHaveBeenCalledTimes(1);
  });

  it("runs atProjectionEntry sync before skills projection", async () => {
    const prepareManagedSession = await loadPrepare();
    const atProjectionEntry = vi.fn((): undefined => {
      callOrder.push("atProjectionEntry");
      return undefined;
    });
    const beforeBriefing = vi.fn(async () => {
      callOrder.push("beforeBriefing");
    });

    await prepareManagedSession({
      sessionCtx: sessionCtx(),
      workspaceRoot,
      runtimeProvider: "cursor",
      runtimeConfig: null,
      payload: {
        kind: "cursor",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
      atProjectionEntry,
      beforeBriefing,
    });

    expect(atProjectionEntry).toHaveBeenCalledTimes(1);
    expect(beforeBriefing).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual([
      "acquire",
      "chatContext",
      "atProjectionEntry",
      "sourceRepos",
      "skills",
      "beforeBriefing",
      "briefing",
      "sourceNames:null",
      "bootstrap",
      "sentinel",
    ]);
  });

  it("rejects async atProjectionEntry at compile time", () => {
    // @ts-expect-error async callbacks are not assignable to () => undefined
    const _hook: PrepareManagedSessionParams["atProjectionEntry"] = async () => undefined;
    void _hook;
  });

  it("rejects thenable atProjectionEntry before reconcile (fail-closed sync contract)", async () => {
    const prepareManagedSession = await loadPrepare();

    await expect(
      prepareManagedSession({
        sessionCtx: sessionCtx(),
        workspaceRoot,
        runtimeProvider: "cursor",
        runtimeConfig: null,
        payload: {
          kind: "cursor",
          prompt: { append: "" },
          model: "",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
        },
        payloadResolved: false,
        contextTree: { path: null, repoUrl: null, branch: null },
        // Type escape: async is assignable to `() => void` but not `() => undefined`.
        // Cast to prove runtime still fail-closes if a thenable slips through.
        atProjectionEntry: (async () => {
          callOrder.push("atProjectionEntry");
        }) as unknown as () => undefined,
      }),
    ).rejects.toThrow(/atProjectionEntry must be synchronous/);

    expect(callOrder).toEqual(["acquire", "chatContext", "atProjectionEntry"]);
    expect(declaredSourceRepos).not.toHaveBeenCalled();
    expect(reconcileManagedSkillsForConfig).not.toHaveBeenCalled();
  });

  it("rejects non-undefined atProjectionEntry returns before reconcile", async () => {
    const prepareManagedSession = await loadPrepare();

    await expect(
      prepareManagedSession({
        sessionCtx: sessionCtx(),
        workspaceRoot,
        runtimeProvider: "cursor",
        runtimeConfig: null,
        payload: {
          kind: "cursor",
          prompt: { append: "" },
          model: "",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
        },
        payloadResolved: false,
        contextTree: { path: null, repoUrl: null, branch: null },
        atProjectionEntry: (() => {
          callOrder.push("atProjectionEntry");
          return null;
        }) as unknown as () => undefined,
      }),
    ).rejects.toThrow(/atProjectionEntry must be synchronous/);

    expect(reconcileManagedSkillsForConfig).not.toHaveBeenCalled();
  });

  it("enters reconcile in the same synchronous turn as atProjectionEntry", async () => {
    const prepareManagedSession = await loadPrepare();
    let microtaskRan = false;

    reconcileManagedSkillsForConfig.mockImplementation(async () => {
      // Must observe the flag still false — an `await` after the checkpoint
      // (old beforeProjection gap) would let the queued microtask run first.
      expect(microtaskRan).toBe(false);
      callOrder.push("skills");
      return {
        ok: true,
        resourceConfigVersion: 3,
        installed: [],
        skipped: [],
        removed: [],
        teamSkills: [
          {
            key: "resource:skill",
            name: "team-skill",
            description: "desc",
            revision: "r1",
            installedDigest: "sha256:abc",
            target: "/tmp/skill-target",
          },
        ],
        failures: [],
        staleTeamSnapshot: false,
      };
    });

    await prepareManagedSession({
      sessionCtx: sessionCtx(),
      workspaceRoot,
      runtimeProvider: "cursor",
      runtimeConfig: null,
      payload: {
        kind: "cursor",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
      atProjectionEntry: (): undefined => {
        queueMicrotask(() => {
          microtaskRan = true;
        });
        return undefined;
      },
    });

    expect(reconcileManagedSkillsForConfig).toHaveBeenCalled();
    await Promise.resolve();
    expect(microtaskRan).toBe(true);
  });

  it("completes briefing/bootstrap/sentinel before sync beforeBriefing microtasks", async () => {
    const prepareManagedSession = await loadPrepare();
    let microtaskRan = false;
    const events: string[] = [];

    buildAgentBriefing.mockImplementation((opts: { teamSkills: Array<{ name: string; target: string }> }) => {
      expect(microtaskRan).toBe(false);
      events.push("briefing");
      callOrder.push("briefing");
      expect(opts.teamSkills[0]?.name).toBe("team-skill");
      return "BRIEFING_BODY";
    });
    ensureAgentBootstrap.mockImplementation(() => {
      expect(microtaskRan).toBe(false);
      events.push("bootstrap");
      callOrder.push("bootstrap");
    });
    markWorkspaceInitComplete.mockImplementation(() => {
      expect(microtaskRan).toBe(false);
      events.push("sentinel");
      callOrder.push("sentinel");
    });

    await prepareManagedSession({
      sessionCtx: sessionCtx(),
      workspaceRoot,
      runtimeProvider: "cursor",
      runtimeConfig: null,
      payload: {
        kind: "cursor",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
      beforeBriefing: () => {
        events.push("beforeBriefing");
        callOrder.push("beforeBriefing");
        queueMicrotask(() => {
          microtaskRan = true;
        });
      },
    });

    expect(events).toEqual(["beforeBriefing", "briefing", "bootstrap", "sentinel"]);
    await Promise.resolve();
    expect(microtaskRan).toBe(true);
  });

  it("awaits async beforeBriefing before briefing/bootstrap/sentinel", async () => {
    const prepareManagedSession = await loadPrepare();

    await prepareManagedSession({
      sessionCtx: sessionCtx(),
      workspaceRoot,
      runtimeProvider: "cursor",
      runtimeConfig: null,
      payload: {
        kind: "cursor",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
      beforeBriefing: async () => {
        callOrder.push("beforeBriefing-start");
        await Promise.resolve();
        callOrder.push("beforeBriefing-end");
      },
    });

    expect(callOrder).toEqual([
      "acquire",
      "chatContext",
      "sourceRepos",
      "skills",
      "beforeBriefing-start",
      "beforeBriefing-end",
      "briefing",
      "sourceNames:null",
      "bootstrap",
      "sentinel",
    ]);
  });

  it("leaves skills/briefing/bootstrap/sentinel untouched when atProjectionEntry throws", async () => {
    const prepareManagedSession = await loadPrepare();

    await expect(
      prepareManagedSession({
        sessionCtx: sessionCtx(),
        workspaceRoot,
        runtimeProvider: "cursor",
        runtimeConfig: null,
        payload: {
          kind: "cursor",
          prompt: { append: "" },
          model: "",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
        },
        payloadResolved: false,
        contextTree: { path: null, repoUrl: null, branch: null },
        atProjectionEntry: (): undefined => {
          callOrder.push("atProjectionEntry");
          throw new Error("lifecycle cancelled at prepare_before_projection");
        },
      }),
    ).rejects.toThrow(/lifecycle cancelled at prepare_before_projection/);

    expect(callOrder).toEqual(["acquire", "chatContext", "atProjectionEntry"]);
    expect(declaredSourceRepos).not.toHaveBeenCalled();
    expect(reconcileManagedSkillsForConfig).not.toHaveBeenCalled();
    expect(buildAgentBriefing).not.toHaveBeenCalled();
    expect(ensureAgentBootstrap).not.toHaveBeenCalled();
    expect(markWorkspaceInitComplete).not.toHaveBeenCalled();
  });

  it("runs beforeBriefing after skills and before briefing/bootstrap/sentinel", async () => {
    const prepareManagedSession = await loadPrepare();
    const beforeBriefing = vi.fn(async () => {
      callOrder.push("beforeBriefing");
    });

    await prepareManagedSession({
      sessionCtx: sessionCtx(),
      workspaceRoot,
      runtimeProvider: "cursor",
      runtimeConfig: null,
      payload: {
        kind: "cursor",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
      beforeBriefing,
    });

    expect(beforeBriefing).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual([
      "acquire",
      "chatContext",
      "sourceRepos",
      "skills",
      "beforeBriefing",
      "briefing",
      "sourceNames:null",
      "bootstrap",
      "sentinel",
    ]);
  });

  it("leaves briefing/bootstrap/sentinel untouched when beforeBriefing throws", async () => {
    const prepareManagedSession = await loadPrepare();

    await expect(
      prepareManagedSession({
        sessionCtx: sessionCtx(),
        workspaceRoot,
        runtimeProvider: "cursor",
        runtimeConfig: null,
        payload: {
          kind: "cursor",
          prompt: { append: "" },
          model: "",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
        },
        payloadResolved: false,
        contextTree: { path: null, repoUrl: null, branch: null },
        beforeBriefing: async () => {
          callOrder.push("beforeBriefing");
          throw new Error("lifecycle cancelled at prepare_skills");
        },
      }),
    ).rejects.toThrow(/lifecycle cancelled at prepare_skills/);

    expect(callOrder).toEqual(["acquire", "chatContext", "sourceRepos", "skills", "beforeBriefing"]);
    expect(buildAgentBriefing).not.toHaveBeenCalled();
    expect(ensureAgentBootstrap).not.toHaveBeenCalled();
    expect(markWorkspaceInitComplete).not.toHaveBeenCalled();
  });
});

describe("projectManagedWorkspace", () => {
  let workspaceRoot: string;
  const callOrder: string[] = [];

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "project-managed-workspace-"));
    callOrder.length = 0;
    vi.clearAllMocks();
    declaredSourceRepos.mockImplementation((workspace: string) => {
      callOrder.push("sourceRepos");
      return [{ absolutePath: join(workspace, "source-repos", "widget"), url: "https://example.test/widget" }];
    });
    reconcileManagedSkillsForConfig.mockImplementation(async () => {
      callOrder.push("skills");
      return {
        ok: true,
        resourceConfigVersion: 1,
        installed: [],
        skipped: [],
        removed: [],
        teamSkills: [],
        failures: [],
        staleTeamSnapshot: false,
      };
    });
    buildAgentBriefing.mockImplementation(() => {
      callOrder.push("briefing");
      return "BRIEFING";
    });
    ensureAgentBootstrap.mockImplementation(() => {
      callOrder.push("bootstrap");
    });
    markWorkspaceInitComplete.mockImplementation(() => {
      callOrder.push("sentinel");
    });
    currentSourceRepoNamesFromPayload.mockReturnValue(null);
    teamSkillBundleResolverFromSdk.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function sessionCtx(): SessionContext {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    return {
      agent: {
        agentId: "019d9a97-90b0-716b-8317-a8c0be8430d7",
        inboxId: "inbox-1",
        displayName: "prep-agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: { serverUrl: "https://first-tree.example.test", sendMessage } as unknown as SessionContext["sdk"],
      chatId: "chat-1",
      log: () => {},
      recordProviderActivity: () => {},
      emitEvent: () => {},
      ...mockCtxPlumbing({ sendMessage }, "chat-1"),
    } as SessionContext;
  }

  it("requires an explicit markInitComplete:false to skip the sentinel", async () => {
    const { projectManagedWorkspace } = await import("../runtime/provider-support/preparation.js");
    await projectManagedWorkspace({
      sessionCtx: sessionCtx(),
      workspace: workspaceRoot,
      runtimeProvider: "pi",
      runtimeConfig: null,
      payload: {
        kind: "pi",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
      markInitComplete: false,
    });
    expect(callOrder).toEqual(["sourceRepos", "skills", "briefing", "bootstrap"]);
    expect(markWorkspaceInitComplete).not.toHaveBeenCalled();
  });

  it("writes the sentinel when markInitComplete is true", async () => {
    const { projectManagedWorkspace } = await import("../runtime/provider-support/preparation.js");
    await projectManagedWorkspace({
      sessionCtx: sessionCtx(),
      workspace: workspaceRoot,
      runtimeProvider: "opencode",
      runtimeConfig: null,
      payload: {
        kind: "opencode",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      payloadResolved: false,
      contextTree: { path: null, repoUrl: null, branch: null },
      markInitComplete: true,
    });
    expect(callOrder).toContain("sentinel");
    expect(markWorkspaceInitComplete).toHaveBeenCalledWith(workspaceRoot);
  });
});

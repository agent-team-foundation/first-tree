import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory pin state shared with the bootstrap.js mock. Hoisted so it's
// available inside the (hoisted) vi.mock factory.
const state = vi.hoisted(() => ({ cachedTreeHead: null as string | null, cachedCli: null as string | null }));

vi.mock("../runtime/bootstrap.js", () => ({
  bootstrapWorkspace: vi.fn(),
  installCoreSkills: vi.fn(),
  installFirstTreeIntegration: vi.fn(),
  deepEqualIdentity: vi.fn(() => false),
  readContextTreeHead: vi.fn(() => "head1"),
  readCachedContextTreeHead: vi.fn(() => state.cachedTreeHead),
  resolveBundledCliVersion: vi.fn(() => "1.0.0"),
  readCachedBundledCliVersion: vi.fn(() => state.cachedCli),
  writeAgentBriefing: vi.fn(),
  writeContextTreeHead: vi.fn((_w: string, h: string | null) => {
    state.cachedTreeHead = h;
  }),
  writeBundledCliVersion: vi.fn((_w: string, v: string | null) => {
    state.cachedCli = v;
  }),
}));

import { ensureAgentBootstrap } from "../runtime/agent-bootstrap.js";
import { installFirstTreeIntegration } from "../runtime/bootstrap.js";
import type { SessionContext } from "../runtime/handler.js";
import { INIT_COMPLETE_SENTINEL_REL } from "../runtime/workspace.js";

function fakeSessionCtx(): SessionContext {
  return {
    agent: {
      agentId: "agent-1",
      inboxId: "inbox-1",
      displayName: "Agent One",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "https://hub.test" },
    log: () => {},
  } as unknown as SessionContext;
}

/**
 * Regression for the integration-failure retry gate (PR #712 review round 2):
 * a tree-bound agent whose first `installFirstTreeIntegration` fails must NOT
 * be frozen behind the init-complete sentinel — the next ensureAgentBootstrap
 * has to retry, and only stop retrying once integration succeeds (CLI pin set).
 */
describe("ensureAgentBootstrap — integration retry gate", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "ft-agent-bootstrap-"));
    // Simulate "already bootstrapped once" — the sentinel is present, which is
    // exactly the state that previously let a failed integration coast on the
    // fast path forever.
    const sentinel = join(workspace, INIT_COMPLETE_SENTINEL_REL);
    mkdirSync(dirname(sentinel), { recursive: true });
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    writeFileSync(sentinel, "1", "utf-8");

    state.cachedTreeHead = null;
    state.cachedCli = null;
    vi.mocked(installFirstTreeIntegration).mockReset();
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("retries integration after a first failure, then settles once it succeeds", () => {
    // First integration attempt fails, second succeeds.
    vi.mocked(installFirstTreeIntegration).mockReturnValueOnce(false).mockReturnValueOnce(true);

    const params = {
      workspace,
      sessionCtx: fakeSessionCtx(),
      contextTreePath: "/tree",
      briefing: "# Agent Identity\n\nstub briefing\n",
      // Tests that don't exercise migration / state-reconcile pass `null` —
      // mirrors the cache-miss caller signal.
      currentSourceRepoNames: null,
    };

    // Call 1: integration fails → CLI version NOT pinned.
    ensureAgentBootstrap(params);
    expect(installFirstTreeIntegration).toHaveBeenCalledTimes(1);
    expect(state.cachedCli).toBeNull();

    // Call 2: CLI pin still missing → slow path retries integration (succeeds).
    ensureAgentBootstrap(params);
    expect(installFirstTreeIntegration).toHaveBeenCalledTimes(2);
    expect(state.cachedCli).toBe("1.0.0");

    // Call 3: integration succeeded (CLI pinned), no drift → fast path, no retry.
    ensureAgentBootstrap(params);
    expect(installFirstTreeIntegration).toHaveBeenCalledTimes(2);
  });

  it("non-tree agents take the fast path on the sentinel (no integration gate)", () => {
    const params = {
      workspace,
      sessionCtx: fakeSessionCtx(),
      contextTreePath: null,
      briefing: "# Agent Identity\n\nstub briefing\n",
      currentSourceRepoNames: null,
    };
    ensureAgentBootstrap(params);
    // No Context Tree → installFirstTreeIntegration is never called regardless.
    expect(installFirstTreeIntegration).not.toHaveBeenCalled();
  });
});

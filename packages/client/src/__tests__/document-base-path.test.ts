import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  documentBasePathFromRuntimeConfig,
  resolveSessionDocRoot,
  selfFenceFromRuntimeConfig,
  singleRepoLocalPathFromPayload,
} from "../runtime/session-manager.js";

function payload(gitRepos: AgentRuntimeConfigPayload["gitRepos"]): AgentRuntimeConfigPayload {
  return {
    kind: "claude-code",
    prompt: { append: "" },
    model: "",
    mcpServers: [],
    env: [],
    gitRepos,
    resourceSkills: [],
    reasoningEffort: "",
  };
}

const PER_CHAT = "/data/workspaces/agent/chat-123";

describe("documentBasePathFromRuntimeConfig", () => {
  // For a NEW agent-home session, sessionRoot === workspaceRoot. The unit tests
  // below stand AGENT_HOME in for both so they exercise the new-layout branch.
  const AGENT_HOME = PER_CHAT;

  it("returns the session doc root when there are zero repos", () => {
    expect(documentBasePathFromRuntimeConfig(payload([]), AGENT_HOME, AGENT_HOME)).toBe(AGENT_HOME);
  });

  it("returns the session doc root when there are multiple repos", () => {
    const result = documentBasePathFromRuntimeConfig(
      payload([{ url: "https://github.com/a/one.git" }, { url: "https://github.com/a/two.git" }]),
      AGENT_HOME,
      AGENT_HOME,
    );
    expect(result).toBe(AGENT_HOME);
  });

  it("returns an ABSOLUTE source-repo clone path (under source-repos/) for a single repo in a new session", () => {
    // New agent-home session (sessionRoot === workspaceRoot): the clone lives
    // under the `source-repos/` layer, so the base is `<root>/source-repos/<name>`.
    expect(
      documentBasePathFromRuntimeConfig(
        payload([{ url: "https://github.com/a/first-tree.git" }]),
        AGENT_HOME,
        AGENT_HOME,
      ),
    ).toBe(`${AGENT_HOME}/source-repos/first-tree`);
  });

  it("honours an explicit localPath for a single repo (under source-repos/)", () => {
    expect(
      documentBasePathFromRuntimeConfig(
        payload([{ url: "https://x/y.git", localPath: "custom-dir" }]),
        AGENT_HOME,
        AGENT_HOME,
      ),
    ).toBe(`${AGENT_HOME}/source-repos/custom-dir`);
  });

  it("keeps the legacy per-chat flat base (no source-repos/) when sessionRoot is a per-chat dir", () => {
    // Legacy pre-#506 session: sessionRoot is `<workspaceRoot>/<chatId>`, NOT the
    // agent home. That layout never had a `source-repos/` layer, so prepending
    // one would point preview at a nonexistent dir — keep the prior flat base.
    const workspaceRoot = "/data/workspaces/agent";
    const legacySessionRoot = `${workspaceRoot}/chat-123`;
    expect(
      documentBasePathFromRuntimeConfig(
        payload([{ url: "https://github.com/a/first-tree.git" }]),
        legacySessionRoot,
        workspaceRoot,
      ),
    ).toBe(`${legacySessionRoot}/first-tree`);
  });

  it("falls back to the session doc root when a single repo's localPath is blank", () => {
    expect(documentBasePathFromRuntimeConfig(payload([{ url: "", localPath: "   " }]), AGENT_HOME, AGENT_HOME)).toBe(
      AGENT_HOME,
    );
  });
});

describe("resolveSessionDocRoot — per-agent-home vs legacy per-chat layout", () => {
  let workspaceRoot: string;

  beforeAll(() => {
    // Stand in for `<workspaces>/<agentSlug>` — the agent home AND the handler's
    // `workspaceRoot`. acquireAgentHome returns this path verbatim.
    workspaceRoot = mkdtempSync(join(tmpdir(), "ft-session-doc-root-"));
  });

  afterAll(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("returns the agent home for a NEW chat with no legacy per-chat dir (the #506 regression)", () => {
    // Post-#506 a fresh chat runs cwd = agent home with the source repo at the
    // top level; no `<workspaceRoot>/<chatId>/` dir is ever created. The base
    // MUST be the agent home, not the phantom per-chat dir — otherwise the
    // snapshot scanner realpaths a non-existent root and embeds zero snapshots,
    // so every `.md` mention stays plain text.
    expect(resolveSessionDocRoot(workspaceRoot, "new-chat-no-dir")).toBe(workspaceRoot);
  });

  it("returns the legacy per-chat dir when it exists on disk (pre-#506 chats)", () => {
    const chatId = "legacy-chat-on-disk";
    mkdirSync(join(workspaceRoot, chatId), { recursive: true });
    expect(resolveSessionDocRoot(workspaceRoot, chatId)).toBe(join(workspaceRoot, chatId));
  });

  it("resolves a NEW single-repo chat's doc base under the agent home, not a per-chat phantom", () => {
    // End-to-end of the bug: compose the root resolver with the base builder.
    const base = documentBasePathFromRuntimeConfig(
      payload([{ url: "https://github.com/agent-team-foundation/first-tree.git" }]),
      resolveSessionDocRoot(workspaceRoot, "another-new-chat"),
      workspaceRoot,
    );
    expect(base).toBe(join(workspaceRoot, "source-repos", "first-tree"));
  });
});

describe("singleRepoLocalPathFromPayload + selfFenceFromRuntimeConfig", () => {
  it("returns null for zero-repo and multi-repo payloads — no promotion path", () => {
    expect(singleRepoLocalPathFromPayload(payload([]))).toBeNull();
    expect(
      singleRepoLocalPathFromPayload(payload([{ url: "https://x/y.git" }, { url: "https://x/z.git" }])),
    ).toBeNull();
  });

  it("returns null for a sparse single-repo payload", () => {
    const gitRepos = new Array<AgentRuntimeConfigPayload["gitRepos"][number]>(1);
    expect(singleRepoLocalPathFromPayload(payload(gitRepos))).toBeNull();
  });

  it("derives the localPath from the repo URL when explicit localPath is absent", () => {
    expect(singleRepoLocalPathFromPayload(payload([{ url: "https://github.com/a/first-tree.git" }]))).toBe(
      "first-tree",
    );
  });

  it("honours an explicit localPath; treats a blank string as no promotion", () => {
    expect(singleRepoLocalPathFromPayload(payload([{ url: "https://x/y.git", localPath: "custom-dir" }]))).toBe(
      "custom-dir",
    );
    expect(singleRepoLocalPathFromPayload(payload([{ url: "https://x/y.git", localPath: "   " }]))).toBeNull();
  });

  it("selfFenceFromRuntimeConfig packs agentHome + source-repos/<name> for a NEW session", () => {
    // New session (sessionRoot === workspaceRoot): singleRepoLocalPath is the
    // repo's agentHome-relative path under the `source-repos/` layer, resolved
    // by the snapshot pipeline as `resolve(agentHome, "source-repos/<name>")`.
    expect(
      selfFenceFromRuntimeConfig(payload([{ url: "https://github.com/a/first-tree.git" }]), "/ws/coder", "/ws/coder"),
    ).toEqual({
      agentHome: "/ws/coder",
      singleRepoLocalPath: "source-repos/first-tree",
    });
    expect(selfFenceFromRuntimeConfig(payload([]), "/ws/coder", "/ws/coder")).toEqual({ agentHome: "/ws/coder" });
  });

  it("selfFenceFromRuntimeConfig keeps the flat relative path for a legacy per-chat session", () => {
    // Legacy session (sessionRoot is a per-chat dir, not the agent home): the
    // pre-#506 flat layout had no `source-repos/` layer, so singleRepoLocalPath
    // stays the bare name to match `documentBasePathFromRuntimeConfig`.
    const workspaceRoot = "/ws/coder";
    const legacySessionRoot = `${workspaceRoot}/chat-1`;
    expect(
      selfFenceFromRuntimeConfig(
        payload([{ url: "https://github.com/a/first-tree.git" }]),
        legacySessionRoot,
        workspaceRoot,
      ),
    ).toEqual({
      agentHome: legacySessionRoot,
      singleRepoLocalPath: "first-tree",
    });
  });

  it("returns agentHome-only when no payload is cached yet (very first message)", () => {
    expect(selfFenceFromRuntimeConfig(null, "/ws/coder", "/ws/coder")).toEqual({ agentHome: "/ws/coder" });
  });
});

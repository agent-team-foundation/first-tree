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
  return { kind: "claude-code", prompt: { append: "" }, model: "", mcpServers: [], env: [], gitRepos };
}

const PER_CHAT = "/data/workspaces/agent/chat-123";

describe("documentBasePathFromRuntimeConfig", () => {
  it("returns the session doc root when there are zero repos", () => {
    expect(documentBasePathFromRuntimeConfig(payload([]), PER_CHAT)).toBe(PER_CHAT);
  });

  it("returns the session doc root when there are multiple repos", () => {
    const result = documentBasePathFromRuntimeConfig(
      payload([{ url: "https://github.com/a/one.git" }, { url: "https://github.com/a/two.git" }]),
      PER_CHAT,
    );
    expect(result).toBe(PER_CHAT);
  });

  it("returns an ABSOLUTE repo worktree path (sessionRoot + derived localPath) for a single repo", () => {
    // Regression: the old code returned a bare relative localPath
    // ("first-tree"), which the runtime resolved against its own
    // process.cwd() (the launch dir, not the per-chat workspace) and failed to
    // find any doc — leaving single-repo cloud preview dead.
    expect(documentBasePathFromRuntimeConfig(payload([{ url: "https://github.com/a/first-tree.git" }]), PER_CHAT)).toBe(
      `${PER_CHAT}/first-tree`,
    );
  });

  it("honours an explicit localPath for a single repo", () => {
    expect(
      documentBasePathFromRuntimeConfig(payload([{ url: "https://x/y.git", localPath: "nested/repo" }]), PER_CHAT),
    ).toBe(`${PER_CHAT}/nested/repo`);
  });

  it("falls back to the session doc root when a single repo's localPath is blank", () => {
    expect(documentBasePathFromRuntimeConfig(payload([{ url: "", localPath: "   " }]), PER_CHAT)).toBe(PER_CHAT);
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
    );
    expect(base).toBe(join(workspaceRoot, "first-tree"));
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
    expect(singleRepoLocalPathFromPayload(payload([{ url: "https://x/y.git", localPath: "nested/repo" }]))).toBe(
      "nested/repo",
    );
    expect(singleRepoLocalPathFromPayload(payload([{ url: "https://x/y.git", localPath: "   " }]))).toBeNull();
  });

  it("selfFenceFromRuntimeConfig packs agentHome + optional singleRepoLocalPath for the snapshot pipeline", () => {
    expect(selfFenceFromRuntimeConfig(payload([{ url: "https://github.com/a/first-tree.git" }]), "/ws/coder")).toEqual({
      agentHome: "/ws/coder",
      singleRepoLocalPath: "first-tree",
    });
    expect(selfFenceFromRuntimeConfig(payload([]), "/ws/coder")).toEqual({ agentHome: "/ws/coder" });
  });

  it("returns agentHome-only when no payload is cached yet (very first message)", () => {
    expect(selfFenceFromRuntimeConfig(null, "/ws/coder")).toEqual({ agentHome: "/ws/coder" });
  });
});

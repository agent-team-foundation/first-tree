import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureOutboundDocs } from "../core/doc-capture.js";

/**
 * `chat send` doc capture (L3 阶段1): the CLI snapshots referenced `.md` the
 * same way result-sink does, driven by the runtime-injected env. These tests
 * exercise the env contract + pass-through behaviour; the snapshot/rewrite
 * mechanics themselves are covered by client `doc-snapshots.test.ts`.
 */
describe("captureOutboundDocs (chat send L3 capture)", () => {
  let base: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "cli-doc-capture-"));
    await writeFile(join(base, "design.md"), "# design\n", "utf8");
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("pass-through when no doc base in env (not in an agent session)", async () => {
    const out = await captureOutboundDocs("see design.md please", {});
    expect(out.content).toBe("see design.md please");
    expect(out.documentContext).toBeUndefined();
  });

  it("snapshots a referenced workspace .md and attaches documentContext (explicit link)", async () => {
    const out = await captureOutboundDocs("see design.md please", { FIRST_TREE_DOC_BASE: base });
    expect(out.content).toBe("see [design.md](design.md) please");
    const ctx = out.documentContext as { kind?: string; docs?: Array<{ path: string }> } | undefined;
    expect(ctx?.kind).toBe("snapshot");
    expect(ctx?.docs?.map((d) => d.path)).toEqual(["design.md"]);
  });

  it("rewrites an absolute-in-base path into an explicit relative link + snapshots it", async () => {
    const abs = join(base, "design.md");
    const out = await captureOutboundDocs(`wrote ${abs} now`, { FIRST_TREE_DOC_BASE: base });
    expect(out.content).toBe("wrote [design.md](design.md) now");
    const ctx = out.documentContext as { docs?: Array<{ path: string }> } | undefined;
    expect(ctx?.docs?.map((d) => d.path)).toEqual(["design.md"]);
  });

  it("no documentContext when the referenced path is not in the workspace", async () => {
    const out = await captureOutboundDocs("see /etc/nope/missing.md", { FIRST_TREE_DOC_BASE: base });
    expect(out.content).toBe("see /etc/nope/missing.md");
    expect(out.documentContext).toBeUndefined();
  });

  it("no documentContext when the message references no .md", async () => {
    const out = await captureOutboundDocs("just a plain message", { FIRST_TREE_DOC_BASE: base });
    expect(out.content).toBe("just a plain message");
    expect(out.documentContext).toBeUndefined();
  });

  describe("wide-fence env (FIRST_TREE_DOC_AGENT_HOME + optional FIRST_TREE_DOC_REPO_LOCAL_PATH)", () => {
    let agentHome: string;

    beforeAll(async () => {
      // Layout mirrors the post-#506 production tree:
      //   <agentHome>/<localPath>/         predeclared source repo
      //   <agentHome>/worktrees/<task>/    on-demand worktree the LLM `git worktree add`s
      agentHome = await mkdtemp(join(tmpdir(), "cli-doc-capture-agent-home-"));
      await mkdir(join(agentHome, "first-tree", "docs"), { recursive: true });
      await writeFile(join(agentHome, "first-tree", "docs", "intro.md"), "# intro\n", "utf8");
      await mkdir(join(agentHome, "worktrees", "task-x", "docs"), { recursive: true });
      await writeFile(join(agentHome, "worktrees", "task-x", "docs", "design.md"), "# design\n", "utf8");
    });

    afterAll(async () => {
      await rm(agentHome, { recursive: true, force: true });
    });

    it("snapshots a worktree-scoped absolute path when AGENT_HOME widens the fence", async () => {
      // The pre-fix narrow fence (source-repo top only) would have dropped this
      // mention to plain text; the wide fence now produces an agent-home-relative
      // snapshot key.
      const abs = join(agentHome, "worktrees", "task-x", "docs", "design.md");
      const out = await captureOutboundDocs(`wrote ${abs} now`, {
        FIRST_TREE_DOC_AGENT_HOME: agentHome,
        FIRST_TREE_DOC_REPO_LOCAL_PATH: "first-tree",
      });
      expect(out.content).toBe(`wrote [worktrees/task-x/docs/design.md](worktrees/task-x/docs/design.md) now`);
      const ctx = out.documentContext as { docs?: Array<{ path: string }> } | undefined;
      expect(ctx?.docs?.map((d) => d.path)).toEqual(["worktrees/task-x/docs/design.md"]);
    });

    it("promotes a relative source-repo mention to a shared agent-home-relative key", async () => {
      // `docs/intro.md` written relatively must share its canonical key with the
      // absolute form `<agentHome>/<localPath>/docs/intro.md` — otherwise the same
      // file produces two snapshot entries and web cache lookup splits.
      const out = await captureOutboundDocs("see docs/intro.md please", {
        FIRST_TREE_DOC_AGENT_HOME: agentHome,
        FIRST_TREE_DOC_REPO_LOCAL_PATH: "first-tree",
      });
      const ctx = out.documentContext as { docs?: Array<{ path: string }> } | undefined;
      expect(ctx?.docs?.map((d) => d.path)).toEqual(["first-tree/docs/intro.md"]);
      expect(out.content).toBe("see [first-tree/docs/intro.md](first-tree/docs/intro.md) please");
    });

    it("ignores the legacy FIRST_TREE_DOC_BASE when FIRST_TREE_DOC_AGENT_HOME is present", async () => {
      // The wide-fence env takes precedence so a runtime that emits BOTH (during
      // upgrade) routes through the new path.
      const abs = join(agentHome, "worktrees", "task-x", "docs", "design.md");
      const out = await captureOutboundDocs(`wrote ${abs} now`, {
        FIRST_TREE_DOC_AGENT_HOME: agentHome,
        FIRST_TREE_DOC_BASE: join(agentHome, "first-tree"),
      });
      const ctx = out.documentContext as { docs?: Array<{ path: string }> } | undefined;
      expect(ctx?.docs?.map((d) => d.path)).toEqual(["worktrees/task-x/docs/design.md"]);
    });
  });
});

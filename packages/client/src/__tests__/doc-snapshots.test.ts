import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMessageDocumentSnapshots } from "../runtime/doc-snapshots.js";

/**
 * Unit tests for the runtime snapshot builder. Every resolved+snapshotted `.md`
 * reference is rewritten into an EXPLICIT markdown link whose href is the
 * canonical snapshot key (bare → `[display](key)`; inline target → key), so web
 * resolves a click by direct href→snapshot lookup without re-scanning. Out-of-
 * root / hidden / escaping paths get no snapshot and are left verbatim.
 */
describe("buildMessageDocumentSnapshots — explicit-link rewrite (self / Case A)", () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "doc-snap-root-"));
    await writeFile(join(root, "design.md"), "# design\n", "utf8");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "intro.md"), "# intro\n", "utf8");
    // Symlink escape fixture: public.md → .agent/secret.md (hidden segment).
    await mkdir(join(root, ".agent"), { recursive: true });
    await writeFile(join(root, ".agent", "secret.md"), "# secret\n", "utf8");
    await symlink(join(root, ".agent", "secret.md"), join(root, "public.md"));

    // A real .md file that EXISTS but lives OUTSIDE the workspace root, so the
    // rejection is proven by containment, not a missing-file shortcut.
    outside = await mkdtemp(join(tmpdir(), "doc-snap-outside-"));
    await writeFile(join(outside, "external.md"), "# external\n", "utf8");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("rewrites a bare absolute-in-root token to its relative path + snapshots it", async () => {
    const abs = join(root, "design.md");
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(`wrote ${abs} just now`, root);

    expect(docs.map((d) => d.path)).toEqual(["design.md"]);
    expect(docs[0]?.content).toBe("# design\n");
    expect(rewrittenText).toBe("wrote [design.md](design.md) just now");
  });

  it("rewrites an absolute target inside an inline markdown link in place", async () => {
    const abs = join(root, "docs", "intro.md");
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(`see [intro](${abs}) for setup`, root);

    expect(docs.map((d) => d.path)).toEqual(["docs/intro.md"]);
    expect(rewrittenText).toBe("see [intro](docs/intro.md) for setup");
  });

  it("preserves the :line[:col] suffix when rewriting an absolute token, keys the snapshot de-suffixed", async () => {
    const abs = join(root, "docs", "intro.md");
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(`open ${abs}:42:7 here`, root);

    expect(docs.map((d) => d.path)).toEqual(["docs/intro.md"]);
    // Explicit link: `:line` kept on the display, stripped from the key href.
    expect(rewrittenText).toBe("open [docs/intro.md:42:7](docs/intro.md) here");
  });

  it("leaves an out-of-root absolute path untouched — no snapshot, no rewrite", async () => {
    const abs = join(outside, "external.md");
    const text = `external doc at ${abs} here`;
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(text, root);

    expect(docs).toEqual([]);
    expect(rewrittenText).toBe(text);
  });

  it("wraps a bare relative mention into an explicit link; an already-canonical inline href is left as-is", async () => {
    const text = "see docs/intro.md and [d](design.md)";
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(text, root);

    expect(docs.map((d) => d.path).sort()).toEqual(["design.md", "docs/intro.md"]);
    // Bare `docs/intro.md` → explicit link; inline `[d](design.md)` href is
    // already the canonical key, so it stays byte-identical.
    expect(rewrittenText).toBe("see [docs/intro.md](docs/intro.md) and [d](design.md)");
  });

  it("canonicalises a non-canonical inline target (`./docs/intro.md` → `docs/intro.md`)", async () => {
    const text = "see [d](./docs/intro.md)";
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(text, root);

    expect(docs.map((d) => d.path)).toEqual(["docs/intro.md"]);
    // Web no longer canonicalises on re-scan; the runtime points the target
    // straight at the snapshot key so the click is a direct lookup.
    expect(rewrittenText).toBe("see [d](docs/intro.md)");
  });

  it("rejects a symlink whose realpath crosses into a hidden dir — relative AND absolute forms", async () => {
    const rel = "see [p](public.md)";
    const relOut = await buildMessageDocumentSnapshots(rel, root);
    expect(relOut.docs).toEqual([]);
    expect(relOut.rewrittenText).toBe(rel);

    const abs = join(root, "public.md");
    const absText = `see ${abs}`;
    const absOut = await buildMessageDocumentSnapshots(absText, root);
    expect(absOut.docs).toEqual([]);
    expect(absOut.rewrittenText).toBe(absText);
  });

  it("rejects a hidden-segment mention and leaves the text verbatim", async () => {
    const text = "secret [s](.agent/secret.md)";
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(text, root);

    expect(docs).toEqual([]);
    expect(rewrittenText).toBe(text);
  });

  it("rewrites every occurrence of the same absolute path, snapshotting it once", async () => {
    const abs = join(root, "design.md");
    const text = `first ${abs} then again ${abs}`;
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(text, root);

    expect(docs.map((d) => d.path)).toEqual(["design.md"]);
    expect(rewrittenText).toBe("first [design.md](design.md) then again [design.md](design.md)");
  });

  it("invariant: every rewritten explicit-link href is a real snapshot key", async () => {
    // The core "two ends agree by construction" guarantee — web resolves a
    // click by direct href→snapshot lookup, so every href the rewrite emits
    // MUST be one of the snapshot keys (else a dead link). Mixes bare +
    // inline + absolute + relative + :line in one message.
    const absDesign = join(root, "design.md");
    const text = `a ${absDesign} b docs/intro.md c [x](${join(root, "docs", "intro.md")}) d ${absDesign}:9`;
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(text, root);

    const keys = new Set(docs.map((d) => d.path));
    const hrefs = [...rewrittenText.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(keys.has(href ?? "")).toBe(true);
  });
});

/**
 * Cross-agent doc preview: with a workspace fence, an absolute `.md` path that
 * realpaths into ANOTHER agent's workspace (same chat) under the shared
 * `workspaces/` common root is snapshotted with a global
 * `<ownerSlug>/<chatId>/<rel>` key and rewritten into an explicit link with a
 * short `<ownerSlug>/<rel>` display and the FULL global key as href. Self paths
 * get an explicit relative link; out-of-scope paths (other chat, other root,
 * hidden) stay verbatim.
 */
describe("buildMessageDocumentSnapshots — cross-agent workspace fence", () => {
  let workspacesRoot: string;
  let selfRoot: string;
  const chatId = "chat-xyz";
  const selfSlug = "coder";
  const otherSlug = "assistant";

  beforeAll(async () => {
    workspacesRoot = await mkdtemp(join(tmpdir(), "doc-snap-ws-"));
    // self workspace: workspaces/coder/chat-xyz
    selfRoot = join(workspacesRoot, selfSlug, chatId);
    await mkdir(selfRoot, { recursive: true });
    await writeFile(join(selfRoot, "mine.md"), "# mine\n", "utf8");
    // Self file whose relative path collides with a cross short form
    // (`assistant/design.md`) — used to prove the collision → full-key rewrite.
    await mkdir(join(selfRoot, otherSlug), { recursive: true });
    await writeFile(join(selfRoot, otherSlug, "design.md"), "# my own assistant notes\n", "utf8");
    // sibling agent workspace (same chat): workspaces/assistant/chat-xyz
    const otherRoot = join(workspacesRoot, otherSlug, chatId);
    await mkdir(join(otherRoot, "docs"), { recursive: true });
    await writeFile(join(otherRoot, "design.md"), "# their design\n", "utf8");
    await writeFile(join(otherRoot, "docs", "intro.md"), "# their intro\n", "utf8");
    await mkdir(join(otherRoot, ".agent"), { recursive: true });
    await writeFile(join(otherRoot, ".agent", "secret.md"), "# their secret\n", "utf8");
    await symlink(join(otherRoot, ".agent", "secret.md"), join(otherRoot, "leak.md"));
    // sibling agent in a DIFFERENT chat: workspaces/assistant/other-chat
    const otherChatRoot = join(workspacesRoot, otherSlug, "other-chat");
    await mkdir(otherChatRoot, { recursive: true });
    await writeFile(join(otherChatRoot, "private.md"), "# other chat\n", "utf8");
  });

  afterAll(async () => {
    await rm(workspacesRoot, { recursive: true, force: true });
  });

  const fence = () => ({ workspacesRoot, chatId, selfSlug });

  it("snapshots a sibling agent's doc with a global key + short rewrite", async () => {
    const abs = join(workspacesRoot, otherSlug, chatId, "design.md");
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(`see ${abs} please`, selfRoot, fence());

    expect(docs.map((d) => d.path)).toEqual([`${otherSlug}/${chatId}/design.md`]);
    expect(docs[0]?.content).toBe("# their design\n");
    // Explicit link: short `<slug>/<rel>` display, FULL global key href so web
    // direct-matches without chatId re-expansion.
    expect(rewrittenText).toBe(`see [${otherSlug}/design.md](${otherSlug}/${chatId}/design.md) please`);
  });

  it("preserves subdir + :line suffix in the cross rewrite", async () => {
    const abs = join(workspacesRoot, otherSlug, chatId, "docs", "intro.md");
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(`open ${abs}:10 now`, selfRoot, fence());

    expect(docs.map((d) => d.path)).toEqual([`${otherSlug}/${chatId}/docs/intro.md`]);
    expect(rewrittenText).toBe(`open [${otherSlug}/docs/intro.md:10](${otherSlug}/${chatId}/docs/intro.md) now`);
  });

  it("rewrites a self path into an explicit relative link even with a fence", async () => {
    const abs = join(selfRoot, "mine.md");
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(`my ${abs} file`, selfRoot, fence());

    expect(docs.map((d) => d.path)).toEqual(["mine.md"]);
    expect(rewrittenText).toBe("my [mine.md](mine.md) file");
  });

  it("rejects a sibling doc from a DIFFERENT chat (chat-scope fence)", async () => {
    const abs = join(workspacesRoot, otherSlug, "other-chat", "private.md");
    const text = `cross-chat ${abs} nope`;
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(text, selfRoot, fence());

    expect(docs).toEqual([]);
    expect(rewrittenText).toBe(text);
  });

  it("rejects a sibling symlink whose realpath crosses into a hidden dir", async () => {
    const abs = join(workspacesRoot, otherSlug, chatId, "leak.md");
    const text = `leak ${abs}`;
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(text, selfRoot, fence());

    expect(docs).toEqual([]);
    expect(rewrittenText).toBe(text);
  });

  it("does NOT cross-resolve when no fence is supplied (opt-in)", async () => {
    const abs = join(workspacesRoot, otherSlug, chatId, "design.md");
    const text = `see ${abs} please`;
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(text, selfRoot);

    expect(docs).toEqual([]);
    expect(rewrittenText).toBe(text);
  });

  it("a self ref and a cross ref that share a short form get DISTINCT hrefs (no collision)", async () => {
    // Self file `assistant/design.md` (relative) AND the sibling agent's
    // `assistant/<chat>/design.md` are both referenced — both display as
    // `assistant/design.md`. With explicit links the hrefs are the canonical
    // keys (self relative vs cross GLOBAL), so they can never collide and web
    // direct-matches each to the right snapshot — no collision handling needed.
    const crossAbs = join(workspacesRoot, otherSlug, chatId, "design.md");
    const text = `self ${otherSlug}/design.md and cross ${crossAbs}`;
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(text, selfRoot, fence());

    expect(docs.map((d) => d.path).sort()).toEqual([`${otherSlug}/${chatId}/design.md`, `${otherSlug}/design.md`]);
    expect(rewrittenText).toBe(
      `self [${otherSlug}/design.md](${otherSlug}/design.md) and ` +
        `cross [${otherSlug}/design.md](${otherSlug}/${chatId}/design.md)`,
    );
  });
});

/**
 * Worktree-fence widening (this PR): the self fence now extends to the FULL
 * agent home, not just the source-repo top, so absolute paths into the
 * agent's on-demand `<agentHome>/worktrees/<task>/` checkouts also snapshot
 * (PR #498's workflow). Relative mentions in a single-repo workspace are
 * promoted to `<localPath>/<rel>` so the abs + rel forms of a source-repo
 * file share one canonical key.
 */
describe("buildMessageDocumentSnapshots — wide self-fence over agent home", () => {
  let agentHome: string;

  beforeAll(async () => {
    // Layout mirrors the post-#506 production tree:
    //   <agentHome>/first-tree/          predeclared source repo (top level)
    //   <agentHome>/worktrees/<task>/    agent-on-demand worktree
    //   <agentHome>/docs/                agent-home-scoped notes
    //   <agentHome>/.agent/              MUST stay rejected via hidden-segment check
    agentHome = await mkdtemp(join(tmpdir(), "doc-snap-agenthome-"));
    await mkdir(join(agentHome, "first-tree", "docs"), { recursive: true });
    await writeFile(join(agentHome, "first-tree", "docs", "intro.md"), "# intro\n", "utf8");
    await mkdir(join(agentHome, "worktrees", "task-x", "docs"), { recursive: true });
    await writeFile(join(agentHome, "worktrees", "task-x", "docs", "design.md"), "# design\n", "utf8");
    await mkdir(join(agentHome, "docs"), { recursive: true });
    await writeFile(join(agentHome, "docs", "note.md"), "# note\n", "utf8");
    await mkdir(join(agentHome, ".agent"), { recursive: true });
    await writeFile(join(agentHome, ".agent", "secret.md"), "# secret\n", "utf8");
  });

  afterAll(async () => {
    await rm(agentHome, { recursive: true, force: true });
  });

  it("snapshots a worktree-scoped absolute .md (#506+#498 idiom — the bug this PR fixes)", async () => {
    // Pre-fix the snapshot scanner gated absolute paths on the source-repo top
    // and dropped this mention back to plain text. Wide fence + agent-home-
    // relative key restores the preview.
    const abs = join(agentHome, "worktrees", "task-x", "docs", "design.md");
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(`wrote ${abs} just now`, {
      agentHome,
      singleRepoLocalPath: "first-tree",
    });

    expect(docs.map((d) => d.path)).toEqual(["worktrees/task-x/docs/design.md"]);
    expect(docs[0]?.content).toBe("# design\n");
    expect(rewrittenText).toBe("wrote [worktrees/task-x/docs/design.md](worktrees/task-x/docs/design.md) just now");
  });

  it("promotes a relative source-repo mention to `<localPath>/<rel>` so abs + rel share one key", async () => {
    // `docs/intro.md` written relatively was the pre-#506 idiom; we keep it
    // resolving against the source-repo top so the agent's old habits still
    // work. The snapshot key is PROMOTED so the absolute form
    // `<agentHome>/first-tree/docs/intro.md` produces the same canonical key —
    // web cache stays single-keyed per file.
    const abs = join(agentHome, "first-tree", "docs", "intro.md");
    const text = `relative docs/intro.md and absolute ${abs}`;
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(text, {
      agentHome,
      singleRepoLocalPath: "first-tree",
    });

    expect(docs.map((d) => d.path)).toEqual(["first-tree/docs/intro.md"]);
    expect(rewrittenText).toBe(
      "relative [first-tree/docs/intro.md](first-tree/docs/intro.md) and " +
        "absolute [first-tree/docs/intro.md](first-tree/docs/intro.md)",
    );
  });

  it("snapshots an agent-home-scoped absolute .md (sibling of the source repo)", async () => {
    // `<agentHome>/docs/note.md` is in neither the source repo nor a worktree;
    // it's an agent-home note (CLAUDE.md, README, scratch). The wide fence
    // accepts it as a valid snapshot target.
    const abs = join(agentHome, "docs", "note.md");
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(`see ${abs}`, {
      agentHome,
      singleRepoLocalPath: "first-tree",
    });

    expect(docs.map((d) => d.path)).toEqual(["docs/note.md"]);
    expect(rewrittenText).toBe("see [docs/note.md](docs/note.md)");
  });

  it("rejects an absolute path outside the agent home — wide fence is not a free-for-all", async () => {
    const outside = await mkdtemp(join(tmpdir(), "doc-snap-outside-wide-"));
    try {
      await writeFile(join(outside, "external.md"), "# external\n", "utf8");
      const abs = join(outside, "external.md");
      const text = `out-of-home ${abs}`;
      const { docs, rewrittenText } = await buildMessageDocumentSnapshots(text, {
        agentHome,
        singleRepoLocalPath: "first-tree",
      });

      expect(docs).toEqual([]);
      expect(rewrittenText).toBe(text);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("still rejects a hidden-segment mention inside the agent home (.agent/secret.md)", async () => {
    const abs = join(agentHome, ".agent", "secret.md");
    const text = `secret ${abs}`;
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(text, {
      agentHome,
      singleRepoLocalPath: "first-tree",
    });

    expect(docs).toEqual([]);
    expect(rewrittenText).toBe(text);
  });

  it("falls back to agent-home resolution when singleRepoLocalPath is absent (zero/multi-repo)", async () => {
    // No promotion: relative `first-tree/docs/intro.md` is interpreted directly
    // against the agent home and resolves cleanly without prefixing.
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots("see first-tree/docs/intro.md please", {
      agentHome,
    });

    expect(docs.map((d) => d.path)).toEqual(["first-tree/docs/intro.md"]);
    expect(rewrittenText).toBe("see [first-tree/docs/intro.md](first-tree/docs/intro.md) please");
  });

  it("gracefully degrades when singleRepoLocalPath points outside the agent home (no promotion)", async () => {
    // Defence in depth: a misconfigured `localPath: "../escape"` must not let
    // docBase wander outside the fence. The resolver silently drops the
    // promotion and falls back to agent-home resolution.
    const abs = join(agentHome, "docs", "note.md");
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(`see ${abs}`, {
      agentHome,
      singleRepoLocalPath: "../escape",
    });

    expect(docs.map((d) => d.path)).toEqual(["docs/note.md"]);
    expect(rewrittenText).toBe("see [docs/note.md](docs/note.md)");
  });
});

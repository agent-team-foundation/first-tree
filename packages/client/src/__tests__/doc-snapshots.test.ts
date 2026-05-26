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

  it("widens the rewrite over a single-backtick code span — code-styled clickable link", async () => {
    // Phase-1 fix: previously inline code was a hard skip and `` `docs/intro.md` ``
    // stayed dead. Now the rewrite encloses the whole tick-wrapped span so the
    // mono-spaced visual survives and the link points at the snapshot key.
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots("see `docs/intro.md` for setup", root);

    expect(docs.map((d) => d.path)).toEqual(["docs/intro.md"]);
    expect(rewrittenText).toBe("see [`docs/intro.md`](docs/intro.md) for setup");
  });

  it("preserves multi-backtick code-span wrappers verbatim in the link text", async () => {
    // Multi-tick spans are commonmark-legal too and the rewrite preserves the
    // exact tick count + surrounding text so embedded backticks aren't lost.
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(
      "see ``the ` token in docs/intro.md`` is escaped",
      root,
    );

    expect(docs.map((d) => d.path)).toEqual(["docs/intro.md"]);
    expect(rewrittenText).toBe("see [``the ` token in docs/intro.md``](docs/intro.md) is escaped");
  });

  it("preserves the :line suffix when the path is wrapped in a code span", async () => {
    // `:line` inside the span survives via the verbatim slice; the href is
    // still the canonical de-suffixed key.
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots("open `docs/intro.md:42:7` here", root);

    expect(docs.map((d) => d.path)).toEqual(["docs/intro.md"]);
    expect(rewrittenText).toBe("open [`docs/intro.md:42:7`](docs/intro.md) here");
  });

  it("snapshots an absolute code-span path and links it with the canonical key", async () => {
    const abs = join(root, "docs", "intro.md");
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(`see \`${abs}\` please`, root);

    expect(docs.map((d) => d.path)).toEqual(["docs/intro.md"]);
    // Display kept verbatim (long absolute path inside ticks), href is the
    // canonical workspace-relative key.
    expect(rewrittenText).toBe(`see [\`${abs}\`](docs/intro.md) please`);
  });

  it("leaves a fenced (triple-backtick) code block as plain text — fenced stays a hard skip", async () => {
    const text = ["before", "```", "docs/intro.md", "```", "after"].join("\n");
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(text, root);

    expect(docs).toEqual([]);
    expect(rewrittenText).toBe(text);
  });

  it("reports a missing relative mention via failedMentions[missing]", async () => {
    // Phase-2: a bare mention whose canonical path can't be resolved to a
    // real file lands in failedMentions with reason "missing". The rewrite
    // leaves the token untouched (no dead link), and the snapshot list stays
    // empty — the agent's text reaches the wire as authored.
    const { docs, rewrittenText, failedMentions } = await buildMessageDocumentSnapshots(
      "see docs/nope.md please",
      root,
    );

    expect(docs).toEqual([]);
    expect(rewrittenText).toBe("see docs/nope.md please");
    expect(failedMentions).toEqual([{ raw: "docs/nope.md", reason: "missing" }]);
  });

  it("reports a code-span-wrapped missing mention with raw stripped of line suffix", async () => {
    // The code-span wrapper doesn't change failure reporting: the agent's
    // written path (suffix-stripped) is what lands in failedMentions, so the
    // web wrap pass can match every variant of the token in one entry.
    const { docs, rewrittenText, failedMentions } = await buildMessageDocumentSnapshots(
      "see `docs/missing.md:42` together",
      root,
    );

    expect(docs).toEqual([]);
    expect(rewrittenText).toBe("see `docs/missing.md:42` together");
    expect(failedMentions).toEqual([{ raw: "docs/missing.md", reason: "missing" }]);
  });

  it("reports an out-of-root absolute mention as out-of-fence", async () => {
    // Out-of-root absolute paths fall through self resolution and fail
    // classification — bucket them as out-of-fence so the chip tooltip can
    // tell the agent the file is outside the workspace.
    const abs = join(outside, "external.md");
    const { docs, failedMentions } = await buildMessageDocumentSnapshots(`see ${abs} now`, root);

    expect(docs).toEqual([]);
    expect(failedMentions).toEqual([{ raw: abs, reason: "out-of-fence" }]);
  });

  it("reports a hidden-segment mention via failedMentions[hidden-segment]", async () => {
    const { docs, failedMentions } = await buildMessageDocumentSnapshots("read .agent/secret.md", root);

    expect(docs).toEqual([]);
    expect(failedMentions).toEqual([{ raw: ".agent/secret.md", reason: "hidden-segment" }]);
  });

  it("classifies a relative `..` escape as out-of-fence, not hidden-segment", async () => {
    // Parent-traversal mentions (`../outside.md`) cannot snapshot — but the
    // failure reason is "outside the workspace", not "hidden directory". The
    // chip tooltip would otherwise mis-attribute the cause and confuse the
    // agent (Codex review round 1 P3).
    const { docs, failedMentions } = await buildMessageDocumentSnapshots("see ../outside.md please", root);

    expect(docs).toEqual([]);
    expect(failedMentions).toEqual([{ raw: "../outside.md", reason: "out-of-fence" }]);
  });

  it("dedupes failedMentions by writtenPath across multiple raw variants", async () => {
    // Two occurrences of the same canonical path under different `:line`
    // suffixes collapse to ONE failedMentions entry on the wire. Web's wrap
    // pass canonicalises each scan match before lookup so all occurrences
    // still render as chips.
    const { failedMentions } = await buildMessageDocumentSnapshots(
      "compare docs/nope.md to docs/nope.md:5 together",
      root,
    );

    expect(failedMentions).toEqual([{ raw: "docs/nope.md", reason: "missing" }]);
  });

  it("mixes successful snapshots and failed mentions in one message", async () => {
    // Mixed message: a real path snapshots, an unreachable one fails. Both
    // are reported so chat-view can render a real link + an inert chip side
    // by side.
    const { docs, rewrittenText, failedMentions } = await buildMessageDocumentSnapshots(
      "wrote docs/intro.md but docs/nope.md is missing",
      root,
    );

    expect(docs.map((d) => d.path)).toEqual(["docs/intro.md"]);
    expect(rewrittenText).toBe("wrote [docs/intro.md](docs/intro.md) but docs/nope.md is missing");
    expect(failedMentions).toEqual([{ raw: "docs/nope.md", reason: "missing" }]);
  });

  it("inline-link failures stay silent — no failedMentions entry", async () => {
    // The agent's explicit `[label](target.md)` already shows their intent
    // to link. A failed snapshot for that target leaves the link as-is in
    // the text; web's click handler no-ops on the missing snapshot. We
    // deliberately do NOT add an inert chip — the proposal scopes the chip
    // UI to scanner-bare-token positions.
    const { docs, failedMentions } = await buildMessageDocumentSnapshots("click [docs](docs/nope.md) please", root);

    expect(docs).toEqual([]);
    expect(failedMentions).toEqual([]);
  });

  it("multi-path-in-one-code-span: first wins, second left inside the link text", async () => {
    // Degenerate case: the agent crams two paths into one code span. The
    // overlap-defensive applyRewrites picks the first match's widened span;
    // the second match's rewrite is dropped. The second path's snapshot is
    // still emitted so metadata stays self-consistent — it just isn't its
    // own clickable target.
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(
      "see `docs/intro.md and design.md` together",
      root,
    );

    const paths = docs.map((d) => d.path).sort();
    expect(paths).toEqual(["design.md", "docs/intro.md"]);
    expect(rewrittenText).toBe("see [`docs/intro.md and design.md`](docs/intro.md) together");
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

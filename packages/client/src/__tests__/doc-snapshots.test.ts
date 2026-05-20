import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMessageDocumentSnapshots } from "../runtime/doc-snapshots.js";

/**
 * Unit tests for the runtime snapshot builder, focused on Option R (Case A):
 * an absolute `.md` path that lands inside the workspace root is snapshotted
 * AND rewritten in the outbound text to its canonical workspace-relative path,
 * so web's unchanged re-scan can match it. Relative mentions and out-of-root /
 * hidden / escaping paths must behave exactly as before.
 */
describe("buildMessageDocumentSnapshots — absolute-in-root rewrite (Option R / Case A)", () => {
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
    expect(rewrittenText).toBe("wrote design.md just now");
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
    expect(rewrittenText).toBe("open docs/intro.md:42:7 here");
  });

  it("leaves an out-of-root absolute path untouched — no snapshot, no rewrite", async () => {
    const abs = join(outside, "external.md");
    const text = `external doc at ${abs} here`;
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(text, root);

    expect(docs).toEqual([]);
    expect(rewrittenText).toBe(text);
  });

  it("leaves relative tokens completely unchanged (regression)", async () => {
    const text = "see docs/intro.md and [d](design.md)";
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(text, root);

    expect(docs.map((d) => d.path).sort()).toEqual(["design.md", "docs/intro.md"]);
    // Text is byte-for-byte identical: relative mentions are never rewritten.
    expect(rewrittenText).toBe(text);
  });

  it("does not rewrite a non-canonical RELATIVE token (web canonicalises it on re-scan)", async () => {
    const text = "see [d](./docs/intro.md)";
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(text, root);

    expect(docs.map((d) => d.path)).toEqual(["docs/intro.md"]);
    expect(rewrittenText).toBe(text);
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
    expect(rewrittenText).toBe("first design.md then again design.md");
  });
});

/**
 * Cross-agent doc preview: with a workspace fence, an absolute `.md` path that
 * realpaths into ANOTHER agent's workspace (same chat) under the shared
 * `workspaces/` common root is snapshotted with a global
 * `<ownerSlug>/<chatId>/<rel>` key and rewritten to the short `<ownerSlug>/<rel>`
 * form. Self paths keep their bare key + #480 behaviour; out-of-scope paths
 * (other chat, other root, hidden) stay verbatim.
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
    expect(rewrittenText).toBe(`see ${otherSlug}/design.md please`);
  });

  it("preserves subdir + :line suffix in the cross rewrite", async () => {
    const abs = join(workspacesRoot, otherSlug, chatId, "docs", "intro.md");
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(`open ${abs}:10 now`, selfRoot, fence());

    expect(docs.map((d) => d.path)).toEqual([`${otherSlug}/${chatId}/docs/intro.md`]);
    expect(rewrittenText).toBe(`open ${otherSlug}/docs/intro.md:10 now`);
  });

  it("keeps the self path bare (Case A unchanged) even with a fence", async () => {
    const abs = join(selfRoot, "mine.md");
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(`my ${abs} file`, selfRoot, fence());

    expect(docs.map((d) => d.path)).toEqual(["mine.md"]);
    expect(rewrittenText).toBe("my mine.md file");
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

  it("rewrites a cross mention to the FULL global key when its short form collides with a self key (P2-b)", async () => {
    // Self file `assistant/design.md` (relative) AND the sibling agent's
    // `assistant/<chat>/design.md` are both referenced. The cross short form
    // would be `assistant/design.md` — identical to the self key — so the cross
    // mention must be rewritten to the full global key instead.
    const crossAbs = join(workspacesRoot, otherSlug, chatId, "design.md");
    const text = `self ${otherSlug}/design.md and cross ${crossAbs}`;
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(text, selfRoot, fence());

    expect(docs.map((d) => d.path).sort()).toEqual([`${otherSlug}/${chatId}/design.md`, `${otherSlug}/design.md`]);
    // Self relative mention stays verbatim; cross mention becomes the full key.
    expect(rewrittenText).toBe(`self ${otherSlug}/design.md and cross ${otherSlug}/${chatId}/design.md`);
  });
});

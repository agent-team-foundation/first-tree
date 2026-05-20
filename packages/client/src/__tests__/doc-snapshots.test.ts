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

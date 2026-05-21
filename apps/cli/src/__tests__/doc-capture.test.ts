import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    const out = await captureOutboundDocs("see design.md please", { FIRST_TREE_HUB_DOC_BASE: base });
    expect(out.content).toBe("see [design.md](design.md) please");
    const ctx = out.documentContext as { kind?: string; docs?: Array<{ path: string }> } | undefined;
    expect(ctx?.kind).toBe("snapshot");
    expect(ctx?.docs?.map((d) => d.path)).toEqual(["design.md"]);
  });

  it("rewrites an absolute-in-base path into an explicit relative link + snapshots it", async () => {
    const abs = join(base, "design.md");
    const out = await captureOutboundDocs(`wrote ${abs} now`, { FIRST_TREE_HUB_DOC_BASE: base });
    expect(out.content).toBe("wrote [design.md](design.md) now");
    const ctx = out.documentContext as { docs?: Array<{ path: string }> } | undefined;
    expect(ctx?.docs?.map((d) => d.path)).toEqual(["design.md"]);
  });

  it("no documentContext when the referenced path is not in the workspace", async () => {
    const out = await captureOutboundDocs("see /etc/nope/missing.md", { FIRST_TREE_HUB_DOC_BASE: base });
    expect(out.content).toBe("see /etc/nope/missing.md");
    expect(out.documentContext).toBeUndefined();
  });

  it("no documentContext when the message references no .md", async () => {
    const out = await captureOutboundDocs("just a plain message", { FIRST_TREE_HUB_DOC_BASE: base });
    expect(out.content).toBe("just a plain message");
    expect(out.documentContext).toBeUndefined();
  });
});

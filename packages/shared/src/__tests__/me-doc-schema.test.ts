import { describe, expect, it } from "vitest";
import { documentContextSchema } from "../schemas/me-doc.js";

describe("documentContextSchema", () => {
  it("normalizes legacy basePath-only context to the path variant", () => {
    expect(documentContextSchema.parse({ basePath: "/tmp/workspace" })).toEqual({
      kind: "path",
      basePath: "/tmp/workspace",
    });
  });

  it("passes through already discriminated context values", () => {
    expect(documentContextSchema.parse({ kind: "path", basePath: "/tmp/workspace" })).toEqual({
      kind: "path",
      basePath: "/tmp/workspace",
    });
  });

  it("accepts a snapshot context carrying a failedMentions roster", () => {
    // Post-convergence the snapshot variant is the inert-chip roster ONLY —
    // successful captures live in metadata.attachments[] as AttachmentRefs.
    const context = {
      kind: "snapshot",
      failedMentions: [{ raw: "docs/missing.md", reason: "missing" }],
    };

    expect(documentContextSchema.parse(context)).toEqual(context);
  });

  it("rejects a snapshot context with an empty failedMentions roster", () => {
    expect(() => documentContextSchema.parse({ kind: "snapshot", failedMentions: [] })).toThrow();
  });

  it("rejects the legacy inline `docs[].content` snapshot shape (cutover)", () => {
    // Old messages with this shape no longer parse; readers degrade gracefully
    // to no-preview rather than throwing.
    expect(() =>
      documentContextSchema.parse({
        kind: "snapshot",
        docs: [{ path: "docs/readme.md", sha256: "a".repeat(64), size: 12, content: "# Readme" }],
      }),
    ).toThrow();
  });
});

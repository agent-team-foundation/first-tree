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

  it("accepts snapshot context with canonical markdown docs", () => {
    const context = {
      kind: "snapshot",
      docs: [
        {
          path: "docs/readme.md",
          sha256: "a".repeat(64),
          size: 12,
          content: "# Readme",
        },
      ],
    };

    expect(documentContextSchema.parse(context)).toEqual(context);
  });

  it("accepts snapshot context with failed mentions and no docs", () => {
    const context = {
      kind: "snapshot",
      docs: [],
      failedMentions: [{ raw: "docs/missing.md", reason: "missing" }],
    };

    expect(documentContextSchema.parse(context)).toEqual(context);
  });

  it("rejects snapshot context without docs or failed mentions", () => {
    expect(() => documentContextSchema.parse({ kind: "snapshot", docs: [] })).toThrow(
      "snapshot documentContext must include at least one snapshot or one failedMention",
    );
  });
});

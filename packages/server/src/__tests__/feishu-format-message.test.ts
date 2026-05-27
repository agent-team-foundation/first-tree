import { describe, expect, it } from "vitest";
import { formatForFeishu } from "../services/adapter-manager.js";

describe("formatForFeishu — file/image branches", () => {
  it("renders a batched image message (caption + N refs) as a readable list", () => {
    const out = formatForFeishu("file", {
      caption: "look at these",
      attachments: [
        { imageId: "9c2ce4e7-3f0d-4f53-9c0c-1c93e7d51a92", mimeType: "image/png", filename: "a.png" },
        { imageId: "11111111-1111-4111-8111-111111111111", mimeType: "image/png", filename: "b.png" },
      ],
    });
    expect(out.msgType).toBe("text");
    const text = JSON.parse(out.content).text as string;
    expect(text).toContain("look at these");
    expect(text).toContain("2 image(s)");
    expect(text).toContain("a.png");
    expect(text).toContain("b.png");
    // The whole point: external Feishu users see the caption + filenames,
    // not a raw `{"caption":"…","attachments":[...]}` JSON object.
    expect(text).not.toContain('{"caption"');
  });

  it("omits the caption line when none is present (attachment-only batch send)", () => {
    const out = formatForFeishu("file", {
      attachments: [{ imageId: "9c2ce4e7-3f0d-4f53-9c0c-1c93e7d51a92", mimeType: "image/png", filename: "only.png" }],
    });
    const text = JSON.parse(out.content).text as string;
    expect(text).toContain("1 image(s)");
    expect(text).toContain("only.png");
    expect(text.startsWith("📎")).toBe(true);
  });

  it("renders a legacy single-image ref as a filename line", () => {
    const out = formatForFeishu("file", {
      imageId: "9c2ce4e7-3f0d-4f53-9c0c-1c93e7d51a92",
      mimeType: "image/png",
      filename: "legacy.png",
    });
    const text = JSON.parse(out.content).text as string;
    expect(text).toContain("legacy.png");
    expect(text).not.toContain('{"imageId"');
  });

  it("falls back to JSON.stringify when the file content shape isn't recognised", () => {
    const out = formatForFeishu("file", { something: "unknown" });
    const text = JSON.parse(out.content).text as string;
    // Unrecognised file shape goes through the default branch; preserves
    // the behaviour the pre-batch code had for non-image file messages.
    expect(text).toBe(JSON.stringify({ something: "unknown" }));
  });

  it("leaves text format unchanged (regression guard)", () => {
    const out = formatForFeishu("text", "hello @alice");
    expect(out.msgType).toBe("text");
    expect(JSON.parse(out.content).text).toBe("hello @alice");
  });
});

import { describe, expect, it } from "vitest";
import { COMPOSER_ACCEPT_ATTRIBUTE, classifyComposerUpload } from "../schemas/attachment-classification.js";

describe("attachment classification", () => {
  it("allows supported images as image attachments", () => {
    expect(classifyComposerUpload("image/png", "screenshot.png")).toEqual({ allowed: true, kind: "image" });
  });

  it("keeps markdown as document refs and text-native files as generic file refs", () => {
    expect(classifyComposerUpload("", "notes.md")).toEqual({ allowed: true, kind: "document" });
    expect(classifyComposerUpload("", "data.csv")).toEqual({ allowed: true, kind: "file" });
    expect(classifyComposerUpload("text/plain", "script.py")).toEqual({ allowed: true, kind: "file" });
  });

  it("allows office documents by extension or MIME", () => {
    expect(classifyComposerUpload("", "brief.pdf")).toEqual({ allowed: true, kind: "file" });
    expect(
      classifyComposerUpload("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "untitled"),
    ).toEqual({ allowed: true, kind: "file" });
  });

  it("rejects archives, executables, and audio/video formats", () => {
    expect(classifyComposerUpload("application/zip", "payload.zip")).toEqual({ allowed: false, kind: "file" });
    expect(classifyComposerUpload("application/x-msdownload", "setup.exe")).toEqual({
      allowed: false,
      kind: "file",
    });
    expect(classifyComposerUpload("video/mp4", "demo.mp4")).toEqual({ allowed: false, kind: "file" });
  });

  it("builds a file input accept list with image MIME types and document extensions", () => {
    expect(COMPOSER_ACCEPT_ATTRIBUTE).toContain("image/png");
    expect(COMPOSER_ACCEPT_ATTRIBUTE).toContain(".pdf");
    expect(COMPOSER_ACCEPT_ATTRIBUTE).toContain(".csv");
    expect(COMPOSER_ACCEPT_ATTRIBUTE).not.toContain(".zip");
  });
});

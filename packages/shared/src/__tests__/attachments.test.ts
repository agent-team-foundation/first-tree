import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_LIMITS,
  AttachmentRejectedError,
  classifyAttachment,
  fileExtension,
  isInlineSafeImage,
  looksExecutable,
  sniffMime,
} from "../attachments.js";
import { deriveAttachmentKind } from "../schemas/message.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
const MZ = new Uint8Array([0x4d, 0x5a, 0x90, 0x00]); // Windows PE
const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
const TEXT = new TextEncoder().encode("# Hello\njust markdown text\n");

function classify(filename: string, declaredMime: string, head: Uint8Array, size = head.length) {
  return classifyAttachment({ filename, declaredMime, head, size });
}

describe("deriveAttachmentKind", () => {
  it("maps image/* to image and everything else to file", () => {
    expect(deriveAttachmentKind("image/png")).toBe("image");
    expect(deriveAttachmentKind("image/svg+xml")).toBe("image");
    expect(deriveAttachmentKind("application/pdf")).toBe("file");
    expect(deriveAttachmentKind("text/markdown")).toBe("file");
  });
});

describe("sniffMime / looksExecutable", () => {
  it("sniffs known media", () => {
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(PDF)).toBe("application/pdf");
    expect(sniffMime(TEXT)).toBeNull();
  });
  it("flags executables regardless of name", () => {
    expect(looksExecutable(MZ)).toBe(true);
    expect(looksExecutable(ELF)).toBe(true);
    expect(looksExecutable(new TextEncoder().encode("#!/bin/sh"))).toBe(true);
    expect(looksExecutable(PNG)).toBe(false);
  });
});

describe("classifyAttachment", () => {
  it("accepts a real PNG (sniffed image)", () => {
    expect(classify("shot.png", "image/png", PNG)).toEqual({ kind: "image", mimeType: "image/png" });
  });

  it("accepts a real PDF as a file", () => {
    expect(classify("doc.pdf", "application/pdf", PDF)).toEqual({ kind: "file", mimeType: "application/pdf" });
  });

  // C1: magicless safe text/doc types must be allowed even though sniff returns null.
  it("accepts magicless safe text (.md) and trusts the declared mime", () => {
    expect(classify("notes.md", "text/markdown", TEXT)).toEqual({ kind: "file", mimeType: "text/markdown" });
    expect(classify("data.csv", "text/csv", TEXT).kind).toBe("file");
    expect(classify("a.json", "application/json", TEXT).kind).toBe("file");
  });

  it("rejects an unknown extension with no magic (could-not-verify)", () => {
    expect(() => classify("mystery.xyz", "application/octet-stream", TEXT)).toThrow(AttachmentRejectedError);
  });

  it("rejects denied executable extensions", () => {
    expect(() => classify("run.exe", "application/octet-stream", TEXT)).toThrow(/not allowed/);
    expect(() => classify("go.sh", "text/x-sh", TEXT)).toThrow(/not allowed/);
  });

  // Disguised binary: executable bytes under an image name must still be rejected.
  it("rejects executable bytes even with an image filename", () => {
    expect(() => classify("cat.png", "image/png", MZ)).toThrow(/Executable/);
  });

  it("enforces the per-file size cap and rejects empties", () => {
    expect(() => classify("big.png", "image/png", PNG, ATTACHMENT_LIMITS.maxFileBytes + 1)).toThrow(/too large/i);
    expect(() => classify("empty.png", "image/png", PNG, 0)).toThrow(/Empty/);
  });
});

describe("isInlineSafeImage / fileExtension", () => {
  it("only allows the inline image allow-list (svg excluded)", () => {
    expect(isInlineSafeImage("image/png")).toBe(true);
    expect(isInlineSafeImage("image/webp")).toBe(true);
    expect(isInlineSafeImage("image/svg+xml")).toBe(false);
    expect(isInlineSafeImage("application/pdf")).toBe(false);
  });
  it("extracts lower-cased extensions", () => {
    expect(fileExtension("a/b/Photo.PNG")).toBe(".png");
    expect(fileExtension("noext")).toBe("");
    expect(fileExtension(".bashrc")).toBe("");
  });
});

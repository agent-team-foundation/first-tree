// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  apiFetchRaw: vi.fn(),
}));

vi.mock("../client.js", () => ({
  apiFetchRaw: clientMocks.apiFetchRaw,
  withOrg: (path: string) => `/orgs/current${path}`,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("attachments extra paths", () => {
  it("fetches attachment text with mime and byte length", async () => {
    const { fetchAttachmentText } = await import("../attachments.js");
    clientMocks.apiFetchRaw.mockResolvedValueOnce(
      new Response(new TextEncoder().encode("hello world"), {
        headers: { "content-type": "text/markdown" },
      }),
    );

    await expect(fetchAttachmentText("att/1")).resolves.toEqual({
      text: "hello world",
      mimeType: "text/markdown",
      sizeBytes: 11,
    });
    expect(clientMocks.apiFetchRaw).toHaveBeenCalledWith("/attachments/att%2F1");
  });

  it("downloads attachment via object URL click", async () => {
    const { downloadAttachment } = await import("../attachments.js");
    const blob = new Blob(["bytes"], { type: "application/pdf" });
    clientMocks.apiFetchRaw.mockResolvedValueOnce(new Response(blob));

    const createObjectURL = vi.fn(() => "blob:mock-url");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });

    const click = vi.fn();
    const originalCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = originalCreate(tag);
      if (tag === "a") {
        Object.defineProperty(el, "click", { value: click });
      }
      return el;
    });

    await downloadAttachment("att-2", "report.pdf");
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });

  it("computes sha256 hex and rejects when subtle is unavailable", async () => {
    const { sha256Hex } = await import("../attachments.js");

    if (globalThis.crypto?.subtle) {
      const hex = await sha256Hex("abc");
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
    }

    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { subtle: undefined },
    });
    await expect(sha256Hex("x")).rejects.toThrow("Web Crypto subtle digest is unavailable");
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
  });

  it("rejects FileReader non-string results when converting blob to base64", async () => {
    const { fetchAttachmentBase64 } = await import("../attachments.js");
    clientMocks.apiFetchRaw.mockResolvedValueOnce(
      new Response(new Blob(["x"]), { headers: { "content-type": "text/plain" } }),
    );

    class BadReader {
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(): void {
        this.result = new ArrayBuffer(0);
        this.onload?.();
      }
    }
    Object.defineProperty(globalThis, "FileReader", { configurable: true, value: BadReader });
    await expect(fetchAttachmentBase64("id")).rejects.toThrow("Unexpected FileReader result");
  });
});

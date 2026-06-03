// @vitest-environment happy-dom

import { ATTACHMENT_FILENAME_HEADER, ATTACHMENT_MIME_HEADER } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  apiFetchRaw: vi.fn(),
  get: vi.fn(),
}));

vi.mock("../client.js", () => ({
  api: { get: clientMocks.get },
  apiFetchRaw: clientMocks.apiFetchRaw,
  withOrg: (path: string) => `/orgs/current${path}`,
}));

const NOW = "2026-05-28T12:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("attachments and usage API wrappers", () => {
  it("uploads image bytes with encoded metadata headers", async () => {
    const { uploadImageAttachment } = await import("../attachments.js");
    const response = {
      id: "11111111-1111-4111-8111-111111111111",
      mimeType: "image/png",
      filename: "你好.png",
      sizeBytes: 3,
      uploadedBy: "member-1",
      createdAt: NOW,
    };
    clientMocks.apiFetchRaw.mockResolvedValueOnce(new Response(JSON.stringify(response)));

    const file = new File([new Uint8Array([1, 2, 3])], "你好.png", { type: "image/png" });
    await expect(uploadImageAttachment(file)).resolves.toEqual(response);

    expect(clientMocks.apiFetchRaw).toHaveBeenCalledTimes(1);
    const [path, init] = clientMocks.apiFetchRaw.mock.calls[0] ?? [];
    expect(path).toBe("/orgs/current/attachments");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/octet-stream",
      [ATTACHMENT_MIME_HEADER]: "image/png",
      [ATTACHMENT_FILENAME_HEADER]: "%E4%BD%A0%E5%A5%BD.png",
    });
    expect(init?.body).toBeInstanceOf(ArrayBuffer);
  });

  it("downloads attachment bytes as base64 and preserves served mime type", async () => {
    const { fetchAttachmentBase64 } = await import("../attachments.js");
    clientMocks.apiFetchRaw.mockResolvedValueOnce(
      new Response(new Blob(["hello"], { type: "text/plain" }), { headers: { "content-type": "text/custom" } }),
    );

    await expect(fetchAttachmentBase64("attachment/id")).resolves.toEqual({
      base64: "aGVsbG8=",
      mimeType: "text/custom",
    });
    expect(clientMocks.apiFetchRaw).toHaveBeenCalledWith("/attachments/attachment%2Fid");
  });

  it("formats usage windows and optional turn pagination", async () => {
    const usage = await import("../usage.js");

    expect(usage.windowToDays("7d")).toBe(7);
    expect(usage.windowToDays("30d")).toBe(30);

    await usage.getOrgUsageByAgent("7d");
    await usage.getAgentUsageSummary("agent/id", "30d");
    await usage.getAgentUsageTurns("agent/id", { window: "7d", cursor: "next/cursor", limit: 25 });
    await usage.getAgentUsageTurns("agent/id", { window: "30d" });

    const usageCalls = clientMocks.get.mock.calls.map((call) => String(call[0]));
    expect(usageCalls[0]).toContain("/orgs/current/usage/by-agent?from=2026-05-21T12%3A00%3A00.000Z");
    expect(usageCalls[0]).toContain("to=2026-05-28T12%3A00%3A00.000Z");
    expect(usageCalls[1]).toContain("/agents/agent%2Fid/usage/summary?from=2026-04-28T12%3A00%3A00.000Z");
    expect(usageCalls[2]).toContain("/agents/agent%2Fid/usage/turns?");
    expect(usageCalls[2]).toContain("cursor=next%2Fcursor");
    expect(usageCalls[2]).toContain("limit=25");
    expect(usageCalls[3]).not.toContain("cursor=");
    expect(usageCalls[3]).not.toContain("limit=");
  });
});

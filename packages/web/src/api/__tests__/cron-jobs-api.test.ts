// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  delete: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

vi.mock("../client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client.js")>();
  return { ...actual, api: apiMock };
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.get.mockResolvedValue({ items: [] });
  apiMock.post.mockResolvedValue({});
  apiMock.patch.mockResolvedValue({});
  apiMock.delete.mockResolvedValue(undefined);
});

describe("cron-jobs api wrappers", () => {
  it("lists chat cron jobs with URL-encoded chat id", async () => {
    const { listChatCronJobs } = await import("../cron-jobs.js");
    await listChatCronJobs("chat/with space");
    expect(apiMock.get).toHaveBeenCalledWith("/chats/chat%2Fwith%20space/cron-jobs");
  });

  it("posts preview requests to the chat-scoped preview route", async () => {
    const { previewChatCronJobs } = await import("../cron-jobs.js");
    const input = { schedule: "0 9 * * 1-5", timezone: "America/New_York" };
    await previewChatCronJobs("chat-1", input);
    expect(apiMock.post).toHaveBeenCalledWith("/chats/chat-1/cron-jobs/preview", input);
  });

  it("sends If-Match revision header on patch and delete, never in the body", async () => {
    const { deleteCronJob, patchCronJob } = await import("../cron-jobs.js");

    await patchCronJob("job/id 1", { state: "paused" }, 7);
    expect(apiMock.patch).toHaveBeenCalledWith(
      "/cron-jobs/job%2Fid%201",
      { state: "paused" },
      { headers: { "If-Match": "7" } },
    );

    await deleteCronJob("job/id 1", 9);
    expect(apiMock.delete).toHaveBeenCalledWith("/cron-jobs/job%2Fid%201", { headers: { "If-Match": "9" } });
  });
});

import { describe, expect, it } from "vitest";
import { resolveChatGithubEntity } from "../services/github-entity-live.js";

function jsonFetcher(body: unknown, ok = true): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers: { "content-type": "application/json" },
    });
}

describe("resolveChatGithubEntity live fields", () => {
  it("resolves pull request URLs and collapsed live states", async () => {
    await expect(
      resolveChatGithubEntity(
        { entityType: "pull_request", entityKey: "owner/repo#12", boundVia: "direct" },
        "token",
        jsonFetcher({ title: "Draft PR", state: "open", draft: true, merged: false }),
      ),
    ).resolves.toMatchObject({
      entityType: "pull_request",
      htmlUrl: "https://github.com/owner/repo/pull/12",
      number: 12,
      state: "draft",
      title: "Draft PR",
    });

    await expect(
      resolveChatGithubEntity(
        { entityType: "pull_request", entityKey: "owner/repo#13", boundVia: "fixes_link" },
        "token",
        jsonFetcher({ title: "Merged PR", state: "closed", draft: false, merged: true }),
      ),
    ).resolves.toMatchObject({ state: "merged", title: "Merged PR" });
  });

  it("resolves issues, commits, and tokenless link-only rows", async () => {
    await expect(
      resolveChatGithubEntity(
        { entityType: "issue", entityKey: "owner/repo#3", boundVia: "direct" },
        "token",
        jsonFetcher({ title: "Bug", state: "closed" }),
      ),
    ).resolves.toMatchObject({
      htmlUrl: "https://github.com/owner/repo/issues/3",
      number: 3,
      state: "closed",
      title: "Bug",
    });

    await expect(
      resolveChatGithubEntity(
        { entityType: "commit", entityKey: "owner/repo@abcdef1", boundVia: "agent_created" },
        "token",
        jsonFetcher({ commit: { message: "Fix bug\n\nBody" } }),
      ),
    ).resolves.toMatchObject({
      htmlUrl: "https://github.com/owner/repo/commit/abcdef1",
      number: null,
      state: null,
      title: "Fix bug",
    });

    await expect(
      resolveChatGithubEntity(
        { entityType: "discussion", entityKey: "owner/repo#7", boundVia: "fixes_link" },
        null,
        jsonFetcher({ title: "Ignored" }),
      ),
    ).resolves.toMatchObject({
      htmlUrl: "https://github.com/owner/repo/discussions/7",
      number: 7,
      state: null,
      title: null,
    });
  });

  it("drops malformed enum values, malformed keys, failed fetches, and bad JSON", async () => {
    await expect(
      resolveChatGithubEntity({ entityType: "unknown", entityKey: "owner/repo#1", boundVia: "direct" }, "token"),
    ).resolves.toBeNull();
    await expect(
      resolveChatGithubEntity({ entityType: "issue", entityKey: "not-a-key", boundVia: "direct" }, "token"),
    ).resolves.toBeNull();
    await expect(
      resolveChatGithubEntity({ entityType: "issue", entityKey: "owner/repo#1", boundVia: "bad" }, "token"),
    ).resolves.toBeNull();
    await expect(
      resolveChatGithubEntity(
        { entityType: "issue", entityKey: "owner/repo#1", boundVia: "direct" },
        "token",
        jsonFetcher({}, false),
      ),
    ).resolves.toMatchObject({ state: null, title: null });
    await expect(
      resolveChatGithubEntity(
        { entityType: "commit", entityKey: "owner/repo@abcdef1", boundVia: "direct" },
        "token",
        async () => new Response("{bad json", { status: 200 }),
      ),
    ).resolves.toMatchObject({ state: null, title: null });
  });
});

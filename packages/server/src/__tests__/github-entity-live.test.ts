import { describe, expect, it, vi } from "vitest";
import { GITHUB_API_BASE } from "../services/github-api-base.js";
import { __testing, materializeChatGithubEntity, resolveChatGithubEntity } from "../services/github-entity-live.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("github entity live helpers", () => {
  it("parses numeric and sha entity keys", () => {
    expect(__testing.parseEntityKey("pull_request", "owner/repo#42")).toEqual({
      kind: "numeric",
      owner: "owner",
      repo: "repo",
      number: 42,
    });
    expect(__testing.parseEntityKey("issue", "owner/repo#7")).toEqual({
      kind: "numeric",
      owner: "owner",
      repo: "repo",
      number: 7,
    });
    expect(__testing.parseEntityKey("discussion", "owner/repo#discussion-9")).toEqual({
      kind: "numeric",
      owner: "owner",
      repo: "repo",
      number: 9,
    });
    expect(__testing.parseEntityKey("commit", "owner/repo@abcdef1")).toEqual({
      kind: "sha",
      owner: "owner",
      repo: "repo",
      sha: "abcdef1",
    });
    expect(__testing.parseEntityKey("commit", "owner/repo#42")).toBeNull();
    expect(__testing.parseEntityKey("issue", "owner/repo@abcdef1")).toBeNull();
    expect(__testing.parseEntityKey("pull_request", "owner/repo#not-a-number")).toBeNull();
  });

  it("keeps defensive parser guards for malformed regex captures", () => {
    const originalExec = RegExp.prototype.exec;
    try {
      RegExp.prototype.exec = function exec(this: RegExp, input: string): RegExpExecArray | null {
        if (input === "owner/repo@abcdef1") {
          return ["owner/repo@abcdef1", "owner", "repo", undefined] as unknown as RegExpExecArray;
        }
        if (input === "owner/repo#discussion-9") {
          return ["owner/repo#discussion-9", "owner", undefined, "9"] as unknown as RegExpExecArray;
        }
        if (input === "owner/repo#42") {
          return ["owner/repo#42", undefined, "repo", "42"] as unknown as RegExpExecArray;
        }
        return originalExec.call(this, input);
      };

      expect(__testing.parseEntityKey("commit", "owner/repo@abcdef1")).toBeNull();
      expect(__testing.parseEntityKey("discussion", "owner/repo#discussion-9")).toBeNull();
      expect(__testing.parseEntityKey("issue", "owner/repo#42")).toBeNull();
    } finally {
      RegExp.prototype.exec = originalExec;
    }
  });

  it("builds canonical GitHub URLs", () => {
    expect(__testing.buildHtmlUrl("pull_request", { kind: "numeric", owner: "o", repo: "r", number: 1 })).toBe(
      "https://github.com/o/r/pull/1",
    );
    expect(__testing.buildHtmlUrl("issue", { kind: "numeric", owner: "o", repo: "r", number: 2 })).toBe(
      "https://github.com/o/r/issues/2",
    );
    expect(__testing.buildHtmlUrl("discussion", { kind: "numeric", owner: "o", repo: "r", number: 3 })).toBe(
      "https://github.com/o/r/discussions/3",
    );
    expect(__testing.buildHtmlUrl("commit", { kind: "sha", owner: "o", repo: "r", sha: "abcdef1" })).toBe(
      "https://github.com/o/r/commit/abcdef1",
    );
    expect(
      __testing.buildHtmlUrl("commit", { kind: "numeric", owner: "o", repo: "r", number: 4 } as never),
    ).toBe("https://github.com/o/r");
  });
});

describe("fetchEntityLiveFields", () => {
  it("maps pull request live states", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ title: "Open PR", state: "open", draft: false, merged: false }))
      .mockResolvedValueOnce(jsonResponse({ title: "Draft PR", state: "open", draft: true, merged: false }))
      .mockResolvedValueOnce(jsonResponse({ title: "Merged PR", state: "closed", draft: false, merged: true }));
    const parsed = { kind: "numeric" as const, owner: "owner", repo: "repo", number: 42 };

    await expect(__testing.fetchEntityLiveFields("pull_request", parsed, "token", fetcher)).resolves.toEqual({
      title: "Open PR",
      state: "open",
    });
    await expect(__testing.fetchEntityLiveFields("pull_request", parsed, "token", fetcher)).resolves.toEqual({
      title: "Draft PR",
      state: "draft",
    });
    await expect(__testing.fetchEntityLiveFields("pull_request", parsed, "token", fetcher)).resolves.toEqual({
      title: "Merged PR",
      state: "merged",
    });
    expect(fetcher).toHaveBeenCalledWith(
      `${GITHUB_API_BASE}/repos/owner/repo/pulls/42`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "token token" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("handles pull request non-ok responses and fallback live fields", async () => {
    const parsed = { kind: "numeric" as const, owner: "owner", repo: "repo", number: 42 };
    await expect(
      __testing.fetchEntityLiveFields(
        "pull_request",
        parsed,
        "token",
        vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("nope", { status: 404 })),
      ),
    ).resolves.toEqual({ title: null, state: null });

    await expect(
      __testing.fetchEntityLiveFields(
        "pull_request",
        parsed,
        "token",
        vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ state: "queued" })),
      ),
    ).resolves.toEqual({ title: null, state: null });

    await expect(
      __testing.fetchEntityLiveFields(
        "pull_request",
        parsed,
        "token",
        vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ state: "closed", title: "" })),
      ),
    ).resolves.toEqual({ title: "", state: "closed" });
  });

  it("fetches issue state and commit title", async () => {
    const issueFetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ title: "Bug", state: "closed" }));
    await expect(
      __testing.fetchEntityLiveFields(
        "issue",
        { kind: "numeric", owner: "owner", repo: "repo", number: 9 },
        "token",
        issueFetcher,
      ),
    ).resolves.toEqual({ title: "Bug", state: "closed" });

    const commitFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ commit: { message: "Fix startup\n\nBody" } }));
    await expect(
      __testing.fetchEntityLiveFields(
        "commit",
        { kind: "sha", owner: "owner", repo: "repo", sha: "abcdef1" },
        "token",
        commitFetcher,
      ),
    ).resolves.toEqual({ title: "Fix startup", state: null });
  });

  it("normalizes issue and commit live field fallbacks", async () => {
    await expect(
      __testing.fetchEntityLiveFields(
        "issue",
        { kind: "numeric", owner: "owner", repo: "repo", number: 9 },
        "token",
        vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ state: "triaged" })),
      ),
    ).resolves.toEqual({ title: null, state: null });

    await expect(
      __testing.fetchEntityLiveFields(
        "commit",
        { kind: "sha", owner: "owner", repo: "repo", sha: "abcdef1" },
        "token",
        vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("nope", { status: 500 })),
      ),
    ).resolves.toEqual({ title: null, state: null });

    await expect(
      __testing.fetchEntityLiveFields(
        "commit",
        { kind: "sha", owner: "owner", repo: "repo", sha: "abcdef1" },
        "token",
        vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ commit: {} })),
      ),
    ).resolves.toEqual({ title: null, state: null });
  });

  it("returns empty live fields when fetch fails or entity type has no live endpoint", async () => {
    const nonOkFetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("nope", { status: 404 }));
    await expect(
      __testing.fetchEntityLiveFields(
        "issue",
        { kind: "numeric", owner: "owner", repo: "repo", number: 1 },
        "token",
        nonOkFetcher,
      ),
    ).resolves.toEqual({ title: null, state: null });

    const throwingFetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("network down"));
    await expect(
      __testing.fetchEntityLiveFields(
        "pull_request",
        { kind: "numeric", owner: "owner", repo: "repo", number: 1 },
        "token",
        throwingFetcher,
      ),
    ).resolves.toEqual({ title: null, state: null });

    const unusedFetcher = vi.fn<typeof fetch>();
    await expect(
      __testing.fetchEntityLiveFields(
        "discussion",
        { kind: "numeric", owner: "owner", repo: "repo", number: 1 },
        "token",
        unusedFetcher,
      ),
    ).resolves.toEqual({ title: null, state: null });
    expect(unusedFetcher).not.toHaveBeenCalled();
  });
});

describe("resolveChatGithubEntity", () => {
  it("materializes persisted PR and issue lifecycle state without live fetches", () => {
    expect(
      materializeChatGithubEntity({
        entityType: "pull_request",
        entityKey: "owner/repo#12",
        boundVia: "direct",
        entityState: "draft",
      }),
    ).toMatchObject({
      entityType: "pull_request",
      entityKey: "owner/repo#12",
      state: "draft",
      title: null,
      number: 12,
    });
    expect(
      materializeChatGithubEntity({
        entityType: "issue",
        entityKey: "owner/repo#13",
        boundVia: "direct",
        entityState: "merged",
      }),
    ).toMatchObject({
      entityType: "issue",
      entityKey: "owner/repo#13",
      state: null,
      number: 13,
    });
    expect(__testing.stateFromPersistedEntityState("pull_request", "open")).toBe("open");
    expect(__testing.stateFromPersistedEntityState("pull_request", "closed")).toBe("closed");
    expect(__testing.stateFromPersistedEntityState("pull_request", "merged")).toBe("merged");
    expect(__testing.stateFromPersistedEntityState("pull_request", "unknown")).toBeNull();
    expect(__testing.stateFromPersistedEntityState("issue", "open")).toBe("open");
    expect(__testing.stateFromPersistedEntityState("issue", "queued")).toBeNull();
    expect(__testing.stateFromPersistedEntityState("commit", "open")).toBeNull();
  });

  it("materializes wire entities with optional live fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ title: "Bug", state: "open" }));

    await expect(
      resolveChatGithubEntity(
        { entityType: "issue", entityKey: "owner/repo#12", boundVia: "direct" },
        "token",
        fetcher,
      ),
    ).resolves.toEqual({
      entityType: "issue",
      entityKey: "owner/repo#12",
      boundVia: "direct",
      htmlUrl: "https://github.com/owner/repo/issues/12",
      title: "Bug",
      state: "open",
      number: 12,
    });
  });

  it("does not fetch live fields without a token", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      resolveChatGithubEntity(
        { entityType: "commit", entityKey: "owner/repo@abcdef1", boundVia: "agent_declared" },
        null,
        fetcher,
      ),
    ).resolves.toEqual({
      entityType: "commit",
      entityKey: "owner/repo@abcdef1",
      boundVia: "agent_declared",
      htmlUrl: "https://github.com/owner/repo/commit/abcdef1",
      title: null,
      state: null,
      number: null,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps persisted rows when live resolution cannot reparse the original key", async () => {
    const originalExec = RegExp.prototype.exec;
    const fetcher = vi.fn<typeof fetch>();
    let numericExecCount = 0;
    try {
      RegExp.prototype.exec = function exec(this: RegExp, input: string): RegExpExecArray | null {
        if (input === "owner/repo#12") {
          numericExecCount += 1;
          if (numericExecCount > 1) {
            return ["owner/repo#12", undefined, "repo", "12"] as unknown as RegExpExecArray;
          }
        }
        return originalExec.call(this, input);
      };

      await expect(
        resolveChatGithubEntity(
          { entityType: "issue", entityKey: "owner/repo#12", boundVia: "direct", title: "Persisted" },
          "token",
          fetcher,
        ),
      ).resolves.toMatchObject({
        title: "Persisted",
        state: null,
      });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      RegExp.prototype.exec = originalExec;
    }
  });

  it("materializes legacy discussion rows as canonical numeric keys", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      resolveChatGithubEntity(
        { entityType: "discussion", entityKey: "owner/repo#discussion-9", boundVia: "agent_declared" },
        null,
        fetcher,
      ),
    ).resolves.toEqual({
      entityType: "discussion",
      entityKey: "owner/repo#9",
      boundVia: "agent_declared",
      htmlUrl: "https://github.com/owner/repo/discussions/9",
      title: null,
      state: null,
      number: 9,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unknown entity types, invalid boundVia values, and malformed keys", async () => {
    await expect(
      resolveChatGithubEntity({ entityType: "release", entityKey: "owner/repo#1", boundVia: "direct" }, "token"),
    ).resolves.toBeNull();
    await expect(
      resolveChatGithubEntity({ entityType: "issue", entityKey: "owner/repo#1", boundVia: "manual" }, "token"),
    ).resolves.toBeNull();
    await expect(
      resolveChatGithubEntity({ entityType: "issue", entityKey: "owner/repo@abcdef1", boundVia: "direct" }, "token"),
    ).resolves.toBeNull();
  });
});

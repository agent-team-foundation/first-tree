import { describe, expect, it, vi } from "vitest";
import { GITHUB_API_BASE } from "../services/github-api-base.js";
import { createRepoFile, createUserRepo, GithubApiError, listUserRepos } from "../services/github-oauth.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("github-oauth helpers", () => {
  it("normalizes an overridden GitHub API base URL at module load", async () => {
    const previous = process.env.FIRST_TREE_GITHUB_API_BASE_URL;
    try {
      process.env.FIRST_TREE_GITHUB_API_BASE_URL = "https://github-api.example///";
      vi.resetModules();
      const module = await import("../services/github-api-base.js");
      expect(module.GITHUB_API_BASE).toBe("https://github-api.example");
    } finally {
      if (previous === undefined) {
        delete process.env.FIRST_TREE_GITHUB_API_BASE_URL;
      } else {
        process.env.FIRST_TREE_GITHUB_API_BASE_URL = previous;
      }
      vi.resetModules();
    }
  });

  it("lists user repos across pages and normalizes nullable fields", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, [
          {
            clone_url: "https://github.com/acme/one.git",
            default_branch: "main",
            full_name: "acme/one",
            html_url: "https://github.com/acme/one",
            private: true,
            pushed_at: "2026-07-08T00:00:00Z",
          },
          {
            clone_url: "https://github.com/acme/two.git",
            full_name: "acme/two",
            html_url: "https://github.com/acme/two",
            private: false,
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, [
          {
            clone_url: "https://github.com/acme/three.git",
            default_branch: null,
            full_name: "acme/three",
            html_url: "https://github.com/acme/three",
            private: false,
            pushed_at: null,
          },
        ]),
      );

    const rows = await listUserRepos("token_1", { fetcher: fetcher as never, perPage: 2, maxPages: 3 });

    expect(rows).toEqual([
      {
        cloneUrl: "https://github.com/acme/one.git",
        defaultBranch: "main",
        fullName: "acme/one",
        htmlUrl: "https://github.com/acme/one",
        private: true,
        pushedAt: "2026-07-08T00:00:00Z",
      },
      {
        cloneUrl: "https://github.com/acme/two.git",
        defaultBranch: null,
        fullName: "acme/two",
        htmlUrl: "https://github.com/acme/two",
        private: false,
        pushedAt: null,
      },
      {
        cloneUrl: "https://github.com/acme/three.git",
        defaultBranch: null,
        fullName: "acme/three",
        htmlUrl: "https://github.com/acme/three",
        private: false,
        pushedAt: null,
      },
    ]);
    expect(fetcher.mock.calls[0]?.[0]).toContain("per_page=2&page=1");
    expect(fetcher.mock.calls[1]?.[0]).toContain("per_page=2&page=2");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { Accept: "application/vnd.github+json", Authorization: "Bearer token_1" },
    });
  });

  it("throws GithubApiError for failed repo listing", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(403, { message: "forbidden" }));

    await expect(listUserRepos("token_1", { fetcher: fetcher as never })).rejects.toMatchObject({
      message: "GitHub repo list failed (403)",
      name: "GithubApiError",
      status: 403,
    });
  });

  it("creates user repos and validates GitHub response shape", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(201, {
        clone_url: "https://github.com/acme/new.git",
        default_branch: "main",
        full_name: "acme/new",
        html_url: "https://github.com/acme/new",
        name: "new",
        owner: { login: "acme" },
        private: true,
      }),
    );

    await expect(
      createUserRepo(
        "token_1",
        { description: "Test repo", name: "new", private: true },
        { fetcher: fetcher as never },
      ),
    ).resolves.toEqual({
      cloneUrl: "https://github.com/acme/new.git",
      defaultBranch: "main",
      fullName: "acme/new",
      htmlUrl: "https://github.com/acme/new",
      name: "new",
      ownerLogin: "acme",
      private: true,
    });
    expect(fetcher).toHaveBeenCalledWith(
      `${GITHUB_API_BASE}/user/repos`,
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(JSON.parse((fetcher.mock.calls[0]?.[1] as { body: string }).body)).toEqual({
      auto_init: false,
      description: "Test repo",
      name: "new",
      private: true,
    });

    const invalidFetcher = vi.fn().mockResolvedValue(jsonResponse(201, { name: "new" }));
    await expect(
      createUserRepo("token_1", { name: "new", private: false }, { fetcher: invalidFetcher as never }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("creates repo files with encoded paths and maps upstream failures", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(201, { content: {} }));

    await createRepoFile(
      "token_1",
      {
        branch: "main",
        contentBase64: "SGk=",
        message: "Add doc",
        owner: "acme",
        path: "/docs/Hello World.md",
        repo: "web app",
      },
      { fetcher: fetcher as never },
    );

    expect(fetcher.mock.calls[0]?.[0]).toBe(`${GITHUB_API_BASE}/repos/acme/web%20app/contents/docs/Hello%20World.md`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "PUT",
    });
    expect(JSON.parse((fetcher.mock.calls[0]?.[1] as { body: string }).body)).toEqual({
      branch: "main",
      content: "SGk=",
      message: "Add doc",
    });

    const failingFetcher = vi.fn().mockResolvedValue(jsonResponse(500, { message: "upstream" }));
    await expect(
      createRepoFile(
        "token_1",
        { branch: "main", contentBase64: "SGk=", message: "Add doc", owner: "acme", path: "README.md", repo: "web" },
        { fetcher: failingFetcher as never },
      ),
    ).rejects.toBeInstanceOf(GithubApiError);
  });
});

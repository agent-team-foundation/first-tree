// Minimal stand-in for the GitHub REST endpoints the First Tree server calls
// when a GitHub App is configured. Point the server at it with
// `FIRST_TREE_GITHUB_API_BASE_URL=http://localhost:9000` so a QA run can
// exercise the App-token / repository-catalog paths without a live GitHub App.
//
// It answers only the two endpoints the server actually hits:
//   POST /app/installations/:id/access_tokens  -> a stub installation token
//   GET  /installation/repositories            -> a stub repository catalog
//
// It does NOT verify the app JWT or the installation token — the point is to
// exercise First Tree's request/parse logic, not GitHub's auth. Everything
// returned here is canned, non-sensitive test data.
//
// Usage: node mock-github-api.mjs [port]   (port also reads MOCK_PORT, default 9000)

import http from "node:http";

const port = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 9000);

// Canned catalog returned by GET /installation/repositories (page 1). Shaped
// exactly like GitHub's `{ total_count, repositories: [...] }` envelope.
const REPOSITORIES = [
  {
    full_name: "acme-org/backend",
    clone_url: "https://github.com/acme-org/backend.git",
    html_url: "https://github.com/acme-org/backend",
    private: true,
    default_branch: "main",
    pushed_at: "2026-07-14T10:00:00Z",
  },
  {
    full_name: "acme-org/frontend",
    clone_url: "https://github.com/acme-org/frontend.git",
    html_url: "https://github.com/acme-org/frontend",
    private: false,
    default_branch: "main",
    pushed_at: "2026-07-13T09:00:00Z",
  },
];

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  response.setHeader("content-type", "application/json");

  if (request.method === "POST" && /\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) {
    response.statusCode = 201;
    response.end(
      JSON.stringify({
        token: "ghs_mockinstalltoken_xyz",
        expires_at: "2030-01-01T00:00:00Z",
        permissions: { contents: "read", metadata: "read" },
        repository_selection: "selected",
      }),
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/installation/repositories") {
    const page = Number(url.searchParams.get("page") ?? "1");
    response.statusCode = 200;
    response.end(
      JSON.stringify(
        page > 1
          ? { total_count: REPOSITORIES.length, repositories: [] }
          : { total_count: REPOSITORIES.length, repositories: REPOSITORIES },
      ),
    );
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ message: `mock: unhandled ${request.method} ${url.pathname}` }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`mock github api listening on :${port}`);
});

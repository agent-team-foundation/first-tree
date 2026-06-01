import { createHmac, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * `github-mock` — a self-contained fastify server that stands in for both
 * sides of the First Tree ↔ GitHub interaction during an e2e run:
 *
 *   1. **Inbound to First Tree**: drives the server's `/api/v1/webhooks/github-app`
 *      handler via `POST /__emit/:event` — payloads are signed in-process
 *      with the e2e run's webhook secret so the server's HMAC verification
 *      accepts them as if GitHub itself had delivered.
 *
 *   2. **Outbound from First Tree**: serves a minimal `/api/*` surface. The server
 *      reaches it via `FIRST_TREE_GITHUB_API_BASE_URL` (F3 — landed in
 *      M1). M2 only wires the webhook direction, so the proxy currently
 *      returns 404 by default — endpoints get stubbed lazily as the test
 *      suite needs them (e.g. installation access tokens for PR-event
 *      delivery in a later test).
 *
 * Tests instantiate one mock per test file via `startGithubMock()`. The
 * mock binds to an ephemeral port; the test reads `mock.baseUrl` for
 * server-env injection and `mock.emit(...)` to drive webhooks. Per-test
 * isolation is by design — there is exactly one webhook secret per run, so
 * sharing a global mock would just hide intent.
 */

export type EmitOptions = {
  /** Optional X-GitHub-Delivery override. Default: a fresh uuid each call. */
  deliveryId?: string;
};

export type EmitResult = {
  status: number;
  body: unknown;
  deliveryId: string;
};

export type GitHubMock = {
  baseUrl: string;
  port: number;
  emit: (eventType: string, payload: unknown, opts?: EmitOptions) => Promise<EmitResult>;
  stop: () => Promise<void>;
  /** Underlying fastify — exposed for tests that want to stub extra `/api/*` routes. */
  fastify: FastifyInstance;
};

export type GitHubMockOptions = {
  /** First Tree server base URL — the mock POSTs webhooks to `${serverBaseUrl}/api/v1/webhooks/github-app`. */
  serverBaseUrl: string;
  /** HMAC secret the server validates against. Must equal the server's `FIRST_TREE_GITHUB_APP_WEBHOOK_SECRET`. */
  webhookSecret: string;
  /** Bind port. Default: 0 (ephemeral, OS-assigned). */
  port?: number;
};

const WEBHOOK_PATH = "/api/v1/webhooks/github-app";

export async function startGithubMock(opts: GitHubMockOptions): Promise<GitHubMock> {
  const app = Fastify({ logger: false });

  // Default proxy behaviour: any /api/* call from the First Tree server lands here.
  // Returning 404 is informative — tests that need a real stub register a
  // route on `mock.fastify` BEFORE the relevant action triggers the call.
  app.get("/api/*", async (request, reply) => {
    return reply.status(404).send({
      error: "github-mock: no stub for this GitHub REST endpoint",
      url: request.url,
      hint: "register a route on mock.fastify if your test exercises this path",
    });
  });
  app.post("/api/*", async (request, reply) => {
    return reply.status(404).send({
      error: "github-mock: no stub for this GitHub REST endpoint",
      url: request.url,
      hint: "register a route on mock.fastify if your test exercises this path",
    });
  });

  await app.listen({ port: opts.port ?? 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("github-mock failed to obtain a listen port");
  }
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function emit(eventType: string, payload: unknown, emitOpts: EmitOptions = {}): Promise<EmitResult> {
    const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
    const signature = `sha256=${createHmac("sha256", opts.webhookSecret).update(rawBody).digest("hex")}`;
    const deliveryId = emitOpts.deliveryId ?? randomUUID();

    const res = await fetch(`${opts.serverBaseUrl}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": eventType,
        "X-GitHub-Delivery": deliveryId,
        "X-Hub-Signature-256": signature,
      },
      body: rawBody,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as raw text
    }
    return { status: res.status, body: parsed, deliveryId };
  }

  async function stop(): Promise<void> {
    await app.close();
  }

  return { baseUrl, port, emit, stop, fastify: app };
}

import { request as httpRequest } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installExpectedServerAuthorityGate } from "../middleware/expected-server-authority.js";

const EXPECTED_AUTHORITY = "https://s1.example/api/v1";
const REQUEST_BODY = '{"secret":"must-not-cross-the-gate"}';
const TEST_MEDIA_TYPE = "application/x-first-tree-authority-test";

type RawResponse = Readonly<{
  body: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  statusCode: number;
}>;

describe("expected server authority request gate", () => {
  let app: FastifyInstance;
  let port = 0;
  let authCalls = 0;
  let bodyParserCalls = 0;
  let handlerCalls = 0;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    installExpectedServerAuthorityGate(app, EXPECTED_AUTHORITY);

    app.addHook("onRequest", (request, reply, done) => {
      authCalls += 1;
      if (request.headers.authorization !== "Bearer accepted") {
        void reply.status(401).send({ error: "Unauthorized" });
        return;
      }
      done();
    });

    app.addContentTypeParser(TEST_MEDIA_TYPE, { parseAs: "string" }, (_request, body, done) => {
      bodyParserCalls += 1;
      done(null, body);
    });

    app.post("/protected", async (request) => {
      handlerCalls += 1;
      return { body: request.body };
    });

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Fastify test server did not bind an IPv4 port");
    }
    port = address.port;
  });

  beforeEach(() => {
    authCalls = 0;
    bodyParserCalls = 0;
    handlerCalls = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  function send(rawAuthorityHeaders: readonly string[], authorization = "Bearer accepted"): Promise<RawResponse> {
    const headers = [
      "Host",
      `127.0.0.1:${port}`,
      "Authorization",
      authorization,
      "Content-Type",
      TEST_MEDIA_TYPE,
      "Content-Length",
      String(Buffer.byteLength(REQUEST_BODY)),
      ...rawAuthorityHeaders,
    ];

    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          agent: false,
          headers,
          host: "127.0.0.1",
          method: "POST",
          path: "/protected",
          port,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("error", reject);
          response.once("end", () => {
            resolve({
              body: Buffer.concat(chunks).toString("utf8"),
              headers: response.headers,
              statusCode: response.statusCode ?? 0,
            });
          });
        },
      );
      request.once("error", reject);
      request.end(REQUEST_BODY);
    });
  }

  function expectRejectedBeforeSensitiveWork(response: RawResponse): void {
    expect(response.statusCode).toBe(421);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(response.body)).toEqual({ error: "Server authority mismatch" });
    expect(authCalls).toBe(0);
    expect(bodyParserCalls).toBe(0);
    expect(handlerCalls).toBe(0);
  }

  it("allows a non-Web client when the expected-authority header is absent", async () => {
    const response = await send([]);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ body: REQUEST_BODY });
    expect(authCalls).toBe(1);
    expect(bodyParserCalls).toBe(1);
    expect(handlerCalls).toBe(1);
  });

  it("allows exactly one byte-exact canonical authority", async () => {
    const response = await send(["X-First-Tree-Expected-Authority", EXPECTED_AUTHORITY]);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ body: REQUEST_BODY });
    expect(authCalls).toBe(1);
    expect(bodyParserCalls).toBe(1);
    expect(handlerCalls).toBe(1);
  });

  it("rejects duplicate raw authority fields before auth or body parsing", async () => {
    const response = await send(
      ["X-First-Tree-Expected-Authority", EXPECTED_AUTHORITY, "x-first-tree-expected-authority", EXPECTED_AUTHORITY],
      "Bearer must-not-be-read",
    );

    expectRejectedBeforeSensitiveWork(response);
  });

  it("rejects a malformed authority before auth or body parsing", async () => {
    const response = await send(
      ["X-First-Tree-Expected-Authority", "not-an-absolute-authority"],
      "Bearer must-not-be-read",
    );

    expectRejectedBeforeSensitiveWork(response);
  });

  it("rejects another canonical server before auth or body parsing", async () => {
    const response = await send(
      ["X-First-Tree-Expected-Authority", "https://s2.example/api/v1"],
      "Bearer must-not-be-read",
    );

    expectRejectedBeforeSensitiveWork(response);
  });
});

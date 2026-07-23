import { canonicalizeServerAuthority, EXPECTED_SERVER_AUTHORITY_HEADER } from "@first-tree/shared/config";
import type { FastifyInstance } from "fastify";

const AUTHORITY_MISMATCH_BODY = Object.freeze({ error: "Server authority mismatch" });

type RawAuthorityHeader = Readonly<{
  count: number;
  value: string | undefined;
}>;

function readRawExpectedAuthority(rawHeaders: readonly string[]): RawAuthorityHeader {
  let count = 0;
  let value: string | undefined;

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    if (name?.toLowerCase() !== EXPECTED_SERVER_AUTHORITY_HEADER) continue;

    count += 1;
    value = rawHeaders[index + 1];
  }

  return { count, value };
}

/**
 * Reject a Web request pinned to another server before authentication, body
 * parsing, or route handling can observe its credentials or payload.
 *
 * Header absence remains valid for non-Web clients. Presence is strict:
 * exactly one raw occurrence must byte-match this server's canonical
 * authority. Reading `rawHeaders` is intentional because Node's normalized
 * header map can coalesce duplicates into one comma-delimited value.
 */
export function installExpectedServerAuthorityGate(app: FastifyInstance, configuredAuthority: string): void {
  const expectedAuthority = canonicalizeServerAuthority(configuredAuthority);
  if (expectedAuthority !== configuredAuthority) {
    throw new Error("Configured server authority must be canonical before installing the request gate");
  }

  app.addHook("onRequest", function expectedServerAuthorityGate(request, reply, done) {
    const supplied = readRawExpectedAuthority(request.raw.rawHeaders);
    if (supplied.count === 0) {
      done();
      return;
    }

    if (supplied.count !== 1 || supplied.value !== expectedAuthority) {
      void reply.status(421).header("cache-control", "no-store").send(AUTHORITY_MISMATCH_BODY);
      return;
    }

    done();
  });
}

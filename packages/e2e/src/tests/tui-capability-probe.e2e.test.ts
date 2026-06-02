import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CurrentRunHandle, readCredentialsOrThrow, readCurrentHandle } from "../framework/current-handle.js";

/**
 * tui-capability-probe — the TUI-mode daemon spawned by globalSetup reports
 * `claude-code-tui: ok` back to the server. This is the gate that lets the
 * web UI offer the TUI runtime when creating an agent against this client.
 *
 * Why this lives in the TUI suite vs the SDK suite: the daemon's capabilities
 * include all providers it probed (claude-code SDK + claude-code-tui + codex).
 * We only get a meaningful `claude-code-tui: ok` when the daemon was spawned
 * with the fake-tui binary on CLAUDE_CODE_EXECUTABLE — the default SDK spawn
 * has no real `claude` on PATH inside the test env, so the TUI probe reports
 * `missing` there.
 *
 * Asserts the row directly via PG (capabilities live on `clients.metadata`),
 * not via the public HTTP surface, because the read API for the metadata blob
 * isn't a stable user-facing contract.
 */

let handle: CurrentRunHandle;
let pg: PgClient;

beforeAll(async () => {
  handle = readCurrentHandle();
  pg = new PgClient({ connectionString: handle.databaseUrl });
  await pg.connect();
});

afterAll(async () => {
  await pg.end().catch(() => undefined);
});

describe("tui-capability-probe — daemon reports claude-code-tui as available", () => {
  it("clients.metadata.capabilities['claude-code-tui'] is state=ok within probe window", async () => {
    const creds = readCredentialsOrThrow(handle);

    // Capabilities are reported asynchronously on daemon startup; poll PG up
    // to 30s so we don't race the first PATCH. The daemon write lands well
    // within that window in practice (sub-second).
    const deadline = Date.now() + 30_000;
    let metadata: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      const res = await pg.query<{ metadata: Record<string, unknown> | null }>(
        "SELECT metadata FROM clients WHERE id = $1 LIMIT 1",
        [creds.clientId],
      );
      metadata = res.rows[0]?.metadata ?? null;
      const capabilities = (metadata?.capabilities as Record<string, { state: string }> | undefined) ?? undefined;
      if (capabilities?.["claude-code-tui"]) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(metadata).not.toBeNull();
    const capabilities = (metadata?.capabilities as Record<string, { state: string; authMethod: string }>) ?? {};
    expect(capabilities["claude-code-tui"]).toBeDefined();
    expect(capabilities["claude-code-tui"]?.state).toBe("ok");
    // Auth detection picks up `ANTHROPIC_API_KEY` from clientExtraEnv —
    // confirms the env wiring works end-to-end.
    expect(capabilities["claude-code-tui"]?.authMethod).toBe("api_key");
  });
});

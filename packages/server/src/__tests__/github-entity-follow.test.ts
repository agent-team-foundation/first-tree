import { generateKeyPairSync, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { BadRequestError, NotFoundError, ServiceUnavailableError, UnprocessableError } from "../errors.js";
import { bindInstallationToOrg, upsertInstallationFromMetadata } from "../services/github-app-installations.js";
import {
  declareEntityFollow,
  type FollowDeps,
  listChatGithubEntities,
  parseEntityReference,
  removeEntityFollow,
} from "../services/github-entity-follow.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

type App = ReturnType<ReturnType<typeof useTestApp>>;

/**
 * Explicit follow / unfollow — the only agent-side wiring path after the
 * session-event auto-binder removal. Covers the robustness matrix rows that
 * live at the service layer: R1 (idempotent re-follow), R2 (PK arbitration →
 * 409), R4 (idempotent unfollow), R7 (GitHub down → 503, no blind write),
 * R8/R9 (canonical key normalization), R10 (unfollow severs all rows),
 * R11 (terminal entities followable), R13 (rebind rewrites bound_via).
 */
describe("github-entity-follow", () => {
  const getApp = useTestApp();

  let appId: string;
  let privateKeyPem: string;
  beforeAll(() => {
    appId = "424242";
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    privateKeyPem = privateKey;
  });

  async function seedAgent(app: App, orgId: string, memberId: string, type: "agent" | "human"): Promise<string> {
    const uuid = randomUUID();
    await app.db.insert(agents).values({
      uuid,
      name: `${type}-${uuid.slice(0, 8)}`,
      organizationId: orgId,
      type,
      displayName: type,
      inboxId: `inbox_${uuid}`,
      managerId: memberId,
      status: "active",
    });
    return uuid;
  }

  async function seedChat(app: App, orgId: string): Promise<string> {
    const id = `chat_${randomUUID()}`;
    await app.db.insert(chats).values({ id, organizationId: orgId, type: "group", metadata: {} });
    return id;
  }

  async function seedInstallation(app: App, orgId: string): Promise<void> {
    const [existing] = await app.db
      .select({ installationId: githubAppInstallations.installationId })
      .from(githubAppInstallations)
      .where(eq(githubAppInstallations.hubOrganizationId, orgId))
      .limit(1);
    if (existing) return;

    const githubAccountId = Math.floor(Math.random() * 1_000_000_000) + 1;
    const row = await upsertInstallationFromMetadata(app.db, {
      installation: {
        id: Math.floor(Math.random() * 1_000_000) + 1,
        accountType: "Organization",
        accountLogin: `acme-${githubAccountId}`,
        accountGithubId: githubAccountId,
        permissions: { contents: "read" },
        events: ["pull_request", "issues"],
        suspendedAt: null,
      },
    });
    await bindInstallationToOrg(app.db, row.installationId, orgId);
  }

  /**
   * Fake GitHub API: routes the token mint plus per-path GET responses.
   * `routes` maps a path substring (after the API base) to a responder.
   */
  function makeFetcher(routes: Record<string, () => Response>): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: "ghs_test_token",
            expires_at: "2099-01-01T00:00:00Z",
            permissions: { contents: "read" },
            repository_selection: "selected",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      // Case-insensitive match: the service's second hop uses the canonical
      // `full_name` casing returned by the repo route (e.g. `Acme/Api`),
      // while route keys are written in the caller's lowercase form.
      const lowerUrl = url.toLowerCase();
      for (const [needle, responder] of Object.entries(routes)) {
        if (lowerUrl.includes(needle.toLowerCase())) return responder();
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }) as typeof fetch;
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  function deps(fetcher: typeof fetch): FollowDeps {
    return { appCredentials: { appId, privateKeyPem }, fetcher };
  }

  /** Standard happy-path fetcher: repo canonicalises to `Acme/Api`, #42 is an open PR. */
  function prFetcher(overrides: Record<string, () => Response> = {}): typeof fetch {
    return makeFetcher({
      "/repos/acme/api/issues/42": () =>
        json({
          number: 42,
          state: "open",
          title: "Add follow command",
          html_url: "https://github.com/Acme/Api/pull/42",
          pull_request: { merged_at: null },
          draft: false,
        }),
      "/repos/acme/api/pulls/42": () =>
        json({
          number: 42,
          state: "open",
          title: "Add follow command",
          html_url: "https://github.com/Acme/Api/pull/42",
          merged: false,
          draft: false,
        }),
      "/repos/acme/api": () => json({ full_name: "Acme/Api" }),
      ...overrides,
    });
  }

  async function setup(app: App) {
    const admin = await createTestAdmin(app, { username: `u-${randomUUID().slice(0, 8)}` });
    const human = await seedAgent(app, admin.organizationId, admin.memberId, "human");
    const delegate = await seedAgent(app, admin.organizationId, admin.memberId, "agent");
    const chatId = await seedChat(app, admin.organizationId);
    await seedInstallation(app, admin.organizationId);
    return { admin, human, delegate, chatId };
  }

  function followParams(s: Awaited<ReturnType<typeof setup>>, entity: string, rebind = false) {
    return {
      chatId: s.chatId,
      organizationId: s.admin.organizationId,
      humanAgentId: s.human,
      delegateAgentId: s.delegate,
      boundVia: "agent_declared" as const,
      entity,
      rebind,
    };
  }

  describe("parseEntityReference", () => {
    it("parses URL and short forms", () => {
      expect(parseEntityReference("https://github.com/o/r/pull/7")).toEqual({
        kind: "numeric",
        owner: "o",
        repo: "r",
        number: 7,
        explicitType: "pull_request",
      });
      expect(parseEntityReference("https://github.com/o/r/issues/8?tab=1")).toMatchObject({
        explicitType: "issue",
        number: 8,
      });
      expect(parseEntityReference("https://github.com/o/r/discussions/9")).toMatchObject({
        explicitType: "discussion",
      });
      expect(parseEntityReference("https://github.com/o/r/commit/3F2A91C0")).toEqual({
        kind: "commit",
        owner: "o",
        repo: "r",
        sha: "3f2a91c0",
      });
      expect(parseEntityReference("o/r#42")).toMatchObject({ kind: "numeric", explicitType: null, number: 42 });
      expect(parseEntityReference("o/r@abcdef1")).toMatchObject({ kind: "commit", sha: "abcdef1" });
    });

    it("rejects garbage", () => {
      expect(parseEntityReference("not-an-entity")).toBeNull();
      expect(parseEntityReference("https://github.com/o/r")).toBeNull();
      expect(parseEntityReference("o/r#abc")).toBeNull();
    });
  });

  it("follows a short-form entity: discriminates PR vs issue and canonicalises the key (R8/R9)", async () => {
    const app = getApp();
    const s = await setup(app);

    const result = await declareEntityFollow(app.db, deps(prFetcher()), followParams(s, "acme/api#42"));
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.entity.entityType).toBe("pull_request");
    // Canonical `full_name` casing from the API, not the caller's input.
    expect(result.entity.entityKey).toBe("Acme/Api#42");

    const rows = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, s.chatId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.boundVia).toBe("agent_declared");
    expect(rows[0]?.entityState).toBe("open");
  });

  it("R1: re-following the same entity in the same chat is idempotent", async () => {
    const app = getApp();
    const s = await setup(app);

    await declareEntityFollow(app.db, deps(prFetcher()), followParams(s, "acme/api#42"));
    // Different spelling of the same entity converges on the same row.
    const again = await declareEntityFollow(
      app.db,
      deps(prFetcher()),
      followParams(s, "https://github.com/ACME/API/pull/42"),
    );
    expect(again.outcome).toBe("already_following");

    const rows = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, s.chatId));
    expect(rows).toHaveLength(1);
  });

  it("R2: the same line in a second chat conflicts with the winner's chat info", async () => {
    const app = getApp();
    const s = await setup(app);
    const otherChat = await seedChat(app, s.admin.organizationId);
    await app.db.update(chats).set({ topic: "first home" }).where(eq(chats.id, s.chatId));

    await declareEntityFollow(app.db, deps(prFetcher()), followParams(s, "acme/api#42"));
    const conflict = await declareEntityFollow(app.db, deps(prFetcher()), {
      ...followParams(s, "acme/api#42"),
      chatId: otherChat,
    });
    expect(conflict.outcome).toBe("conflict");
    if (conflict.outcome !== "conflict") throw new Error("unreachable");
    expect(conflict.conflict.chatId).toBe(s.chatId);
    expect(conflict.conflict.topic).toBe("first home");
  });

  it("R13: rebind moves the line and rewrites bound_via to the declared value", async () => {
    const app = getApp();
    const s = await setup(app);
    const newChat = await seedChat(app, s.admin.organizationId);

    // Seed the existing row as a github-minted `direct` anchor.
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: s.admin.organizationId,
      humanAgentId: s.human,
      delegateAgentId: s.delegate,
      entityType: "pull_request",
      entityKey: "Acme/Api#42",
      chatId: s.chatId,
      boundVia: "direct",
    });

    const rebound = await declareEntityFollow(app.db, deps(prFetcher()), {
      ...followParams(s, "acme/api#42", true),
      chatId: newChat,
    });
    expect(rebound.outcome).toBe("rebound");

    const rows = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(
        and(
          eq(githubEntityChatMappings.organizationId, s.admin.organizationId),
          eq(githubEntityChatMappings.entityKey, "Acme/Api#42"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.chatId).toBe(newChat);
    // The moved row no longer impersonates a github-minted anchor.
    expect(rows[0]?.boundVia).toBe("agent_declared");
    // The pre-0067 row had no title; follow-time resolution fetched it, so the
    // moved row must now carry it instead of waiting for a webhook.
    expect(rows[0]?.title).toBe("Add follow command");
  });

  it("rebind moves a legacy discussion row instead of inserting a duplicate canonical row", async () => {
    const app = getApp();
    const s = await setup(app);
    const newChat = await seedChat(app, s.admin.organizationId);
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: s.admin.organizationId,
      humanAgentId: s.human,
      delegateAgentId: s.delegate,
      entityType: "discussion",
      entityKey: "Acme/Api#discussion-42",
      chatId: s.chatId,
      boundVia: "direct",
    });
    const fetcher = makeFetcher({
      // The discussion route must precede the repo route: makeFetcher matches
      // by substring, and `/repos/acme/api` is a prefix of the discussion URL,
      // so the less-specific repo route would otherwise shadow it (and strip
      // the title). Real GitHub has no such ambiguity.
      "/repos/Acme/Api/discussions/42": () =>
        json({
          number: 42,
          state: "open",
          title: "RFC",
          html_url: "https://github.com/Acme/Api/discussions/42",
        }),
      "/repos/acme/api": () => json({ full_name: "Acme/Api" }),
    });

    const rebound = await declareEntityFollow(app.db, deps(fetcher), {
      ...followParams(s, "https://github.com/acme/api/discussions/42", true),
      chatId: newChat,
    });
    expect(rebound.outcome).toBe("rebound");

    const rows = await app.db
      .select({
        entityKey: githubEntityChatMappings.entityKey,
        chatId: githubEntityChatMappings.chatId,
        title: githubEntityChatMappings.title,
      })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityType, "discussion"));
    // The legacy key (`#discussion-42`) is matched by the candidate-key title
    // refresh, so the moved row carries the follow-time title — not just when a
    // future webhook happens to touch it.
    expect(rows).toEqual([{ entityKey: "Acme/Api#discussion-42", chatId: newChat, title: "RFC" }]);
  });

  it("R11: a merged PR is followable and its terminal state is recorded", async () => {
    const app = getApp();
    const s = await setup(app);
    const fetcher = prFetcher({
      "/repos/acme/api/issues/42": () =>
        json({
          number: 42,
          state: "closed",
          title: "Add follow command",
          html_url: "https://github.com/Acme/Api/pull/42",
          pull_request: { merged_at: "2026-06-01T00:00:00Z" },
        }),
      "/repos/acme/api/pulls/42": () =>
        json({
          number: 42,
          state: "closed",
          title: "Add follow command",
          html_url: "https://github.com/Acme/Api/pull/42",
          merged: true,
          draft: false,
        }),
    });

    const result = await declareEntityFollow(app.db, deps(fetcher), followParams(s, "acme/api#42"));
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.entity.state).toBe("merged");

    const [row] = await app.db
      .select({ entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, s.chatId));
    expect(row?.entityState).toBe("merged");
  });

  it("records draft PR state on follow", async () => {
    const app = getApp();
    const s = await setup(app);
    const fetcher = prFetcher({
      "/repos/acme/api/issues/42": () =>
        json({
          number: 42,
          state: "open",
          title: "Draft follow command",
          html_url: "https://github.com/Acme/Api/pull/42",
          pull_request: { merged_at: null },
        }),
      "/repos/acme/api/pulls/42": () =>
        json({
          number: 42,
          state: "open",
          title: "Draft follow command",
          html_url: "https://github.com/Acme/Api/pull/42",
          merged: false,
          draft: true,
        }),
    });

    const result = await declareEntityFollow(app.db, deps(fetcher), followParams(s, "acme/api#42"));
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.entity.state).toBe("draft");

    const [row] = await app.db
      .select({ entityState: githubEntityChatMappings.entityState })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, s.chatId));
    expect(row?.entityState).toBe("draft");
  });

  it("follows a commit URL and stores the full sha with its first-line title", async () => {
    const app = getApp();
    const s = await setup(app);
    const fullSha = "3f2a91c0aaaabbbbccccddddeeeeffff00001111";
    const fetcher = makeFetcher({
      "/repos/Acme/Api/commits/3f2a91c0": () =>
        json({
          sha: fullSha,
          html_url: `https://github.com/Acme/Api/commit/${fullSha}`,
          commit: { message: "Fix inbox routing\n\nLonger body" },
        }),
      "/repos/acme/api": () => json({ full_name: "Acme/Api" }),
    });

    const result = await declareEntityFollow(
      app.db,
      deps(fetcher),
      followParams(s, "https://github.com/acme/api/commit/3F2A91C0"),
    );

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.entity).toMatchObject({
      entityType: "commit",
      entityKey: `Acme/Api@${fullSha}`,
      htmlUrl: `https://github.com/Acme/Api/commit/${fullSha}`,
      title: "Fix inbox routing",
      state: null,
      number: null,
    });

    const [row] = await app.db
      .select({
        entityType: githubEntityChatMappings.entityType,
        entityKey: githubEntityChatMappings.entityKey,
        title: githubEntityChatMappings.title,
        entityState: githubEntityChatMappings.entityState,
      })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, s.chatId));
    expect(row).toEqual({
      entityType: "commit",
      entityKey: `Acme/Api@${fullSha}`,
      title: "Fix inbox routing",
      entityState: "open",
    });
  });

  it("allows commit payloads without a commit object and falls back to a null title", async () => {
    const app = getApp();
    const s = await setup(app);
    const fullSha = "3f2a91c0aaaabbbbccccddddeeeeffff00001111";
    const fetcher = makeFetcher({
      "/repos/Acme/Api/commits/3f2a91c0": () =>
        json({
          sha: fullSha,
          html_url: `https://github.com/Acme/Api/commit/${fullSha}`,
          commit: null,
        }),
      "/repos/acme/api": () => json({ full_name: "Acme/Api" }),
    });

    const result = await declareEntityFollow(
      app.db,
      deps(fetcher),
      followParams(s, "https://github.com/acme/api/commit/3F2A91C0"),
    );

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.entity.title).toBeNull();
  });

  it("falls back to a null live state when GitHub returns an unexpected PR state", async () => {
    const app = getApp();
    const s = await setup(app);
    const fetcher = prFetcher({
      "/repos/acme/api/pulls/42": () =>
        json({
          number: 42,
          state: "queued",
          title: "Odd state",
          html_url: "https://github.com/Acme/Api/pull/42",
          merged: false,
          draft: false,
        }),
    });

    const result = await declareEntityFollow(app.db, deps(fetcher), followParams(s, "acme/api#42"));

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.entity.state).toBeNull();
  });

  it("an issue without a pull_request block resolves to entityType issue", async () => {
    const app = getApp();
    const s = await setup(app);
    const fetcher = prFetcher({
      "/repos/acme/api/issues/42": () =>
        json({ number: 42, state: "open", title: "Bug", html_url: "https://github.com/Acme/Api/issues/42" }),
    });

    const result = await declareEntityFollow(app.db, deps(fetcher), followParams(s, "acme/api#42"));
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.entity.entityType).toBe("issue");
  });

  it("does not fall back to discussions when an explicit issue URL misses", async () => {
    const app = getApp();
    const s = await setup(app);
    const discussionProbe = vi.fn(() => json({ number: 42 }, 200));
    const fetcher = makeFetcher({
      "/repos/acme/api/issues/42": () => json({ message: "Not Found" }, 404),
      "/repos/Acme/Api/discussions/42": discussionProbe,
      "/repos/acme/api": () => json({ full_name: "Acme/Api" }),
    });

    await expect(
      declareEntityFollow(app.db, deps(fetcher), followParams(s, "https://github.com/acme/api/issues/42")),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(discussionProbe).not.toHaveBeenCalled();
  });

  it("422: no installation for the org", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `u-${randomUUID().slice(0, 8)}` });
    const human = await seedAgent(app, admin.organizationId, admin.memberId, "human");
    const delegate = await seedAgent(app, admin.organizationId, admin.memberId, "agent");
    const chatId = await seedChat(app, admin.organizationId);

    await expect(
      declareEntityFollow(app.db, deps(prFetcher()), {
        chatId,
        organizationId: admin.organizationId,
        humanAgentId: human,
        delegateAgentId: delegate,
        boundVia: "agent_declared",
        entity: "acme/api#42",
        rebind: false,
      }),
    ).rejects.toBeInstanceOf(UnprocessableError);
  });

  it("422: the installation cannot see the repo", async () => {
    const app = getApp();
    const s = await setup(app);
    const fetcher = makeFetcher({
      "/repos/acme/api": () => json({ message: "Not Found" }, 404),
    });
    await expect(declareEntityFollow(app.db, deps(fetcher), followParams(s, "acme/api#42"))).rejects.toBeInstanceOf(
      UnprocessableError,
    );
  });

  it("503: installation token mint failure is retryable and writes no mapping", async () => {
    const app = getApp();
    const s = await setup(app);
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/access_tokens")) {
        return json({ message: "server error" }, 500);
      }
      return json({ message: "unexpected" }, 500);
    }) as typeof fetch;

    await expect(declareEntityFollow(app.db, deps(fetcher), followParams(s, "acme/api#42"))).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    const rows = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, s.chatId));
    expect(rows).toHaveLength(0);
  });

  it("R7 / 503: GitHub down → no blind write, nothing persisted", async () => {
    const app = getApp();
    const s = await setup(app);
    const fetcher = makeFetcher({
      "/repos/acme/api": () => json({ message: "boom" }, 502),
    });

    await expect(declareEntityFollow(app.db, deps(fetcher), followParams(s, "acme/api#42"))).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    const rows = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, s.chatId));
    expect(rows).toHaveLength(0);
  });

  it("R7 / 503: GitHub rate-limit and network failures are retryable without writes", async () => {
    const app = getApp();
    const rateLimited = await setup(app);
    const rateLimitedFetcher = makeFetcher({
      "/repos/acme/api": () =>
        new Response(JSON.stringify({ message: "rate limited" }), {
          status: 403,
          headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" },
        }),
    });

    await expect(
      declareEntityFollow(app.db, deps(rateLimitedFetcher), followParams(rateLimited, "acme/api#42")),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);

    const networkFetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/access_tokens")) {
        return json({
          token: "ghs_test_token",
          expires_at: "2099-01-01T00:00:00Z",
          permissions: { contents: "read" },
          repository_selection: "selected",
        });
      }
      throw new Error("network down");
    }) as typeof fetch;

    await expect(
      declareEntityFollow(app.db, deps(networkFetcher), followParams(rateLimited, "acme/api#42")),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);

    const rows = await app.db
      .select()
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "Acme/Api#42"));
    expect(rows).toHaveLength(0);
  });

  it("404: entity number does not exist (issues + discussions both miss)", async () => {
    const app = getApp();
    const s = await setup(app);
    const fetcher = makeFetcher({
      "/repos/acme/api/issues/42": () => json({ message: "Not Found" }, 404),
      "/repos/Acme/Api/discussions/42": () => json({ message: "Not Found" }, 404),
      "/repos/acme/api": () => json({ full_name: "Acme/Api" }),
    });
    await expect(declareEntityFollow(app.db, deps(fetcher), followParams(s, "acme/api#42"))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("rejects an unparseable reference with 400", async () => {
    const app = getApp();
    const s = await setup(app);
    await expect(
      declareEntityFollow(app.db, deps(prFetcher()), followParams(s, "what-is-this")),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(removeEntityFollow(app.db, { chatId: s.chatId, entity: "what-is-this" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it("R4: unfollow is idempotent — removed: 0 on a non-followed entity, repeatable", async () => {
    const app = getApp();
    const s = await setup(app);

    await expect(removeEntityFollow(app.db, { chatId: s.chatId, entity: "acme/api#42" })).resolves.toEqual({
      removed: 0,
    });

    await declareEntityFollow(app.db, deps(prFetcher()), followParams(s, "acme/api#42"));
    await expect(removeEntityFollow(app.db, { chatId: s.chatId, entity: "acme/api#42" })).resolves.toEqual({
      removed: 1,
    });
    await expect(removeEntityFollow(app.db, { chatId: s.chatId, entity: "acme/api#42" })).resolves.toEqual({
      removed: 0,
    });
  });

  it("R9: unfollow matches the canonical key case-insensitively", async () => {
    const app = getApp();
    const s = await setup(app);
    await declareEntityFollow(app.db, deps(prFetcher()), followParams(s, "acme/api#42"));
    // Stored key is `Acme/Api#42`; the caller types lowercase.
    await expect(removeEntityFollow(app.db, { chatId: s.chatId, entity: "acme/api#42" })).resolves.toEqual({
      removed: 1,
    });
  });

  it("R10: unfollow severs every row pointing at the chat, across pairs and bound_via values", async () => {
    const app = getApp();
    const s = await setup(app);
    const secondDelegate = await seedAgent(app, s.admin.organizationId, s.admin.memberId, "agent");

    const base = {
      organizationId: s.admin.organizationId,
      humanAgentId: s.human,
      entityType: "pull_request",
      entityKey: "Acme/Api#42",
      chatId: s.chatId,
    };
    await app.db.insert(githubEntityChatMappings).values([
      { ...base, delegateAgentId: s.delegate, boundVia: "direct" },
      { ...base, delegateAgentId: secondDelegate, boundVia: "human_fallback" },
    ]);

    await expect(removeEntityFollow(app.db, { chatId: s.chatId, entity: "acme/api#42" })).resolves.toEqual({
      removed: 2,
    });
  });

  it("unfollow with a /pull/ URL also removes the auto-corrected issue row (follow/unfollow symmetry)", async () => {
    const app = getApp();
    const s = await setup(app);
    // `/pull/42` actually pointing at an issue: follow auto-corrects via the
    // issues endpoint and stores entityType "issue".
    const fetcher = prFetcher({
      "/repos/acme/api/issues/42": () =>
        json({ number: 42, state: "open", title: "Bug", html_url: "https://github.com/Acme/Api/issues/42" }),
    });
    const followed = await declareEntityFollow(
      app.db,
      deps(fetcher),
      followParams(s, "https://github.com/acme/api/pull/42"),
    );
    if (followed.outcome !== "created") throw new Error("expected created");
    expect(followed.entity.entityType).toBe("issue");

    // The same reference the caller used to create the row must remove it.
    await expect(
      removeEntityFollow(app.db, { chatId: s.chatId, entity: "https://github.com/acme/api/pull/42" }),
    ).resolves.toEqual({ removed: 1 });
  });

  it("unfollow with an explicit issue/PR reference never sweeps a discussion sharing the number", async () => {
    const app = getApp();
    const s = await setup(app);
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: s.admin.organizationId,
      humanAgentId: s.human,
      delegateAgentId: s.delegate,
      entityType: "discussion",
      entityKey: "Acme/Api#42",
      chatId: s.chatId,
      boundVia: "agent_declared",
    });

    await expect(
      removeEntityFollow(app.db, { chatId: s.chatId, entity: "https://github.com/acme/api/issues/42" }),
    ).resolves.toEqual({ removed: 0 });
    // The bare form is the documented broad sweep.
    await expect(removeEntityFollow(app.db, { chatId: s.chatId, entity: "acme/api#42" })).resolves.toEqual({
      removed: 1,
    });
  });

  it("unfollow removes legacy discussion keys with the same explicit discussion reference", async () => {
    const app = getApp();
    const s = await setup(app);
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: s.admin.organizationId,
      humanAgentId: s.human,
      delegateAgentId: s.delegate,
      entityType: "discussion",
      entityKey: "Acme/Api#discussion-42",
      chatId: s.chatId,
      boundVia: "agent_declared",
    });

    await expect(
      removeEntityFollow(app.db, { chatId: s.chatId, entity: "https://github.com/acme/api/discussions/42" }),
    ).resolves.toEqual({ removed: 1 });
  });

  it("commit unfollow escapes LIKE metacharacters — an underscore repo cannot sweep a sibling", async () => {
    const app = getApp();
    const s = await setup(app);
    const base = {
      organizationId: s.admin.organizationId,
      humanAgentId: s.human,
      delegateAgentId: s.delegate,
      entityType: "commit",
      chatId: s.chatId,
      boundVia: "agent_declared",
    };
    await app.db.insert(githubEntityChatMappings).values([
      { ...base, entityKey: "acme/my_app@3f2a91c0aaaabbbbccccddddeeeeffff00001111" },
      // `_` as LIKE-any-char would also match this sibling repo's row.
      { ...base, entityKey: "acme/myxapp@3f2a91c0aaaabbbbccccddddeeeeffff00001111" },
    ]);

    await expect(removeEntityFollow(app.db, { chatId: s.chatId, entity: "acme/my_app@3f2a91c0" })).resolves.toEqual({
      removed: 1,
    });
    const remaining = await app.db
      .select({ entityKey: githubEntityChatMappings.entityKey })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.chatId, s.chatId));
    expect(remaining).toEqual([{ entityKey: "acme/myxapp@3f2a91c0aaaabbbbccccddddeeeeffff00001111" }]);
  });

  it("rebind whose conflicting row vanished concurrently falls back to a real insert (no ghost success)", async () => {
    const app = getApp();
    const s = await setup(app);
    const newChat = await seedChat(app, s.admin.organizationId);
    await declareEntityFollow(app.db, deps(prFetcher()), followParams(s, "acme/api#42"));

    // Simulate the concurrent unfollow racing between the conflict read and
    // the UPDATE: a fetcher hook is overkill — delete the row inside the
    // same window by removing it before the rebind call reaches the UPDATE.
    // Deterministic stand-in: remove the row, then rebind. The UPDATE
    // matches 0 rows and must fall back to inserting, not report "rebound".
    await removeEntityFollow(app.db, { chatId: s.chatId, entity: "acme/api#42" });

    const result = await declareEntityFollow(app.db, deps(prFetcher()), {
      ...followParams(s, "acme/api#42", true),
      chatId: newChat,
    });
    expect(result.outcome).toBe("created");
    const rows = await app.db
      .select({ chatId: githubEntityChatMappings.chatId })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "Acme/Api#42"));
    expect(rows).toEqual([{ chatId: newChat }]);
  });

  it("rebind falls back to insert when the conflicting row vanishes during the update", async () => {
    const app = getApp();
    const s = await setup(app);
    const newChat = await seedChat(app, s.admin.organizationId);
    await declareEntityFollow(app.db, deps(prFetcher()), followParams(s, "acme/api#42"));

    const fnName = `test_gef_skip_update_${randomUUID().replace(/-/g, "_")}`;
    const triggerName = `test_gef_skip_update_trg_${randomUUID().replace(/-/g, "_")}`;
    const quote = (value: string) => value.replace(/'/g, "''");
    await app.db.execute(
      sql.raw(`
      CREATE FUNCTION ${fnName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.entity_key = 'Acme/Api#42' AND NEW.chat_id = '${quote(newChat)}' THEN
          DELETE FROM github_entity_chat_mappings
          WHERE organization_id = OLD.organization_id
            AND human_agent_id = OLD.human_agent_id
            AND delegate_agent_id = OLD.delegate_agent_id
            AND entity_type = OLD.entity_type
            AND entity_key = OLD.entity_key;
          RETURN NULL;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE ON github_entity_chat_mappings
      FOR EACH ROW EXECUTE FUNCTION ${fnName}();
    `),
    );

    try {
      const result = await declareEntityFollow(app.db, deps(prFetcher()), {
        ...followParams(s, "acme/api#42", true),
        chatId: newChat,
      });

      expect(result.outcome).toBe("created");
      const rows = await app.db
        .select({ chatId: githubEntityChatMappings.chatId, title: githubEntityChatMappings.title })
        .from(githubEntityChatMappings)
        .where(eq(githubEntityChatMappings.entityKey, "Acme/Api#42"));
      expect(rows).toEqual([{ chatId: newChat, title: "Add follow command" }]);
    } finally {
      await app.db.execute(
        sql.raw(`
        DROP TRIGGER IF EXISTS ${triggerName} ON github_entity_chat_mappings;
        DROP FUNCTION IF EXISTS ${fnName}();
      `),
      );
    }
  });

  it("rebind reports conflict when a third writer wins the fallback insert race", async () => {
    const app = getApp();
    const s = await setup(app);
    const newChat = await seedChat(app, s.admin.organizationId);
    const thirdChat = await seedChat(app, s.admin.organizationId);
    await app.db.update(chats).set({ topic: "third winner" }).where(eq(chats.id, thirdChat));
    await declareEntityFollow(app.db, deps(prFetcher()), followParams(s, "acme/api#42"));

    const fnName = `test_gef_third_writer_${randomUUID().replace(/-/g, "_")}`;
    const triggerName = `test_gef_third_writer_trg_${randomUUID().replace(/-/g, "_")}`;
    const quote = (value: string) => value.replace(/'/g, "''");
    await app.db.execute(
      sql.raw(`
      CREATE FUNCTION ${fnName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.entity_key = 'Acme/Api#42' AND NEW.chat_id = '${quote(newChat)}' THEN
          DELETE FROM github_entity_chat_mappings
          WHERE organization_id = OLD.organization_id
            AND human_agent_id = OLD.human_agent_id
            AND delegate_agent_id = OLD.delegate_agent_id
            AND entity_type = OLD.entity_type
            AND entity_key = OLD.entity_key;
          INSERT INTO github_entity_chat_mappings (
            organization_id,
            human_agent_id,
            delegate_agent_id,
            entity_type,
            entity_key,
            chat_id,
            bound_via,
            entity_state,
            title
          )
          VALUES (
            OLD.organization_id,
            OLD.human_agent_id,
            OLD.delegate_agent_id,
            OLD.entity_type,
            OLD.entity_key,
            '${quote(thirdChat)}',
            'human_declared',
            OLD.entity_state,
            OLD.title
          );
          RETURN NULL;
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE ON github_entity_chat_mappings
      FOR EACH ROW EXECUTE FUNCTION ${fnName}();
    `),
    );

    try {
      const result = await declareEntityFollow(app.db, deps(prFetcher()), {
        ...followParams(s, "acme/api#42", true),
        chatId: newChat,
      });

      expect(result).toEqual({ outcome: "conflict", conflict: { chatId: thirdChat, topic: "third winner" } });
    } finally {
      await app.db.execute(
        sql.raw(`
        DROP TRIGGER IF EXISTS ${triggerName} ON github_entity_chat_mappings;
        DROP FUNCTION IF EXISTS ${fnName}();
      `),
      );
    }
  });

  it("rebind refreshes boundAt so the listing dedup sees the move as most recent", async () => {
    const app = getApp();
    const s = await setup(app);
    const newChat = await seedChat(app, s.admin.organizationId);
    await declareEntityFollow(app.db, deps(prFetcher()), followParams(s, "acme/api#42"));
    const [before] = await app.db
      .select({ boundAt: githubEntityChatMappings.boundAt })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "Acme/Api#42"));

    const rebound = await declareEntityFollow(app.db, deps(prFetcher()), {
      ...followParams(s, "acme/api#42", true),
      chatId: newChat,
    });
    expect(rebound.outcome).toBe("rebound");
    const [after] = await app.db
      .select({ boundAt: githubEntityChatMappings.boundAt })
      .from(githubEntityChatMappings)
      .where(eq(githubEntityChatMappings.entityKey, "Acme/Api#42"));
    expect(after && before && after.boundAt.getTime() >= before.boundAt.getTime()).toBe(true);
  });

  it("legacy agent_created rows normalise to agent_declared at read time (rolling-deploy belt-and-suspenders)", async () => {
    const app = getApp();
    const s = await setup(app);
    // A row written by a still-draining old instance AFTER the one-shot
    // backfill ran — the legacy value must not vanish from listings.
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: s.admin.organizationId,
      humanAgentId: s.human,
      delegateAgentId: s.delegate,
      entityType: "pull_request",
      entityKey: "Acme/Api#7",
      chatId: s.chatId,
      boundVia: "agent_created",
    });

    const list = await listChatGithubEntities(app.db, { chatId: s.chatId });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ entityKey: "Acme/Api#7", boundVia: "agent_declared", state: "open" });
  });

  it("following reads lifecycle state from the DB projection", async () => {
    const app = getApp();
    const s = await setup(app);
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: s.admin.organizationId,
      humanAgentId: s.human,
      delegateAgentId: s.delegate,
      entityType: "pull_request",
      entityKey: "Acme/Api#8",
      chatId: s.chatId,
      boundVia: "agent_declared",
      entityState: "draft",
    });

    const list = await listChatGithubEntities(app.db, { chatId: s.chatId });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      entityType: "pull_request",
      entityKey: "Acme/Api#8",
      htmlUrl: "https://github.com/Acme/Api/pull/8",
      title: null,
      state: "draft",
      number: 8,
    });
  });

  it("following surfaces the persisted entity title from the DB projection", async () => {
    const app = getApp();
    const s = await setup(app);
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: s.admin.organizationId,
      humanAgentId: s.human,
      delegateAgentId: s.delegate,
      entityType: "pull_request",
      entityKey: "Acme/Api#9",
      chatId: s.chatId,
      boundVia: "agent_declared",
      title: "Refactor inbox dispatcher",
    });

    const list = await listChatGithubEntities(app.db, { chatId: s.chatId });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      entityKey: "Acme/Api#9",
      title: "Refactor inbox dispatcher",
      state: "open",
      number: 9,
    });
  });

  it("following lists legacy discussion mappings under the canonical numeric key", async () => {
    const app = getApp();
    const s = await setup(app);
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: s.admin.organizationId,
      humanAgentId: s.human,
      delegateAgentId: s.delegate,
      entityType: "discussion",
      entityKey: "Acme/Api#discussion-42",
      chatId: s.chatId,
      boundVia: "agent_declared",
    });

    const list = await listChatGithubEntities(app.db, { chatId: s.chatId });

    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      entityType: "discussion",
      entityKey: "Acme/Api#42",
      htmlUrl: "https://github.com/Acme/Api/discussions/42",
      number: 42,
    });
  });

  it("unfollow by short commit sha prefix removes the full-sha row", async () => {
    const app = getApp();
    const s = await setup(app);
    await app.db.insert(githubEntityChatMappings).values({
      organizationId: s.admin.organizationId,
      humanAgentId: s.human,
      delegateAgentId: s.delegate,
      entityType: "commit",
      entityKey: "Acme/Api@3f2a91c0aaaabbbbccccddddeeeeffff00001111",
      chatId: s.chatId,
      boundVia: "agent_declared",
    });
    await expect(removeEntityFollow(app.db, { chatId: s.chatId, entity: "acme/api@3f2a91c0" })).resolves.toEqual({
      removed: 1,
    });
  });

  it("uses commit resolver fallbacks for repo name, sha, html URL, and blank first-line title", async () => {
    const app = getApp();
    const s = await setup(app);
    const fetcher = makeFetcher({
      "/repos/acme/api/commits/3f2a91c0": () => json({ commit: { message: "\nbody" } }),
      "/repos/acme/api": () => json({}),
    });

    const result = await declareEntityFollow(app.db, deps(fetcher), followParams(s, "acme/api@3f2a91c0"));

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("expected created");
    expect(result.entity).toMatchObject({
      entityType: "commit",
      entityKey: "acme/api@3f2a91c0",
      htmlUrl: "https://github.com/acme/api/commit/3f2a91c0",
      title: "",
      state: null,
      number: null,
    });
  });

  it("maps commit GitHub failures after repo resolution", async () => {
    const app = getApp();
    const unavailable = await setup(app);
    await expect(
      declareEntityFollow(
        app.db,
        deps(
          makeFetcher({
            "/repos/acme/api/commits/3f2a91c0": () => json({ message: "server error" }, 502),
            "/repos/acme/api": () => json({ full_name: "Acme/Api" }),
          }),
        ),
        followParams(unavailable, "acme/api@3f2a91c0"),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);

    const missing = await setup(app);
    await expect(
      declareEntityFollow(
        app.db,
        deps(
          makeFetcher({
            "/repos/acme/api/commits/3f2a91c0": () => json({ message: "Not Found" }, 404),
            "/repos/acme/api": () => json({ full_name: "Acme/Api" }),
          }),
        ),
        followParams(missing, "acme/api@3f2a91c0"),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("maps PR second-hop failures without writing a follow row", async () => {
    const app = getApp();
    const unavailable = await setup(app);
    await expect(
      declareEntityFollow(
        app.db,
        deps(
          prFetcher({
            "/repos/acme/api/pulls/42": () => json({ message: "server error" }, 502),
          }),
        ),
        followParams(unavailable, "acme/api#42"),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);

    const forbidden = await setup(app);
    await expect(
      declareEntityFollow(
        app.db,
        deps(
          prFetcher({
            "/repos/acme/api/pulls/42": () => json({ message: "Forbidden" }, 403),
          }),
        ),
        followParams(forbidden, "acme/api#42"),
      ),
    ).rejects.toBeInstanceOf(UnprocessableError);

    const missing = await setup(app);
    await expect(
      declareEntityFollow(
        app.db,
        deps(
          prFetcher({
            "/repos/acme/api/pulls/42": () => json({ message: "Gone" }, 410),
          }),
        ),
        followParams(missing, "acme/api#42"),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("uses PR and issue payload fallbacks for URL, title, number, and state", async () => {
    const app = getApp();
    const prSetup = await setup(app);
    const prResult = await declareEntityFollow(
      app.db,
      deps(
        prFetcher({
          "/repos/acme/api/issues/42": () =>
            json({
              state: "closed",
              title: "Issue title fallback",
              pull_request: { merged_at: null },
            }),
          "/repos/acme/api/pulls/42": () =>
            json({
              state: "closed",
              merged: false,
              draft: false,
            }),
        }),
      ),
      followParams(prSetup, "acme/api#42"),
    );
    expect(prResult.outcome).toBe("created");
    if (prResult.outcome !== "created") throw new Error("expected created");
    expect(prResult.entity).toMatchObject({
      htmlUrl: "https://github.com/Acme/Api/pull/42",
      title: "Issue title fallback",
      state: "closed",
      number: 42,
    });

    const issueSetup = await setup(app);
    const issueResult = await declareEntityFollow(
      app.db,
      deps(
        prFetcher({
          "/repos/acme/api/issues/42": () =>
            json({
              state: "queued",
            }),
        }),
      ),
      followParams(issueSetup, "acme/api#42"),
    );
    expect(issueResult.outcome).toBe("created");
    if (issueResult.outcome !== "created") throw new Error("expected created");
    expect(issueResult.entity).toMatchObject({
      entityType: "issue",
      htmlUrl: "https://github.com/Acme/Api/issues/42",
      title: null,
      state: null,
      number: 42,
    });
  });

  it("maps discussion resolver fallbacks and unavailable responses", async () => {
    const app = getApp();
    const unavailable = await setup(app);
    await expect(
      declareEntityFollow(
        app.db,
        deps(
          makeFetcher({
            "/repos/Acme/Api/discussions/42": () => json({ message: "server error" }, 502),
            "/repos/acme/api": () => json({ full_name: "Acme/Api" }),
          }),
        ),
        followParams(unavailable, "https://github.com/acme/api/discussions/42"),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);

    const ok = await setup(app);
    const result = await declareEntityFollow(
      app.db,
      deps(
        makeFetcher({
          "/repos/Acme/Api/discussions/42": () => json({ state: "queued" }),
          "/repos/acme/api": () => json({ full_name: "Acme/Api" }),
        }),
      ),
      followParams(ok, "https://github.com/acme/api/discussions/42"),
    );
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("expected created");
    expect(result.entity).toMatchObject({
      entityType: "discussion",
      htmlUrl: "https://github.com/Acme/Api/discussions/42",
      title: null,
      state: null,
      number: 42,
    });
  });

  it("treats non-object GitHub JSON, retry-after limits, and 401s as resolver errors", async () => {
    const app = getApp();
    const nonObject = await setup(app);
    await expect(
      declareEntityFollow(
        app.db,
        deps(
          makeFetcher({
            "/repos/acme/api": () => json("not an object"),
          }),
        ),
        followParams(nonObject, "acme/api#42"),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);

    const retryAfter = await setup(app);
    const retryAfterFetcher = makeFetcher({
      "/repos/acme/api": () =>
        new Response(JSON.stringify({ message: "secondary limit" }), {
          status: 403,
          headers: { "content-type": "application/json", "retry-after": "1" },
        }),
    });
    await expect(
      declareEntityFollow(app.db, deps(retryAfterFetcher), followParams(retryAfter, "acme/api#42")),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);

    const forbidden = await setup(app);
    await expect(
      declareEntityFollow(
        app.db,
        deps(
          makeFetcher({
            "/repos/acme/api": () => json({ message: "Bad credentials" }, 401),
          }),
        ),
        followParams(forbidden, "acme/api#42"),
      ),
    ).rejects.toBeInstanceOf(UnprocessableError);
  });
});

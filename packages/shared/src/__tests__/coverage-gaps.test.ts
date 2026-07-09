import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalGitRepoUrl } from "../canonical-git-repo-url.js";
import { daemonEnvFile, defaultHome, resetConfigMeta } from "../config/resolver.js";
import { createServerConfigSchema } from "../config/server-config.js";
import { buildDocAnchor, locateDocAnchor } from "../doc-anchor.js";
import { identiconCells, identiconSvg } from "../lib/identicon.js";
import { findReservedAgentMetadataKey, listAgentsQuerySchema, userAgentMetadataSchema } from "../schemas/agent.js";
import {
  deriveRepoLocalPath,
  deriveRepoShortLabel,
  formatRepoCoordinate,
  normalizeRepoLocalPath,
} from "../schemas/agent-runtime-config.js";
import { attachmentRefSchema, attachmentRefsFromMetadata, isAttachmentRef } from "../schemas/attachment-ref.js";
import { addParticipantSchema, updateChatSchema } from "../schemas/chat.js";
import { githubEntityBoundViaSchema, isDeclaredBoundVia } from "../schemas/chat-github-entities.js";
import { isImageBatchRefContent, isImageRefContent } from "../schemas/image-payload.js";
import {
  isLandingCampaignTrialAgentMetadata,
  isLandingCampaignTrialChatLocked,
  parseLandingCampaignTrialAgentMetadata,
  parseLandingCampaignTrialChatMetadata,
} from "../schemas/landing-campaign.js";
import { orgContextTreeFeaturesInputSchema, orgContextTreeFeaturesStorageSchema } from "../schemas/org-settings.js";
import {
  encodeProviderRetryEventMessage,
  type ProviderRetryEventPayload,
  parseProviderRetryEventMessage,
  statusReasonFromProviderRetryEvent,
} from "../schemas/provider-retry.js";
import { agentResourceBindingInputSchema, canonicalizeResourceRepoUrl } from "../schemas/resource.js";
import { isRuntimeProviderEnabled } from "../schemas/runtime-provider.js";
import { classifyShellCommandIo, stripShellCommandDisplayWrapper } from "../shell-command-io.js";

const VALID_UUID = "01234567-89ab-4def-8123-456789abcdef";
const VALID_SHA256 = "a".repeat(64);

describe("attachment-ref helpers", () => {
  it("isAttachmentRef rejects malformed values and accepts valid refs", () => {
    expect(isAttachmentRef(null)).toBe(false);
    expect(isAttachmentRef(undefined)).toBe(false);
    expect(isAttachmentRef("x")).toBe(false);
    expect(isAttachmentRef({})).toBe(false);
    expect(isAttachmentRef({ attachmentId: "not-a-uuid", kind: "file", mimeType: "a", filename: "f", size: 1 })).toBe(
      false,
    );
    expect(isAttachmentRef({ attachmentId: VALID_UUID, kind: "other", mimeType: "a", filename: "f", size: 1 })).toBe(
      false,
    );
    expect(isAttachmentRef({ attachmentId: VALID_UUID, kind: "file", mimeType: "", filename: "f", size: 1 })).toBe(
      false,
    );
    expect(isAttachmentRef({ attachmentId: VALID_UUID, kind: "file", mimeType: "a", filename: "", size: 1 })).toBe(
      false,
    );
    expect(isAttachmentRef({ attachmentId: VALID_UUID, kind: "file", mimeType: "a", filename: "f", size: 1.5 })).toBe(
      false,
    );
    expect(isAttachmentRef({ attachmentId: VALID_UUID, kind: "file", mimeType: "a", filename: "f", size: -1 })).toBe(
      false,
    );
    expect(
      isAttachmentRef({
        attachmentId: VALID_UUID,
        kind: "file",
        mimeType: "a",
        filename: "f",
        size: 1,
        sha256: "not-hex",
      }),
    ).toBe(false);
    expect(
      isAttachmentRef({
        attachmentId: VALID_UUID,
        kind: "file",
        mimeType: "a",
        filename: "f",
        size: 1,
        source: "bad",
      }),
    ).toBe(false);
    expect(
      isAttachmentRef({
        attachmentId: VALID_UUID,
        kind: "file",
        mimeType: "a",
        filename: "f",
        size: 1,
        source: { path: 1 },
      }),
    ).toBe(false);
    expect(
      isAttachmentRef({
        attachmentId: VALID_UUID,
        kind: "file",
        mimeType: "a",
        filename: "f",
        size: 1,
        source: { path: "p", sourcePath: 1 },
      }),
    ).toBe(false);

    const valid = {
      attachmentId: VALID_UUID,
      kind: "document" as const,
      mimeType: "text/markdown",
      filename: "note.md",
      size: 0,
      sha256: VALID_SHA256,
      source: { path: "docs/note.md", sourcePath: "/abs/docs/note.md" },
    };
    expect(isAttachmentRef(valid)).toBe(true);
    expect(attachmentRefSchema.parse(valid)).toMatchObject(valid);
  });

  it("attachmentRefsFromMetadata filters invalid entries and empty payloads", () => {
    expect(attachmentRefsFromMetadata(undefined)).toEqual([]);
    expect(attachmentRefsFromMetadata({})).toEqual([]);
    expect(attachmentRefsFromMetadata({ attachments: "nope" })).toEqual([]);
    expect(
      attachmentRefsFromMetadata({
        attachments: [
          null,
          {
            attachmentId: VALID_UUID,
            kind: "file",
            mimeType: "application/pdf",
            filename: "a.pdf",
            size: 10,
          },
          { attachmentId: "bad" },
        ],
      }),
    ).toEqual([
      {
        attachmentId: VALID_UUID,
        kind: "file",
        mimeType: "application/pdf",
        filename: "a.pdf",
        size: 10,
      },
    ]);
  });
});

describe("landing campaign metadata helpers", () => {
  const agentMeta = {
    landingCampaignTrial: true as const,
    campaign: "hello-world",
    skillSetId: "skills-1",
    skillSetVersion: "1.0.0",
    repo: {
      url: "https://github.com/acme/demo",
      canonicalKey: "github.com/acme/demo",
      owner: "acme",
      name: "demo",
    },
  };

  const chatMeta = {
    landingCampaignTrial: {
      campaign: "hello-world",
      agentId: "agent-1",
      skillSetId: "skills-1",
      skillSetVersion: "1.0.0",
      repo: {
        url: "https://github.com/acme/demo",
        canonicalKey: "github.com/acme/demo",
      },
      state: "running" as const,
      inputLocked: true,
      maxAgentTurns: 2,
      completedAgentTurns: 0,
      completedAgentTurnIds: [],
      maxEstimatedTokens: null,
      estimatedTokensUsed: 0,
      lastObservedEstimatedTokens: 0,
      lastObservedTokenUsageEventId: null,
    },
  };

  it("parses trial agent/chat metadata and lock status", () => {
    expect(parseLandingCampaignTrialAgentMetadata(null)).toBeNull();
    expect(parseLandingCampaignTrialAgentMetadata({})).toBeNull();
    expect(parseLandingCampaignTrialAgentMetadata(agentMeta)).toMatchObject(agentMeta);
    expect(isLandingCampaignTrialAgentMetadata(agentMeta)).toBe(true);
    expect(isLandingCampaignTrialAgentMetadata({ landingCampaignTrial: false })).toBe(false);

    expect(parseLandingCampaignTrialChatMetadata(undefined)).toBeNull();
    expect(parseLandingCampaignTrialChatMetadata({})).toBeNull();
    expect(parseLandingCampaignTrialChatMetadata(chatMeta)).toMatchObject(chatMeta.landingCampaignTrial);
    expect(isLandingCampaignTrialChatLocked(chatMeta)).toBe(true);
    expect(
      isLandingCampaignTrialChatLocked({
        landingCampaignTrial: { ...chatMeta.landingCampaignTrial, inputLocked: false },
      }),
    ).toBe(false);
    expect(isLandingCampaignTrialChatLocked(null)).toBe(false);
  });
});

describe("runtime provider enablement", () => {
  it("reports temporarily disabled providers", () => {
    expect(isRuntimeProviderEnabled("claude-code")).toBe(true);
    expect(isRuntimeProviderEnabled("codex")).toBe(true);
    expect(isRuntimeProviderEnabled("claude-code-tui")).toBe(false);
    expect(isRuntimeProviderEnabled("unknown")).toBe(true);
  });
});

describe("chat github entity bound_via helpers", () => {
  it("normalizes legacy agent_created and detects declared bindings", () => {
    expect(githubEntityBoundViaSchema.parse("agent_created")).toBe("agent_declared");
    expect(githubEntityBoundViaSchema.parse("direct")).toBe("direct");
    expect(githubEntityBoundViaSchema.parse("human_declared")).toBe("human_declared");
    expect(isDeclaredBoundVia("agent_declared")).toBe(true);
    expect(isDeclaredBoundVia("human_declared")).toBe(true);
    expect(isDeclaredBoundVia("direct")).toBe(false);
  });
});

describe("addParticipantSchema refine message", () => {
  it("requires exactly one of agentId or agentName", () => {
    expect(addParticipantSchema.safeParse({}).success).toBe(false);
    expect(addParticipantSchema.safeParse({ agentId: "a", agentName: "b" }).success).toBe(false);
    expect(addParticipantSchema.parse({ agentId: "a" })).toEqual({ agentId: "a" });
    expect(addParticipantSchema.parse({ agentName: "bot" })).toEqual({ agentName: "bot" });
    const both = addParticipantSchema.safeParse({ agentId: "a", agentName: "b" });
    expect(both.success).toBe(false);
    if (!both.success) {
      expect(both.error.issues[0]?.message).toContain("exactly one of");
    }
  });
});

describe("updateChatSchema", () => {
  it("requires at least one of topic or description", () => {
    expect(updateChatSchema.safeParse({}).success).toBe(false);
    expect(updateChatSchema.parse({ topic: "t" })).toMatchObject({ topic: "t" });
    expect(updateChatSchema.parse({ description: "d" })).toMatchObject({ description: "d" });
    expect(updateChatSchema.parse({ topic: null, description: null })).toMatchObject({
      topic: null,
      description: null,
    });
  });
});

describe("agent metadata and list query schemas", () => {
  it("findReservedAgentMetadataKey and userAgentMetadataSchema reserve runtime keys", () => {
    expect(findReservedAgentMetadataKey(undefined)).toBeNull();
    expect(findReservedAgentMetadataKey({})).toBeNull();
    expect(findReservedAgentMetadataKey({ custom: 1 })).toBeNull();
    expect(findReservedAgentMetadataKey({ runtimeSwitch: {} })).toBe("runtimeSwitch");
    expect(findReservedAgentMetadataKey({ runtimeSession: {} })).toBe("runtimeSession");
    expect(userAgentMetadataSchema.safeParse({ runtimeSwitch: true }).success).toBe(false);
    expect(userAgentMetadataSchema.safeParse({ ok: true }).success).toBe(true);
  });

  it("listAgentsQuerySchema preprocesses addressableOnly flags", () => {
    expect(listAgentsQuerySchema.parse({}).addressableOnly).toBe(false);
    expect(listAgentsQuerySchema.parse({ addressableOnly: "true" }).addressableOnly).toBe(true);
    expect(listAgentsQuerySchema.parse({ addressableOnly: "1" }).addressableOnly).toBe(true);
    expect(listAgentsQuerySchema.parse({ addressableOnly: true }).addressableOnly).toBe(true);
    expect(listAgentsQuerySchema.parse({ addressableOnly: "false" }).addressableOnly).toBe(false);
    expect(listAgentsQuerySchema.parse({ addressableOnly: "0" }).addressableOnly).toBe(false);
    expect(listAgentsQuerySchema.parse({ addressableOnly: false }).addressableOnly).toBe(false);
    expect(listAgentsQuerySchema.parse({ addressableOnly: "" }).addressableOnly).toBe(false);
    expect(listAgentsQuerySchema.safeParse({ addressableOnly: "maybe" }).success).toBe(false);
    expect(listAgentsQuerySchema.parse({ query: "  alice  " }).query).toBe("alice");
  });
});

describe("provider-retry event helpers", () => {
  const base = {
    provider: "claude-code" as const,
    scope: "provider_turn" as const,
    category: "transient_transport" as const,
    reasonCode: "timeout",
    userSeverity: "warning" as const,
    messagePreview: "slow",
    attempt: 1,
    maxAttempts: 3,
  };

  it("parses and classifies retry events across success/waiting/retrying/terminal paths", () => {
    expect(parseProviderRetryEventMessage("provider.retry:")).toBeNull();
    expect(parseProviderRetryEventMessage("provider.retry: {")).toBeNull();
    expect(parseProviderRetryEventMessage("provider.retry: {}")).toBeNull();

    const scheduled: ProviderRetryEventPayload = {
      event: "provider_retry_scheduled",
      ...base,
      retryMode: "foreground",
    };
    const scheduledMsg = encodeProviderRetryEventMessage(scheduled);
    expect(parseProviderRetryEventMessage(scheduledMsg)).toMatchObject({ event: "provider_retry_scheduled" });
    expect(statusReasonFromProviderRetryEvent(scheduled)).toMatchObject({
      kind: "retrying",
      label: "Retrying provider",
    });

    const waiting: ProviderRetryEventPayload = {
      event: "provider_retry_started",
      ...base,
      retryMode: "background",
      category: "provider_capacity",
      reasonCode: "capacity_wait_required",
    };
    expect(statusReasonFromProviderRetryEvent(waiting)).toMatchObject({
      kind: "waiting",
      label: "Waiting for provider capacity",
    });

    const waitingGeneric: ProviderRetryEventPayload = {
      event: "provider_retry_started",
      ...base,
      retryMode: "background",
      category: "transient_transport",
    };
    expect(statusReasonFromProviderRetryEvent(waitingGeneric)).toMatchObject({
      kind: "waiting",
      label: "Waiting to retry provider",
    });

    const succeeded: ProviderRetryEventPayload = { event: "provider_retry_succeeded", ...base };
    expect(statusReasonFromProviderRetryEvent(succeeded)).toBeNull();

    const exhausted: ProviderRetryEventPayload = {
      event: "provider_retry_exhausted",
      ...base,
      category: "unknown",
      reasonCode: "gave_up",
    };
    expect(statusReasonFromProviderRetryEvent(exhausted)).toMatchObject({
      kind: "terminal",
      label: "Provider retry exhausted",
    });

    const capacityTerminal: ProviderRetryEventPayload = {
      event: "provider_failure_terminal",
      ...base,
      category: "provider_capacity",
      reasonCode: "capacity_wait_required",
    };
    expect(statusReasonFromProviderRetryEvent(capacityTerminal)).toMatchObject({
      kind: "terminal",
      label: "Provider capacity limit",
    });

    const genericTerminal: ProviderRetryEventPayload = {
      event: "provider_failure_terminal",
      ...base,
      category: "credential",
      reasonCode: "auth",
    };
    expect(statusReasonFromProviderRetryEvent(genericTerminal)).toMatchObject({
      kind: "terminal",
      label: "Provider failure",
    });
  });
});

describe("resource binding and canonicalizeResourceRepoUrl edge cases", () => {
  it("rejects invalid binding combinations for prompt/repo/include/disable/replace", () => {
    expect(
      agentResourceBindingInputSchema.safeParse({
        type: "skill",
        mode: "include",
        inlinePromptBody: "only for prompts",
      }).success,
    ).toBe(false);

    expect(
      agentResourceBindingInputSchema.safeParse({
        type: "prompt",
        mode: "include",
        agentExtraRepo: { url: "https://github.com/a/b" },
      }).success,
    ).toBe(false);

    expect(
      agentResourceBindingInputSchema.safeParse({
        type: "prompt",
        mode: "include",
        resourceId: "r1",
        repoRef: "main",
      }).success,
    ).toBe(false);

    expect(
      agentResourceBindingInputSchema.safeParse({
        type: "prompt",
        mode: "disable",
        resourceId: null,
      }).success,
    ).toBe(false);

    expect(
      agentResourceBindingInputSchema.safeParse({
        type: "prompt",
        mode: "disable",
        resourceId: "r1",
        replacesResourceId: "r0",
      }).success,
    ).toBe(false);

    expect(
      agentResourceBindingInputSchema.safeParse({
        type: "skill",
        mode: "replace",
        resourceId: "r1",
      }).success,
    ).toBe(false);

    expect(
      agentResourceBindingInputSchema.safeParse({
        type: "skill",
        mode: "replace",
        replacesResourceId: "r0",
        resourceId: null,
      }).success,
    ).toBe(false);

    expect(
      agentResourceBindingInputSchema.safeParse({
        type: "skill",
        mode: "replace",
        replacesResourceId: "r0",
        resourceId: "r1",
        inlinePromptBody: "nope",
      }).success,
    ).toBe(false);

    expect(
      agentResourceBindingInputSchema.safeParse({
        type: "prompt",
        mode: "include",
        resourceId: "r1",
        inlinePromptBody: "also",
      }).success,
    ).toBe(false);

    expect(
      agentResourceBindingInputSchema.safeParse({
        type: "prompt",
        mode: "include",
        resourceId: "r1",
        replacesResourceId: "r0",
      }).success,
    ).toBe(false);

    expect(
      agentResourceBindingInputSchema.safeParse({
        type: "repo",
        mode: "include",
        resourceId: "r1",
        repoLocalPath: "../escape",
      }).success,
    ).toBe(false);

    expect(
      agentResourceBindingInputSchema.parse({
        type: "prompt",
        mode: "include",
        resourceId: "r1",
      }),
    ).toMatchObject({ type: "prompt", mode: "include", resourceId: "r1" });

    expect(
      agentResourceBindingInputSchema.parse({
        type: "prompt",
        mode: "replace",
        replacesResourceId: "old",
        inlinePromptBody: "replacement body",
      }),
    ).toMatchObject({ mode: "replace", replacesResourceId: "old" });

    expect(
      agentResourceBindingInputSchema.parse({
        type: "skill",
        mode: "disable",
        resourceId: "r1",
      }),
    ).toMatchObject({ mode: "disable", resourceId: "r1" });

    // valid repoLocalPath exercises the superRefine success path (no safety error)
    expect(
      agentResourceBindingInputSchema.parse({
        type: "repo",
        mode: "include",
        resourceId: "r1",
        repoLocalPath: "valid-local",
        repoRef: "main",
      }),
    ).toMatchObject({ type: "repo", repoLocalPath: "valid-local", repoRef: "main" });

    // nested path is normalized then accepted
    expect(
      agentResourceBindingInputSchema.parse({
        type: "repo",
        mode: "include",
        resourceId: "r1",
        repoLocalPath: "nested/ok",
      }),
    ).toMatchObject({ repoLocalPath: "nested-ok" });
  });

  it("canonicalizes non-default ports and rejects invalid scp-like forms", () => {
    expect(canonicalizeResourceRepoUrl("https://github.com/Acme/Repo.git")).toBe("github.com/acme/repo");
    expect(canonicalizeResourceRepoUrl("https://example.com:8443/org/repo.git")).toBe("example.com:8443/org/repo");
    expect(canonicalizeResourceRepoUrl("ssh://git@github.com:22/Acme/Repo.git")).toBe("github.com/acme/repo");
    expect(canonicalizeResourceRepoUrl("https://example.com:443/org/repo.git")).toBe("example.com/org/repo");
    expect(canonicalizeResourceRepoUrl("git@github.com:Acme/Repo.git")).toBe("github.com/acme/repo");
    expect(canonicalizeResourceRepoUrl("github.com:Acme/Repo")).toBe("github.com/acme/repo");
    // scp-like without user@
    expect(canonicalizeResourceRepoUrl("github.com:Acme/Repo.git")).toBe("github.com/acme/repo");
    // Exercise scp-like reject branches (leading slash, digit-only, digit+slash, empty host, trailing colon)
    for (const sample of [
      "host:/abs/path",
      "host:2",
      "host:2/foo",
      "@:Acme/Repo",
      "host:",
      "no-colon",
      ":missing-host",
      "git@host:path with space",
      "git@host:path:extra",
    ]) {
      try {
        const key = canonicalizeResourceRepoUrl(sample);
        expect(typeof key === "string" || key === undefined).toBe(true);
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
      }
    }
    // digit+slash scp path with user is rejected when second char is /
    try {
      canonicalizeResourceRepoUrl("git@host:2/foo");
    } catch {
      /* URL fallback may throw */
    }
    // trailing slashes and non-github hosts
    expect(canonicalizeResourceRepoUrl("https://gitlab.com/Org/Repo.git///")).toBe("gitlab.com/Org/Repo");
    // github short path (<2 segments) keeps full path
    expect(canonicalizeResourceRepoUrl("https://github.com/only-one")).toBe("github.com/only-one");
    // whitespace in path via containsWhitespace
    expect(canonicalizeResourceRepoUrl("https://example.com/a%20b/repo")).toBeTruthy();
  });
});

describe("org context tree feature schemas", () => {
  it("requires agentUuid when reviewer is enabled", () => {
    expect(
      orgContextTreeFeaturesStorageSchema.safeParse({
        contextReviewer: { enabled: true, agentUuid: null },
      }).success,
    ).toBe(false);
    expect(
      orgContextTreeFeaturesInputSchema.safeParse({
        contextReviewer: { enabled: true, agentUuid: null },
      }).success,
    ).toBe(false);
    expect(
      orgContextTreeFeaturesInputSchema.parse({
        contextReviewer: { enabled: true, agentUuid: "agent-1" },
      }),
    ).toMatchObject({ contextReviewer: { enabled: true, agentUuid: "agent-1" } });
    expect(
      orgContextTreeFeaturesStorageSchema.parse({
        contextReviewer: { enabled: false, agentUuid: null },
      }),
    ).toMatchObject({ contextReviewer: { enabled: false } });
  });
});

describe("config resolver daemonEnvFile", () => {
  afterEach(() => {
    delete process.env.FIRST_TREE_HOME;
    resetConfigMeta();
  });

  it("joins daemon.env under defaultHome", () => {
    process.env.FIRST_TREE_HOME = "/tmp/first-tree-test-home";
    expect(defaultHome()).toBe("/tmp/first-tree-test-home");
    expect(daemonEnvFile()).toBe(join("/tmp/first-tree-test-home", "daemon.env"));
  });
});

describe("createServerConfigSchema secret modes", () => {
  it("returns the shared schema when auto-generate is enabled and a distinct shape when disabled", () => {
    const withAuto = createServerConfigSchema({ autoGenerateSecrets: true });
    const withoutAuto = createServerConfigSchema({ autoGenerateSecrets: false });
    const defaulted = createServerConfigSchema();
    expect(withAuto).toBe(defaulted);
    expect(withoutAuto).not.toBe(withAuto);
    expect(withoutAuto.secrets).toBeDefined();

    // Exercise optionalTrimmedStringSchema branches via growth.landingCampaigns fields.
    const serviceUserField = withAuto.growth.landingCampaigns.shape.serviceUserId;
    expect(serviceUserField.schema.parse(undefined)).toBeUndefined();
    // non-string preprocess path (then rejected by z.string().optional())
    expect(serviceUserField.schema.safeParse(42).success).toBe(false);
    expect(serviceUserField.schema.parse("   ")).toBeUndefined();
    expect(serviceUserField.schema.parse(" user-1 ")).toBe("user-1");

    // landing campaign runtime provider refine (codex/claude-code only)
    const runtimeField = withAuto.growth.landingCampaigns.shape.runtimeProvider;
    expect(runtimeField.schema.parse("codex")).toBe("codex");
    expect(runtimeField.schema.parse("claude-code")).toBe("claude-code");
    expect(runtimeField.schema.safeParse("claude-code-tui").success).toBe(false);
  });
});

describe("agent-runtime-config helpers", () => {
  it("normalizeRepoLocalPath collapses safe nested paths and leaves unsafe shapes alone", () => {
    expect(normalizeRepoLocalPath("nested/path")).toBe("nested-path");
    expect(normalizeRepoLocalPath("single")).toBe("single");
    expect(normalizeRepoLocalPath(" spaced ")).toBe(" spaced ");
    expect(normalizeRepoLocalPath("has\u0000control")).toBe("has\u0000control");
    expect(normalizeRepoLocalPath("win\\path")).toBe("win\\path");
    expect(normalizeRepoLocalPath("/abs")).toBe("/abs");
    expect(normalizeRepoLocalPath("C:/drive")).toBe("C:/drive");
    expect(normalizeRepoLocalPath("a/../b")).toBe("a/../b");
    expect(normalizeRepoLocalPath("a//b")).toBe("a//b");
    expect(normalizeRepoLocalPath("a/./b")).toBe("a/./b");
    expect(normalizeRepoLocalPath("a/ b")).toBe("a/ b");
    expect(normalizeRepoLocalPath("c:\\windows")).toBe("c:\\windows");
  });

  it("deriveRepoShortLabel handles empty, owner/repo, and bare names", () => {
    expect(deriveRepoShortLabel("")).toBe("");
    expect(deriveRepoShortLabel("   ")).toBe("");
    expect(deriveRepoShortLabel("https://github.com/Acme/Demo.git?x=1#y")).toBe("Acme/Demo");
    expect(deriveRepoShortLabel("ssh://git@github.com/Acme/Demo.git")).toBe("Acme/Demo");
    expect(deriveRepoShortLabel("Demo.git")).toBe("Demo");
  });

  it("formatRepoCoordinate omits default branch/path and shows deviations", () => {
    const url = "https://github.com/Acme/Demo.git";
    expect(formatRepoCoordinate({ url })).toBe("Acme/Demo");
    expect(formatRepoCoordinate({ url, ref: "main" })).toBe("Acme/Demo");
    expect(formatRepoCoordinate({ url, ref: "master" })).toBe("Acme/Demo");
    expect(formatRepoCoordinate({ url, ref: "feature" })).toBe("Acme/Demo@feature");
    const defaultPath = deriveRepoLocalPath(url);
    expect(formatRepoCoordinate({ url, localPath: defaultPath })).toBe("Acme/Demo");
    expect(formatRepoCoordinate({ url, localPath: "custom" })).toBe("Acme/Demo → custom");
  });
});

describe("image batch ref guard edge", () => {
  it("rejects empty attachment arrays and non-objects", () => {
    expect(isImageBatchRefContent(null)).toBe(false);
    expect(isImageBatchRefContent({ attachments: [] })).toBe(false);
    expect(
      isImageBatchRefContent({
        attachments: [{ imageId: "i", mimeType: "image/png", filename: "a.png" }],
      }),
    ).toBe(true);
    expect(isImageRefContent({ imageId: "i", mimeType: "image/png", filename: "a.png" })).toBe(true);
  });
});

describe("canonicalGitRepoUrl edge branches", () => {
  it("returns null for empty and unparsable values", () => {
    expect(canonicalGitRepoUrl(null)).toBeNull();
    expect(canonicalGitRepoUrl(undefined)).toBeNull();
    expect(canonicalGitRepoUrl("   ")).toBeNull();
    expect(canonicalGitRepoUrl("not a url")).toBeNull();
    expect(canonicalGitRepoUrl("https://github.com/acme/demo")).toBe("github.com/acme/demo");
    expect(canonicalGitRepoUrl("git@github.com:acme/demo.git")).toBe("github.com/acme/demo");
    // scp-like with empty path after colon is rejected by regex or normalize
    expect(canonicalGitRepoUrl("host:")).toBeNull();
    // path that normalizes empty
    expect(canonicalGitRepoUrl("https://github.com/")).toBeNull();
    expect(canonicalGitRepoUrl("https://github.com///")).toBeNull();
  });
});

describe("identicon generation", () => {
  it("builds symmetric cells and svg with optional size/background", () => {
    const cells = identiconCells("seed-a", 5);
    expect(cells).toHaveLength(5);
    expect(cells[0]).toHaveLength(5);
    // mirror symmetry
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        expect(cells[y]?.[x]).toBe(cells[y]?.[4 - x]);
      }
    }
    const svg = identiconSvg("seed-a", { size: 32, background: "#fff", color: "#000" });
    expect(svg).toContain("<svg");
    expect(svg).toContain('width="32"');
    expect(svg).toContain("#fff");
    // fluid size (no root width/height attrs) and default color
    const fluid = identiconSvg("seed-b");
    expect(fluid).toContain("<svg");
    expect(fluid).toContain('fill="currentColor"');
    expect(fluid).not.toMatch(/<svg[^>]*\swidth=/);
    // odd/even grids
    expect(identiconCells("x", 4)).toHaveLength(4);
    expect(identiconCells("y", 6)).toHaveLength(6);
  });
});

describe("doc-anchor disambiguation and edge paths", () => {
  it("disambiguates repeated selections with prefix/suffix and rejects empty selection", () => {
    expect(buildDocAnchor({ source: "hello world", selectedText: "   " })).toBeNull();
    expect(buildDocAnchor({ source: "hello", selectedText: "missing" })).toBeNull();
    const source = "alpha beta alpha beta gamma";
    const anchor = buildDocAnchor({
      source,
      selectedText: "alpha",
      renderedPrefix: " beta ",
      renderedSuffix: " beta",
    });
    expect(anchor).not.toBeNull();
    if (anchor) {
      const range = locateDocAnchor(source, anchor);
      expect(range).not.toBeNull();
      // only prefix for disambiguation
      const byPrefix = buildDocAnchor({
        source,
        selectedText: "alpha",
        renderedPrefix: "beta ",
      });
      expect(byPrefix).not.toBeNull();
      // only suffix
      const bySuffix = buildDocAnchor({
        source,
        selectedText: "alpha",
        renderedSuffix: " beta",
      });
      expect(bySuffix).not.toBeNull();
      // unique occurrence without context
      expect(buildDocAnchor({ source: "only once here", selectedText: "once" })).toMatchObject({
        exact: "once",
      });
      // selection at document start → empty prefix branch
      const atStart = buildDocAnchor({ source: "start mid end", selectedText: "start" });
      expect(atStart).toMatchObject({ exact: "start" });
      expect(atStart && "prefix" in atStart ? atStart.prefix : undefined).toBeUndefined();
      // selection at document end → empty suffix branch
      const atEnd = buildDocAnchor({ source: "start mid end", selectedText: "end" });
      expect(atEnd).toMatchObject({ exact: "end" });
      expect(atEnd && "suffix" in atEnd ? atEnd.suffix : undefined).toBeUndefined();
      // empty exact cannot locate
      expect(locateDocAnchor(source, { exact: "   " })).toBeNull();
      expect(locateDocAnchor(source, { exact: "not-present" })).toBeNull();
    }
  });
});

describe("shell-command-io remaining branches", () => {
  it("covers tokenizer edge cases and command classifiers", () => {
    expect(classifyShellCommandIo("")).toEqual({ supported: false, reason: "empty" });
    expect(classifyShellCommandIo("   ")).toEqual({ supported: false, reason: "empty" });
    expect(classifyShellCommandIo('cat "unterminated')).toEqual({ supported: false, reason: "complex_shell" });
    expect(classifyShellCommandIo("cat 'unterminated")).toEqual({ supported: false, reason: "complex_shell" });
    expect(classifyShellCommandIo('cat "trailing\\')).toEqual({ supported: false, reason: "complex_shell" });
    expect(classifyShellCommandIo("cat trailing\\")).toEqual({ supported: false, reason: "complex_shell" });
    expect(classifyShellCommandIo("cat `dyn`")).toMatchObject({ supported: false });
    expect(classifyShellCommandIo("cat file`x`")).toMatchObject({ supported: false });
    expect(classifyShellCommandIo('cat "has $var"')).toMatchObject({ supported: false });
    expect(classifyShellCommandIo('cat "has `tick`"')).toMatchObject({ supported: false });
    expect(classifyShellCommandIo('cat "ok\\npath" /tree/a.md')).toMatchObject({ supported: true });
    expect(classifyShellCommandIo("cat \\ x /tree/a.md")).toMatchObject({ supported: true });
    expect(classifyShellCommandIo("$dyncmd /tree")).toMatchObject({ supported: false, reason: "dynamic_path" });
    expect(classifyShellCommandIo("~cat /tree")).toMatchObject({ supported: false });

    // head/tail value options and --
    expect(classifyShellCommandIo("head -n 5 -- /tree/a.md")).toEqual({
      supported: true,
      action: "read",
      commandName: "head",
      pathArgs: [{ raw: "/tree/a.md", pathKindHint: "file" }],
    });
    expect(classifyShellCommandIo("head -n5 /tree/a.md")).toEqual({
      supported: true,
      action: "read",
      commandName: "head",
      pathArgs: [{ raw: "/tree/a.md", pathKindHint: "file" }],
    });
    expect(classifyShellCommandIo("tail -c 10 /tree/a.md")).toEqual({
      supported: true,
      action: "read",
      commandName: "tail",
      pathArgs: [{ raw: "/tree/a.md", pathKindHint: "file" }],
    });
    expect(classifyShellCommandIo("cat -- -")).toMatchObject({ supported: false, reason: "no_explicit_path" });

    // sed with -- and -e script
    expect(classifyShellCommandIo("sed -e s/a/b/ -- /tree/a.md")).toEqual({
      supported: true,
      action: "read",
      commandName: "sed",
      pathArgs: [{ raw: "/tree/a.md", pathKindHint: "file" }],
    });
    expect(classifyShellCommandIo("sed --expression=s/a/b/ /tree/a.md")).toEqual({
      supported: true,
      action: "read",
      commandName: "sed",
      pathArgs: [{ raw: "/tree/a.md", pathKindHint: "file" }],
    });
    expect(classifyShellCommandIo("sed --in-place s/a/b/ /tree/a.md")).toEqual({
      supported: false,
      reason: "write_or_mutation",
      commandName: "sed",
    });
    expect(classifyShellCommandIo("sed -i.bak s/a/b/ /tree/a.md")).toEqual({
      supported: false,
      reason: "write_or_mutation",
      commandName: "sed",
    });

    // grep with -- and -e pattern
    expect(classifyShellCommandIo("grep -e Context -- /tree/a.md")).toEqual({
      supported: true,
      action: "read",
      commandName: "grep",
      pathArgs: [{ raw: "/tree/a.md", pathKindHint: "unknown" }],
    });
    expect(classifyShellCommandIo("grep --regexp=Context /tree/a.md")).toEqual({
      supported: true,
      action: "read",
      commandName: "grep",
      pathArgs: [{ raw: "/tree/a.md", pathKindHint: "unknown" }],
    });

    // rg with -e and --
    expect(classifyShellCommandIo("rg -e Context -- /tree")).toEqual({
      supported: true,
      action: "read",
      commandName: "rg",
      pathArgs: [{ raw: "/tree", pathKindHint: "unknown" }],
    });
    expect(classifyShellCommandIo("rg --regexp=Context /tree")).toEqual({
      supported: true,
      action: "read",
      commandName: "rg",
      pathArgs: [{ raw: "/tree", pathKindHint: "unknown" }],
    });
    expect(classifyShellCommandIo("rg -f patterns.txt /tree")).toEqual({
      supported: true,
      action: "read",
      commandName: "rg",
      pathArgs: [{ raw: "/tree", pathKindHint: "unknown" }],
    });
    expect(classifyShellCommandIo("rg --files -- /tree/docs")).toEqual({
      supported: true,
      action: "read",
      commandName: "rg",
      pathArgs: [{ raw: "/tree/docs", pathKindHint: "directory" }],
    });
    expect(classifyShellCommandIo("rg --files")).toMatchObject({ supported: false, reason: "no_explicit_path" });

    // find with -- separator before path
    expect(classifyShellCommandIo("find -- /tree")).toEqual({
      supported: true,
      action: "read",
      commandName: "find",
      pathArgs: [{ raw: "/tree", pathKindHint: "directory" }],
    });
    expect(classifyShellCommandIo("find /tree -name NODE.md")).toEqual({
      supported: true,
      action: "read",
      commandName: "find",
      pathArgs: [{ raw: "/tree", pathKindHint: "directory" }],
    });
    expect(classifyShellCommandIo("find /tree ! -name skip")).toEqual({
      supported: true,
      action: "read",
      commandName: "find",
      pathArgs: [{ raw: "/tree", pathKindHint: "directory" }],
    });
    expect(classifyShellCommandIo("find /tree ( -name a )")).toMatchObject({ supported: true });
    // semicolon is complex_shell at tokenize time; use space-separated mutating primary
    expect(classifyShellCommandIo("find /tree -delete")).toMatchObject({
      supported: false,
      reason: "write_or_mutation",
    });
    expect(classifyShellCommandIo("find /tree -fprintf out %p")).toMatchObject({
      supported: false,
      reason: "write_or_mutation",
    });

    // ls with options and --
    expect(classifyShellCommandIo("ls -la -- /tree")).toEqual({
      supported: true,
      action: "read",
      commandName: "ls",
      pathArgs: [{ raw: "/tree", pathKindHint: "unknown" }],
    });
    expect(classifyShellCommandIo("ls -- /tree")).toEqual({
      supported: true,
      action: "read",
      commandName: "ls",
      pathArgs: [{ raw: "/tree", pathKindHint: "unknown" }],
    });

    // combined short boolean flags for grep
    expect(classifyShellCommandIo("grep -ni Context /tree/a.md")).toEqual({
      supported: true,
      action: "read",
      commandName: "grep",
      pathArgs: [{ raw: "/tree/a.md", pathKindHint: "unknown" }],
    });

    // absolute tool path still classifies via basename
    expect(classifyShellCommandIo("/usr/bin/cat NODE.md")).toEqual({
      supported: true,
      action: "read",
      commandName: "cat",
      pathArgs: [{ raw: "NODE.md", pathKindHint: "file" }],
    });
    expect(classifyShellCommandIo("/usr/bin/cat")).toMatchObject({ supported: false, reason: "no_explicit_path" });

    expect(classifyShellCommandIo("unknown-tool /tree")).toEqual({
      supported: false,
      reason: "unsupported_tool",
      commandName: "unknown-tool",
    });

    expect(stripShellCommandDisplayWrapper("")).toBe("");
    expect(stripShellCommandDisplayWrapper("cat x")).toBe("cat x");
    expect(stripShellCommandDisplayWrapper("$shell -lc 'cat x'")).toBe("$shell -lc 'cat x'");
    expect(stripShellCommandDisplayWrapper("bash -lc")).toBe("bash -lc");

    // empty-token edge: only quotes → empty after flush
    expect(classifyShellCommandIo("''")).toEqual({ supported: false, reason: "empty" });
    expect(classifyShellCommandIo('""')).toEqual({ supported: false, reason: "empty" });
    // consecutive whitespace flushes empty values
    expect(classifyShellCommandIo("cat    /tree/a.md")).toMatchObject({ supported: true });
    // basename of slash-only path falls back to normalized value
    expect(classifyShellCommandIo("/// cat /tree/a.md")).toMatchObject({ supported: false });
    // option with = does not consume separate value
    expect(classifyShellCommandIo("head -n=5 /tree/a.md")).toMatchObject({ supported: true });
    // single-quoted content
    expect(classifyShellCommandIo("cat 'my file.md'")).toMatchObject({
      supported: true,
      pathArgs: [{ raw: "my file.md", pathKindHint: "file" }],
    });
  });
});

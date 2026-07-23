import { describe, expect, it } from "vitest";
import {
  buildCronRunKey,
  CRON_TRIGGER_METADATA_KEY,
  createCronJobRequestSchema,
  cronExpressionSchema,
  cronJobSchema,
  cronPreviewRequestSchema,
  cronTimezoneSchema,
  cronTriggerMetadataSchema,
  isCronTriggerMetadata,
  updateCronJobRequestSchema,
} from "../schemas/cron-job.js";

describe("cron expression schema", () => {
  it("normalizes whitespace to a single space between five fields", () => {
    expect(cronExpressionSchema.parse("  *   0  *   *  1  ")).toBe("* 0 * * 1");
  });

  it("rejects macros, seconds, and non-portable extensions", () => {
    expect(cronExpressionSchema.safeParse("@daily").success).toBe(false);
    expect(cronExpressionSchema.safeParse("0 0 0 * * *").success).toBe(false);
    expect(cronExpressionSchema.safeParse("0 0 L * *").success).toBe(false);
    expect(cronExpressionSchema.safeParse("0 0 * * 1#2").success).toBe(false);
    expect(cronExpressionSchema.safeParse("0 12 1 * +MON").success).toBe(false);
    expect(cronExpressionSchema.safeParse("0 0 15W * *").success).toBe(false);
    expect(cronExpressionSchema.safeParse("H 0 * * *").success).toBe(false);
  });

  it("accepts day and month aliases that Croner supports", () => {
    expect(cronExpressionSchema.parse("0 9 * * THU")).toBe("0 9 * * THU");
    expect(cronExpressionSchema.parse("0 9 * JUL *")).toBe("0 9 * JUL *");
    expect(cronExpressionSchema.parse("0 9 * MARCH *")).toBe("0 9 * MARCH *");
    expect(cronExpressionSchema.parse("0 9 * * WED")).toBe("0 9 * * WED");
  });
});

describe("cron timezone schema", () => {
  it("accepts and normalizes IANA zones", () => {
    expect(cronTimezoneSchema.parse("Asia/Taipei")).toBe("Asia/Taipei");
    expect(cronTimezoneSchema.parse("  America/New_York ")).toBe("America/New_York");
  });

  it("rejects unrecognized zones", () => {
    expect(cronTimezoneSchema.safeParse("Not/AZone").success).toBe(false);
    expect(cronTimezoneSchema.safeParse("").success).toBe(false);
  });
});

describe("cron job request schemas", () => {
  it("accepts a create body", () => {
    expect(
      createCronJobRequestSchema.parse({
        name: " daily triage ",
        schedule: "0 9 * * 1-5",
        timezone: "Asia/Taipei",
        prompt: "Triage the inbox.",
      }),
    ).toEqual({
      name: "daily triage",
      schedule: "0 9 * * 1-5",
      timezone: "Asia/Taipei",
      prompt: "Triage the inbox.",
    });
  });

  it("rejects empty update bodies and reserved fields", () => {
    expect(updateCronJobRequestSchema.safeParse({}).success).toBe(false);
    expect(updateCronJobRequestSchema.safeParse({ stateReason: "user_paused" }).success).toBe(false);
    expect(updateCronJobRequestSchema.safeParse({ chatMode: "reuse_control_chat" }).success).toBe(false);
    expect(updateCronJobRequestSchema.safeParse({ nextRunAt: null }).success).toBe(false);
  });

  it("accepts a partial update", () => {
    expect(updateCronJobRequestSchema.parse({ state: "paused" })).toEqual({ state: "paused" });
  });
});

describe("cron trigger metadata", () => {
  it("builds a stable run key and validates the reserved payload", () => {
    const scheduledFor = "2026-07-23T01:00:00.000Z";
    const runKey = buildCronRunKey("job-1", scheduledFor);
    expect(runKey).toBe("cron/job-1/2026-07-23T01:00:00.000Z");
    expect(
      cronTriggerMetadataSchema.parse({
        jobId: "job-1",
        scheduledFor,
        runKey,
      }),
    ).toEqual({ jobId: "job-1", scheduledFor, runKey });
    expect(
      isCronTriggerMetadata({
        [CRON_TRIGGER_METADATA_KEY]: { jobId: "job-1", scheduledFor, runKey },
      }),
    ).toBe(true);
  });
});

describe("cron job read model", () => {
  it("accepts the shared CronJob envelope", () => {
    const job = cronJobSchema.parse({
      id: "job-1",
      ownerMemberId: "member-1",
      controlChatId: "chat-1",
      agentId: "agent-1",
      name: "daily triage",
      chatMode: "reuse_control_chat",
      schedule: "0 9 * * 1-5",
      timezone: "Asia/Taipei",
      prompt: "Triage the inbox.",
      state: "active",
      stateReason: null,
      revision: 1,
      nextRunAt: "2026-07-23T01:00:00.000Z",
      outstanding: null,
      createdAt: "2026-07-22T00:00:00.000Z",
    });
    expect(job.chatMode).toBe("reuse_control_chat");
    expect(job.outstanding).toBeNull();
  });

  it("parses a preview request", () => {
    expect(
      cronPreviewRequestSchema.parse({
        schedule: "0 9 * * *",
        timezone: "Europe/London",
      }),
    ).toEqual({ schedule: "0 9 * * *", timezone: "Europe/London" });
  });
});

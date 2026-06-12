ALTER TABLE "members" ADD COLUMN "onboarding_suppressed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "onboarding_suppressed_reason" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "onboarding_completed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_onboarding_suppress_reason_check" CHECK (
  (
    "onboarding_suppressed_at" IS NULL
    AND "onboarding_suppressed_reason" IS NULL
  )
  OR (
    "onboarding_suppressed_at" IS NOT NULL
    AND "onboarding_suppressed_reason" IN ('finish_later', 'completed', 'invitee_skip')
  )
);
--> statement-breakpoint
UPDATE "members" AS m
SET
  "onboarding_completed_at" = u."onboarding_completed_at",
  "onboarding_suppressed_at" = u."onboarding_completed_at",
  "onboarding_suppressed_reason" = 'completed'
FROM "users" AS u
WHERE m."user_id" = u."id"
  AND m."status" = 'active'
  AND u."onboarding_completed_at" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "agents" AS a
    WHERE a."organization_id" = m."organization_id"
      AND a."status" = 'active'
      AND a."type" <> 'human'
      AND (
        a."manager_id" = m."id"
        OR a."visibility" = 'organization'
      )
  );
--> statement-breakpoint
UPDATE "members" AS m
SET
  "onboarding_suppressed_at" = u."onboarding_dismissed_at",
  "onboarding_suppressed_reason" = 'finish_later'
FROM "users" AS u
WHERE m."user_id" = u."id"
  AND m."status" = 'active'
  AND u."onboarding_completed_at" IS NULL
  AND u."onboarding_dismissed_at" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "agents" AS a
    WHERE a."organization_id" = m."organization_id"
      AND a."status" = 'active'
      AND a."type" <> 'human'
      AND (
        a."manager_id" = m."id"
        OR a."visibility" = 'organization'
      )
  );

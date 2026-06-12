-- Clear the onboarding-dismissal stamp for every completed user. The normal
-- completion path (`completeAndEnterChat`) used to call `dismissOnboarding()`
-- alongside `markOnboardingCompleted()` (a leftover from the retired inline
-- workspace stepper), so finishing onboarding also wrote
-- `onboarding_dismissed_at`. The workspace gate consults the dismissal BEFORE
-- the per-org readiness check, which made the org-level re-entry gate
-- unreachable for those users (issue #1025, P0-1).
--
-- Deliberately the broad form — every completed+dismissed row is cleared.
-- Timestamp comparisons cannot reliably separate the row classes (both old
-- endpoints stamp with millisecond-precision `new Date()` and the old client
-- fired the two writes in parallel, so a genuine artifact can carry EQUAL
-- stamps), so we accept the wider blast radius across all three classes:
--   1. completion artifacts (the bug this repairs) — the overwhelming bulk;
--   2. the 0043 backfill cohort (0043_onboarding_completed_at.sql copied
--      `dismissed_at` into the then-new column verbatim for legacy
--      dismissed-only users) — treating them as completed was 0043's own
--      accepted trade-off, and the worst post-clear outcome is one wizard
--      prompt in a not-yet-ready org with finish-later one click away;
--   3. dismiss-then-complete rows (finish later, then returned and finished)
--      — completion supersedes the earlier dismissal for the enter gate's
--      purpose.
-- Genuine finish-later users who never completed are dismissed-only and are
-- untouched by construction. Going forward the combination cannot reappear:
-- completion no longer writes the dismissal, a completed account has no
-- dismiss affordance (Settings hides the onboarding entry once completed),
-- and Resume clears the dismissal before re-entering the flow.
--
-- The NOTICE below records the class distribution in the boot log before the
-- clear, so the assumption ("equal/dismissed-first rows are a thin tail") is
-- checkable against production data after the deploy.
DO $$
DECLARE
  equal_stamps bigint;
  dismissed_before_completed bigint;
  dismissed_after_completed bigint;
BEGIN
  SELECT
    count(*) FILTER (WHERE "onboarding_dismissed_at" = "onboarding_completed_at"),
    count(*) FILTER (WHERE "onboarding_dismissed_at" < "onboarding_completed_at"),
    count(*) FILTER (WHERE "onboarding_dismissed_at" > "onboarding_completed_at")
  INTO equal_stamps, dismissed_before_completed, dismissed_after_completed
  FROM "users"
  WHERE "onboarding_completed_at" IS NOT NULL
    AND "onboarding_dismissed_at" IS NOT NULL;
  RAISE NOTICE '0062: clearing completed+dismissed stamps — equal=% dismissed_before=% dismissed_after=%',
    equal_stamps, dismissed_before_completed, dismissed_after_completed;
END $$;
--> statement-breakpoint
UPDATE "users"
SET "onboarding_dismissed_at" = NULL
WHERE "onboarding_completed_at" IS NOT NULL
  AND "onboarding_dismissed_at" IS NOT NULL;

-- Clear the onboarding-dismissal artifact stamped by the normal completion
-- path. `completeAndEnterChat` used to call `dismissOnboarding()` alongside
-- `markOnboardingCompleted()` (a leftover from the retired inline workspace
-- stepper), so every user who finished onboarding also carries
-- `onboarding_dismissed_at`. The workspace gate consults the dismissal BEFORE
-- the per-org readiness check, which made the org-level re-entry gate
-- unreachable for those users (issue #1025, P0-1).
--
-- Scope: only rows where the two stamps DIFFER. The completion artifact is
-- two independent server writes (PATCH dismissal + POST completion), so its
-- timestamps are close but never equal. Rows where they are exactly EQUAL
-- are the 0043 backfill cohort instead (0043_onboarding_completed_at.sql
-- copied `onboarding_dismissed_at` into the then-new column verbatim for
-- every dismissed-only legacy user) — a mix of genuine finish-later users
-- and pre-column completers we cannot tell apart, so we conservatively keep
-- their dismissal rather than resurrect auto-bounce for users who only ever
-- asked to hide the flow. Genuine post-0043 finish-later users are
-- dismissed-only (completion is stamped exclusively by walking kickoff to
-- success) and are untouched by construction. New completions no longer
-- write the dismissal at all, and a completed account can no longer reach a
-- dismiss affordance (Settings hides the onboarding entry once completed,
-- and Resume clears the dismissal first), so the artifact cannot reappear.
UPDATE "users"
SET "onboarding_dismissed_at" = NULL
WHERE "onboarding_completed_at" IS NOT NULL
  AND "onboarding_dismissed_at" IS NOT NULL
  AND "onboarding_completed_at" <> "onboarding_dismissed_at";

-- Clear the onboarding-dismissal artifact stamped by the normal completion
-- path. `completeAndEnterChat` used to call `dismissOnboarding()` alongside
-- `markOnboardingCompleted()` (a leftover from the retired inline workspace
-- stepper), so every user who finished onboarding also carries
-- `onboarding_dismissed_at`. The workspace gate consults the dismissal BEFORE
-- the per-org readiness check, which made the org-level re-entry gate
-- unreachable for those users (issue #1025, P0-1).
--
-- The completed+dismissed combination is always a completion artifact:
-- genuine "finish later" users are dismissed-only (completion is stamped
-- exclusively by walking kickoff to success, which navigates away from the
-- flow). Clearing it restores the documented gate behavior for existing
-- accounts; new completions no longer write the dismissal at all.
UPDATE "users"
SET "onboarding_dismissed_at" = NULL
WHERE "onboarding_completed_at" IS NOT NULL
  AND "onboarding_dismissed_at" IS NOT NULL;

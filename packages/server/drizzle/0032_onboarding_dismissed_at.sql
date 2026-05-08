-- Onboarding stepper dismissal flag. Decoupled from the server-side
-- `onboardingStep` enum so the stepper keeps rendering across all three
-- UI steps (server-side onboardingStep flips to `completed` at the end of
-- Step 2; Step 3 is purely client-driven and the stepper must keep
-- showing during the tree-init chat).
--
-- See docs/new-user-onboarding-design.md §8.
--
-- NULL  → stepper renders
-- value → user clicked the `✕`; stepper unmounts. Irreversible from UI v1.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "onboarding_dismissed_at" timestamp with time zone;

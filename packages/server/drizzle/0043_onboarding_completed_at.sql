-- Onboarding terminal-state stamp. Distinct from `onboarding_dismissed_at`:
--
--   * `onboarding_dismissed_at` means "the user clicked ✕ on the stepper" —
--     a UI hide, not a setup-complete signal. The user can resume the
--     wizard from Settings → Onboarding to land back on whichever step is
--     still incomplete.
--
--   * `onboarding_completed_at` means "the user actually walked Step 3 to
--     success" (admin Continue, invitee Confirm/Continue). Once set, the
--     Settings → Onboarding entry point and Resume button disappear
--     permanently. Subsequent tree / source-repo edits go through Settings
--     → Team and /agents/:uuid.
--
-- The two stamps are intentionally orthogonal: `inferOnboardingStep()`
-- keeps its existing "infer from current resources" semantics and never
-- consults this column. This field is UI-gate only.
--
-- Backfill: every already-dismissed user is treated as completed. The pre-
-- column population (mid-2025) had no terminal-state concept, so the only
-- signal we have is "they hid the stepper" — and the alternative (showing
-- the Onboarding sidebar entry to every legacy user forever) is worse than
-- the off-by-one risk that a few users dismissed-without-finishing and
-- will lose their Resume affordance.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "onboarding_completed_at" timestamp with time zone;

--> statement-breakpoint
UPDATE "users"
   SET "onboarding_completed_at" = "onboarding_dismissed_at"
 WHERE "onboarding_dismissed_at" IS NOT NULL
   AND "onboarding_completed_at" IS NULL;

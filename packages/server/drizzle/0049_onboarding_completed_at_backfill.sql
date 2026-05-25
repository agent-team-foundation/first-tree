-- Backfill `onboarding_completed_at` for users who already finished setup,
-- so the standalone `/onboarding` gate never yanks them back in on deploy.
--
-- Context: `shouldEnterOnboarding()` now redirects a server-`completed` user
-- (computer + agent both exist) into `/onboarding` to resume the Context Tree
-- kickoff. That is correct for someone who created an agent but never ran the
-- kickoff — but it would ALSO drag a genuinely-finished legacy user back into
-- the flow: one who predates the `onboarding_completed_at` column and never
-- dismissed the old stepper has step=`completed` with a null stamp. Migration
-- 0043 only backfilled *dismissed* users (`completed_at = dismissed_at`), so
-- those finished-but-never-dismissed users are unprotected.
--
-- This one-shot backfill stamps every user who is already "completed" by the
-- exact definition `inferOnboardingStep()` uses (>= 1 client AND >= 1 active,
-- non-human agent they manage through an active membership) and isn't stamped
-- yet. It only ever ADDS a terminal stamp, so it strictly REDUCES redirects
-- (never introduces one) and is safe to re-run on any environment.

UPDATE "users" AS u
   SET "onboarding_completed_at" = now()
 WHERE u."onboarding_completed_at" IS NULL
   AND EXISTS (
         SELECT 1 FROM "clients" AS c
          WHERE c."user_id" = u."id"
       )
   AND EXISTS (
         SELECT 1
           FROM "agents" AS a
           JOIN "members" AS m ON m."id" = a."manager_id"
          WHERE m."user_id" = u."id"
            AND m."status" = 'active'
            AND a."type" <> 'human'
            AND a."status" = 'active'
       );

-- Optional context-tree GitHub URL bound to this organization. Cache only —
-- the source-of-truth binding lives in each source repo's
-- `.first-tree/local-tree.json`. This column lets the onboarding UI and
-- future agent spawns know about the tree without re-reading every source
-- repo.
--
-- Set during Step 3 onboarding via:
--   1. PATCH /orgs/:orgId  with `{ treeUrl }`  (web Path A — user pastes
--      an existing tree URL into the Step 3 view)
--   2. `first-tree-hub org bind-tree <url>`  (Path B — agent reports
--      the URL of a tree it just created via the same PATCH endpoint)
--
-- See docs/new-user-onboarding-design.md §7.4 (Step 3 design).
--
-- NULL  → no tree configured yet
-- value → bound to this GitHub URL

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "tree_url" text;

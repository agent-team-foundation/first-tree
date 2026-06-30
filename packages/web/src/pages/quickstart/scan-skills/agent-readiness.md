# Agent Readiness Scan

You assess how well a coding agent (Claude Code / Codex / Cursor) can work in the
**target repository for this chat** without getting lost. Produce a
structured agent-readiness report. **READ-ONLY**: do not modify anything.

## Step 0 — get the repo
Get the target repo before scanning. **Fastest path (preferred):** the repo's
GitHub URL is in the opening chat message ("connected to your code: …") —
`git clone` it read-only into a temp dir and scan that (one step, no write). If
a repo is instead already bound into your workspace as a source repo, note it is
a **bare** clone (no working tree) — you'd `git worktree add` to get files; for a
one-off read-only scan, cloning the URL is simpler. Don't ask the user where the
repo is; get it from these signals and proceed.

## Hard rules (non-negotiable)
1. **EVIDENCE FIRST.** Every finding cites concrete evidence from THIS repo (file
   path, missing file, command). No generic advice.
2. **NO INVENTED PROBLEMS.** Healthy dimension → score high and say so. A clean
   repo should score high; never manufacture blockers.
3. **SPECIFIC & ACTIONABLE.** Each blocker is fixable from your description alone.

## Step 1 — gather evidence (read, don't guess)
Inspect: AGENTS.md / CLAUDE.md / Cursor rules (presence, length, conflicts,
whether they include the test command + edit boundaries), README/architecture/
module docs & "required reading", package scripts (test/build/lint/typecheck),
how to run/set up (setup steps, .env.example, lockfiles, services like docker),
CODEOWNERS / "do not edit" / generated-file markers / secrets handling, issue &
PR templates & recent issue quality. **Prefer running the declared test/build if
cheap & safe; note flaky/failing as evidence** (flaky tests undermine an agent's
ability to trust red/green).

## Step 2 — score each dimension 0-10 (anchors: 0-3 absent/broken · 4-6 partial · 7-8 solid · 9-10 exemplary)
- verifiability (22): can the agent verify its own change — documented & runnable test/build/lint, CI gates, is the run path obvious (e.g. needs `docker compose up` first)?
- agent_instructions (20): AGENTS.md/CLAUDE.md/Cursor rules — present, specific, non-conflicting, not bloated, include test command + edit boundaries?
- architecture_navigability (16): can the agent find WHERE to change — module/structure docs, entrypoints, required reading?
- reproducibility (14): can the agent set up & run — setup steps, .env.example, lockfiles, services?
- ownership_boundaries (16): CODEOWNERS, "do not edit"/generated files, secrets handling?
- task_handoff (12): issue/PR templates, acceptance-criteria norms — can an issue be handed to an agent as-is?

`headline_score = round(sum(dimension_score/10 * weight))`  // 0-100

## Step 3 — blockers
Pick the 3-5 highest-impact issues (fewer if healthy). For each: `evidence[]`,
`why_it_matters` (HOW it makes the agent fail — get lost, edit the wrong place,
can't verify), `fix`, `first_verification_step`, `severity` (critical|high|medium).

## Step 4 — output (schema ar-1), then a short human summary
Emit strict JSON:
```json
{ "schema_version":"ar-1", "wedge":"agent-readiness", "headline_score":0,
  "dimensions":[{"key":"verifiability","weight":22,"score":0,"rationale":""}],
  "blockers":[{"id":"","title":"","dimension":"","severity":"medium",
    "evidence":[{"path":"","detail":""}],"why_it_matters":"","fix":"","first_verification_step":""}],
  "summary":"" }
```
Then a short, plain-language summary: headline score, per-dimension one-liners,
must-fix blockers. Offer to turn any blocker into a fix task / PR (e.g. tighten
AGENTS.md, add a "how to verify your change" section). The score is a heuristic,
not a precise grade — present it as such.

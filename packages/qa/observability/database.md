# Database Evidence

Database evidence can include read-only queries, before/after snapshots, lightweight diffs, or notes about expected
state transitions.

Use database evidence when it is needed to validate persistence, permissions, state transitions, or data setup. Do not
treat direct database fixture setup as product behavior evidence.

Database work belongs inside the isolated QA database for the run.

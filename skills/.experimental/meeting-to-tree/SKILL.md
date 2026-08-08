---
name: meeting-to-tree
description: Turn exact meeting records that the user supplies into durable Context Tree updates. Use when a user asks to sync meeting minutes, transcripts, AI notes, decision records, or related meeting artifacts into the team's Context Tree: read the exact sources, reconcile chronology, identify durable decisions and constraints, map relevant participants to First Tree members, confirm only unsettled claims, and hand the meeting source material to first-tree-write. Do not use for a summary-only request, calendar discovery, meeting search, provider authorization, or scheduled capture.
---

# Meeting to Tree

Turn one logical meeting's exact source artifacts into reviewable Context Tree
updates. Use existing readers, First Tree member communication, and
`first-tree-write`; do not build a parallel reader, confirmation store, or Tree
writer.

## Establish the meeting source

- Require at least one concrete meeting artifact and clear intent to update the
  Context Tree. If either is missing, ask for it and stop.
- Process one logical meeting at a time. When supplied artifacts may belong to
  different meetings, separate them using explicit source evidence or ask the
  user to group them.
- Use the environment's ordinary reader for each exact provider document,
  attachment, local file, or pasted record. For a Feishu source, use the
  available Feishu reader or CLI; keep provider authorization, download, OCR,
  parsing, completeness, and revision handling in that reader layer.
- Do not use a calendar, search for related meetings, scan a time window, or
  follow links embedded in a source to discover adjacent material.
- Preserve the user-declared or document-visible order. If order is unknown,
  do not infer that one artifact overrides another.
- If an artifact is unreadable or incomplete, identify the gap. When the gap
  could contain a correction or later decision, do not call the affected point
  settled.
- Use the exact source through the ordinary reader in the current task. If the
  reader already provides a transient local file, reuse it. Do not create or
  retain an additional raw copy solely for this Skill. Never write raw meeting
  content to the Context Tree, a source repository, or parallel persistent
  state.

## Identify durable Tree candidates

Read the available artifacts in order and identify claims that may change
durable team context:

- a decision or explicit non-choice and its surviving rationale;
- a constraint future work must respect;
- a durable ownership or responsibility change;
- a cross-domain relationship.

For every candidate:

1. Separate proposals, discussion, and final statements.
2. Scan all later material for correction, withdrawal, replacement,
   disagreement, completion, or cancellation.
3. Keep only the surviving current statement.
4. Preserve the surviving rationale, qualifiers, and consequences.
5. Distinguish supported conclusions from uncertain interpretations.

Progress, plans, actions, blockers, risks, and other member-specific updates
are signals, not required output categories. Consider them only when they
establish or change a durable candidate above. Do not create a complete meeting
summary before applying the Tree write bar.

Evidence strength matters:

- Human-confirmed minutes or an explicit decision record may confirm an item
  when wording is unambiguous and no later material overrides it.
- AI-generated notes may identify an item but cannot alone prove human
  confirmation.
- A transcript confirms only what it explicitly records. Do not infer speaker
  identity, authority, or agreement from participation.
- When provenance or wording is ambiguous, state the uncertainty instead of
  promoting it to a fact.

Before mapping members or sending any confirmation, apply the Context Tree
Double Test as a preliminary filter. Keep a claim only when it both establishes
or changes context future agents must respect and would remain durable if the
meeting's implementation work were rewritten. `first-tree-write` will reapply
the normal write gate after any confirmation reply.

## Match members and confirm unsettled claims

- Identify participants only from the supplied meeting record. When routing a
  confirmation or evaluating responsibility context, match them to First Tree
  members using member context available in the current environment. Do not
  guess when names or identities are ambiguous.
- Treat member mapping as routing information, not permission to change Context
  Tree ownership.
- Request confirmation only for a claim that is AI-only, ambiguous, disputed,
  weakly attributed, changes ownership or durable responsibility, or is
  otherwise not settled by the source. Do not repeat confirmation for a clear
  human-confirmed minute or explicit decision record, except that an ownership
  or durable responsibility change still requires confirmation from the
  affected human.
- Send the relevant member a concise claim-level question. Use the runtime's
  tracked question mechanism when that claim's Tree write depends on the
  answer, then incorporate any correction into the source bundle.
- An unanswered, disputed, or unresolved claim blocks only itself. Keep it out
  of normal Tree content and continue with independently settled durable
  candidates.
- If the environment cannot contact a needed member, report the unresolved
  claim and prepared confirmation prompt. Stop before the Tree write only when
  no independently settled durable candidate remains.

## Sync durable context

- Treat the exact meeting artifacts, relevant confirmation replies, and the
  user's Tree-write intent as one meeting source bundle for `first-tree-write`.
  Do not reimplement its Tree-read, target-selection, verification, branch, or
  PR workflow.
- Let `first-tree-write` apply the Context Tree Double Test. Sync only durable
  decisions, constraints, ownership or responsibility changes confirmed by the
  affected humans, and cross-domain relationships that future agents must
  respect.
- Do not dump the transcript, the complete meeting summary, routine progress,
  temporary plans, task lists, or transient blockers into normal Tree content.
  Those remain in their source systems unless they establish durable context.
- If nothing passes the Tree write bar, create no Tree change and explain why.
- Let `first-tree-write` verify the Tree and prepare the Tree PR or MR. Stop
  before review or merge.

## Finish

Report:

- the Context Tree nodes changed and the Tree PR or MR, or why no Tree write
  was warranted;
- any durable candidate still blocked on identity, attribution, conflict, or
  confirmation.

Never maintain discovery watermarks, processed ledgers, provider profiles,
organizer gates, schedules, or a parallel approval state.

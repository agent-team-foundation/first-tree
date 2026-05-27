# Message text + attachments — local design doc

Companion to Context Tree proposal `hub-message-text-attachments.20260521.md`
(merged). This file is the hub-side reference: invariants you need to keep in
mind when touching `services/message.ts`, `services/attachment.ts`,
`api/chats.ts`, the web composer, or the agent runtime handlers.

## Design at a glance

- **Single bubble.** One send = one message = one bubble. Text caption +
  arbitrary attachments ride together; the old "split per image" path is
  gone.
- **A′ on the wire.** Caption lives in `content`; attachments ride
  `metadata.attachments[]` as refs (no base64, no client-local ids). No new
  `format` value — old readers degrade gracefully (render the caption, ignore
  the attachments) and the @mention guard stays on the existing text path.
- **Route 2 / PG-bytea for storage.** Bytes persist in `message_attachments`
  (bytea, `STORAGE EXTERNAL`); messages carry only references. No new infra,
  follows the agent-avatar precedent, fits "PostgreSQL only / stateless
  server".
- **Authenticated fetch, no signed URLs.** Web uses the existing JWT, agent
  runtime uses its token; membership is re-checked per request. Avoids
  signed-URL churn against the 5s message refetch.
- **Two-phase bind.** Upload returns an unbound `attachmentId` (`message_id
  IS NULL`). At send time the server validates uploader / unbound / same-chat
  (C3), folds authoritative refs into `metadata.attachments`, and binds in
  the same transaction so a rollback drops both. `SELECT … FOR UPDATE` +
  `RETURNING` row-count closes the rebind race.

## Security double-gates

- **C1** — type gate: magicless safe text/docs (`.md/.csv/.json/...`) are
  allowed; executables (MZ/ELF/Mach-O/shebang) and a denied-extension list
  are rejected.
- **C2** — download response: only a png/jpeg/gif/webp allow-list is served
  inline; everything else (incl. SVG) is `Content-Disposition: attachment` +
  `X-Content-Type-Options: nosniff`.
- **C3** — at send: each referenced attachment must have been uploaded by
  the sender, still unbound, and in the same chat. Forged
  `metadata.attachments` keys submitted by clients are stripped before
  insert (see `SERVER_MANAGED_METADATA_KEYS` in shared).

## Invariants worth not breaking

- **`kind` is a pure function of mime.** Compute it via
  `deriveAttachmentKind(mime)`; the DB CHECK constraint
  (`message_attachments_kind_check`) defends against drift. Don't add a
  `kind` parameter to any service entry point — the caller has no say.
- **`metadata.attachments` is server-managed.** Listed in
  `SERVER_MANAGED_METADATA_KEYS`; `stripUntrustedMetadataKeys` removes it
  from every caller-supplied `metadata` before the insert. Adding a new
  server-managed key means adding to that set, not adding a new ad-hoc
  `delete`.
- **`getMessageAttachments(metadata)` is the only parser.** Server, web,
  agent runtime all share it (`packages/shared/src/schemas/message.ts`).
  Don't reinvent the `safeParse → .data.attachments` dance locally.
- **No internal links to external IM users.** Feishu downgrade is a
  filename + size list, never URLs (no Hub session on the far side). Real
  file forwarding via the Feishu upload API is a follow-up.

## Limits

- Single file ≤ 10 MB. Per-message total ≤ 25 MB. Max 9 attachments per
  message. Per-org quota 10 GB.

## Known follow-ups

- **drizzle meta snapshot chain is broken.** `drizzle-kit generate` cannot
  run; migration 0048 is hand-authored. Repairing the snapshot chain is the
  immediate post-merge follow-up (see PR #497 description).
- **org-quota overcommit window.** The quota check is non-atomic; two
  concurrent uploads can both pass at the cap. Worst case is bounded
  (single-file cap × concurrency); accepted for now because the obvious
  short fix (`SELECT … FOR UPDATE` on the org row) serialises all uploads
  within an org and is a worse trade-off than the rare overcommit.
- **Mime↔extension consistency.** Currently soft (we trust the magic-byte
  sniff plus the deny-list); future hardening can tighten by cross-checking
  extension against mime category.

## Future evolution — rich-text + inline attachments

If the product later wants **inline attachments** — images interleaved with
text in the caption, instead of stacked below it — **do not introduce a new
`format` value**. The A′ contract works as-is:

> Reuse `metadata.attachments[]` unchanged; in the caption use markdown
> `![alt](attachment:<attachmentId>)` to reference an attachment that is
> already in the same message's `metadata.attachments`.

Concretely:

```json
{
  "format": "markdown",
  "content": "Look at this UI: ![mockup](attachment:att_1)\n…and the data flow: ![flow](attachment:att_2)",
  "metadata": {
    "attachments": [
      { "attachmentId": "att_1", "mimeType": "image/png", "filename": "ui.png", "size": 12345, "kind": "image" },
      { "attachmentId": "att_2", "mimeType": "image/png", "filename": "flow.png", "size": 23456, "kind": "image" }
    ]
  }
}
```

Why this is the most restrained path:

- **No new `format`.** A′'s core property — `format` describes presentation
  intent, not data shape — stays intact.
- **No DB-schema change.** `message_attachments` and `metadata.attachments`
  are already what we need.
- **Old clients keep working.** A client that doesn't recognise the
  `attachment:` URI scheme renders the markdown as plain text; the
  attachments still show in the existing bottom-of-bubble list (rendered
  off `metadata.attachments`). Zero break.
- **Adapters keep their downgrades.** Feishu's filename-list downgrade
  works unchanged — it reads `metadata.attachments` and ignores the
  caption's URI scheme.

Rejected alternatives:

- **A new `format: "rich-text"` carrying block arrays** (Feishu `post` /
  Slack `blocks` style). This would require a new data model and parallel
  read paths in every consumer (server adapter, web renderer, agent
  runtime, feishu downgrade). It would also break older clients hard
  rather than degrading them. The block-array model is what other
  platforms built natively from day one — for us it's a migration
  liability, not a feature.
- **A new metadata key (e.g. `metadata.inlineSpec`) mapping caption
  positions to attachment ids.** Doable but redundant with the markdown
  URI approach, which already encodes the position implicitly.

When you actually need this: the implementation work is in the rendering
clients (markdown image renderer + URI scheme resolver), not on the wire
contract.

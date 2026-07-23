---
id: server-attachment-s3-governance
description: Validate attachment S3 storage governance — streaming upload, org quotas, presigned download, orphan sweep, and the S3-unconfigured degradation — against a booted server with MinIO.
areas: [server]
surfaces: [server, web, cli]
---

# Attachment S3 Storage Governance

## Goal

Verify that attachment bytes live in S3 (Postgres holds metadata only), that
org storage cannot grow unbounded, that downloads never buffer through the
server, and that unreferenced attachments are collected — without breaking
pre-migration (legacy bytea) attachments or S3-less deployments.

## Preconditions

- Run against a server booted with the `FIRST_TREE_S3_*` block pointing at a
  local MinIO (`docker compose up -d` provides one, bucket
  `first-tree-attachments`) and a scratch organization.
- A second server config WITHOUT the `FIRST_TREE_S3_*` block is needed for
  the degradation branch (a separate boot, not a live reconfigure).
- Direct MinIO access (`mc` or the AWS SDK) and SQL access to the server's
  database are required for byte-level and row-level evidence.
- Do not run against production; the sweep branch deletes storage.

## Operate

1. Upload an attachment via `POST /api/v1/orgs/:orgId/attachments`. Confirm
   the row has `object_key` set, `data` NULL, and `org_id` set, and that the
   bytes fetched straight from MinIO match the uploaded bytes.
2. Download via `GET /api/v1/attachments/:id` and confirm a 302 to a
   presigned URL with `Cache-Control: private, no-cache`; fetch the URL
   without any JWT and confirm the bytes and the `Content-Type` /
   `Content-Disposition` overrides. Repeat the GET with `If-None-Match` and
   confirm 304 never touches S3.
3. Quota branches: with the org near the 1000-object cap and near the 2 GiB
   byte cap (SQL-seeded rows are acceptable), upload and confirm 422 with
   `code: ATTACHMENT_QUOTA_EXCEEDED`. Upload a file over 10 MiB and confirm
   413 with no row and no S3 object left behind.
4. Lifecycle branches: age an unreferenced attachment past 24h
   (`created_at` backdated via SQL), wait for or trigger the orphan sweep,
   and confirm both row and object are gone. Repeat with the attachment
   referenced from a message (single image, batch image, and
   `metadata.attachments[]` shapes) and confirm survival. Edit a message to
   drop its last image reference and confirm the attachment disappears
   immediately.
5. Migration branch: insert a legacy row (bytes in `data`, no `object_key`),
   run `scripts/migrate-attachments-to-s3.ts`, and confirm the row flips to
   `object_key` + backfilled `org_id` + NULL `data`, downloads via 302, and
   a rerun is a no-op.
6. Degradation branch: boot without the `FIRST_TREE_S3_*` block; confirm
   upload answers 503 with `code: ATTACHMENT_STORAGE_NOT_CONFIGURED` while a
   legacy bytea row still downloads with 200.

## Observe

- No code path buffers a full attachment in the server: upload streams into
  S3 multipart, download is a 302 (server logs show no large allocations on
  either path).
- Partial S3 config (e.g. only `FIRST_TREE_S3_BUCKET` set) fails the boot
  with an actionable all-or-none error.
- Browser fetches that follow the 302 cross origins; confirm the deployment
  note about bucket CORS (AWS/R2 need it; MinIO allows `*` by default) and
  that the Authorization header is not forwarded to the S3 endpoint.

## Limitations

- Quota seeding via SQL bypasses the upload path; treat the 422 branches as
  governance checks, not upload-integrity checks.
- The orphan sweep cadence is config-driven; forcing `created_at` back is
  the intended way to exercise it in a short run.

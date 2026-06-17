UPDATE "inbox_entries"
SET "status" = 'acked',
    "acked_at" = COALESCE("acked_at", NOW())
WHERE "status" = 'failed';

ALTER TABLE "inbox_entries" ADD CONSTRAINT "ck_inbox_entries_status" CHECK ("inbox_entries"."status" IN ('pending', 'delivered', 'acked')) NOT VALID;

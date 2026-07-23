CREATE TABLE "auth_identity_provider_heads" (
	"provider" text PRIMARY KEY NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_auth_identity_provider_heads_provider" CHECK ("auth_identity_provider_heads"."provider" IN ('github', 'google')),
	CONSTRAINT "ck_auth_identity_provider_heads_generation" CHECK ("auth_identity_provider_heads"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "auth_identity_refresh_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"identity_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"source_authority_revision" bigint NOT NULL,
	"source_credential_revision" bigint NOT NULL,
	"source_credential_fingerprint" text NOT NULL,
	"phase" text NOT NULL,
	"lease_revision" bigint NOT NULL,
	"lease_id" text,
	"lease_until" timestamp with time zone,
	"hard_expires_at" timestamp with time zone NOT NULL,
	"terminal_reason" text,
	"terminal_receipt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_auth_identity_refresh_ops_provider" CHECK ("auth_identity_refresh_operations"."provider" IN ('github', 'google')),
	CONSTRAINT "ck_auth_identity_refresh_ops_phase" CHECK ("auth_identity_refresh_operations"."phase" IN (
        'reserved',
        'provider_dispatched',
        'terminal_success',
        'terminal_invalid',
        'terminal_uncertain',
        'cancelled_pre_dispatch',
        'superseded'
      )),
	CONSTRAINT "ck_auth_identity_refresh_ops_authority_revision" CHECK ("auth_identity_refresh_operations"."source_authority_revision" > 0),
	CONSTRAINT "ck_auth_identity_refresh_ops_credential_revision" CHECK ("auth_identity_refresh_operations"."source_credential_revision" > 0),
	CONSTRAINT "ck_auth_identity_refresh_ops_lease_revision" CHECK ("auth_identity_refresh_operations"."lease_revision" > 0),
	CONSTRAINT "ck_auth_identity_refresh_ops_terminal_reason" CHECK ("auth_identity_refresh_operations"."terminal_reason" IS NULL
        OR "auth_identity_refresh_operations"."terminal_reason" IN (
          'invalid_grant',
          'refresh_uncertain',
          'cancelled_pre_dispatch',
          'superseded'
        )),
	CONSTRAINT "ck_auth_identity_refresh_ops_expiry_order" CHECK ("auth_identity_refresh_operations"."hard_expires_at" > "auth_identity_refresh_operations"."created_at"),
	CONSTRAINT "ck_auth_identity_refresh_ops_lease_shape" CHECK ((
        (
          "auth_identity_refresh_operations"."lease_id" IS NULL
          AND "auth_identity_refresh_operations"."lease_until" IS NULL
        )
        OR (
          "auth_identity_refresh_operations"."lease_id" IS NOT NULL
          AND "auth_identity_refresh_operations"."lease_until" IS NOT NULL
          AND "auth_identity_refresh_operations"."lease_revision" > 0
          AND "auth_identity_refresh_operations"."lease_until" > "auth_identity_refresh_operations"."created_at"
          AND "auth_identity_refresh_operations"."lease_until" <= "auth_identity_refresh_operations"."hard_expires_at"
        )
      )),
	CONSTRAINT "ck_auth_identity_refresh_ops_phase_shape" CHECK ((
        (
          "auth_identity_refresh_operations"."phase" IN ('reserved', 'provider_dispatched')
          AND "auth_identity_refresh_operations"."lease_id" IS NOT NULL
          AND "auth_identity_refresh_operations"."lease_until" IS NOT NULL
          AND "auth_identity_refresh_operations"."lease_revision" > 0
          AND "auth_identity_refresh_operations"."terminal_reason" IS NULL
          AND "auth_identity_refresh_operations"."terminal_receipt" IS NULL
        )
        OR (
          "auth_identity_refresh_operations"."phase" = 'terminal_success'
          AND "auth_identity_refresh_operations"."lease_id" IS NULL
          AND "auth_identity_refresh_operations"."lease_until" IS NULL
          AND "auth_identity_refresh_operations"."terminal_reason" IS NULL
          AND "auth_identity_refresh_operations"."terminal_receipt" IS NOT NULL
        )
        OR (
          "auth_identity_refresh_operations"."phase" = 'terminal_invalid'
          AND "auth_identity_refresh_operations"."lease_id" IS NULL
          AND "auth_identity_refresh_operations"."lease_until" IS NULL
          AND "auth_identity_refresh_operations"."terminal_reason" IS NOT NULL
          AND "auth_identity_refresh_operations"."terminal_reason" = 'invalid_grant'
          AND "auth_identity_refresh_operations"."terminal_receipt" IS NOT NULL
        )
        OR (
          "auth_identity_refresh_operations"."phase" = 'terminal_uncertain'
          AND "auth_identity_refresh_operations"."lease_id" IS NULL
          AND "auth_identity_refresh_operations"."lease_until" IS NULL
          AND "auth_identity_refresh_operations"."terminal_reason" IS NOT NULL
          AND "auth_identity_refresh_operations"."terminal_reason" = 'refresh_uncertain'
          AND "auth_identity_refresh_operations"."terminal_receipt" IS NOT NULL
        )
        OR (
          "auth_identity_refresh_operations"."phase" = 'cancelled_pre_dispatch'
          AND "auth_identity_refresh_operations"."lease_id" IS NULL
          AND "auth_identity_refresh_operations"."lease_until" IS NULL
          AND "auth_identity_refresh_operations"."terminal_reason" IS NOT NULL
          AND "auth_identity_refresh_operations"."terminal_reason" = 'cancelled_pre_dispatch'
          AND "auth_identity_refresh_operations"."terminal_receipt" IS NOT NULL
        )
        OR (
          "auth_identity_refresh_operations"."phase" = 'superseded'
          AND "auth_identity_refresh_operations"."lease_id" IS NULL
          AND "auth_identity_refresh_operations"."lease_until" IS NULL
          AND "auth_identity_refresh_operations"."terminal_reason" IS NOT NULL
          AND "auth_identity_refresh_operations"."terminal_reason" = 'superseded'
          AND "auth_identity_refresh_operations"."terminal_receipt" IS NOT NULL
        )
      ))
);
--> statement-breakpoint
CREATE TABLE "auth_identity_retirement_fences" (
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"retired_identity_id" text NOT NULL,
	"retired_user_id" text NOT NULL,
	"retired_generation" bigint NOT NULL,
	"retired_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pk_auth_identity_retirement_fences" PRIMARY KEY("provider","subject"),
	CONSTRAINT "ck_auth_identity_retirement_fences_provider" CHECK ("auth_identity_retirement_fences"."provider" IN ('github', 'google')),
	CONSTRAINT "ck_auth_identity_retirement_fences_generation" CHECK ("auth_identity_retirement_fences"."retired_generation" >= 0),
	CONSTRAINT "ck_auth_identity_retirement_fences_expiry_order" CHECK ("auth_identity_retirement_fences"."expires_at" > "auth_identity_retirement_fences"."retired_at")
);
--> statement-breakpoint
CREATE TABLE "oauth_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"flow_kind" text NOT NULL,
	"provider" text NOT NULL,
	"server_authority" text NOT NULL,
	"provider_generation" bigint NOT NULL,
	"public_handle_hash" text NOT NULL,
	"replay_secret_hash" text NOT NULL,
	"verifier_hash" text NOT NULL,
	"flow_proof_hash" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"payload_key_id" text NOT NULL,
	"user_id" text,
	"identity_id" text,
	"phase" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"receipt_id" text,
	"bootstrap_envelope" text,
	"bootstrap_digest" text,
	"bootstrap_key_id" text,
	"mint_lease_revision" bigint DEFAULT 0 NOT NULL,
	"mint_lease_id" text,
	"mint_lease_until" timestamp with time zone,
	"finalization_lease_revision" bigint DEFAULT 0 NOT NULL,
	"finalization_lease_id" text,
	"finalization_lease_until" timestamp with time zone,
	"terminal_envelope" text,
	"terminal_key_id" text,
	"terminal_at" timestamp with time zone,
	"terminal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_oauth_transactions_kind" CHECK ("oauth_transactions"."kind" IN ('acquisition', 'management')),
	CONSTRAINT "ck_oauth_transactions_flow_kind" CHECK ("oauth_transactions"."flow_kind" IN (
        'acquisition_sign_in',
        'identity_link',
        'identity_unlink',
        'github_install_return'
      )),
	CONSTRAINT "ck_oauth_transactions_provider" CHECK ("oauth_transactions"."provider" IN ('github', 'google')),
	CONSTRAINT "ck_oauth_transactions_phase" CHECK ("oauth_transactions"."phase" IN (
        'issued',
        'provider_exchanging',
        'bootstrap_committed',
        'minting',
        'management_finalizing',
        'terminal_success',
        'terminal_failure',
        'cancelled'
      )),
	CONSTRAINT "ck_oauth_transactions_kind_flow" CHECK ((
        ("oauth_transactions"."kind" = 'acquisition' AND "oauth_transactions"."flow_kind" = 'acquisition_sign_in')
        OR (
          "oauth_transactions"."kind" = 'management'
          AND "oauth_transactions"."flow_kind" IN ('identity_link', 'identity_unlink', 'github_install_return')
        )
      )),
	CONSTRAINT "ck_oauth_transactions_provider_flow" CHECK ("oauth_transactions"."flow_kind" <> 'github_install_return' OR "oauth_transactions"."provider" = 'github'),
	CONSTRAINT "ck_oauth_transactions_kind_phase" CHECK ((
        (
          "oauth_transactions"."kind" = 'acquisition'
          AND "oauth_transactions"."phase" IN (
            'issued',
            'provider_exchanging',
            'bootstrap_committed',
            'minting',
            'terminal_success',
            'terminal_failure',
            'cancelled'
          )
        )
        OR (
          "oauth_transactions"."kind" = 'management'
          AND "oauth_transactions"."phase" IN (
            'issued',
            'provider_exchanging',
            'management_finalizing',
            'terminal_success',
            'terminal_failure',
            'cancelled'
          )
        )
      )),
	CONSTRAINT "ck_oauth_transactions_provider_generation" CHECK ("oauth_transactions"."provider_generation" >= 0),
	CONSTRAINT "ck_oauth_transactions_mint_lease_revision" CHECK ("oauth_transactions"."mint_lease_revision" >= 0),
	CONSTRAINT "ck_oauth_transactions_finalization_lease_revision" CHECK ("oauth_transactions"."finalization_lease_revision" >= 0),
	CONSTRAINT "ck_oauth_transactions_expiry_order" CHECK ("oauth_transactions"."expires_at" > "oauth_transactions"."created_at"
        AND "oauth_transactions"."expires_at" <= "oauth_transactions"."created_at" + INTERVAL '10 minutes'),
	CONSTRAINT "ck_oauth_transactions_terminal_time" CHECK ("oauth_transactions"."terminal_at" IS NULL
        OR (
          "oauth_transactions"."terminal_at" >= "oauth_transactions"."created_at"
          AND "oauth_transactions"."terminal_at" <= "oauth_transactions"."expires_at"
        )),
	CONSTRAINT "ck_oauth_transactions_bootstrap_tuple" CHECK ((
        (
          "oauth_transactions"."bootstrap_envelope" IS NULL
          AND "oauth_transactions"."bootstrap_digest" IS NULL
          AND "oauth_transactions"."bootstrap_key_id" IS NULL
        )
        OR (
          "oauth_transactions"."bootstrap_envelope" IS NOT NULL
          AND "oauth_transactions"."bootstrap_digest" IS NOT NULL
          AND "oauth_transactions"."bootstrap_key_id" IS NOT NULL
        )
      )),
	CONSTRAINT "ck_oauth_transactions_mint_lease_shape" CHECK ((
        (
          "oauth_transactions"."mint_lease_id" IS NULL
          AND "oauth_transactions"."mint_lease_until" IS NULL
        )
        OR (
          "oauth_transactions"."mint_lease_id" IS NOT NULL
          AND "oauth_transactions"."mint_lease_until" IS NOT NULL
          AND "oauth_transactions"."mint_lease_revision" > 0
          AND "oauth_transactions"."mint_lease_until" > "oauth_transactions"."created_at"
          AND "oauth_transactions"."mint_lease_until" <= "oauth_transactions"."expires_at"
        )
      )),
	CONSTRAINT "ck_oauth_transactions_finalization_lease_shape" CHECK ((
        (
          "oauth_transactions"."finalization_lease_id" IS NULL
          AND "oauth_transactions"."finalization_lease_until" IS NULL
        )
        OR (
          "oauth_transactions"."finalization_lease_id" IS NOT NULL
          AND "oauth_transactions"."finalization_lease_until" IS NOT NULL
          AND "oauth_transactions"."finalization_lease_revision" > 0
          AND "oauth_transactions"."finalization_lease_until" > "oauth_transactions"."created_at"
          AND "oauth_transactions"."finalization_lease_until" <= "oauth_transactions"."expires_at"
        )
      )),
	CONSTRAINT "ck_oauth_transactions_owner_shape" CHECK ((
        (
          "oauth_transactions"."flow_kind" = 'acquisition_sign_in'
          AND (
            (
              "oauth_transactions"."phase" IN ('issued', 'provider_exchanging')
              AND "oauth_transactions"."user_id" IS NULL
              AND "oauth_transactions"."identity_id" IS NULL
            )
            OR (
              "oauth_transactions"."phase" IN ('bootstrap_committed', 'minting', 'terminal_success')
              AND "oauth_transactions"."user_id" IS NOT NULL
              AND "oauth_transactions"."identity_id" IS NOT NULL
            )
            OR (
              "oauth_transactions"."phase" IN ('terminal_failure', 'cancelled')
              AND (
                (
                  "oauth_transactions"."bootstrap_envelope" IS NULL
                  AND "oauth_transactions"."user_id" IS NULL
                  AND "oauth_transactions"."identity_id" IS NULL
                )
                OR (
                  "oauth_transactions"."bootstrap_envelope" IS NOT NULL
                  AND "oauth_transactions"."user_id" IS NOT NULL
                  AND "oauth_transactions"."identity_id" IS NOT NULL
                )
              )
            )
          )
        )
        OR (
          "oauth_transactions"."flow_kind" = 'identity_link'
          AND "oauth_transactions"."user_id" IS NOT NULL
          AND ("oauth_transactions"."phase" <> 'terminal_success' OR "oauth_transactions"."identity_id" IS NOT NULL)
        )
        OR (
          "oauth_transactions"."flow_kind" IN ('identity_unlink', 'github_install_return')
          AND "oauth_transactions"."user_id" IS NOT NULL
          AND "oauth_transactions"."identity_id" IS NOT NULL
        )
      )),
	CONSTRAINT "ck_oauth_transactions_phase_shape" CHECK ((
        (
          "oauth_transactions"."phase" IN ('issued', 'provider_exchanging')
          AND "oauth_transactions"."receipt_id" IS NULL
          AND "oauth_transactions"."bootstrap_envelope" IS NULL
          AND "oauth_transactions"."bootstrap_digest" IS NULL
          AND "oauth_transactions"."bootstrap_key_id" IS NULL
          AND "oauth_transactions"."mint_lease_revision" = 0
          AND "oauth_transactions"."mint_lease_id" IS NULL
          AND "oauth_transactions"."mint_lease_until" IS NULL
          AND "oauth_transactions"."finalization_lease_revision" = 0
          AND "oauth_transactions"."finalization_lease_id" IS NULL
          AND "oauth_transactions"."finalization_lease_until" IS NULL
          AND "oauth_transactions"."terminal_envelope" IS NULL
          AND "oauth_transactions"."terminal_key_id" IS NULL
          AND "oauth_transactions"."terminal_at" IS NULL
          AND "oauth_transactions"."terminal_reason" IS NULL
        )
        OR (
          "oauth_transactions"."phase" = 'bootstrap_committed'
          AND "oauth_transactions"."receipt_id" IS NOT NULL
          AND "oauth_transactions"."bootstrap_envelope" IS NOT NULL
          AND "oauth_transactions"."bootstrap_digest" IS NOT NULL
          AND "oauth_transactions"."bootstrap_key_id" IS NOT NULL
          AND "oauth_transactions"."mint_lease_revision" = 0
          AND "oauth_transactions"."mint_lease_id" IS NULL
          AND "oauth_transactions"."mint_lease_until" IS NULL
          AND "oauth_transactions"."finalization_lease_revision" = 0
          AND "oauth_transactions"."finalization_lease_id" IS NULL
          AND "oauth_transactions"."finalization_lease_until" IS NULL
          AND "oauth_transactions"."terminal_envelope" IS NULL
          AND "oauth_transactions"."terminal_key_id" IS NULL
          AND "oauth_transactions"."terminal_at" IS NULL
          AND "oauth_transactions"."terminal_reason" IS NULL
        )
        OR (
          "oauth_transactions"."phase" = 'minting'
          AND "oauth_transactions"."receipt_id" IS NOT NULL
          AND "oauth_transactions"."bootstrap_envelope" IS NOT NULL
          AND "oauth_transactions"."bootstrap_digest" IS NOT NULL
          AND "oauth_transactions"."bootstrap_key_id" IS NOT NULL
          AND "oauth_transactions"."mint_lease_revision" > 0
          AND "oauth_transactions"."mint_lease_id" IS NOT NULL
          AND "oauth_transactions"."mint_lease_until" IS NOT NULL
          AND "oauth_transactions"."finalization_lease_revision" = 0
          AND "oauth_transactions"."finalization_lease_id" IS NULL
          AND "oauth_transactions"."finalization_lease_until" IS NULL
          AND "oauth_transactions"."terminal_envelope" IS NULL
          AND "oauth_transactions"."terminal_key_id" IS NULL
          AND "oauth_transactions"."terminal_at" IS NULL
          AND "oauth_transactions"."terminal_reason" IS NULL
        )
        OR (
          "oauth_transactions"."phase" = 'management_finalizing'
          AND "oauth_transactions"."receipt_id" IS NULL
          AND "oauth_transactions"."bootstrap_envelope" IS NULL
          AND "oauth_transactions"."bootstrap_digest" IS NULL
          AND "oauth_transactions"."bootstrap_key_id" IS NULL
          AND "oauth_transactions"."mint_lease_revision" = 0
          AND "oauth_transactions"."mint_lease_id" IS NULL
          AND "oauth_transactions"."mint_lease_until" IS NULL
          AND "oauth_transactions"."finalization_lease_revision" > 0
          AND "oauth_transactions"."finalization_lease_id" IS NOT NULL
          AND "oauth_transactions"."finalization_lease_until" IS NOT NULL
          AND "oauth_transactions"."terminal_envelope" IS NULL
          AND "oauth_transactions"."terminal_key_id" IS NULL
          AND "oauth_transactions"."terminal_at" IS NULL
          AND "oauth_transactions"."terminal_reason" IS NULL
        )
        OR (
          "oauth_transactions"."phase" = 'terminal_success'
          AND "oauth_transactions"."receipt_id" IS NOT NULL
          AND "oauth_transactions"."mint_lease_id" IS NULL
          AND "oauth_transactions"."mint_lease_until" IS NULL
          AND "oauth_transactions"."finalization_lease_id" IS NULL
          AND "oauth_transactions"."finalization_lease_until" IS NULL
          AND "oauth_transactions"."terminal_envelope" IS NOT NULL
          AND "oauth_transactions"."terminal_key_id" IS NOT NULL
          AND "oauth_transactions"."terminal_at" IS NOT NULL
          AND "oauth_transactions"."terminal_reason" IS NULL
          AND (
            (
              "oauth_transactions"."kind" = 'acquisition'
              AND "oauth_transactions"."bootstrap_envelope" IS NOT NULL
              AND "oauth_transactions"."bootstrap_digest" IS NOT NULL
              AND "oauth_transactions"."bootstrap_key_id" IS NOT NULL
              AND "oauth_transactions"."mint_lease_revision" > 0
              AND "oauth_transactions"."finalization_lease_revision" = 0
            )
            OR (
              "oauth_transactions"."kind" = 'management'
              AND "oauth_transactions"."bootstrap_envelope" IS NULL
              AND "oauth_transactions"."bootstrap_digest" IS NULL
              AND "oauth_transactions"."bootstrap_key_id" IS NULL
              AND "oauth_transactions"."mint_lease_revision" = 0
              AND "oauth_transactions"."finalization_lease_revision" > 0
            )
          )
        )
        OR (
          "oauth_transactions"."phase" IN ('terminal_failure', 'cancelled')
          AND "oauth_transactions"."mint_lease_id" IS NULL
          AND "oauth_transactions"."mint_lease_until" IS NULL
          AND "oauth_transactions"."finalization_lease_id" IS NULL
          AND "oauth_transactions"."finalization_lease_until" IS NULL
          AND "oauth_transactions"."terminal_envelope" IS NULL
          AND "oauth_transactions"."terminal_key_id" IS NULL
          AND "oauth_transactions"."terminal_at" IS NOT NULL
          AND "oauth_transactions"."terminal_reason" IS NOT NULL
          AND (
            (
              "oauth_transactions"."kind" = 'acquisition'
              AND "oauth_transactions"."finalization_lease_revision" = 0
              AND (
                (
                  "oauth_transactions"."receipt_id" IS NULL
                  AND "oauth_transactions"."bootstrap_envelope" IS NULL
                  AND "oauth_transactions"."bootstrap_digest" IS NULL
                  AND "oauth_transactions"."bootstrap_key_id" IS NULL
                  AND "oauth_transactions"."mint_lease_revision" = 0
                )
                OR (
                  "oauth_transactions"."receipt_id" IS NOT NULL
                  AND "oauth_transactions"."bootstrap_envelope" IS NOT NULL
                  AND "oauth_transactions"."bootstrap_digest" IS NOT NULL
                  AND "oauth_transactions"."bootstrap_key_id" IS NOT NULL
                )
              )
            )
            OR (
              "oauth_transactions"."kind" = 'management'
              AND "oauth_transactions"."receipt_id" IS NULL
              AND "oauth_transactions"."bootstrap_envelope" IS NULL
              AND "oauth_transactions"."bootstrap_digest" IS NULL
              AND "oauth_transactions"."bootstrap_key_id" IS NULL
              AND "oauth_transactions"."mint_lease_revision" = 0
            )
          )
        )
      ))
);
--> statement-breakpoint
ALTER TABLE "auth_identities" ADD COLUMN "authority_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD COLUMN "credential_revision" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD COLUMN "credential_state" text;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD COLUMN "pending_refresh_operation_id" text;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD COLUMN "retired_source_credential_revision" bigint;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD COLUMN "credential_state_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_auth_identity_refresh_ops_identity_source_revision" ON "auth_identity_refresh_operations" USING btree ("identity_id","source_credential_revision");--> statement-breakpoint
CREATE INDEX "idx_auth_identity_refresh_ops_identity" ON "auth_identity_refresh_operations" USING btree ("identity_id");--> statement-breakpoint
CREATE INDEX "idx_auth_identity_refresh_ops_phase_expiry" ON "auth_identity_refresh_operations" USING btree ("phase","hard_expires_at");--> statement-breakpoint
CREATE INDEX "idx_auth_identity_refresh_ops_provider_subject" ON "auth_identity_refresh_operations" USING btree ("provider","subject");--> statement-breakpoint
CREATE INDEX "idx_auth_identity_retirement_fences_expiry" ON "auth_identity_retirement_fences" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_oauth_transactions_public_handle_hash" ON "oauth_transactions" USING btree ("public_handle_hash");--> statement-breakpoint
CREATE INDEX "idx_oauth_transactions_provider_phase_expiry" ON "oauth_transactions" USING btree ("provider","phase","expires_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_transactions_expiry" ON "oauth_transactions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_transactions_user" ON "oauth_transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_transactions_identity" ON "oauth_transactions" USING btree ("identity_id");--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "ck_auth_identities_authority_revision" CHECK ("auth_identities"."authority_revision" > 0);--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "ck_auth_identities_credential_revision" CHECK ("auth_identities"."credential_revision" > 0);--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "ck_auth_identities_retired_source_revision" CHECK ("auth_identities"."retired_source_credential_revision" IS NULL OR "auth_identities"."retired_source_credential_revision" > 0);--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "ck_auth_identities_credential_state" CHECK ("auth_identities"."credential_state" IN ('active', 'refresh_pending', 'reauth_required'));--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "ck_auth_identities_credential_state_reason" CHECK ("auth_identities"."credential_state_reason" IN ('refresh_uncertain', 'invalid_grant', 'corrupt'));--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "ck_auth_identities_credential_state_coherence" CHECK ((
        (
          "auth_identities"."credential_state" IS NULL
          AND "auth_identities"."pending_refresh_operation_id" IS NULL
          AND "auth_identities"."retired_source_credential_revision" IS NULL
          AND "auth_identities"."credential_state_reason" IS NULL
        )
        OR (
          "auth_identities"."credential_state" = 'active'
          AND "auth_identities"."pending_refresh_operation_id" IS NULL
          AND "auth_identities"."retired_source_credential_revision" IS NULL
          AND "auth_identities"."credential_state_reason" IS NULL
        )
        OR (
          "auth_identities"."credential_state" = 'refresh_pending'
          AND "auth_identities"."pending_refresh_operation_id" IS NOT NULL
          AND "auth_identities"."retired_source_credential_revision" IS NOT NULL
          AND "auth_identities"."credential_revision" > "auth_identities"."retired_source_credential_revision"
          AND "auth_identities"."credential_revision" - "auth_identities"."retired_source_credential_revision" = 1
          AND "auth_identities"."credential_state_reason" IS NULL
        )
        OR (
          "auth_identities"."credential_state" = 'reauth_required'
          AND "auth_identities"."pending_refresh_operation_id" IS NULL
          AND "auth_identities"."retired_source_credential_revision" IS NOT NULL
          AND "auth_identities"."credential_revision" > "auth_identities"."retired_source_credential_revision"
          AND "auth_identities"."credential_revision" - "auth_identities"."retired_source_credential_revision" = 2
          AND "auth_identities"."credential_state_reason" IS NOT NULL
        )
      ));
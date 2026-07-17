import { z } from "zod";
import { runtimeProviderSchema } from "./runtime-provider.js";

/**
 * Provider model catalog — the list of model ids a computer's real provider
 * installation reports, discovered on demand by the daemon (never by the
 * server holding provider credentials). The web Model picker renders this
 * list; when discovery is unavailable it degrades to a free-form id input.
 *
 * Wire contract between daemon, server, and web: it versions independently
 * across a rolling upgrade, so every consumer must tolerate a missing or
 * partial catalog (see the web fallback and the server's unsupported-daemon
 * mapping).
 */

/** How the daemon obtained the catalog. */
export const PROVIDER_MODEL_CATALOG_SOURCES = {
  /** The provider's own CLI listed models (e.g. Cursor `agent models`). */
  PROVIDER_CLI: "provider-cli",
  /** Parsed from the provider's local config (e.g. ~/.kimi-code/config.toml). */
  PROVIDER_CONFIG: "provider-config",
  /** A provider RPC/API (e.g. Codex app-server model/list). */
  PROVIDER_RPC: "provider-rpc",
  /** A local provider cache; non-authoritative. */
  PROVIDER_CACHE: "provider-cache",
  /** Discovery failed or is unsupported — `models` may be empty. */
  UNAVAILABLE: "unavailable",
} as const;

export const providerModelCatalogSourceSchema = z.enum([
  "provider-cli",
  "provider-config",
  "provider-rpc",
  "provider-cache",
  "unavailable",
]);
export type ProviderModelCatalogSource = z.infer<typeof providerModelCatalogSourceSchema>;

export const providerModelOptionSchema = z.object({
  /** Exact value written to `config.payload.model`. */
  id: z.string(),
  /** Display name; falls back to `id` when absent. */
  label: z.string().optional(),
  /** Secondary muted note (context size, tier, ...). */
  hint: z.string().optional(),
  /** Provider-reported default for this account/installation. */
  isDefault: z.boolean().optional(),
});
export type ProviderModelOption = z.infer<typeof providerModelOptionSchema>;

export const providerModelCatalogSchema = z.object({
  provider: runtimeProviderSchema,
  models: z.array(providerModelOptionSchema),
  /** The provider's local default model id, when known. */
  defaultModelId: z.string().nullable().optional(),
  /** ISO8601 instant the daemon produced this catalog. */
  fetchedAt: z.string(),
  source: providerModelCatalogSourceSchema,
  /** Human-readable discovery failure, present when `source` is `unavailable`. */
  error: z.string().nullable().optional(),
});
export type ProviderModelCatalog = z.infer<typeof providerModelCatalogSchema>;

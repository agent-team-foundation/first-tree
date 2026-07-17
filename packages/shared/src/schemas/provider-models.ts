import { z } from "zod";
import { runtimeProviderSchema } from "./runtime-provider.js";

/**
 * Host-local model catalog discovery: the daemon asks the real provider on the
 * computer for the models the operator can pick, and the web renders that list.
 * First Tree never maintains a global model matrix and never proxies provider
 * credentials — discovery runs only on the daemon host.
 *
 * Wire shape mirrors runtime-auth:
 *   - Web → Server HTTP `GET /clients/:clientId/providers/:provider/models`
 *   - Server → daemon reverse command `provider-models:list` (ref-correlated)
 *   - Daemon → Server reply frame `provider-models:result`
 *   - Server resolves the pending HTTP request with the catalog
 */

/** Server→client command: discover models for one runtime provider. */
export const PROVIDER_MODELS_LIST_TYPE = "provider-models:list" as const;

/** Client→server reply carrying the discovered catalog (or an unavailable stub). */
export const PROVIDER_MODELS_RESULT_TYPE = "provider-models:result" as const;

export const providerModelOptionSchema = z.object({
  /** Exact value written to `config.payload.model`. */
  id: z.string().min(1),
  /** Human-facing label; defaults to `id` in the UI when absent. */
  label: z.string().optional(),
  /** Secondary hint (e.g. "default", "flagship"). */
  hint: z.string().optional(),
  /** Provider-reported default; informational — Web still uses empty string for DEFAULT. */
  isDefault: z.boolean().optional(),
});
export type ProviderModelOption = z.infer<typeof providerModelOptionSchema>;

export const providerModelCatalogSourceSchema = z.enum([
  "provider-cli",
  "provider-config",
  "provider-rpc",
  "provider-cache",
  "unavailable",
]);
export type ProviderModelCatalogSource = z.infer<typeof providerModelCatalogSourceSchema>;

export const providerModelCatalogSchema = z.object({
  provider: runtimeProviderSchema,
  models: z.array(providerModelOptionSchema),
  /** Provider's own default model id when known (Kimi `default_model`, Cursor `auto`, …). */
  defaultModelId: z.string().nullable().optional(),
  fetchedAt: z.string(),
  source: providerModelCatalogSourceSchema,
  /** Present when discovery failed or the provider is not supported yet. */
  error: z.string().nullable().optional(),
});
export type ProviderModelCatalog = z.infer<typeof providerModelCatalogSchema>;

export const providerModelsListCommandSchema = z.object({
  type: z.literal(PROVIDER_MODELS_LIST_TYPE),
  provider: runtimeProviderSchema,
  /** Correlation id tying command → result → HTTP response. */
  ref: z.string().min(1),
});
export type ProviderModelsListCommand = z.infer<typeof providerModelsListCommandSchema>;

export const providerModelsResultFrameSchema = z.object({
  type: z.literal(PROVIDER_MODELS_RESULT_TYPE),
  ref: z.string().min(1),
  catalog: providerModelCatalogSchema,
});
export type ProviderModelsResultFrame = z.infer<typeof providerModelsResultFrameSchema>;

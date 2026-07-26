import { z } from "zod";
import { type ProviderModelCatalog, providerModelCatalogSchema } from "./provider-model-catalog.js";
import { runtimeProviderSchema } from "./runtime-provider.js";

/**
 * Host-local model catalog RPC wire frames (server ↔ daemon).
 * Catalog payload shape lives in `provider-model-catalog.ts` (shared with web).
 *
 *   - Server → daemon reverse command `provider-models:list` (ref-correlated)
 *   - Daemon → Server reply frame `provider-models:result`
 */

/** Server→client command: discover models for one runtime provider. */
export const PROVIDER_MODELS_LIST_TYPE = "provider-models:list" as const;

/** Client→server reply carrying the discovered catalog (or an unavailable stub). */
export const PROVIDER_MODELS_RESULT_TYPE = "provider-models:result" as const;

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

export type { ProviderModelCatalog };

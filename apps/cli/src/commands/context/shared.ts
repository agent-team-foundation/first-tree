import { type ContextIntegrationProvider, contextIntegrationProviderSchema } from "@first-tree/shared";
import { createContextIntegrationProviderDriver } from "../../core/context-integration/provider-factory.js";

export function parseContextProvider(value: string): ContextIntegrationProvider {
  return contextIntegrationProviderSchema.parse(value);
}

export const createContextIntegrationDriver = createContextIntegrationProviderDriver;

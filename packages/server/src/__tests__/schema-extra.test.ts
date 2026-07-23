import { describe, expect, it } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { agentResourceBindings } from "../db/schema/agent-resource-bindings.js";
import { agents } from "../db/schema/agents.js";
import { authIdentities } from "../db/schema/auth-identities.js";
import { authIdentityProviderHeads } from "../db/schema/auth-identity-provider-heads.js";
import { authIdentityRefreshOperations } from "../db/schema/auth-identity-refresh-operations.js";
import { authIdentityRetirementFences } from "../db/schema/auth-identity-retirement-fences.js";
import { clients } from "../db/schema/clients.js";
import { connectCodes } from "../db/schema/connect-codes.js";
import { githubAppInstallations } from "../db/schema/github-app-installations.js";
import { githubEntityChatMappings } from "../db/schema/github-entity-chat-mappings.js";
import { invitationRedemptions, invitations } from "../db/schema/invitations.js";
import { oauthTransactions } from "../db/schema/oauth-transactions.js";
import { organizationSettings } from "../db/schema/organization-settings.js";
import { processedEvents } from "../db/schema/processed-events.js";
import { resources } from "../db/schema/resources.js";

type DrizzleTableRecord = Record<PropertyKey, unknown>;
type InlineForeignKeyRecord = {
  reference?: unknown;
};

function asDrizzleTableRecord(table: object): DrizzleTableRecord {
  // Drizzle stores table builders behind symbols without public test-facing types.
  return table as DrizzleTableRecord;
}

function findDrizzleSymbol(table: object, name: string): symbol {
  const symbol = Object.getOwnPropertySymbols(table).find((candidate) => String(candidate).includes(name));
  if (!symbol) throw new Error(`Missing Drizzle symbol ${name}`);
  return symbol;
}

function buildExtraConfig(table: object): unknown[] {
  const record = asDrizzleTableRecord(table);
  const builder = record[findDrizzleSymbol(table, "ExtraConfigBuilder")];
  const columns = record[findDrizzleSymbol(table, "ExtraConfigColumns")];
  if (typeof builder !== "function") throw new Error("ExtraConfigBuilder is not callable");
  const built = builder(columns);
  if (!Array.isArray(built)) throw new Error("ExtraConfigBuilder did not return an array");
  return built;
}

function resolveInlineForeignKeys(table: object): unknown[] {
  const record = asDrizzleTableRecord(table);
  const foreignKeys = record[findDrizzleSymbol(table, "PgInlineForeignKeys")];
  if (!Array.isArray(foreignKeys)) throw new Error("PgInlineForeignKeys is not an array");
  return foreignKeys.map((foreignKey) => {
    if (typeof foreignKey !== "object" || foreignKey === null) throw new Error("Foreign key is not an object");
    const reference = (foreignKey as InlineForeignKeyRecord).reference;
    if (typeof reference !== "function") throw new Error("Foreign key reference is not callable");
    return reference();
  });
}

describe("database schema exports", () => {
  it("exports the processed events table metadata", () => {
    expect(processedEvents).toBeDefined();
    expect(processedEvents.eventId.name).toBe("event_id");
    expect(processedEvents.platform.notNull).toBe(true);
  });

  it("builds deferred Drizzle extra configs for indexed tables", () => {
    expect(buildExtraConfig(agentChatSessions)).toHaveLength(2);
    expect(buildExtraConfig(agentResourceBindings)).toHaveLength(3);
    expect(buildExtraConfig(agents)).toHaveLength(5);
    expect(buildExtraConfig(authIdentities)).toHaveLength(10);
    expect(buildExtraConfig(authIdentityProviderHeads)).toHaveLength(2);
    expect(buildExtraConfig(authIdentityRefreshOperations)).toHaveLength(13);
    expect(buildExtraConfig(authIdentityRetirementFences)).toHaveLength(5);
    expect(buildExtraConfig(clients)).toHaveLength(2);
    expect(buildExtraConfig(connectCodes)).toHaveLength(2);
    expect(buildExtraConfig(githubAppInstallations)).toHaveLength(6);
    expect(buildExtraConfig(githubEntityChatMappings)).toHaveLength(3);
    expect(buildExtraConfig(invitations)).toHaveLength(2);
    expect(buildExtraConfig(invitationRedemptions)).toHaveLength(2);
    expect(buildExtraConfig(oauthTransactions)).toHaveLength(22);
    expect(buildExtraConfig(organizationSettings)).toHaveLength(2);
    expect(buildExtraConfig(resources)).toHaveLength(5);
  });

  it("resolves inline foreign key references for schema tables", () => {
    expect(resolveInlineForeignKeys(agentChatSessions)).toHaveLength(2);
    expect(resolveInlineForeignKeys(agentPresence)).toHaveLength(2);
    expect(resolveInlineForeignKeys(agentResourceBindings)).toHaveLength(4);
    expect(resolveInlineForeignKeys(agents)).toHaveLength(2);
    expect(resolveInlineForeignKeys(authIdentities)).toHaveLength(1);
    expect(resolveInlineForeignKeys(authIdentityProviderHeads)).toHaveLength(0);
    expect(resolveInlineForeignKeys(authIdentityRefreshOperations)).toHaveLength(0);
    expect(resolveInlineForeignKeys(authIdentityRetirementFences)).toHaveLength(0);
    expect(resolveInlineForeignKeys(clients)).toHaveLength(2);
    expect(resolveInlineForeignKeys(connectCodes)).toHaveLength(1);
    expect(resolveInlineForeignKeys(githubAppInstallations)).toHaveLength(1);
    expect(resolveInlineForeignKeys(githubEntityChatMappings)).toHaveLength(4);
    expect(resolveInlineForeignKeys(invitations)).toHaveLength(2);
    expect(resolveInlineForeignKeys(invitationRedemptions)).toHaveLength(2);
    expect(resolveInlineForeignKeys(oauthTransactions)).toHaveLength(0);
    expect(resolveInlineForeignKeys(organizationSettings)).toHaveLength(2);
    expect(resolveInlineForeignKeys(resources)).toHaveLength(2);
  });

  it("exposes the custom bytea avatar column type", () => {
    expect(agents.avatarImageData.getSQLType()).toBe("bytea");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createOrganization,
  ensureDefaultOrganization,
  getOrganization,
  resolveDefaultOrgId,
  updateOrganization,
} from "../services/organization.js";

function makeSelectDb(rows: unknown[]): unknown {
  const chain = {
    from: vi.fn(() => chain),
    limit: vi.fn(async () => rows),
    where: vi.fn(() => chain),
  };
  return { select: vi.fn(() => chain) };
}

function makeInsertDb(rows: unknown[], rejection?: unknown): { db: unknown; values: unknown[] } {
  const values: unknown[] = [];
  const chain = {
    onConflictDoNothing: vi.fn(() => chain),
    returning: vi.fn(async () => {
      if (rejection) throw rejection;
      return rows;
    }),
    values: vi.fn((value: unknown) => {
      values.push(value);
      return chain;
    }),
  };
  return { db: { insert: vi.fn(() => chain) }, values };
}

function makeUpdateDb(rows: unknown[], rejection?: unknown): { db: unknown; updates: unknown[] } {
  const updates: unknown[] = [];
  const chain = {
    returning: vi.fn(async () => {
      if (rejection) throw rejection;
      return rows;
    }),
    set: vi.fn((value: unknown) => {
      updates.push(value);
      return chain;
    }),
    where: vi.fn(() => chain),
  };
  return { db: { update: vi.fn(() => chain) }, updates };
}

describe("organization service edge cases", () => {
  it("resolves the default org or throws when bootstrap has not seeded it", async () => {
    await expect(resolveDefaultOrgId(makeSelectDb([{ id: "org_default" }]) as never)).resolves.toBe("org_default");
    await expect(resolveDefaultOrgId(makeSelectDb([]) as never)).rejects.toThrow("Default organization not found");
  });

  it("creates organizations with defaults and maps unique conflicts", async () => {
    const { db, values } = makeInsertDb([{ id: "org_1", name: "acme" }]);

    await expect(createOrganization(db as never, { displayName: "Acme", name: "acme" })).resolves.toMatchObject({
      id: "org_1",
      name: "acme",
    });
    expect(values[0]).toMatchObject({
      displayName: "Acme",
      features: {},
      maxAgents: 0,
      maxMessagesPerMinute: 0,
      name: "acme",
    });

    await expect(
      createOrganization(makeInsertDb([], { code: "23505" }).db as never, { displayName: "Acme", name: "acme" }),
    ).rejects.toThrow('Organization with name "acme" already exists');
    await expect(
      createOrganization(makeInsertDb([]).db as never, { displayName: "Acme", name: "acme" }),
    ).rejects.toThrow("Unexpected: INSERT RETURNING produced no row");
  });

  it("reads and updates organizations with not-found and conflict handling", async () => {
    await expect(getOrganization(makeSelectDb([{ id: "org_1" }]) as never, "org_1")).resolves.toEqual({ id: "org_1" });
    await expect(getOrganization(makeSelectDb([]) as never, "missing")).rejects.toThrow(
      'Organization "missing" not found',
    );

    const { db, updates } = makeUpdateDb([{ id: "org_1", displayName: "Acme Inc" }]);
    await expect(
      updateOrganization(db as never, "org_1", {
        displayName: "Acme Inc",
        features: { beta: true },
        maxAgents: 10,
        maxMessagesPerMinute: 20,
        name: "acme-inc",
      }),
    ).resolves.toMatchObject({ displayName: "Acme Inc" });
    expect(updates[0]).toMatchObject({
      displayName: "Acme Inc",
      features: { beta: true },
      maxAgents: 10,
      maxMessagesPerMinute: 20,
      name: "acme-inc",
    });
    expect((updates[0] as { updatedAt?: unknown }).updatedAt).toBeInstanceOf(Date);

    await expect(updateOrganization(makeUpdateDb([]).db as never, "missing", {})).rejects.toThrow(
      'Organization "missing" not found',
    );
    await expect(
      updateOrganization(makeUpdateDb([], { cause: { code: "23505" } }).db as never, "org_1", { name: "taken" }),
    ).rejects.toThrow('Organization name "taken" is already taken');
  });

  it("ensures the default organization idempotently", async () => {
    await expect(ensureDefaultOrganization(makeSelectDb([{ id: "org_default" }]) as never)).resolves.toEqual({
      id: "org_default",
    });

    const selectChain = {
      from: vi.fn(() => selectChain),
      limit: vi.fn(async () => []),
      where: vi.fn(() => selectChain),
    };
    const insertChain = {
      onConflictDoNothing: vi.fn(() => insertChain),
      returning: vi.fn(async () => [{ id: "org_created", name: "default" }]),
      values: vi.fn(() => insertChain),
    };
    const db = {
      insert: vi.fn(() => insertChain),
      select: vi.fn(() => selectChain),
    };

    await expect(ensureDefaultOrganization(db as never)).resolves.toMatchObject({ id: "org_created" });
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Default Organization", name: "default" }),
    );
  });
});

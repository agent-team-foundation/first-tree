import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import { ConflictError, NotFoundError } from "../errors.js";
import {
  createOrganization,
  ensureDefaultOrganization,
  getOrganization,
  resolveDefaultOrgId,
  updateOrganization,
} from "../services/organization.js";

type Captures = {
  insertValues?: unknown;
  updateValues?: unknown;
};

function dbFor(options: {
  captures?: Captures;
  insertError?: unknown;
  insertRows?: unknown[];
  selectRows?: unknown[];
  updateError?: unknown;
  updateRows?: unknown[];
}): Database {
  const captures = options.captures;
  const selectRows = options.selectRows ?? [];
  const insertRows = options.insertRows ?? [];
  const updateRows = options.updateRows ?? [];
  const selectChain = {
    from: () => selectChain,
    limit: async () => selectRows,
    where: () => selectChain,
  };
  return {
    select: () => selectChain,
    insert: () => ({
      values: (value: unknown) => {
        if (captures) captures.insertValues = value;
        const returning = async () => {
          if (options.insertError) throw options.insertError;
          return insertRows;
        };
        return {
          onConflictDoNothing: () => ({ returning }),
          returning,
        };
      },
    }),
    update: () => ({
      set: (value: unknown) => {
        if (captures) captures.updateValues = value;
        return {
          where: () => ({
            returning: async () => {
              if (options.updateError) throw options.updateError;
              return updateRows;
            },
          }),
        };
      },
    }),
  } as unknown as Database;
}

describe("organization service unit branches", () => {
  it("resolves the default organization and reports missing bootstrap state", async () => {
    await expect(resolveDefaultOrgId(dbFor({ selectRows: [{ id: "org-default" }] }))).resolves.toBe("org-default");

    await expect(resolveDefaultOrgId(dbFor({ selectRows: [] }))).rejects.toThrow("Default organization not found");
  });

  it("creates organizations with defaults and maps duplicate inserts to ConflictError", async () => {
    const captures: Captures = {};
    const created = { id: "org-1", name: "team" };

    await expect(
      createOrganization(dbFor({ captures, insertRows: [created] }), { name: "team", displayName: "Team" }),
    ).resolves.toBe(created);

    expect(captures.insertValues).toEqual(
      expect.objectContaining({
        displayName: "Team",
        features: {},
        maxAgents: 0,
        maxMessagesPerMinute: 0,
        name: "team",
      }),
    );

    await expect(
      createOrganization(dbFor({ insertError: { code: "23505" } }), { name: "team", displayName: "Team" }),
    ).rejects.toBeInstanceOf(ConflictError);

    await expect(
      createOrganization(dbFor({ insertRows: [] }), { name: "empty", displayName: "Empty" }),
    ).rejects.toThrow("Unexpected: INSERT RETURNING produced no row");
  });

  it("gets and updates organizations, including not-found and duplicate-name branches", async () => {
    const org = { id: "org-1", name: "team", displayName: "Team" };
    await expect(getOrganization(dbFor({ selectRows: [org] }), "org-1")).resolves.toBe(org);
    await expect(getOrganization(dbFor({ selectRows: [] }), "missing")).rejects.toBeInstanceOf(NotFoundError);

    const captures: Captures = {};
    const updated = { ...org, displayName: "New Team" };
    await expect(
      updateOrganization(dbFor({ captures, updateRows: [updated] }), "org-1", {
        displayName: "New Team",
        features: { beta: true },
        maxAgents: 5,
        maxMessagesPerMinute: 30,
        name: "new-team",
      }),
    ).resolves.toBe(updated);

    expect(captures.updateValues).toEqual(
      expect.objectContaining({
        displayName: "New Team",
        features: { beta: true },
        maxAgents: 5,
        maxMessagesPerMinute: 30,
        name: "new-team",
      }),
    );
    expect(captures.updateValues).toEqual(expect.objectContaining({ updatedAt: expect.any(Date) }));

    await expect(updateOrganization(dbFor({ updateRows: [] }), "missing", {})).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      updateOrganization(dbFor({ updateError: { cause: { code: "23505" } } }), "org-1", { name: "taken" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("ensures the default organization using existing rows, inserts, and insert-race fallback", async () => {
    const existing = { id: "org-existing" };
    await expect(ensureDefaultOrganization(dbFor({ selectRows: [existing] }))).resolves.toBe(existing);

    const inserted = { id: "org-inserted", name: "default" };
    await expect(ensureDefaultOrganization(dbFor({ insertRows: [inserted], selectRows: [] }))).resolves.toBe(inserted);

    await expect(ensureDefaultOrganization(dbFor({ insertRows: [], selectRows: [] }))).resolves.toBeUndefined();
  });
});

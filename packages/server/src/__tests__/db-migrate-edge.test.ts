import { afterEach, describe, expect, it, vi } from "vitest";

function mockPostgresClient(): ReturnType<typeof vi.fn> {
  const postgresMock = vi.fn(() => {
    throw new Error("postgres connection should not be opened for migration validation failures");
  });
  vi.doMock("postgres", () => ({
    default: postgresMock,
  }));
  return postgresMock;
}

describe("runMigrations edge validation", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.doUnmock("postgres");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("fails clearly when the drizzle migrations folder cannot be located", async () => {
    vi.resetModules();
    const postgresMock = mockPostgresClient();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        existsSync: vi.fn(() => false),
      };
    });

    const { runMigrations } = await import("../db/migrate.js");

    await expect(runMigrations("postgres://example.invalid/db")).rejects.toThrow(
      /Cannot locate drizzle migrations folder/,
    );
    expect(postgresMock).not.toHaveBeenCalled();
  });

  it("rejects non-monotonic migration journal timestamps before connecting to postgres", async () => {
    vi.resetModules();
    const postgresMock = mockPostgresClient();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        existsSync: vi.fn(() => true),
        readFileSync: vi.fn(() =>
          JSON.stringify({
            entries: [
              { idx: 0, when: 200, tag: "0000_initial" },
              { idx: 1, when: 100, tag: "0001_late" },
            ],
          }),
        ),
      };
    });

    const { runMigrations } = await import("../db/migrate.js");

    await expect(runMigrations("postgres://example.invalid/db")).rejects.toThrow(
      /Migration journal timestamps are not monotonically increasing/,
    );
    expect(postgresMock).not.toHaveBeenCalled();
  });
});

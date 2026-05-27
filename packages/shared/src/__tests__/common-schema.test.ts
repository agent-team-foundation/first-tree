import { describe, expect, it } from "vitest";
import { z } from "zod";
import { paginatedResponse, paginationQuerySchema } from "../schemas/common.js";

describe("common schemas", () => {
  it("applies pagination defaults and coercion", () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(paginationQuerySchema.parse({ limit: "5", cursor: "next" })).toEqual({ limit: 5, cursor: "next" });
  });

  it("builds a typed paginated response schema", () => {
    const responseSchema = paginatedResponse(z.object({ id: z.string() }));

    expect(
      responseSchema.parse({
        items: [{ id: "item-1" }],
        nextCursor: null,
      }),
    ).toEqual({
      items: [{ id: "item-1" }],
      nextCursor: null,
    });
  });
});

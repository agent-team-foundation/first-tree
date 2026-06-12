import type { z } from "zod";
import type { FieldDef, FieldOptions, OptionalGroupDef, OptionalGroupOptions } from "./types.js";

/** Declare a config field with a Zod schema and optional metadata. */
export function field<S extends z.ZodTypeAny>(schema: S, options?: FieldOptions): FieldDef<z.output<S>> {
  // _type is a phantom field used only for type inference (never read at runtime)
  return { _tag: "field", _type: undefined as z.output<S>, schema, options: options ?? {} };
}

/** Mark a config group as optional, optionally narrowing which fields activate it. */
export function optional<T extends Record<string, unknown>>(
  shape: T,
  options: OptionalGroupOptions = {},
): OptionalGroupDef<T> {
  return { _tag: "optional", shape, options };
}

/** Define a config shape. Identity function used for type inference. */
export function defineConfig<T extends Record<string, unknown>>(shape: T): T {
  return shape;
}

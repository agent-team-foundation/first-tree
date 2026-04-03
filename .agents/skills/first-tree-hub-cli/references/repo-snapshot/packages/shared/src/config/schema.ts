import type { z } from "zod";
import type { FieldDef, FieldOptions, OptionalGroupDef } from "./types.js";

/** Declare a config field with a Zod schema and optional metadata. */
export function field<S extends z.ZodTypeAny>(schema: S, options?: FieldOptions): FieldDef<z.output<S>> {
  // _type is a phantom field used only for type inference (never read at runtime)
  return { _tag: "field", _type: undefined as z.output<S>, schema, options: options ?? {} };
}

/** Mark a config group as optional — present only when at least one field has an explicit value. */
export function optional<T extends Record<string, unknown>>(shape: T): OptionalGroupDef<T> {
  return { _tag: "optional", shape };
}

/** Define a config shape. Identity function used for type inference. */
export function defineConfig<T extends Record<string, unknown>>(shape: T): T {
  return shape;
}

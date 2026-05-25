import type { z } from "zod";

export type PromptChoice = {
  name: string;
  value: string;
};

export type PromptDef = {
  /** Prompt message shown to user */
  message: string;
  /** Prompt type: input (default), select, or password */
  type?: "input" | "select" | "password";
  /** Choices for select type */
  choices?: PromptChoice[];
  /** Default value */
  default?: string;
};

export type FieldOptions = {
  /** Environment variable name to read from */
  env?: string;
  /** Auto-generation strategy (e.g., 'random:base64url:32') */
  auto?: string;
  /** Mask value in `client config show` output */
  secret?: boolean;
  /** Interactive prompt config — shown when value is missing at startup */
  prompt?: PromptDef;
};

export type FieldDef<T = unknown> = {
  readonly _tag: "field";
  readonly _type: T;
  readonly schema: z.ZodTypeAny;
  readonly options: FieldOptions;
};

export type OptionalGroupDef<T = Record<string, unknown>> = {
  readonly _tag: "optional";
  readonly shape: T;
};

/** Infer the resolved config type from a config shape definition. */
export type InferConfig<T> =
  T extends FieldDef<infer V>
    ? V
    : T extends OptionalGroupDef<infer S>
      ? { [K in keyof S]: InferConfig<S[K]> }
      : T extends Record<string, unknown>
        ? Simplify<InferRequiredFields<T> & InferOptionalFields<T>>
        : never;

type InferRequiredFields<T extends Record<string, unknown>> = {
  [K in keyof T as T[K] extends OptionalGroupDef ? never : K]: InferConfig<T[K]>;
};

type InferOptionalFields<T extends Record<string, unknown>> = {
  [K in keyof T as T[K] extends OptionalGroupDef ? K : never]?: InferConfig<T[K]>;
};

type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type ConfigSource = "cli" | "env" | "file" | "auto" | "default";

export type ResolvedFieldInfo = {
  value: unknown;
  source: ConfigSource;
  secret: boolean;
};

export type AutoGenerator = () => string | Promise<string>;

export type InitConfigOptions<T = Record<string, unknown>> = {
  schema: T;
  role: string;
  configDir?: string;
  cliArgs?: Record<string, unknown>;
  autoGenerators?: Record<string, AutoGenerator>;
};

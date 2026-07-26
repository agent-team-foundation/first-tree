import { readFileSync } from "node:fs";

import matter from "gray-matter";

import { isRecord } from "./shared.js";

export type ContextDocument = {
  body: string;
  data: Record<string, unknown> | null;
  error?: string;
  frontmatter: "invalid" | "missing" | "valid";
};

export type NodeMetadata = {
  description?: string;
  owners: string[];
  title: string;
};

export type ContextField<T> =
  | { present: false; valid: false }
  | { present: true; valid: false }
  | { present: true; valid: true; value: T };

const FRONTMATTER_SOURCE_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|\s*$)/u;

function splitFrontmatterSource(source: string): { body: string; hasFrontmatter: boolean } {
  const match = source.match(FRONTMATTER_SOURCE_RE);
  if (match === null) {
    return { body: source, hasFrontmatter: false };
  }

  return {
    body: source.slice(match[0].length),
    hasFrontmatter: true,
  };
}

export function readContextDocument(path: string): ContextDocument {
  let source: string;

  try {
    source = readFileSync(path, "utf-8");
  } catch (error) {
    return {
      body: "",
      data: null,
      error: error instanceof Error ? error.message : String(error),
      frontmatter: "invalid",
    };
  }

  const sourceParts = splitFrontmatterSource(source);
  if (!matter.test(source) || !sourceParts.hasFrontmatter) {
    return { body: source, data: null, frontmatter: "missing" };
  }

  try {
    const parsed = matter(source);
    const data: unknown = parsed.data;

    if (!isRecord(data)) {
      return {
        body: parsed.content,
        data: null,
        error: "frontmatter must be a YAML mapping",
        frontmatter: "invalid",
      };
    }

    return { body: parsed.content, data, frontmatter: "valid" };
  } catch (error) {
    return {
      body: sourceParts.body,
      data: null,
      error: error instanceof Error ? error.message : String(error),
      frontmatter: "invalid",
    };
  }
}

export function readNonEmptyStringField(data: Record<string, unknown>, key: string): ContextField<string> {
  if (!(key in data)) {
    return { present: false, valid: false };
  }

  const value = data[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return { present: true, valid: false };
  }

  return { present: true, valid: true, value: value.trim() };
}

export function readNonEmptyStringArrayField(data: Record<string, unknown>, key: string): ContextField<string[]> {
  if (!(key in data)) {
    return { present: false, valid: false };
  }

  const value = data[key];
  if (!Array.isArray(value) || value.length === 0) {
    return { present: true, valid: false };
  }

  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return { present: true, valid: false };
    }
    items.push(item.trim());
  }

  return { present: true, valid: true, value: items };
}

export function readNodeMetadata(path: string): NodeMetadata | null {
  const document = readContextDocument(path);
  if (document.frontmatter !== "valid" || document.data === null) {
    return null;
  }

  const title = readNonEmptyStringField(document.data, "title");
  const owners = readNonEmptyStringArrayField(document.data, "owners");
  const description = readNonEmptyStringField(document.data, "description");

  if (!title.valid || !owners.valid || (description.present && !description.valid)) {
    return null;
  }

  return {
    title: title.value,
    owners: owners.value,
    ...(description.valid ? { description: description.value } : {}),
  };
}

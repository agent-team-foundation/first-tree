import { type DefaultTreeAdapterMap, parse } from "parse5";

export type BuildHtmlScript = {
  src: string | null;
  body: string;
  async: boolean;
  defer: boolean;
};

export type BuildHtmlSecuritySurface = {
  scripts: BuildHtmlScript[];
  hasInlineEventHandler: boolean;
  hasStyleElement: boolean;
};

type HtmlNode = DefaultTreeAdapterMap["node"];

function textContent(node: HtmlNode): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if (!("childNodes" in node)) return "";
  return node.childNodes.map((child) => textContent(child)).join("");
}

/** Parse emitted HTML with browser semantics; security checks must not filter HTML with regular expressions. */
export function inspectBuildHtmlSecuritySurface(indexHtml: string): BuildHtmlSecuritySurface {
  const surface: BuildHtmlSecuritySurface = {
    scripts: [],
    hasInlineEventHandler: false,
    hasStyleElement: false,
  };

  function visit(node: HtmlNode): void {
    if ("tagName" in node) {
      const attributes = new Map(node.attrs.map((attribute) => [attribute.name.toLowerCase(), attribute.value]));
      surface.hasInlineEventHandler ||= [...attributes.keys()].some((name) => name.startsWith("on"));
      surface.hasStyleElement ||= node.tagName === "style";
      if (node.tagName === "script") {
        surface.scripts.push({
          src: attributes.get("src") ?? null,
          body: textContent(node),
          async: attributes.has("async"),
          defer: attributes.has("defer"),
        });
      }
      if (node.tagName === "template" && "content" in node) visit(node.content);
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) visit(child);
    }
  }

  visit(parse(indexHtml));
  return surface;
}

/** Enforce the executable-HTML portion of the production browser-security contract. */
export function assertBuildHtmlSecurity(indexHtml: string): BuildHtmlScript[] {
  const surface = inspectBuildHtmlSecuritySurface(indexHtml);
  const { scripts } = surface;
  if (scripts.length === 0) throw new Error("Browser security build verification failed: index has no scripts");
  for (const script of scripts) {
    if (!script.src || script.body.trim().length > 0) {
      throw new Error("Browser security build verification failed: emitted index contains an inline script");
    }
  }
  if (surface.hasInlineEventHandler) {
    throw new Error("Browser security build verification failed: emitted index contains an inline event handler");
  }
  if (surface.hasStyleElement) {
    throw new Error("Browser security build verification failed: emitted index contains an inline style element");
  }

  const themeScript = scripts[0];
  if (themeScript?.src !== "/theme-init.js" || themeScript.async || themeScript.defer) {
    throw new Error("Browser security build verification failed: theme bootstrap is not a blocking external script");
  }
  return scripts;
}

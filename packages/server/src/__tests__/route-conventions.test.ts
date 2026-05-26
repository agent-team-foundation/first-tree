import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Invariant tests for the route naming conventions documented in
 * `docs/development/http-path-conventions.md`. They replace the old
 * `admin-routes-org-scope-invariant.test.ts` (deleted with the JWT-ambient-
 * scope refactor) and pin three layers of defense:
 *
 *   1. CLAUDE.md anchor — humans / AI agents read the conventions doc first
 *   2. Type signatures — `requireOrgMembership` requires `Params: { orgId: string }`
 *   3. These tests — grep-style structural checks fail CI if drift sneaks in
 *
 * Adding a legitimate exception? Please leave a one-line comment in the
 * offending file explaining why, and update the relevant whitelist below.
 */

const SERVER_SRC = join(__dirname, "..");
const API_DIR = join(SERVER_SRC, "api");
const APP_TS = join(SERVER_SRC, "app.ts");
const TYPES_TS = join(SERVER_SRC, "types.ts");
const AUTH_SERVICE = join(SERVER_SRC, "services", "auth.ts");

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTs(full));
    } else if (st.isFile() && name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("route conventions: no /admin prefix anywhere", () => {
  it("app.ts does not register any /admin/* prefix", () => {
    const src = readFileSync(APP_TS, "utf-8");
    // Match `prefix: "/admin..."` or `prefix: '/admin..."`
    const matches = src.match(/prefix:\s*["']\/admin/g) ?? [];
    expect(
      matches.length,
      `app.ts still registers /admin/* prefixes — role belongs in middleware, not URL. Found: ${matches.join(", ")}`,
    ).toBe(0);
  });

  it("no api/ source file under api/admin/", () => {
    const adminDir = join(API_DIR, "admin");
    let exists = false;
    try {
      const st = statSync(adminDir);
      exists = st.isDirectory();
    } catch {
      exists = false;
    }
    expect(exists, "packages/server/src/api/admin/ should not exist — migrate to api/orgs/ + api/<resource>/").toBe(
      false,
    );
  });
});

describe("route conventions: middleware matches Class", () => {
  it("files under api/orgs/** import requireOrgMembership or requireOrgAdmin (not requireUser-only)", () => {
    const orgsDir = join(API_DIR, "orgs");
    let files: string[] = [];
    try {
      files = walkTs(orgsDir);
    } catch {
      // orgs/ does not exist yet — invariant trivially holds.
      return;
    }
    // WebSocket upgrade routes can't run the user-auth hook (the upgrade
    // handler hijacks the reply); they verify the JWT + probe membership
    // inline instead. Whitelisted with that exemption documented in-file.
    const WHITELIST = new Set(["api/orgs/ws.ts"]);
    for (const file of files) {
      const rel = relative(SERVER_SRC, file);
      if (WHITELIST.has(rel)) continue;
      const src = readFileSync(file, "utf-8");
      const usesOrg = /\brequireOrg(Membership|Admin)\b/.test(src);
      expect(usesOrg, `${rel} is in api/orgs/ but does not use requireOrgMembership / requireOrgAdmin`).toBe(true);
    }
  });

  it("api/me*.ts and api/me/** do not import requireOrgMembership / requireOrgAdmin", () => {
    const meFiles: string[] = [];
    for (const name of readdirSync(API_DIR)) {
      if (name === "me.ts" || name.startsWith("me-")) meFiles.push(join(API_DIR, name));
    }
    const meDir = join(API_DIR, "me");
    try {
      if (statSync(meDir).isDirectory()) meFiles.push(...walkTs(meDir));
    } catch {
      // no me/ dir is fine
    }
    for (const file of meFiles) {
      const src = readFileSync(file, "utf-8");
      const orgOnly = /\brequireOrg(Membership|Admin)\b/.test(src);
      expect(
        orgOnly,
        `${relative(SERVER_SRC, file)} is in /me namespace but imports requireOrgMembership / requireOrgAdmin — ` +
          "Class A routes should only use requireUser",
      ).toBe(false);
    }
  });
});

describe("route conventions: JWT carries only userId", () => {
  it("services/auth.ts AccessTokenPayload has no scope fields", () => {
    const src = readFileSync(AUTH_SERVICE, "utf-8");
    // The JWT signing functions must not stamp organizationId / memberId / role into the payload.
    const banned = ["organizationId:", "memberId:", "role:"];
    for (const field of banned) {
      const occurrences = src.split(field).length - 1;
      // Allow zero matches in the signing module — the only legitimate occurrences are
      // db column references in select clauses, but auth.ts intentionally only signs sub.
      expect(
        occurrences,
        `services/auth.ts still references "${field}" — JWT payload must carry only sub/type/iat/exp/jti`,
      ).toBe(0);
    }
  });

  it("types.ts FastifyRequest carries `user`, not `member`", () => {
    const src = readFileSync(TYPES_TS, "utf-8");
    expect(/member\?:/.test(src), "types.ts still augments FastifyRequest with `member` — should be `user` only").toBe(
      false,
    );
    expect(/user\?:\s*UserScope|user\?:\s*\{/.test(src), "types.ts should augment FastifyRequest with `user`").toBe(
      true,
    );
  });
});

describe("route conventions: no code reads JWT scope fossils", () => {
  const ALLOWED_PATHS = [
    // The user-auth middleware is the only place that decodes the JWT;
    // it ignores legacy fields and is allowed to know they may exist.
    join("middleware", "user-auth.ts"),
    // The route-conventions test itself names the banned strings.
    join("__tests__", "route-conventions.test.ts"),
  ];

  it("no source file outside the auth middleware reads request.member or request.user.organizationId/memberId/role", () => {
    const all = walkTs(SERVER_SRC).filter((p) => !p.includes("/__tests__/"));
    const offenders: string[] = [];
    for (const file of all) {
      const rel = relative(SERVER_SRC, file);
      if (ALLOWED_PATHS.some((allowed) => rel === allowed)) continue;
      const src = readFileSync(file, "utf-8");
      if (/request\.member\b|req\.member\b/.test(src)) offenders.push(`${rel} (request.member)`);
      if (/request\.user\.(organizationId|memberId|role)\b|req\.user\.(organizationId|memberId|role)\b/.test(src)) {
        offenders.push(`${rel} (request.user.<scope>)`);
      }
    }
    expect(offenders.length, `JWT scope fossil reads found:\n  ${offenders.join("\n  ")}`).toBe(0);
  });
});

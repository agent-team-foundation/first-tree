/**
 * Sanitize an `err.message` (or any free-text preview) before it leaves the
 * `safe to embed in logs but NOT chat` boundary established by
 * {@link Classification.message} in `error-taxonomy.ts`.
 *
 * Local server logs are operator-only; resilience events emitted via
 * `SessionContext.emitEvent` are routed back to the chat / web event path,
 * persisted, and viewable by anyone with chat-read access. Anything written to
 * the latter MUST run through this helper first.
 *
 * Design:
 *  - Bias toward over-redacting: false positives are a readability nuisance;
 *    false negatives leak credentials. Don't add a pattern unless its
 *    matching shape is unique enough not to chew through ordinary prose.
 *  - Patterns must be cheap (linear regex, bounded backtracking) — this runs
 *    on every transient failure, not just rare ones.
 *  - Truncation happens AFTER redaction. Redacting a truncated string risks
 *    leaving a half-token tail past the boundary; redact the full message,
 *    then slice.
 *  - The redaction PLACEHOLDER itself stays stable so log-side grep on
 *    `[REDACTED]` is reliable. Vendor-prefixed shapes use a `:` inside the
 *    placeholder (`[REDACTED:AKIA]`, `[REDACTED:ghp]`, …) — the `:` is NOT
 *    in the step-5 credential value class, which short-circuits a stuttered
 *    double-redact when a vendor token appears as the VALUE of a
 *    `name=…` credential pair (e.g. `api_key=AKIA…`).
 */

/** Default cap matches the resilience-event payload budget (256 chars). */
const DEFAULT_MAX_LEN = 256;

/**
 * Redact common credential shapes then truncate. Pure function — every input
 * deterministically maps to the same output, suitable for snapshot tests.
 *
 * Pattern coverage (all checked independently):
 *
 *  1. URL-embedded basic auth — `<scheme>://user:pass@host/...` for ANY
 *     RFC-3986 scheme (https / ssh / git / postgres / mysql / mongodb+srv /
 *     redis / amqp / …). `git clone <url>` echoes the configured URL into
 *     the resulting `GitMirrorError` message, so a PAT-bearing
 *     `remote.origin.url` lands here verbatim — but so does any database
 *     connection string an SDK happens to log on failure.
 *  2. Standard token prefixes that are unambiguously credentials:
 *       - GitHub: `ghp_*`, `ghs_*`, `gho_*`, `ghu_*`, `ghr_*` (refresh
 *         token), `github_pat_*`
 *       - AWS: long-term `AKIA*` and session-token `ASIA*`
 *       - Anthropic / OpenAI: vendored `sk-ant-*` / `sk-proj-*` and the
 *         older bare `sk-*` shape (no vendor segment)
 *       - Slack: `xox[abprs]-...`
 *  3. `Authorization: <anything>` headers — full scheme + credential, not
 *     just Bearer. Matches to end-of-line so `Basic <b64>`, `Digest …`,
 *     `token …`, `ApiKey …` etc. all have their credential portion erased
 *     (previously the regex only ate the scheme word and left the credential
 *     after the next space — a real leak in chat-visible events).
 *  4. Bare `Bearer <token>` substrings outside an `Authorization:` header.
 *  5. Common credential-bearing query / form / env name=value pairs.
 *
 * Negative space (deliberately NOT matched, to keep prose readable):
 *  - Plain `key`, `secret`, `password` as English words without a value
 *  - GitHub URLs without embedded creds
 *  - Numeric IDs, branch SHAs, dates
 */
export function redactErrorPreview(input: string, maxLen: number = DEFAULT_MAX_LEN): string {
  if (!input) return input;
  let s = input;

  // 1. URL-embedded basic auth — any RFC-3986 scheme. Keeps host + path so
  //    the operator can still tell which resource failed. Bounded scheme
  //    length (1–31 chars after the leading letter) keeps the match cheap
  //    and unambiguous: an arbitrary `word://` is rare outside actual URIs.
  s = s.replace(/\b([a-z][a-z0-9+.\-]{0,30}:\/\/)([^\s:@/]+):([^\s@/]+)@/gi, "$1[REDACTED]@");

  // 2. Vendor-prefixed token shapes. Order matters: longest / most-specific
  //    first so we don't half-redact a `github_pat_…` to a `gh…` shape.
  //
  //    Placeholders embed a `:` (e.g. `[REDACTED:ghp]`) so step-5's
  //    credential value class — which excludes `:` — cannot extract 4
  //    consecutive chars from the placeholder and stutter-redact a
  //    `api_key=AKIA…` pair into `api_key=[REDACTED][REDACTED]`.
  s = s.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED:github_pat]");
  s = s.replace(/\bgh[psohur]_[A-Za-z0-9_]{20,}/g, (m) => `[REDACTED:${m.slice(0, 3)}]`);
  // AWS access keys: long-term (AKIA) and session-token (ASIA) prefixes.
  s = s.replace(/\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g, (m) => `[REDACTED:${m.slice(0, 4)}]`);
  // OpenAI / Anthropic `sk-…` family. The vendor segment (`-ant-`, `-proj-`,
  // a service codename) is OPTIONAL: the older bare `sk-<longstring>` shape
  // is still in the wild and the new helper should catch it.
  s = s.replace(/\bsk-(?:(?:ant|proj|[a-z]{2,12})-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED:sk]");
  s = s.replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:xox]");

  // 3. `Authorization: …` headers — full scheme + credential to end-of-line.
  //    The previous `(?:Bearer\s+)?\S+` only ate the scheme word for Basic /
  //    Digest / token / ApiKey, leaving the actual credential after the next
  //    space unredacted in chat-visible payloads. Single-line `[^\r\n]+`
  //    catches every scheme since an HTTP header per spec occupies one line.
  s = s.replace(/(\bAuthorization\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]");

  // 4. Bare `Bearer <token>` outside an Authorization header (some SDK stderr).
  s = s.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1[REDACTED]");

  // 5. Common credential-bearing key=value pairs. Constrained to the keys
  //    below to avoid eating ordinary prose like `key 'foo' missing`.
  //    Matches `name=value`, `name: value`, and JSON `"name": "value"` —
  //    optional quotes on BOTH sides of the separator. Value is at least
  //    4 chars from a credential-shaped charset; stops at whitespace,
  //    quote, or common delimiters.
  //
  //    Negative lookbehind `(?<![\w-])` is the load-bearing guard against
  //    matching credKey as a SUFFIX of an unrelated identifier — e.g.
  //    `X-GitHub-Token` would otherwise let `token` match, then redact the
  //    `ghp_…` value the step-2 vendor pattern just turned into
  //    `[REDACTED:ghp]`, producing a stuttered double-redact.
  const credKey =
    "(?:token|access[_-]?token|api[_-]?key|apikey|private[_-]?token|password|passwd|secret|client[_-]?secret)";
  s = s.replace(
    new RegExp(`(?<![\\w-])(${credKey})(["']?\\s*[:=]\\s*["']?)([A-Za-z0-9._\\-+/=~]{4,})`, "gi"),
    "$1$2[REDACTED]",
  );
  // URL query string form: `?token=...` / `&access_token=...` — distinct
  // from the key=value form because the credential charset there can include
  // url-encoded bytes that the above pattern's value class would reject.
  s = s.replace(new RegExp(`([?&]${credKey}=)[^&\\s]{4,}`, "gi"), "$1[REDACTED]");

  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

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
 *    `[REDACTED]` is reliable.
 */

/** Default cap matches the resilience-event payload budget (256 chars). */
const DEFAULT_MAX_LEN = 256;

/**
 * Redact common credential shapes then truncate. Pure function — every input
 * deterministically maps to the same output, suitable for snapshot tests.
 *
 * Pattern coverage (all checked independently):
 *
 *  1. URL-embedded basic auth (`https://user:PAT@host/...`,
 *     `ssh://user:pw@host/...`) — `git clone <url>` echoes the configured
 *     URL into the resulting `GitMirrorError` message, so a PAT-bearing
 *     `remote.origin.url` lands here verbatim.
 *  2. Standard token prefixes that are unambiguously credentials:
 *       - GitHub: `ghp_*`, `ghs_*`, `gho_*`, `ghu_*`, `github_pat_*`
 *       - AWS access key: `AKIA<16 base32-ish>`
 *       - Anthropic / OpenAI-style: `sk-*-<longstring>` (catches both
 *         `sk-ant-...` and `sk-proj-...`)
 *       - Slack: `xox[abprs]-...`
 *  3. `Authorization: Bearer …` / `Authorization: …` headers.
 *  4. `bearer <token>` substrings (rare but seen in some SDK stderr).
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

  // 1. URL-embedded basic auth — replace the credentials, keep host + path so
  //    the operator can still tell which repo failed.
  s = s.replace(/\b((?:https?|ssh|git):\/\/)([^\s:@/]+):([^\s@/]+)@/gi, "$1[REDACTED]@");

  // 2. Vendor-prefixed token shapes. Order matters: longest / most-specific
  //    first so we don't half-redact a `github_pat_…` to a `gh…` shape.
  s = s.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_[REDACTED]");
  s = s.replace(/\bgh[psohu]_[A-Za-z0-9_]{20,}/g, (m) => `${m.slice(0, 4)}[REDACTED]`);
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]");
  // sk-ant-..., sk-proj-..., sk-... (long Anthropic / OpenAI shapes).
  s = s.replace(/\bsk-(?:ant|proj|[a-z]{2,12})-[A-Za-z0-9_-]{20,}/g, "sk-[REDACTED]");
  s = s.replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "xox[REDACTED]");

  // 3. `Authorization: Bearer …` / `Authorization: …` headers.
  s = s.replace(/(\bAuthorization\s*:\s*)(?:Bearer\s+)?\S+/gi, "$1[REDACTED]");

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
  //    `ghp_[REDACTED]`, producing a stuttered double-redact.
  const credKey = "(?:token|access[_-]?token|api[_-]?key|apikey|password|passwd|secret|client[_-]?secret)";
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

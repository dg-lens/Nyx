const REDACTED = '[REDACTED]';

// Generic credential-shape backstop. Catches well-known secret token formats
// that are NOT the dispatcher's own configured env values — e.g. a token a
// spawned subprocess echoed, a key from a different project, or a per-task
// Bitwarden value that surfaced in a stack trace. The exact-value passes
// (process.env / extraEnv) handle the dispatcher's known secrets; this is the
// shape-based net for everything else.
//
// Ordering note: the fine-grained `github_pat_` form must precede the classic
// `gh[posru]_` alternation so the longer literal prefix wins — `github_pat_`
// does not start with `gh[posru]_` (the char after `gh` is `i`), so they don't
// actually overlap, but listing the more specific shape first keeps intent clear.
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\bgh[posru]_[A-Za-z0-9]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

/**
 * Apply the generic credential-shape backstop to a string. Pattern-based, so it
 * scrubs secret token shapes regardless of whether the exact value is known to
 * the caller. Always layer this AFTER exact-value redaction of known secrets.
 */
export function redactCredentialPatterns(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of CREDENTIAL_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/**
 * Exact-value scrub for a known set of secret values (e.g. the resolved
 * per-task Bitwarden `extraEnv` the spawned child received). Values shorter than
 * 8 chars are skipped to avoid scrubbing innocuous substrings. Splits on the
 * literal value so no regex escaping is needed.
 */
export function redactValues(text: string, values: Iterable<string>): string {
  if (!text) return text;
  let out = text;
  for (const value of values) {
    if (value && value.length >= 8) out = out.split(value).join(REDACTED);
  }
  return out;
}

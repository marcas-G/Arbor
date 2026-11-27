/**
 * Semantic-naming rules for architecture object 11 (first ratchet slice).
 *
 * Scope: only NEW work is checked — paths added or renamed onto HEAD after
 * the baseline commit, new export symbol declarations and new describe/it/
 * test name literals on lines added after the baseline commit. Existing
 * inventory stays in `naming-baseline.json` and is never re-reported.
 *
 * Rules are deliberately narrow: they only match the historical planning-code
 * shapes already inventoried in the baseline (docs/engineering/
 * semantic-naming-policy.md documents each one). Legitimate protocol and
 * algorithm numbers (sha256, schema-vNN, portV1) are exempt by shape, not by
 * an allowlist of paths.
 */

/** Path segments like `p39-`, `ah7/`, `p10.test.ts`, `p3/` directories. */
export const PATH_PATTERN = /(^|[-_/])(p|ah)[0-9]{1,3}([-_/]|\.test\.|$)/u;

/**
 * New exported-ish symbol declarations carrying a planning code:
 * DatabaseWriterLockClient, AH7RecoveryProbe, SandboxOutcomeReadPort.
 * A declaration continues with `=`, `{`, `(`, a `|` union member or a line
 * end — import-list entries (`,` or `}` after the identifier) and bare
 * references are not declarations. A letter must follow the digits so that
 * V-numbered schema/protocol names are a distinct shape covered by the
 * version exemption.
 */
export const SYMBOL_PATTERN =
  /\b(?:class|interface|type|const|function|enum)\s+(P[0-9]{1,3}|AH[0-9]{1,2})[A-Za-z][A-Za-z0-9_]*(?=\s*(?:[={(|]|\bextends\b|$))/u;

/** describe / it / test name literals opening with a planning code. */
export const TEST_NAME_PATTERN =
  /\b(?:describe|it|test)\s*\(\s*["'`](P[0-9]{1,3}|AH[0-9]{1,2})\b/u;

/**
 * Numeric suffixes that name protocols, algorithms and schema versions, not
 * planning provenance: sha256, base64, schema-v57, xxHash64, ObservationV1.
 * Matched on the declared identifier only. A planning code at the head of the
 * identifier wins over a trailing version suffix: P4SandboxUnavailable…V1 is
 * inventory, ConversationCheckpoint…V1 is a versioned contract name.
 */
export const NUMBER_EXEMPT_PATTERN =
  /^(?:(?:sha|xx|crc|md|base)(?:[-_ ]?[A-Za-z0-9]+)*[0-9]{1,3}[A-Za-z0-9]*|(?:.*[-_ ])?v[0-9]{1,3}$|.*V[0-9]{1,3}$)/iu;

const SOURCE_PATTERN = /\.(?:[cm]?[jt]sx?|[cm]?js|py|sh|bash|rs|go)$/u;

/**
 * Planning evidence and its indexes quote the historical codes as data.
 * The frozen inventory (`docs/**`, `planning/**`) is out of scope entirely.
 */
export const OUT_OF_SCOPE_PREFIXES = ["docs/", "planning/"];

export function isSourcePath(path) {
  return SOURCE_PATTERN.test(path);
}

export function isOutOfScope(path) {
  return OUT_OF_SCOPE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * The symbol rule fires only when the identifier head is genuinely a
 * planning code, not a protocol/algorithm/version number: the digits must be
 * followed by a letter that starts a word, and the whole identifier must not
 * be exempt (sha256, vNN, …V1).
 */
export function symbolViolation(line) {
  const match = SYMBOL_PATTERN.exec(line);
  if (!match) return null;
  const rest = line.slice(match.index);
  const identifier = rest.replace(
    /^(?:class|interface|type|const|function|enum)\s+/u,
    "",
  );
  if (
    NUMBER_EXEMPT_PATTERN.test(identifier) &&
    !/^(?:P|AH)[0-9]/u.test(identifier)
  ) {
    return null;
  }
  return { symbol: match[0].trim().split(/\s+/u).pop(), line: line.trim() };
}

export function pathViolation(path) {
  if (!isSourcePath(path) || isOutOfScope(path)) return null;
  return PATH_PATTERN.test(path) ? { path } : null;
}

export function testNameViolation(line) {
  const match = TEST_NAME_PATTERN.exec(line);
  if (!match) return null;
  // A captured name is exactly the P/AH code head (never sha/v-shaped), so
  // the number exemption does not apply here.
  return { name: match[1], line: line.trim() };
}

/** Categories used by both the checker output and the baseline schema. */
export const CATEGORIES = ["path", "symbol", "test-name"];

export function categoryFor(rule) {
  if (rule === "path") return "path";
  if (rule === "symbol") return "symbol";
  return "test-name";
}

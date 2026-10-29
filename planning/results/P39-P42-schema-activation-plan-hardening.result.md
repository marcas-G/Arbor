# P39–P42 schema activation plan hardening

Date: 2026-10-13
Base for review revision: `0ae4510904bbcef7843b191b8b6655df078f6cb2`
Scope: documentation only; no design documents or production code changed.

This revision further bounds the disposable-copy provenance contract:

- The authorized OS operator identity is the trust root. The protected
  manifest detects accidental misuse, aliases, stale/wrong copies, and targets
  created outside the CLI flow. It is not a signature and does not claim to
  resist malicious edits by that same trusted identity.
- `resume-copy` is limited to targets created by `copy`. Every invocation must
  re-supply the original `--source-database`, `--database`,
  `--copy-manifest`, and `--p39-report-db`; source path/file identity/content
  digest, target identity/content digest/prefix, manifest nonce/hash chain, and
  report identity/schema/rows are revalidated. Missing or changed evidence
  fails closed.
- A resume requires the exact existing report sidecar bound by the manifest.
  Missing reports are rejected; resume never creates a replacement. Exclusive
  creation of report and manifest files is restricted to fresh/copy setup.
- The deterministic logical SQLite digest now defines object/table/column
  ordering, typed and length-prefixed value encodings, rowid/primary-key row
  ordering, duplicate-row multiplicity, and explicit treatment of
  `sqlite_sequence`, planner statistics, and physical SQLite files.

The earlier review disposition remains: a P39 isolated target is permanently
audit-only under the frozen DID contract, and its resume-denial case is part of
qualification. Implementation authorization remains separate.

Updated implementation-plan SHA-256:
`7509948A83D2D6AD2B1A3C090EE6548628EB46397ABFB9718EB48535BBC0CE59`

## Verification

- `git diff --check`: PASS.
- No tests or builds were run; this is a documentation-only change.
- No design documents, production code, migration registration, databases,
  daemon, deployment, or release were changed or operated.

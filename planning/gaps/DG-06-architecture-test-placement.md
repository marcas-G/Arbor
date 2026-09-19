# DG-06 — Architecture test placement conflict

## Status

RESOLVED — DID v1.4.

## Resolution

Canonical architecture-test location is frozen as `tests/architecture/**`
in DID §10.1 (monorepo boundary) and §10.4.1 (no second architecture-test
root). `AGENTS.md` hard rule 5 already required the same location, so the
former DID §10.1 `tooling` architecture entry was the side that changed.

Authority:

- `docs/design/03-detailed-implementation-design.md` v1.4 §10.1, §10.4.1
- `AGENTS.md` hard rule 5 (unchanged)

Resolved in: DID v1.4.

## Owning design document

`docs/design/03-detailed-implementation-design.md` §10.1 and
`AGENTS.md` hard rule 5 (both manually governed).

## Symptom

Two manually-governed documents gave different homes for the architecture
tests:

- DID §10.1 monorepo boundary listed a `tooling`-rooted architecture
  directory.
- `AGENTS.md` hard rule 5: "enforce with architecture tests in
  `tests/architecture/`".

## Evidence

DID §14.1 only says "Architecture custom Vitest package-DAG tests"
(DID:3652) with no path, so it could not break the tie.

## Why planning cannot decide this

Both documents are manually governed and are authoritative within their own
scope; planning may not silently prefer one. The resolution determines the
package layout for P0-001 and P0-017.

## Affected planning tasks

- `P0-001` (repository skeleton)
- `P0-017` (architecture tests)

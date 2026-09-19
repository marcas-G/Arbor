# P1-DG-01 — Error algebra incomplete for P1 (FencingRejected / PersistenceUnavailable)

## Status

RESOLVED — DID v1.5.

## Resolution

DID §6A.15 freezes the three-layer failure model: `DomainError` (pure
domain), Application-owned `CommandRejection = DomainError | FencingRejected
| ExecutionStopping`, and `OperationalFailure` (not a top-level closed
union). `CommandResolution<Result, Rejection>` is parameterized; Domain does
not depend on `CommandRejection`.

Authority: DID v1.5 §6A.15, §4.1.


## Owning design document

`docs/design/03-detailed-implementation-design.md` §6A.4, §6A.5, §4.1, §12.5;
P0 artifact `packages/domain/src/errors.ts`.

## Symptom

The design freezes `FencingRejected` as a terminal typed rejection
(§6A.4, §6A.5, §4.1:1161, §9.9:2919, §12.5:3421) and mentions
`PersistenceUnavailable` (§6A.4), but neither is present in the P0
`DomainError` closed union. P1 must persist these as
`commands.terminal_error_json` (§9.9:2888), so the union cannot express a
frozen artifact.

## Evidence

```text
DID §6A.4:1565   lease generation mismatch → FencingRejected
DID §6A.4:1568   persistence translation → PersistenceUnavailable
DID §6A.5:1620   FencingRejected = persistence enforcement 的权威拒绝
DID §4.1:1161    FencingRejected terminal for that Execution-originated Command
DID §9.9:2919    FencingRejected terminal
DID §12.5:3421   FencingRejected → terminal
packages/domain/src/errors.ts  (no FencingRejected / PersistenceUnavailable)
```

## Why planning cannot decide this

Which layer owns each error (domain vs port/application vs persistence),
its payload shape, and whether `CommandResolution.TerminalRejected` carries
`DomainError` or a broader union are **error-algebra boundary** decisions.

## Required resolution

Freeze: the owning union for `FencingRejected` and `PersistenceUnavailable`;
their payloads; and how they are represented in `commands.terminal_error_json`.

## Affected P1 areas

Command contracts, transaction model, fencing.

# P1-DG-02 — Command resolution states, receipt shape, and attempt vocabulary

## Status

OPEN — awaiting manual governance.

## Owning design document

`docs/design/03-detailed-implementation-design.md` §4.1, §7.4, §9.9;
P0 artifact `packages/domain/src/command.ts`.

## Symptom

Three related inconsistencies between the frozen persistence model and P0:

1. `commands.resolution = Pending | Committed | TerminalRejected` (§9.9:2886)
   vs P0 `CommandResolution = Committed | TerminalRejected` (no `Pending`).
2. `Pending` durability contradicts the rollback rule: §7.4:1934 registers
   the logical command *inside* the semantic transaction, but §7.4:1961-1970
   rolls that transaction back on operational failure — so a `Pending` row
   can never commit as written; `command_attempts.command_id` then has no
   parent (§9.9:2898).
3. `CommandReceipt` has no frozen field list (§4.1:1144-1162 says only
   "stable representation"); P0's shape (`{commandId, fingerprint,
   resolution}`) diverges from the durable row
   (`command_id, project_id, payload_hash, resolution, result_json,
   terminal_error_json, created_at, settled_at`, §9.9:2881-2891).
   `command_attempts.outcome` / `failure_kind?` have no value domains, and
   P0's `attemptNo` is 0-based while §4.1:1134 illustrates `#1,#2,#3`.

## Evidence

```text
DID §9.9:2886   resolution Pending | Committed | TerminalRejected
DID §9.9:2917   Pending 可以产生新的 CommandAttempt
DID §7.4:1934   BEGIN → load/register logical Command
DID §7.4:1961   retryable failure → ROLLBACK, no authoritative receipt
DID §12.6:3449  Retryable operational failure 不产生 authoritative resolution
DID §9.9:2898   command_attempts columns (outcome, failure_kind? no domains)
DID §4.1:1134   Attempt #1/#2/#3
packages/domain/src/command.ts  CommandResolution / CommandReceipt / CommandAttempt
```

## Why planning cannot decide this

The durable resolution state machine, the receipt projection, and the
attempt-outcome vocabulary are **persistence/command truth** semantics.

## Required resolution

Freeze: (a) whether `Pending` is durable and in which transaction; (b) the
`CommandReceipt` view fields; (c) `command_attempts.outcome` /
`failure_kind` domains; (d) `attempt_no` base (align P0 or §4.1); (e)
duplicate-attempt behavior while a row is `Pending`.

## Affected P1 areas

Idempotency persistence, recovery matrix, command contracts.

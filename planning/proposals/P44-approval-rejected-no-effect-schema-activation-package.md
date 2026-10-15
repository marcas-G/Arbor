# P44 ApprovalRejected no-effect migration activation package

Status: prepared implementation package; **not activated**.

## Proposed physical change

Migration 0044, `approval_rejected_no_effect_denial`, requires user version 43.
It drops and recreates only the P40 `tool_invocations` observation INSERT and
UPDATE guards. The recreated guards are derived from the exact P40 definitions;
the sole predicate change is admitting the already-frozen
`ApprovalRejected` reason in the `Denied` no-effect allowlist. P40/P39/P42 SQL,
table shape, canonical observation predicates, and other denial reasons remain
unchanged.

Prepared descriptor SQL SHA-256:
`2378c0170aae7beb0592c69bfffef9e611da6d5323caaa0de5b7d5360b7ff33f`.

The descriptor is exported for isolated qualification only. It is absent from
`CURRENT_MIGRATIONS`; `CURRENT_SCHEMA_VERSION`, runtime admission, readiness,
production fixtures, and the P39–P42 offline CLI are unchanged. No online or
preserved database was opened or upgraded.

## Required activation boundary

Activation must be authorized as an ordered schema **43 → 44** suffix; P44 must
not be applied directly to schema 42. This package does not silently assign the
schema-43 predecessor. The repository currently contains a dormant, unregistered
P43 Blocked WorkEpisode descriptor used only by isolated tests. Its presence
does not authorize registering or applying that feature. Before activation, the
governor must explicitly settle the schema-43 predecessor/ownership and issue
the applicable token.

Only after that token may a follow-up implementation register P44, raise the
runtime target, update readiness and the offline fresh/copy/resume CLI, and
rename current-runtime fixtures. That follow-up must remain offline and limited
to fresh databases or operator-selected disposable copies; it must not open,
upgrade, or mutate any preserved/live Arbor database.

## Isolated evidence target

Qualification uses a disposable schema-42 fixture, explicitly applies the
existing dormant P43 fixture descriptor and then P44, verifies `user_version=44`,
the P43 fixture tables, unchanged tool-invocation foreign keys/indexes, clean
`foreign_key_check`, exact P40 trigger predicates plus the one added reason, and
P4 `ApprovalRejected`/`ApprovalExpired` denial insert/update. Unknown denial
codes and malformed canonical-success evidence must remain rejected. This
isolated sequence is test evidence only, not permission to activate either
migration in production.

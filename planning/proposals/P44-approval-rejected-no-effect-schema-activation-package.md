# Combined P43 + P44 schema activation package

Status: prepared; **not activated**. Required authorization token:
`AUTHORIZE_P43_BLOCKED_AND_P44_APPROVAL_REJECTED_SCHEMA_ACTIVATION`.

## Combined migration sequence

The schema-43 owner is the existing accepted but dormant
`P43_BLOCKED_WORKEPISODE_MIGRATION`. The combined request is exactly:

1. P43: schema 42 → 43, applying the existing Blocked WorkEpisode and Inbox
   workspace-sequence migration.
2. P44: schema 43 → 44, applying
   `P44_APPROVAL_REJECTED_NO_EFFECT_DENIAL_MIGRATION`.

P44 drops and recreates only the P40 `tool_invocations` observation INSERT and
UPDATE guards. It preserves their exact predicates and adds only the frozen
`ApprovalRejected` reason to each Denied no-effect allowlist. P40/P39/P42 SQL,
table shape, canonical observation predicates, and all other denial reasons
remain unchanged.

Prepared P44 descriptor SQL SHA-256:
`2378c0170aae7beb0592c69bfffef9e611da6d5323caaa0de5b7d5360b7ff33f`.

## Required post-token implementation scope

Only after the exact token above may an implementation follow-up:

- register the ordered current suffix P40 → P41 → P42 → P43 → P44 (P39 remains
  the privileged maintenance step), and move runtime/readiness target to 44;
- extend the offline schema-upgrade CLI for fresh/copy/resume paths through
  versions 39–44, including version-44 close/read-only-reopen no-op checks;
- rename/create current-runtime fixtures as schema 44 while retaining schema42
  historical fixtures; migrate current composition/store fixture call sites;
- qualify migration-43 and migration-44 prepared/commit/rollback crash
  boundaries and exact ordered resume behavior.

This proposal grants none of those changes by itself. No online database,
preserved database, deployment, or release upgrade is authorized. Any future
qualification/upgrade must be offline and confined to fresh databases or
operator-selected disposable copies. Existing live/preserved Arbor databases
must not be opened, modified, migrated, or used as a source fixture.

## Current preparatory evidence

The unregistered P44 descriptor and isolated schema42 → explicit dormant P43 →
P44 test evidence are recorded in
`planning/results/P44-approval-rejected-no-effect-migration-preparatory.result.md`.
That isolated sequence validates SQL behavior only; it does not register P43 or
P44 or authorize production activation.

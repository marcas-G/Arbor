# Native OS Sandbox V21 acceptance and authorization corrigendum

**Decision date:** 2026-10-19
**Decision:** User accepted `ACCEPT_NATIVE_OS_SANDBOX_REMAINING_RUNTIME_CONTRACT_CLOSURE_V21`.
**Accepted proposal raw SHA-256:** `5CF4E41F1940F7ABB6C61D5B963A9E9D687D967AC4C72EE7A31E18424873486A`.
**Accepted proposal path:** `C:\Users\ThinkPad\.codex\worktrees\native-sandbox-governance\Arbor\planning\proposals\native-os-sandbox-remaining-runtime-contract-closure-v21.md`.
**Landing base:** `8cd0a94653f1278a194cf23e63503bf154885373` (`p4-final-release-fixes`, schema-48 current-main candidate).
**Landing branch:** `codex/native-sandbox-v21-owner-landing`.

## Accepted semantic delta

The fixed V21 package preserves V20 except for its two stated closure points:

1. There is no new P9 failure-code enum, persisted event enum, database table,
   column, migration or schema change. `SandboxRecoveryBindingFailure` is an
   additive API AttentionSource literal only; it is non-persisted.
2. Derived Attention identity uses JSON `null` for SQL NULL
   `recovery_binding_sha256`; an exact syntactically valid lowercase 64-hex
   stored value is used as-is even if it does not match the binding bytes.
   Invalid non-NULL hash format fails closed through the existing corruption
   Problem/operational path and emits no derived Attention.

The inherited V20 contract remains: P4's immutable RecoveryBindingV1 is the
sole proof authority; P9 classifies proof failure read-only with no
ToolObservationReplay/P40 fact, event, marker, lease, P4/Provider call or
effect; P10 derives Attention without persistent projection state. The public
summary is fixed, `occurredAt` is the immutable canonical-UTC
`tool_invocations.intent_at`, and corrupt/missing time is a projection
integrity failure with no fallback. The source clears only on exact invocation
terminality or Execution Stop. There is no automatic/manual in-v1 repair or
rebind; verified backup/new Execution is outside the contract. Current-source
drift and actual provider-unavailable facts retain their existing paths.

## Implementation authorization corrigendum

The pre-existing direct user authorization is
`AUTHORIZE_NATIVE_OS_SANDBOX_CONVERGENCE_IMPLEMENTATION`, granted 2026-10-18
in thread `01a0ec9b-9a9f-7242-9d1e-973451238d05`, for T0–T4. V21 creates no
new implementation authorization. The V1.53 “NOT GRANTED” checkpoint wording
is historical and is superseded by the V21 correction in the DID. The grant
may be acted on only after the accepted owner landing passes independent
post-review. This design landing does not activate migrations, upgrade an
existing database, or authorize release.

## Landing scope

Only `docs/design/**` owner contracts and planning acceptance/manifest records
are changed. No production code, tests, migration files/registry, database,
deployment or release artifacts are changed. No migration is registered or
executed and no database is upgraded. The landing starts from the exact base
above; side-branch owner files are not copied wholesale.

## Full-chain completeness corrigendum (same acceptance)

The accepted V21 package is interpreted together with its incorporated final
V1–V20 clauses. This follow-up does not change the user decision, proposal raw
hash or acceptance token and requests no new token. It substantively fills the
named P1/P2/P3/P4/P5/P9/P10/P11/P12/P13/API owners: existing
episode_revision/CAS; exact command/fingerprint/result/receipt rules; protected
authority bundle and provider qualification; process/network/platform/T3
contracts; same-Execution HumanIntervention and no-reprobe recovery; P9 fact
freshness and P10 100/5s/30s queue, derived Attention, exact DTO/503; UI and
region mapping. Full owner coverage and all changed-file base/postimage hashes
are recorded in the amended landing manifest. Current migration head remains
0050/schema 50; no 0051, DDL, activation, implementation, test, DB mutation or
release is added by this completeness follow-up.

The incorporated full-chain implementation evidence baseline is
`f705a517f7f9e0bb46e527bb438d96beaea539b4`; it is audit evidence only, not
the owner preimage. Preserved read-only audit files and raw SHA-256 values are:

| Audit | Raw SHA-256 |
|---|---|
| `planning/results/native-os-sandbox-wave-c-authority-gap-audit-f705a517.result.md` | `A1EB042817CB6886405982A7CA17D790A0E325762ECF835A23C840A567A6772B` |
| `planning/results/native-os-sandbox-t2-t3-provider-gap-audit-f705a517.result.md` | `14E0B8D8D64A2684AE33FBE65CCF8F6A7BB7B19F05D6712555549146CF4FCDEE` |
| `planning/results/native-os-sandbox-wave-d-recovery-gap-audit-f705a517.result.md` | `412E79EC9CA466A397B8E698AFF195676300662934763E3CF0CC50268C33F7E5` |

The audit index `planning/results/native-os-sandbox-runtime-gap-audits-f705a517.record.md` remains raw SHA-256 `BB9D1BDE75397FCDCC8EFBE3BB19760A0F7A33644725E12976245356823A54C1`.

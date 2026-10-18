# Native OS Sandbox schema-48 design landing acceptance record

**Date:** 2026-10-18
**Decision:** Accepted by the user: `ACCEPT_NATIVE_OS_SANDBOX_SCHEMA48_REBASE_FIXED_IMPLEMENTATION_PLAN`
**Implementation authorization:** NOT GRANTED.

## Accepted inputs

The user explicitly accepted the fixed schema-48 proposal at raw SHA-256
`3EAD84A15267DD00AF754C2FC2B5DCE98FDBDBC7C5CB305A99055646571A8F62`,
located at
`C:\Users\ThinkPad\.codex\worktrees\native-sandbox-governance\Arbor\planning\proposals\native-os-sandbox-schema48-rebase-fixed-implementation-plan.md`.
The proposal's independent pre-acceptance review recorded B0/B1/B2 = 0 at
`ah19_work_review` and binds the proposal to candidate commit
`2a5f0ab4605c316c8bfc0c5db1b54172e39c3d46`.

The proposal carries forward these previously accepted semantic packages:

| Token | Accepted proposal raw SHA-256 | Source owner landing |
|---|---|---|
| `ACCEPT_NATIVE_OS_SANDBOX_CONVERGENCE_V1` | `ACAE6656234C50856FEC7B4B8AEF829E9A10C2EBDC1142862E35EAE3CF5C9341` | `cbb541c11aa7029e23b027d4e2b257ada2b83b34` |
| `ACCEPT_NATIVE_OS_SANDBOX_COMMAND_AUTHORITY_AMENDMENT_V3` | `CCF6874FACF846FB9A9A32C861A29D17CC82F641139C6E8A18ACD69F8D04418D` | `cbb541c11aa7029e23b027d4e2b257ada2b83b34` |
| `ACCEPT_NATIVE_OS_SANDBOX_PROVIDER_UNAVAILABLE_FACT_STORAGE_V5` | `B62294818B14347DB0B40278C115B5BD8397C3C05F2FBE1B00D7949481BE07BD` | `ed8c343724d00bb81c64db33f50943cc7386d5c5` |

V2 is superseded by V3; V4's storage semantics are carried only under V5.
The side-branch landing commits above are semantic source evidence, not
ancestors of this combined current-main landing.

## Landing decision and bounds

The accepted design is forward-ported from the exact schema-48 candidate,
preserving its Scenarios v1.4, System Design v1.19 and DID v1.52 bytes and
advancing those owners to Scenarios v1.5, System Design v1.20 and DID v1.53.
P1 owns the fixed decision/provenance schema and the 0049/0050 sequence;
P4/P5/P9/P10/P11/P12/P13 retain their accepted process, authority, provider,
recovery, Attention, composition and human-surface responsibilities.

The schema-48 sequence is fixed as migration 0049
(`requiresUserVersion=48`) for policy decision/grant provenance, followed by
0050 (`requiresUserVersion=49`) for the V5 unavailable fact/queue/marker and
exact decision foreign key. This landing does not register or activate either
migration, execute a migration, upgrade any database, modify production code
or tests, deploy, or release. The fixed plan's separate
`AUTHORIZE_NATIVE_OS_SANDBOX_CONVERGENCE_IMPLEMENTATION` token remains
ungranted.

The exact accepted proposal was not edited after acceptance. Its accepted raw
hash is preserved above; this record documents the owner landing and technical
rebase only. Independent post-landing review is pending and gates any later
implementation authorization.

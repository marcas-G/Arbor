# Native Sandbox V21 Producer Mapping Closure V3 — Acceptance and Landing Record

**Decision date:** 2026-10-19

**Decision:** User accepted `ACCEPT_NATIVE_OS_SANDBOX_V21_PRODUCER_MAPPING_CLOSURE_V3`.

**Accepted proposal raw SHA-256:** `3944B1E8BBA9A7A0EBB47988B4B67965718C94EB4EE05D9605E9711AC1FF8A8A`.

**Accepted proposal path:** `C:\Users\ThinkPad\.codex\worktrees\native-sandbox-governance\Arbor\planning\proposals\native-os-sandbox-v21-producer-mapping-closure-v3.md`.

**Owner landing base:** `e99e1c6e375bd92e04ec94a0bc5cdb9d4cd873e8`; the main candidate at `21863de2222552d2c0aeb8e93e21e86da226afc6` has identical owner blobs at this base.

**Landing branch:** `codex/native-sandbox-v21-owner-landing`.

**Independent post-landing review:** pending; this record does not claim PASS.

## Accepted semantic delta

V3 accepts exactly the two final producer-mapping corrections over its fixed
V2 package:

1. `SandboxOperatorPolicyConfigV1.trustedLocalRuntimeVersion` is exactly the
   literal `builtin-v1`. V21 TrustedLocal P4 snapshot/basis codecs and golden
   vectors remain unchanged. Any future runtime-version value requires new
   accepted governance and a new codec version.
2. Restricted/Enabled `NetworkBrokerControlsV1.pref64` is exactly
   `FreshPerResolutionAndConnection`. Each DNS resolution, connection, and
   redirect hop performs fresh discovery; a result is usable only within
   that connection's one answer-validation/address-pin/connect/TLS-handshake
   sequence. No cross-resolution, connection, pool, or redirect reuse is
   permitted. There is no `pref64-changed` code or separate controls digest.

All V2 producer mapping clauses remain accepted by the exact V2 raw hash
referenced from V3, except the two replaced clauses above. In particular,
V21 SandboxTargetRefV1 remains object-valued; authority bundle/high-water/
audit compatibility, full-boundary digest, mount/access mapping, configured
T3 limit binding, audit-ref source restrictions, and existing P1/P4/P9/P10
contracts remain controlling.

## Implementation authorization and non-goals

The pre-existing user authorization is
`AUTHORIZE_NATIVE_OS_SANDBOX_CONVERGENCE_IMPLEMENTATION`, granted 2026-10-18
in thread `01a0ec9b-9a9f-7242-9d1e-973451238d05`, scope T0–T4. This accepted
design package requests no new implementation token. Implementation may
continue under that existing grant only after this exact owner landing passes
independent post-review. This landing changes no code, tests, migration,
database, deployment, or release artifact; migration 0049/0050 is not
activated and no database is upgraded.

## Owner landing scope

The owner changes are limited to:

- `docs/design/03-detailed-implementation-design.md` (DID 1.55 cross-owner
  dependency summary; Scenarios/System Design remain unchanged)
- P1/00, P1/01, P1/03
- P4/00, P4/04, P4/05
- P5/00, P5/01
- P11/00, P11/04, P11/12
- P12/00, P12/09 (cross-reference only), P12/13, P12/14
- this acceptance record and `native-os-sandbox-v21-design-landing.manifest.md`

P10 and Scenarios are unchanged because the accepted delta is producer
contract closure with no new view or externally observable journey. No
System Design/domain semantics change is introduced.

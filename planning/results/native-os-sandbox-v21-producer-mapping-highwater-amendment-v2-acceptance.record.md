# Native Sandbox Producer Mapping — High-Water Amendment V2 Acceptance

**Decision date:** 2026-10-19

**Decision:** User accepted `ACCEPT_NATIVE_OS_SANDBOX_V21_PRODUCER_MAPPING_CLOSURE_V3_HIGHWATER_AMENDMENT_V2`.

**Accepted proposal raw SHA-256:** `09F67CCA1DA295C08011890C96E6409990EB9A3CB45D7F555E3776925C0BA1EE`.

**Accepted proposal path:** `C:\Arbor\planning\proposals\native-os-sandbox-v21-producer-mapping-closure-v3-highwater-amendment-v2.md`.

**Owner base:** V21 landing `e99e1c6e375bd92e04ec94a0bc5cdb9d4cd873e8`; main candidate `21863de2222552d2c0aeb8e93e21e86da226afc6` has identical owner blobs.

## Accepted amendment

This amendment resolves the accepted V3 producer closure's V1→V2
source/high-water transition only. The V1 source and exact V1 high-water bytes
are preserved as immutable forensic evidence and are not copied into active
V2 bundle/high-water fields. V2 source `bundleRevision` is strictly greater
than the V1 high-water's bundle revision. `SandboxAuthorityHighWaterV2` exact
codec/key order is unchanged; it is the sole active high-water after adoption
and must exactly match the complete V2 source identity, bundle revision/digest,
and issuer/operator/provider-registry revision/digest pairs. Unchanged issuer
or registry children may retain their prior child revision/digest; changed
children advance monotonically, as does the enclosing bundle. The operator
config has an explicit positive revision/digest. Source/high-water mismatch,
unproven preservation, or failed atomic/durable transition leaves authority
unavailable. V1 cannot authorize decisions after V2 adoption.

All other V3 clauses remain unchanged, including the literal TrustedLocal
runtime version and Pref64 control. This amendment adds no schema, migration,
implementation-authorization token, database write, code, test, or release
scope. The existing implementation authorization remains gated on exact
owner landing and independent post-review.

## Landing scope and review

P5/01 owns the exact old-value retention, V2 source/high-water matching and
crash behavior. The existing `SandboxAuthorityHighWaterV2` canonical example,
fields, key order, and digest codec are retained verbatim. Other V3 owners are
unchanged by this amendment. Independent post-landing review is pending.

# Native Sandbox V21 Producer Mapping Closure V3 — High-Water Amendment V2

Status: fixed planning-only amendment for owner landing; supersedes the prior
high-water amendment draft.

Recommended acceptance token:
`ACCEPT_NATIVE_OS_SANDBOX_V21_PRODUCER_MAPPING_CLOSURE_V3_HIGHWATER_AMENDMENT_V2`

## 1. Fixed bases and scope

This amendment applies to the accepted proposal
`planning/proposals/native-os-sandbox-v21-producer-mapping-closure-v3.md`,
raw SHA-256
`3944B1E8BBA9A7A0EBB47988B4B67965718C94EB4EE05D9605E9711AC1FF8A8A`.
V3 §1 incorporates the complete V2 package unchanged by exact hash; that
incorporated base is
`planning/proposals/native-os-sandbox-v21-producer-mapping-closure-v2.md`,
raw SHA-256
`6A40F37F69257C3BF9EC26DDDC5D218CD9DCC99C7767859B26D671FF8DE49F94`.
The earlier draft
`planning/proposals/native-os-sandbox-v21-producer-mapping-closure-v3-highwater-amendment.md`,
raw SHA-256
`8C4A60BA967492D59DC9AADA514078020B9B3937ACA647FA336BEC1EDAF20E6B`
(commit `5ab2a36d20ab259d65c3287d9cd9504838ad2d6e`), is superseded in full
by this V2 amendment and MUST NOT be landed independently.

This amendment resolves the V1→V2 high-water contradiction only. It changes
no `docs/design/**`, source code, tests, database, migration, or release
artifact. It introduces no schema or migration and grants no new
implementation authorization. The existing
`AUTHORIZE_NATIVE_OS_SANDBOX_CONVERGENCE_IMPLEMENTATION` remains applicable
only after this exact amendment is accepted, landed within the existing V3
owner scope, and independently reviewed.

## 2. Exact replacements in the V3-incorporated V2 §3

In the “Version compatibility and old-source handling are explicit” list
within V2 §3, replace only these two bullets:

1. The bullet beginning “The operator provisions a V2 source offline through
   the existing protected source identity/ACL procedure” and ending “The old
   V1 bytes remain immutable historical evidence and are not rewritten in
   place.”
2. The following bullet beginning “Existing V1 protected high-water state
   is not discarded or auto-reset” and ending “do not initialize fresh
   state or lower a revision to recover service.”

Replace them with these three bullets:

> - The operator provisions a V2 source offline through the existing
>   protected source identity/ACL procedure. It preserves the same source
>   identity unless the existing re-enrollment procedure explicitly changes
>   it, carries all previously accepted issuer and provider-registry contents
>   forward without widening them, adds an explicit operator config, and
>   assigns a `bundleRevision` strictly greater than the old V1 high-water's
>   `bundleRevision`. The old V1 source bytes remain immutable historical
>   evidence and are not rewritten in place.
> - Before replacing the active high-water representation, the offline
>   operator preserves the exact old V1 high-water bytes as immutable
>   forensic evidence, separate from the active high-water input and outside
>   the application database. The V1 bytes are never copied into the V2
>   active `bundleRevision` or `bundleDigest` fields and never authorize a
>   decision after V2 adoption. `SandboxAuthorityHighWaterV2` is the sole
>   active high-water after adoption, and its `sourceIdentity`,
>   `bundleRevision`, and `bundleDigest` exactly match the complete V2
>   source. Its issuer, operator, and provider-registry revision/digest pairs
>   each exactly match their embedded V2 subobjects. For issuer or
>   provider-registry contents carried forward byte-for-byte unchanged, the
>   V2 source and active V2 high-water may retain the corresponding V1 child
>   revision and digest. A changed child subobject requires its own strictly
>   increasing child revision and the enclosing V2 `bundleRevision` to
>   advance. The new operator config has its own explicit positive revision
>   and exact digest. If preservation or exact source/high-water matching
>   cannot be proven, authority remains unavailable; do not initialize fresh
>   state or lower/reuse a revision to recover service.

The `SandboxAuthorityHighWaterV2` exact codec block in the incorporated V2
§3 is expressly retained unchanged. In particular, retain its complete
canonical JSON example, exact key order
`version,sourceIdentity,bundleRevision,bundleDigest,issuerConfigRevision,
issuerConfigDigest,operatorConfigRevision,operatorConfigDigest,
providerRegistryRevision,providerRegistryDigest`, and its following
revision/digest validation rules. This amendment neither deletes nor
redefines that codec.

Replace only the paragraph in V2 §3 beginning “The V1→V2 source/high-water
transition is explicitly fail-closed across crashes” and ending “rollback to
V1 after V2 activation is forbidden” with:

> The V1→V2 source/high-water transition is atomic and fail-closed. First
> write and durably verify the complete V2 source, including its canonical
> bytes and child digests, at a `bundleRevision` strictly greater than the
> old V1 high-water value. Until the active V2 high-water is atomically
> committed, the old V1 high-water remains intact and the source-ahead or
> version-mismatched state disables decisions. Startup MUST NOT authorize
> from a V2 source without its exact matching active V2 high-water, or fall
> back to the V1 source. Then atomically replace the active high-water with
> the complete `SandboxAuthorityHighWaterV2` record, using the exact codec
> and key order retained immediately above and values that exactly match
> that verified V2 source. Preserve the old V1 raw high-water bytes
> separately as immutable forensic evidence; after this commit, they are
> forensic-only. A crash before commit leaves the V1 high-water unchanged,
> the V2 source ahead, and authority unavailable. A crash after the durable
> atomic commit leaves the exact verified V2 source/high-water pair active
> and V1 evidence forensic-only. No V1 bundle, V1 bundle fields copied into
> a V2 active record, or defaulted config can authorize a decision. Rollback
> to V1 after V2 adoption is forbidden. If preservation, atomic replacement,
> durable verification, or exact source/high-water matching cannot be
> proven, authority remains unavailable; the operator MUST NOT initialize
> fresh state or lower/reuse a revision to recover service.

All other V2 §3 text remains unchanged and incorporated by V3, including the
`SandboxAuthorityHighWaterV2` codec and exact source/high-water matching
requirements. V3's own §2 and §3 literal corrections remain unchanged.

## 3. Existing owner scope and TDD

Landing uses the owner set already fixed by accepted V3 §8; no owner is added
or removed. P5/01 owns the protected authority source and high-water
loading, verification, and transition. Existing P4 owners consume only the
V2 values mapped by V3 and acquire no high-water transition or migration
responsibility. Preserve later unrelated owner-document content.

Add these cases to the V3 §8 TDD matrix while retaining its existing
high-water codec and known-answer checks:

- The retained `SandboxAuthorityHighWaterV2` codec decodes/encodes only its
  exact existing canonical shape and key order. The amendment causes no
  codec, field, or preimage change.
- Old V1 high-water raw bytes are retained byte-for-byte as forensic
  evidence, excluded from the V2 active `bundleRevision` and `bundleDigest`,
  and never used as decision authority after adoption.
- V2 source `bundleRevision` is strictly greater than the old V1
  high-water. The active V2 high-water exactly matches source identity,
  bundle revision/digest, and all issuer/operator/provider-registry
  revision/digest pairs.
- Byte-identical carried-forward issuer and provider-registry subobjects
  may retain their V1 child revisions/digests in both the V2 source and
  active V2 high-water. Changed child content with a reused or
  non-increasing child revision, or any source/high-water mismatch, fails
  closed.
- A crash before active V2 high-water commit leaves the old V1 bytes intact,
  the V2 source ahead, and decisions disabled. A crash after durable atomic
  commit leaves only the exact V2 pair active and V1 evidence forensic-only.
  Neither side permits fallback authorization from V1 or a default operator
  config.
- Failed V1 evidence preservation, V2 source verification, atomic high-water
  replacement, or durable post-commit verification leaves authority
  unavailable; no revision reset, reuse, or fresh-state initialization
  occurs.

No test result is claimed by this planning proposal. No new schema, database
write, migration, or implementation-authorization token is introduced.

## 4. Acceptance and limits

Acceptance applies to this exact V2 amendment hash and exact replacement
scope. It supersedes the earlier high-water amendment draft identified in
§1. It does not alter the V3 §3 literal correction or any other incorporated
V2 clause. This amendment does not activate migrations 0049/0050, upgrade a
database, qualify a provider, claim release readiness, or grant new
implementation authority.

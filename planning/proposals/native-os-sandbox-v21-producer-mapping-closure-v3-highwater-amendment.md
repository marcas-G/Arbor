# Native Sandbox V21 Producer Mapping Closure V3 — High-Water Amendment

Status: fixed planning-only amendment for owner landing.

Recommended acceptance token:
`ACCEPT_NATIVE_OS_SANDBOX_V21_PRODUCER_MAPPING_CLOSURE_V3_HIGHWATER_AMENDMENT`

## 1. Fixed base and scope

This amendment is solely to the accepted proposal
`planning/proposals/native-os-sandbox-v21-producer-mapping-closure-v3.md`,
raw SHA-256
`3944B1E8BBA9A7A0EBB47988B4B67965718C94EB4EE05D9605E9711AC1FF8A8A`.
It resolves the V1→V2 authority high-water contradiction in §3. It does not
reopen any other V3 clause; the accepted V3 proposal remains incorporated
unchanged except for the exact replacement in §2 below.

This is planning-only. It changes no `docs/design/**`, source code, tests,
database, migration, or release artifact. It introduces no schema or
migration and grants no new implementation authorization. The existing
`AUTHORIZE_NATIVE_OS_SANDBOX_CONVERGENCE_IMPLEMENTATION` remains applicable
only after this exact amendment is accepted, landed within the existing V3
owner scope, and independently reviewed.

## 2. Exact replacement in V3 §3

Replace the V3 §3 text beginning with “Version compatibility and old-source
handling are explicit:” through and including the paragraph beginning “The
V1→V2 source/high-water transition is explicitly fail-closed across crashes”
with the following complete text. This replacement supersedes the V3
statements that the active V2 high-water preserves the V1 `bundleRevision`
and `bundleDigest`, and that the V2 source and active high-water must exactly
match, by defining the former as forensic history and the latter as the
current V2 pair.

> **Version compatibility and old-source handling are explicit:**
>
> - A V1 authority bundle and its V1 protected high-water are decoded only
>   by their frozen V1 codecs. They remain immutable historical evidence and
>   are not a source of new sandbox decisions after V2 adoption. No implicit
>   default operator config is synthesized from V1.
> - The operator provisions the V2 source offline through the existing
>   protected source identity/ACL procedure. It preserves the same source
>   identity unless the existing re-enrollment procedure explicitly changes
>   it; carries forward the accepted issuer and provider-registry contents
>   without widening them; adds an explicit operator config; and assigns a
>   `bundleRevision` strictly greater than the V1 high-water's
>   `bundleRevision`. The old V1 source bytes remain immutable historical
>   evidence and are not rewritten in place.
> - Before replacing the active high-water representation, the offline
>   operator preserves the exact old V1 high-water bytes as immutable
>   forensic evidence, separate from the active high-water input and outside
>   the application database. These bytes are never copied into V2's active
>   `bundleRevision` or `bundleDigest` fields and never authorize a decision
>   after V2 adoption. The V2 source's bundle revision and digest are the
>   values recorded in the active V2 high-water.
> - `SandboxAuthorityHighWaterV2` is the sole active high-water after
>   adoption. Its `sourceIdentity`, `bundleRevision`, and `bundleDigest`
>   exactly match the complete V2 source. Its issuer, operator, and provider
>   registry revision/digest pairs each exactly match their embedded V2
>   subobjects. For issuer or provider-registry contents carried forward
>   byte-for-byte unchanged, the V2 source and active V2 high-water may retain
>   the corresponding V1 child revision and digest. A changed child
>   subobject requires its own strictly increasing child revision. The new
>   operator config has its own explicit positive revision and exact digest.
>   Any child-subobject change also requires the enclosing V2
>   `bundleRevision` to advance; the V2 `bundleRevision` is always strictly
>   greater than the old V1 high-water value during this transition.
> - The active transition is atomic and fail-closed. First write and durably
>   verify the complete V2 source, including its canonical bytes and child
>   digests, at the strictly higher bundle revision. Until the V2 high-water
>   is atomically committed, the old V1 high-water remains intact and the
>   source-ahead/version-mismatched state disables decisions; startup MUST
>   NOT authorize from either the V2 source without its matching active V2
>   high-water or the V1 source as fallback. Then atomically replace the
>   active high-water with the complete V2 record whose fields exactly match
>   that verified V2 source. The V1 raw high-water evidence is retained
>   separately and is forensic-only after this commit.
> - A crash before the V2 high-water commit leaves the V1 high-water
>   unchanged, the V2 source ahead of it, and authority unavailable. A crash
>   after the durable atomic commit leaves the verified V2 source and exact
>   V2 high-water pair active, with the V1 bytes available only as forensic
>   evidence. There is no window in which a V1 bundle, preserved V1 bundle
>   fields copied into a V2 record, or a defaulted config can authorize a
>   decision. Rollback to V1 after V2 adoption is forbidden. If preservation,
>   atomic replacement, or exact source/high-water matching cannot be proven,
>   authority remains unavailable; the operator MUST NOT initialize fresh
>   state or lower/reuse a revision to recover service.
>
> `SandboxAuthorityHighWaterV2` retains the exact canonical key order and
> shape already specified below in this V3 §3. Its active `bundleRevision`
> and `bundleDigest` are the V2 source values, while each child revision and
> digest is the exact corresponding V2 subobject value. V1 audit records stay
> immutable and are decoded only by their V1 codec; V2 audit records retain
> the already specified V2 codec.

All other V3 §3 text remains effective, including the canonical V2 bundle
and high-water codecs, forward-skip rules, audit codecs, snapshot mapping,
and exact source/high-water equality requirement after activation.

## 3. Existing owner scope and TDD

Landing uses the owner set already fixed by accepted V3 §8; this amendment
does not add an owner or change document ownership. Within that set, the
high-water transition is owned by P5/01 (protected authority source and
high-water loading/verification). Existing P4 owners consume only the exact
V2 values mapped by V3; they gain no migration or authority-transition
responsibility. Preserve all later unrelated owner-document content.

Add these cases to the V3 §8 TDD matrix for the corrected §3 contract:

- V1 high-water raw bytes are retained byte-for-byte in forensic evidence,
  excluded from the active V2 record's `bundleRevision` and `bundleDigest`,
  and never consulted as a decision authority after V2 adoption.
- The V2 source has a bundle revision strictly greater than the old V1
  high-water. Its active V2 high-water exactly matches source identity,
  bundle revision/digest, and every issuer/operator/provider-registry
  revision/digest pair.
- Byte-identical carried-forward issuer and provider-registry subobjects may
  preserve their V1 child revisions/digests in both the V2 source and active
  V2 high-water. Changed child content with a reused/non-increasing revision,
  or any source/high-water field mismatch, fails closed.
- Crash before active V2 high-water commit leaves the old V1 bytes intact,
  the V2 source ahead, and all decisions disabled. Crash after the durable
  atomic commit leaves only the exact V2 pair active and V1 evidence
  forensic-only. Neither side permits fallback authorization from V1 or
  default operator config.
- Failed V1 evidence preservation, V2 source verification, atomic high-water
  replacement, or durable post-commit verification leaves authority
  unavailable; tests prove no revision reset, reuse, or fresh-state
  initialization occurs.

No test result is claimed by this planning proposal. No new schema, database
write, migration, or implementation-authorization token is introduced.

## 4. Acceptance and limits

Acceptance applies to this exact amendment hash and the exact replacement in
§2. It is inseparable from the accepted V3 proposal identified in §1; it does
not authorize landing V3 independently from the accepted owner package. All
V3 provisions not expressly replaced remain in force. This amendment does
not activate migrations 0049/0050, upgrade a database, qualify a provider,
claim release readiness, or grant new implementation authority.

# AH10 Deliver P7 Migration Reference Correction — Governance Decision

Date: 2026-10-11  
Decision: `ACCEPT_P7_DELIVER_MIGRATION_REFERENCE_CORRECTION`  
Status: **Exact documentation correction accepted; independent final re-review pending**

## Fixed source contract

This decision is limited to correcting the P7 owner references to the already
accepted AH10 Deliver storage sequence. It does not revise that contract or
add runtime, schema, authority, or release semantics.

- Original AH10 Deliver proposal SHA-256:
  `75EAF29FC8FC90C5E098DA3758EFAD8C69074F478C82F2399619F522AE596565`.
- Original acceptance commit:
  `5bb55134e680b1830309910c5eb618ffa75fa21c`.
- Original owner landing commit:
  `89d799025e0633aebd9e4299df172907f14cc05e`.
- Accepted P10 storage addendum SHA-256:
  `040789D32BE1D92F1BAD28C5E3346439C1E902236452E778CD104AF6AA71EC8B`.
- Addendum acceptance commit:
  `d5649e9c74ed274fb3c05ea8246db33b326dc60d`.
- Addendum owner landing commit:
  `129782081677041526ef92be27c0a5f472f48bb2`.

The fixed sequence is P36 / migration 0036, then P37 / migration 0037.
Migration 0034 remains P10 Attention materialization. P37's proposed
`0037_ah10_deliver_replay_attention_rows` carries the DeliverReplay P9 fact
and P10 source-specific marker after P36. The P36 owner contract is integrated
in the governance tree; migration implementations/registrations 0036 and 0037
are not integrated there. This decision does not authorize either migration's
implementation or release.

## Review finding and delegated authority

The independent integration review reported semantic **Blocking = 0** and
governance-scope **Blocking = 1**: the accepted P37 storage addendum's original
owner-document list excluded P7, while P7 `02` still incorrectly attributed
the DeliverReplay fact table to migration 0034. The reviewer confirmed the
correct migration ownership/order from DID §9.3 and the accepted addendum; the
finding concerns the P7 correction's governance scope.

Under the user's standing manual-governance delegation recorded in
`AGENTS.md`, and the coordinating Governor's instruction for this exact
correction, this record accepts the two-file P7 correction as a narrow
correction of the existing owner-document migration reference. The fixed
factual basis is the accepted P37 addendum above. The correction adds no
behavior and does not broaden its migration, release, or implementation
authority.

## Accepted correction and owner hashes

Correction commit: `a8b4c0718833560a08664997ed8ef1cb37dfc85b`.

| Owner | Accepted correction | SHA-256 after correction |
|---|---|---|
| `docs/design/implementation/P7/00-contract-index.md` | Indexes the accepted v1.38 addendum; identifies P36→P37 and distinguishes integrated owner contracts from unintegrated migration registrations. | `8BEC5B0D93489E95668AC9C360DF1931823ECD5A9CB3B03C23C6EEFC0B95F00B` |
| `docs/design/implementation/P7/02-deliver-primitive.md` | Marks the former 0034 DeliverReplay statement superseded; points to proposed 0037 after P36/0036 and states that migration implementation/registration is not integrated. | `ADD1FEA5A069DDA16914CB836215B1F5CD6DE052189637B48C4C130374090ABA` |

DID §9.3's wording clarification is separately recorded in the integration
result: it says the P36 owner contract is integrated while migration 0036
implementation/registration is not integrated in this tree. It restates
current integration status only.

No production, migration, or test files were changed. No tests, migration,
build, or push were performed. The owner-document diff check passed. The
integration result is updated to record this governance disposition and the
current independent-review gate. Final review of this scope disposition
remains pending.
